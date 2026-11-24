import type {
  Finding,
  FindingDraft,
  GateAction,
  GateFile,
  GateTable,
  Tier,
} from "./contract.ts";

/**
 * Tier 0 is an allowlist. It stays empty until a rule has a recorded
 * false-positive-free in-session history; everything below is machine-evidenced
 * Tier 1 or LLM-judgment Tier 2.
 */
const TIER_ZERO_RULES = new Set<string>();

export function tierForDraft(draft: FindingDraft): Tier {
  if (TIER_ZERO_RULES.has(draft.rule)) {
    return 0;
  }
  if (draft.detector === "jscpd") {
    return 1;
  }
  return 2;
}

export function actionForTier(tier: Tier): GateAction {
  return tier === 0 ? "apply" : "ask";
}

export function finalizeFindings(drafts: FindingDraft[]): Finding[] {
  const occurrences = new Map<string, number>();
  return drafts.map((draft) => {
    const identity = `${draft.detector}:${draft.rule}:${draft.file}:${draft.line}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const tier = tierForDraft(draft);
    return {
      ...draft,
      id: `${identity}#${occurrence}`,
      tier,
      action: actionForTier(tier),
    };
  });
}

export function groupByFile(findings: Finding[]): GateFile[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = groups.get(finding.file);
    if (group) {
      group.push(finding);
    } else {
      groups.set(finding.file, [finding]);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, entries]) => ({
      file,
      findings: entries.sort(
        (left, right) =>
          left.line - right.line ||
          left.rule.localeCompare(right.rule) ||
          left.id.localeCompare(right.id),
      ),
    }));
}

export function buildGateTable(findings: Finding[]): GateTable {
  const totals: Record<Tier, number> = { 0: 0, 1: 0, 2: 0 };
  for (const finding of findings) {
    totals[finding.tier] += 1;
  }
  return { files: groupByFile(findings), totals };
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderGateTable(table: GateTable): string {
  const lines: string[] = [];
  if (table.files.length === 0) {
    lines.push("No findings.");
  }
  for (const group of table.files) {
    lines.push(
      `### ${group.file}`,
      "",
      "| Line | Tier | Rule | Evidence | Proposed fix |",
      "| ---: | ---: | --- | --- | --- |",
    );
    for (const finding of group.findings) {
      lines.push(
        `| ${finding.line} | ${finding.tier} | ${cell(finding.rule)} | ${cell(
          finding.evidence,
        )} | ${cell(finding.proposedFix ?? "—")} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `**Totals:** Tier 0: ${table.totals[0]}, Tier 1: ${table.totals[1]}, Tier 2: ${table.totals[2]}`,
  );
  return lines.join("\n");
}
