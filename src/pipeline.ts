import type { FindingDraft, SweepReport } from "./contract.ts";
import { selectFiles } from "./diff.ts";
import { realCommandRunner, type CommandRunner } from "./exec.ts";
import { buildGateTable, finalizeFindings, renderGateTable } from "./gate.ts";
import { detect as detectJscpd } from "./adapters/jscpd.ts";

export type SweepKind = "sweep" | "code" | "test" | "prose";

export interface DetectorInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
}

export interface Detector {
  name: string;
  detect(input: DetectorInput): Promise<FindingDraft[]>;
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
    case "test":
      return [jscpdDetector];
    case "prose":
      return [];
  }
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
  for (const detector of detectors) {
    drafts.push(
      ...(await detector.detect({
        files: selection.files,
        cwd: request.cwd,
        runner,
      })),
    );
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
  };

  return { report, markdown: renderGateTable(gate) };
}
