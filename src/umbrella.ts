import type {
  DetectorStatus,
  Finding,
  GateTable,
  SweepCharter,
  SweepReport,
} from "./contract.ts";
import { selectFiles, type DiffSelection } from "./diff.ts";
import { realCommandRunner, type CommandRunner } from "./exec.ts";
import { buildGateTable } from "./gate.ts";
import { renderApplyReport, type ApplyDecision, type ApplyResult } from "./apply.ts";
import type { TestCommand } from "./test-command.ts";
import type { LensClient } from "./adapters/zero-fanout.ts";
import {
  detectorsFor,
  runSweep,
  type Detector,
  type SweepResult,
} from "./pipeline.ts";
import { renameAwareProseFiles, type RenameExpansion } from "./rename.ts";
import { mutationCleanFiles } from "./mutation.ts";
import { unique } from "./paths.ts";
import { escapeTableCell, renderTable, renderTotals } from "./markdown.ts";
import { buildBehaviorAxis, jscpdCleanFiles, type BehaviorAxis } from "./sweeps/test.ts";

export type UmbrellaDetectors = Partial<Record<SweepCharter, Detector[]>>;

export interface UmbrellaRequest {
  cwd: string;
  runner?: CommandRunner;
  base?: string;
  fullAudit?: boolean;
  apply?: boolean;
  decide?: ApplyDecision;
  testCommand?: TestCommand | null;
  lens?: LensClient;
  /** Injecting detectors replaces the real set for every charter. */
  detectors?: UmbrellaDetectors;
  selection?: DiffSelection;
  /** Explicit mutation report path passed to the test sweep. */
  mutationReportPath?: string;
  /** Override the measured freshness baseline, mainly for tests. */
  mutationLatestChangeMs?: number;
  /** Clock used for the mutation evidence timestamp, mainly for tests. */
  mutationNow?: () => number;
}

export interface UmbrellaReport extends SweepReport {
  sweeps: Record<SweepCharter, SweepReport>;
  renameExpansions: RenameExpansion[];
  /** Test axis built from the test sweep's fresh mutation evidence. */
  behaviorAxis: BehaviorAxis;
}

export interface UmbrellaResult {
  report: UmbrellaReport;
  markdown: string;
  apply?: ApplyResult;
  behaviorAxis: BehaviorAxis;
}

function findingKey(finding: Finding): string {
  return [finding.file, finding.line, finding.rule, finding.evidence].join(
    "\0",
  );
}

/** Drop findings repeated by shared detectors; distinct positions stay. */
export function dedupeUmbrellaFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = findingKey(finding);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** One table for every charter, with a Sweep column the single-sweep table lacks. */
export function renderUmbrellaTable(table: GateTable): string {
  const lines: string[] = [];
  if (table.files.length === 0) {
    lines.push("No findings.");
  }
  for (const group of table.files) {
    const rows = group.findings.map((finding) => [
      String(finding.line),
      finding.sweep ?? "—",
      String(finding.tier),
      escapeTableCell(finding.rule),
      escapeTableCell(finding.evidence),
      escapeTableCell(finding.proposedFix ?? "—"),
    ]);
    lines.push(
      `### ${group.file}`,
      "",
      renderTable(
        ["Line", "Sweep", "Tier", "Rule", "Evidence", "Proposed fix"],
        rows,
      ),
      "",
    );
  }
  lines.push(renderTotals(table.totals));
  return lines.join("\n");
}

function renderRenameExpansions(expansions: RenameExpansion[]): string {
  return [
    "**Rename expansion:**",
    "",
    ...expansions.map((expansion) => `- ${expansion.file}: ${expansion.evidence}`),
  ].join("\n");
}

export function renderDetectorCoverage(statuses: DetectorStatus[]): string {
  if (statuses.length === 0) {
    return "";
  }
  return [
    "**Detectors:**",
    "",
    ...statuses.map(
      (status) =>
        `- ${status.name}: ${
          status.available
            ? "ran"
            : `unavailable — ${status.reason ?? "unknown reason"}`
        }`,
    ),
  ].join("\n");
}

function mergeStatus(
  statuses: Map<string, DetectorStatus>,
  status: DetectorStatus,
): void {
  const existing = statuses.get(status.name);
  if (!existing) {
    statuses.set(status.name, { ...status });
    return;
  }
  if (!status.available) {
    statuses.set(status.name, { ...status });
  }
}

/**
 * Fold detector statuses and unavailable strings into one coverage list. An
 * unavailable string whose reason no status carries becomes a coverage entry.
 */
