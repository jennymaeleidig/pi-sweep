import type {
  DetectorInput,
  DetectorStatus,
  FindingDraft,
  SweepCharter,
  SweepReport,
} from "./contract.ts";
import { selectFiles, type DiffSelection } from "./diff.ts";
import { applyWithinCharter } from "./charter.ts";
import { realCommandRunner, type CommandRunner } from "./exec.ts";
import { buildGateTable, decideForPolicy, finalizeFindings, isCiEnvironment, renderGateTable, type GatePolicy } from "./gate.ts";
import { applyFindings, renderApplyReport, type ApplyDecision, type ApplyResult } from "./apply.ts";
import type { TestCommand } from "./test-command.ts";
import type { LensClient } from "./adapters/zero-fanout.ts";
import { codeDetectors } from "./sweeps/code.ts";
import { testDetectors } from "./sweeps/test.ts";
import { proseDetectors } from "./sweeps/prose.ts";
import { loadMutationEvidence, type MutationEvidence } from "./mutation.ts";

export type SweepKind = "sweep" | SweepCharter;

export type { DetectorInput } from "./contract.ts";

export interface DetectorAvailability {
  available: boolean;
  reason?: string;
}

export interface Detector {
  name: string;
  detect(input: DetectorInput): Promise<FindingDraft[]>;
  /** Optional pre-flight probe so an absent tool is reported, not treated as clean. */
  probe?(input: DetectorInput): Promise<DetectorAvailability>;
  /** Coverage the detector could not provide, so the report never shows it as clean. */
  unavailable?(input: DetectorInput): Promise<string[]>;
}

export interface SweepRequest {
  kind: SweepKind;
  cwd: string;
  runner?: CommandRunner;
  base?: string;
  fullAudit?: boolean;
  /** Run the apply engine after the gate. Report-only unless true. */
  apply?: boolean;
  /** Explicit apply decision; defaults to the gate's per-finding action. */
  decide?: ApplyDecision;
  /** True only for an interactive pi session; Tier 0 auto-applies inside one. */
  interactive?: boolean;
  /** CI override; defaults to detecting the `CI` environment variable. */
  ci?: boolean;
  /** Duplicate-block size at or above which jscpd findings are Tier 0. */
  jscpdMinTokens?: number;
  /** Pre-resolved suite; the engine resolves the repo's declaration otherwise. */
  testCommand?: TestCommand | null;
  detectors?: Detector[];
  lens?: LensClient;
  /** Explicit mutation report path; the declaration and convention are used otherwise. */
  mutationReportPath?: string;
  /** Extra no-assertion hook locations, consulted before the default candidates. */
  hookPaths?: string[];
  /** Override the measured freshness baseline, mainly for tests. */
  mutationLatestChangeMs?: number;
  /** Clock used for the mutation evidence timestamp, mainly for tests. */
  mutationNow?: () => number;
  /** Pre-resolved selection, so an umbrella runs every sweep over one snapshot. */
  selection?: DiffSelection;
  /** Origin charter stamped onto drafts when the caller runs one sweep of several. */
  sweep?: SweepCharter;
}

export interface SweepResult {
  report: SweepReport;
  markdown: string;
  apply?: ApplyResult;
  /** Fresh or stale mutation evidence; absent when the repository has not opted in. */
  mutation?: MutationEvidence;
}

export function detectorsFor(
  kind: SweepKind,
  options: { lens?: LensClient } = {},
): Detector[] {
  switch (kind) {
    case "sweep":
      return [
        ...codeDetectors(options),
        ...testDetectors(),
        ...proseDetectors(),
      ];
    case "code":
      return codeDetectors(options);
    case "test":
      return testDetectors();
    case "prose":
      return proseDetectors();
  }
}

function withDetectorStatuses(markdown: string, statuses: DetectorStatus[]): string {
  if (statuses.length === 0) {
    return markdown;
  }
  const lines = ["", "**Detectors:**", ""];
  for (const status of statuses) {
    lines.push(
      `- ${status.name}: ${status.available ? "ran" : `unavailable — ${status.reason ?? "unknown reason"}`}`,
    );
  }
  return `${markdown}\n${lines.join("\n")}`;
}

