import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Finding, FindingEdit, GateAction } from "./contract.ts";
import type { CommandRunner } from "./exec.ts";
import { groupByFile } from "./gate.ts";
import { resolveTestCommand, type TestCommand } from "./test-command.ts";

export type ApplyStatus = "applied" | "reverted" | "skipped" | "ask";

export interface ApplyOutcome {
  finding: Finding;
  status: ApplyStatus;
}

/** One reviewable batch of hunks, scoped to a single file. */
export interface ApplyBatch {
  file: string;
  outcomes: ApplyOutcome[];
}

export interface ApplyResult {
  /** The resolved suite; null means verification was impossible. */
  testCommand: TestCommand | null;
  /** True when apply was requested but no suite exists to verify it. */
  reportOnly: boolean;
  batches: ApplyBatch[];
  /** Findings with their resolved action, reason, and outcome recorded. */
  findings: Finding[];
  applied: number;
  reverted: number;
  skipped: number;
}

/** Explicit apply decision: the caller owns all policy. */
export type ApplyDecision = (finding: Finding) => GateAction;

export interface ApplyInput {
  cwd: string;
  findings: Finding[];
  runner: CommandRunner;
  decide?: ApplyDecision;
  /** Pre-resolved suite; when omitted the repo's own declaration is resolved. */
  testCommand?: TestCommand | null;
}

const NO_EDIT_REASON = "no structured edit attached";
const NO_SUITE_REASON = "no test command resolved; report-only";

function resolveAction(
  finding: Finding,
  decide: ApplyDecision,
): Finding {
  const action = decide(finding);
  if (action === "apply") {
    if (!finding.edit) {
      return { ...finding, action: "skip", reason: NO_EDIT_REASON };
    }
    return { ...finding, action: "apply", reason: undefined };
  }
  if (action === "skip") {
    return { ...finding, action: "skip", reason: finding.reason ?? "skipped" };
  }
  return { ...finding, action: "ask" };
}

