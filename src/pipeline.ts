import type { FindingDraft, SweepReport } from "./contract.ts";
import { selectFiles } from "./diff.ts";
import { realCommandRunner, type CommandRunner } from "./exec.ts";
import { buildGateTable, finalizeFindings, renderGateTable } from "./gate.ts";
import { detect as detectJscpd } from "./adapters/jscpd.ts";
import type { LensClient } from "./adapters/zero-fanout.ts";
import { codeDetectors } from "./sweeps/code.ts";

export type SweepKind = "sweep" | "code" | "test" | "prose";

export interface DetectorInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
}

export interface Detector {
  name: string;
  detect(input: DetectorInput): Promise<FindingDraft[]>;
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
  detectors?: Detector[];
  lens?: LensClient;
}

export interface SweepResult {
  report: SweepReport;
  markdown: string;
}

const jscpdDetector: Detector = {
  name: "jscpd",
  detect: (input) => detectJscpd(input),
};

export function detectorsFor(
  kind: SweepKind,
  options: { lens?: LensClient } = {},
): Detector[] {
  switch (kind) {
    case "sweep":
    case "test":
      return [jscpdDetector];
    case "code":
      return codeDetectors(options);
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

  const detectors = request.detectors ?? detectorsFor(request.kind, { lens: request.lens });
  const drafts: FindingDraft[] = [];
  const unavailable: string[] = [];
  for (const detector of detectors) {
    drafts.push(
      ...(await detector.detect({
        files: selection.files,
        cwd: request.cwd,
        runner,
      })),
    );
    if (detector.unavailable) {
      unavailable.push(
        ...(await detector.unavailable({
          files: selection.files,
          cwd: request.cwd,
          runner,
        })),
      );
    }
  }

  const findings = finalizeFindings(drafts);
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
  };

  const markdown =
    unavailableMessages.length > 0
      ? `${renderGateTable(gate)}\n\n**Unavailable:** ${unavailableMessages.join("; ")}`
      : renderGateTable(gate);

  return { report, markdown };
}
