import type {
  DetectorStatus,
  FindingDraft,
  SweepCharter,
  SweepReport,
} from "./contract.ts";
import { selectFiles, type DiffSelection } from "./diff.ts";
import { applyWithinCharter } from "./charter.ts";
import { realCommandRunner, type CommandRunner } from "./exec.ts";
import { buildGateTable, finalizeFindings, renderGateTable } from "./gate.ts";
import { applyFindings, renderApplyReport, type ApplyDecision, type ApplyResult } from "./apply.ts";
import type { TestCommand } from "./test-command.ts";
import { detect as detectJscpd } from "./adapters/jscpd.ts";
import type { LensClient } from "./adapters/zero-fanout.ts";
import { codeDetectors } from "./sweeps/code.ts";
import { testDetectors } from "./sweeps/test.ts";
import { proseDetectors } from "./sweeps/prose.ts";

export type SweepKind = "sweep" | SweepCharter;

export interface DetectorInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
}

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
  reportOnly?: boolean;
  /** Run the apply engine after the gate. Report-only unless true. */
  apply?: boolean;
  /** Explicit apply decision; defaults to the gate's per-finding action. */
  decide?: ApplyDecision;
  /** Pre-resolved suite; the engine resolves the repo's declaration otherwise. */
  testCommand?: TestCommand | null;
  detectors?: Detector[];
  lens?: LensClient;
  /** Pre-resolved selection, so an umbrella runs every sweep over one snapshot. */
  selection?: DiffSelection;
  /** Origin charter stamped onto drafts when the caller runs one sweep of several. */
  sweep?: SweepCharter;
}

export interface SweepResult {
  report: SweepReport;
  markdown: string;
  apply?: ApplyResult;
}

const jscpdDetector: Detector = {
  name: "jscpd",
  detect: (input) => detectJscpd(input),
};

function dedupeDetectors(detectors: Detector[]): Detector[] {
  const seen = new Set<string>();
  const unique: Detector[] = [];
  for (const detector of detectors) {
    if (seen.has(detector.name)) {
      continue;
    }
    seen.add(detector.name);
    unique.push(detector);
  }
  return unique;
}

export function detectorsFor(
  kind: SweepKind,
  options: { lens?: LensClient } = {},
): Detector[] {
  switch (kind) {
    case "sweep":
      return dedupeDetectors([
        jscpdDetector,
        ...codeDetectors(options),
        ...testDetectors(),
        ...proseDetectors(),
      ]);
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

  const origin =
    request.sweep ?? (request.kind === "sweep" ? undefined : request.kind);
  const tagged = origin
    ? drafts.map((draft) => (draft.sweep ? draft : { ...draft, sweep: origin }))
    : drafts;
  const finalized = finalizeFindings(tagged);
  const applyCandidates =
    request.kind === "sweep" ? finalized : applyWithinCharter(request.kind, finalized);
  const applyResult = request.apply
    ? await applyFindings({
        cwd: request.cwd,
        findings: applyCandidates,
        runner,
        decide: request.decide,
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

  return applyResult ? { report, markdown, apply: applyResult } : { report, markdown };
}