export async function runSweep(request: SweepRequest): Promise<SweepResult> {
  const runner = request.runner ?? realCommandRunner;
  const policy: GatePolicy = {
    interactive: request.interactive === true,
    ci: request.ci ?? isCiEnvironment(),
    ...(request.jscpdMinTokens !== undefined
      ? { jscpdMinTokens: request.jscpdMinTokens }
      : {}),
  };
  const selection =
    request.selection ??
    (await selectFiles({
      cwd: request.cwd,
      runner,
      base: request.base,
      fullAudit: request.fullAudit,
    }));

  const detectors = request.detectors ?? detectorsFor(request.kind, { lens: request.lens });
  const drafts: FindingDraft[] = [];
  const unavailable: string[] = [];
  const detectorStatuses: DetectorStatus[] = [];
  for (const detector of detectors) {
    const input = {
      files: selection.files,
      cwd: request.cwd,
      runner,
      ...(request.hookPaths ? { hookPaths: request.hookPaths } : {}),
    };
    if (detector.probe) {
      const availability = await detector.probe(input);
      detectorStatuses.push({
        name: detector.name,
        available: availability.available,
        ...(availability.reason ? { reason: availability.reason } : {}),
      });
      if (!availability.available) {
        continue;
      }
    }
    drafts.push(...(await detector.detect(input)));
    if (detector.unavailable) {
      unavailable.push(...(await detector.unavailable(input)));
    }
  }

  let mutation: MutationEvidence | undefined;
  if (request.kind === "test" || request.kind === "sweep") {
    const evidence = await loadMutationEvidence({
      cwd: request.cwd,
      runner,
      files: selection.files,
      ...(request.mutationReportPath ? { reportPath: request.mutationReportPath } : {}),
      ...(typeof request.mutationLatestChangeMs === "number"
        ? { latestChangeMs: request.mutationLatestChangeMs }
        : {}),
      ...(request.mutationNow ? { now: request.mutationNow } : {}),
    });
    if (evidence.status === "fresh") {
      drafts.push(...evidence.findings);
      mutation = evidence;
    } else if (evidence.status === "stale" || evidence.status === "unknown-shape") {
      unavailable.push(`mutation: ${evidence.reason ?? evidence.status}`);
      mutation = evidence;
    } else if (evidence.reason) {
      mutation = evidence;
    }
  }

  const origin =
    request.sweep ?? (request.kind === "sweep" ? undefined : request.kind);
  const tagged = origin
    ? drafts.map((draft) => (draft.sweep ? draft : { ...draft, sweep: origin }))
    : drafts;
  const finalized = finalizeFindings(tagged, { policy });
  const applyCandidates =
    request.kind === "sweep" ? finalized : applyWithinCharter(request.kind, finalized);
  const applyResult = request.apply
    ? await applyFindings({
        cwd: request.cwd,
        findings: applyCandidates,
        runner,
        decide: request.decide ?? decideForPolicy(policy),
        testCommand: request.testCommand,
      })
    : undefined;
  const findings = applyResult?.findings ?? finalized;
  const gate = buildGateTable(findings);
  const unavailableMessages = [...new Set(unavailable.filter(Boolean))];
  const report: SweepReport = {
    mode: selection.mode,
    baseRef: selection.baseRef,
    resolvedBase: selection.resolvedBase,
    files: selection.files,
    findings,
    gate,
    ...(unavailableMessages.length > 0 ? { unavailable: unavailableMessages } : {}),
    ...(detectorStatuses.length > 0 ? { detectors: detectorStatuses } : {}),
  };

  const sections = [renderGateTable(gate)];
  if (unavailableMessages.length > 0) {
    sections.push(`**Unavailable:** ${unavailableMessages.join("; ")}`);
  }
  if (applyResult) {
    sections.push(renderApplyReport(applyResult));
  }
  const markdown = withDetectorStatuses(sections.join("\n\n"), detectorStatuses);

  const result: SweepResult = { report, markdown };
  if (applyResult) {
    result.apply = applyResult;
  }
  if (mutation) {
    result.mutation = mutation;
  }
  return result;
}
