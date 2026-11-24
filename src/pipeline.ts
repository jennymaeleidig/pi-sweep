import type {
  DetectorStatus,
  FindingDraft,
  SweepReport,
} from "./contract.ts";
import { selectFiles } from "./diff.ts";
import { realCommandRunner, type CommandRunner } from "./exec.ts";
import { buildGateTable, finalizeFindings, renderGateTable } from "./gate.ts";
import { detect as detectJscpd } from "./adapters/jscpd.ts";
import { testDetectors } from "./sweeps/test.ts";

export type SweepKind = "sweep" | "code" | "test" | "prose";

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
}

export interface SweepRequest {
  kind: SweepKind;
  cwd: string;
  runner?: CommandRunner;
  base?: string;
  fullAudit?: boolean;
  reportOnly?: boolean;
  detectors?: Detector[];
}

export interface SweepResult {
  report: SweepReport;
  markdown: string;
}

const jscpdDetector: Detector = {
  name: "jscpd",
  detect: (input) => detectJscpd(input),
};

export function detectorsFor(kind: SweepKind): Detector[] {
  switch (kind) {
    case "sweep":
    case "code":
      return [jscpdDetector];
    case "test":
      return testDetectors();
    case "prose":
      return [];
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
  const selection = await selectFiles({
    cwd: request.cwd,
    runner,
    base: request.base,
    fullAudit: request.fullAudit,
  });

  const detectors = request.detectors ?? detectorsFor(request.kind);
  const drafts: FindingDraft[] = [];
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
  }

  const findings = finalizeFindings(drafts);
  const gate = buildGateTable(findings);
  const report: SweepReport = {
    mode: selection.mode,
    baseRef: selection.baseRef,
    resolvedBase: selection.resolvedBase,
    files: selection.files,
    findings,
    gate,
    ...(detectorStatuses.length > 0 ? { detectors: detectorStatuses } : {}),
  };

  return { report, markdown: withDetectorStatuses(renderGateTable(gate), detectorStatuses) };
}