/** Index of the hunk's anchor, preferring the occurrence nearest `line`. */
function locateHunk(content: string, edit: FindingEdit, line: number): number | null {
  if (edit.oldText.length === 0) {
    return null;
  }
  const indices: number[] = [];
  let from = 0;
  while (true) {
    const index = content.indexOf(edit.oldText, from);
    if (index === -1) {
      break;
    }
    indices.push(index);
    from = index + 1;
  }
  const [first] = indices;
  if (first === undefined) {
    return null;
  }
  if (indices.length === 1) {
    return first;
  }
  let nearest = first;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const index of indices) {
    const distance = Math.abs(content.slice(0, index).split("\n").length - line);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function splice(content: string, index: number, length: number, text: string): string {
  return content.slice(0, index) + text + content.slice(index + length);
}

/** Apply one hunk, verify the suite, and revert exactly that hunk when red. */
async function applyHunk(
  cwd: string,
  file: string,
  finding: Finding,
  edit: FindingEdit,
  content: string,
  runner: CommandRunner,
  testCommand: TestCommand,
): Promise<{ content: string; status: ApplyStatus; reason?: string }> {
  const index = locateHunk(content, edit, finding.line);
  if (index === null) {
    return {
      content,
      status: "skipped",
      reason: `edit anchor not found in ${file}`,
    };
  }

  const path = resolve(cwd, file);
  const applied = splice(content, index, edit.oldText.length, edit.newText);
  await writeFile(path, applied, "utf8");

  let code: number;
  try {
    code = (await runner(testCommand.command, testCommand.args, { cwd })).code;
  } catch {
    code = 1;
  }

  if (code === 0) {
    return { content: applied, status: "applied" };
  }

  // Revert only this hunk; every earlier hunk in the file stays applied.
  if (applied.slice(index, index + edit.newText.length) !== edit.newText) {
    throw new Error(`cannot revert ${finding.id}: the hunk changed under it`);
  }
  const reverted = splice(applied, index, edit.newText.length, edit.oldText);
  await writeFile(path, reverted, "utf8");
  return {
    content: reverted,
    status: "reverted",
    reason: "test suite was red; reverted this hunk",
  };
}

export async function applyFindings(input: ApplyInput): Promise<ApplyResult> {
  const decide = input.decide ?? ((finding) => finding.action ?? "ask");
  const resolved = input.findings.map((finding) => resolveAction(finding, decide));

  const hasApply = resolved.some((finding) => finding.action === "apply");
  let testCommand: TestCommand | null;
  if (input.testCommand !== undefined) {
    testCommand = input.testCommand;
  } else if (hasApply) {
    testCommand = await resolveTestCommand(input.cwd);
  } else {
    testCommand = null;
  }

  const reportOnly = hasApply && testCommand === null;
  const effective = reportOnly
    ? resolved.map((finding) => {
        if (finding.action !== "apply") {
          return finding;
        }
        return { ...finding, action: "skip" as const, reason: NO_SUITE_REASON };
      })
    : resolved;

  const outcomes = new Map<string, ApplyOutcome>();
  const batches: ApplyBatch[] = [];
  let applied = 0;
  let reverted = 0;
  let skipped = 0;

  for (const group of groupByFile(effective)) {
    let content: string | null = null;
    const batch: ApplyBatch = { file: group.file, outcomes: [] };

    for (const finding of group.findings) {
      if (finding.action !== "apply" || testCommand === null || !finding.edit) {
        const status: ApplyStatus = finding.action === "ask" ? "ask" : "skipped";
        if (status === "skipped") {
          skipped += 1;
        }
        const outcome = { finding, status };
        batch.outcomes.push(outcome);
        outcomes.set(finding.id, outcome);
        continue;
      }

      if (content === null) {
        try {
          content = await readFile(resolve(input.cwd, group.file), "utf8");
        } catch {
          const skippedFinding: Finding = {
            ...finding,
            action: "skip",
            reason: `file ${group.file} could not be read`,
          };
          skipped += 1;
          const outcome: ApplyOutcome = { finding: skippedFinding, status: "skipped" };
          batch.outcomes.push(outcome);
          outcomes.set(finding.id, outcome);
          continue;
        }
      }

      const result = await applyHunk(
        input.cwd,
        group.file,
        finding,
        finding.edit,
        content,
        input.runner,
        testCommand,
      );
      content = result.content;

      let outcomeFinding: Finding = finding;
      if (result.status === "reverted" || result.status === "skipped") {
        outcomeFinding = { ...finding, action: "skip", reason: result.reason };
      }
      if (result.status === "applied") {
        applied += 1;
      } else if (result.status === "reverted") {
        reverted += 1;
        skipped += 1;
      } else {
        skipped += 1;
      }
      const outcome: ApplyOutcome = { finding: outcomeFinding, status: result.status };
      batch.outcomes.push(outcome);
      outcomes.set(finding.id, outcome);
    }

    batches.push(batch);
  }

  return {
    testCommand,
    reportOnly,
    batches,
    findings: input.findings.map(
      (finding) => outcomes.get(finding.id)?.finding ?? finding,
    ),
    applied,
    reverted,
    skipped,
  };
}

export function renderApplyReport(result: ApplyResult): string {
  const lines: string[] = [];
  let suite = "none";
  if (result.testCommand) {
    suite = `${result.testCommand.command} ${result.testCommand.args.join(" ")}`.trim();
  }
  lines.push(
    `**Apply:** ${result.applied} applied, ${result.reverted} reverted, ${result.skipped} skipped (test command: ${suite})`,
  );
  if (result.reportOnly) {
    lines.push("", "Report-only: no test command resolved, so nothing was applied.");
  }
  for (const batch of result.batches) {
    const notable = batch.outcomes.filter(
      (outcome) => outcome.status !== "applied",
    );
    if (notable.length === 0) {
      continue;
    }
    lines.push("", `### ${batch.file}`);
    for (const outcome of notable) {
      const finding = outcome.finding;
      const reason = finding.reason ? `: ${finding.reason}` : "";
      lines.push(
        `- line ${finding.line} ${outcome.status} (${finding.rule})${reason}`,
      );
    }
  }
  return lines.join("\n");
}