export function canonicalCoverage(reports: SweepReport[]): {
  detectors: DetectorStatus[];
  unavailable: string[];
} {
  const statuses = new Map<string, DetectorStatus>();
  const reasons = new Set<string>();
  const unavailable: string[] = [];

  for (const report of reports) {
    for (const status of report.detectors ?? []) {
      mergeStatus(statuses, status);
      if (status.reason) {
        reasons.add(status.reason);
      }
    }
    for (const message of report.unavailable ?? []) {
      unavailable.push(message);
    }
  }

  for (const message of [...new Set(unavailable)]) {
    if (!reasons.has(message)) {
      statuses.set(`coverage:${message}`, {
        name: "coverage",
        available: false,
        reason: message,
      });
      reasons.add(message);
    }
  }

  return {
    detectors: [...statuses.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    unavailable: [...new Set(unavailable)],
  };
}

function mergeApply(results: Array<ApplyResult | undefined>): ApplyResult | undefined {
  const present = results.filter((result): result is ApplyResult => Boolean(result));
  if (present.length === 0) {
    return undefined;
  }
  return {
    testCommand:
      present.find((result) => result.testCommand !== null)?.testCommand ?? null,
    reportOnly: present.some((result) => result.reportOnly),
    batches: present.flatMap((result) => result.batches),
    findings: present.flatMap((result) => result.findings),
    applied: present.reduce((sum, result) => sum + result.applied, 0),
    reverted: present.reduce((sum, result) => sum + result.reverted, 0),
    skipped: present.reduce((sum, result) => sum + result.skipped, 0),
  };
}

function detectorsForUmbrella(
  request: UmbrellaRequest,
  charter: SweepCharter,
): Detector[] {
  if (request.detectors) {
    return request.detectors[charter] ?? [];
  }
  return detectorsFor(charter, { lens: request.lens });
}

/**
 * Run code, test, and prose sweeps against one resolved selection, then merge
 * their gate tables. Rename-aware prose expansion joins the same selection.
 */
export async function runUmbrella(request: UmbrellaRequest): Promise<UmbrellaResult> {
  const runner = request.runner ?? realCommandRunner;
  const selection =
    request.selection ??
    (await selectFiles({
      cwd: request.cwd,
      runner,
      base: request.base,
      fullAudit: request.fullAudit,
    }));

  let proseSelection = selection;
  let renameExpansions: RenameExpansion[] = [];
  if (selection.mode === "diff" && selection.resolvedBase) {
    const expansion = await renameAwareProseFiles({
      cwd: request.cwd,
      runner,
      base: selection.resolvedBase,
    });
    renameExpansions = expansion.expansions;
    if (expansion.files.length > 0) {
      proseSelection = {
        ...selection,
        files: unique([...selection.files, ...expansion.files]),
      };
    }
  }

  const common = {
    cwd: request.cwd,
    runner,
    apply: request.apply,
    decide: request.decide,
    testCommand: request.testCommand,
  };
  const runs: Record<SweepCharter, SweepResult> = {
    code: await runSweep({
      ...common,
      kind: "code",
      sweep: "code",
      selection,
      detectors: detectorsForUmbrella(request, "code"),
    }),
    test: await runSweep({
      ...common,
      kind: "test",
      sweep: "test",
      selection,
      ...(request.mutationReportPath
        ? { mutationReportPath: request.mutationReportPath }
        : {}),
      ...(typeof request.mutationLatestChangeMs === "number"
        ? { mutationLatestChangeMs: request.mutationLatestChangeMs }
        : {}),
      ...(request.mutationNow ? { mutationNow: request.mutationNow } : {}),
      detectors: detectorsForUmbrella(request, "test"),
    }),
    prose: await runSweep({
      ...common,
      kind: "prose",
      sweep: "prose",
      selection: proseSelection,
      detectors: detectorsForUmbrella(request, "prose"),
    }),
  };

  const findings = dedupeUmbrellaFindings([
    ...runs.code.report.findings,
    ...runs.test.report.findings,
    ...runs.prose.report.findings,
  ]);
  const gate = buildGateTable(findings);
  const coverage = canonicalCoverage([
    runs.code.report,
    runs.test.report,
    runs.prose.report,
  ]);
  const apply = mergeApply([
    runs.code.apply,
    runs.test.apply,
    runs.prose.apply,
  ]);
  const behaviorAxis = buildBehaviorAxis({
    files: runs.test.report.files,
    jscpdClean: jscpdCleanFiles(
      runs.test.report.files,
      runs.test.report.findings,
    ),
    mutationClean: runs.test.mutation
      ? mutationCleanFiles(runs.test.mutation)
      : [],
    ...(selection.resolvedBase ? { baseRef: selection.resolvedBase } : {}),
  });

  const report: UmbrellaReport = {
    mode: selection.mode,
    baseRef: selection.baseRef,
    resolvedBase: selection.resolvedBase,
    files: unique([...selection.files, ...proseSelection.files]),
    findings,
    gate,
    sweeps: {
      code: runs.code.report,
      test: runs.test.report,
      prose: runs.prose.report,
    },
    renameExpansions,
    behaviorAxis,
    ...(coverage.unavailable.length > 0
      ? { unavailable: coverage.unavailable }
      : {}),
    ...(coverage.detectors.length > 0
      ? { detectors: coverage.detectors }
      : {}),
  };

  const sections = [renderUmbrellaTable(gate)];
  if (renameExpansions.length > 0) {
    sections.push(renderRenameExpansions(renameExpansions));
  }
  const coverageMarkdown = renderDetectorCoverage(coverage.detectors);
  if (coverageMarkdown) {
    sections.push(coverageMarkdown);
  }
  if (apply) {
    sections.push(renderApplyReport(apply));
  }

  return apply
    ? { report, markdown: sections.join("\n\n"), apply, behaviorAxis }
    : { report, markdown: sections.join("\n\n"), behaviorAxis };
}
