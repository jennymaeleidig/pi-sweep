import type {
  Finding,
  FindingDraft,
  GateAction,
  GateFile,
  GateTable,
  Tier,
} from "./contract.ts";

/** jscpd's own default minimum block size, and the Tier 0 duplicate threshold. */
export const DEFAULT_JSCPD_MIN_TOKENS = 50;

/**
 * Tier 0 is an allowlist of linter unused-symbol rules. Matching is exact on
 * the rule id or on its final path segment, so plugin prefixes such as
 * `@typescript-eslint/` and `unused-imports/` resolve to the same rule.
 */
const TIER_ZERO_RULES = new Set<string>([
  "no-unused-vars",
  "@typescript-eslint/no-unused-vars",
  "no-unused-imports",
  "unused-imports/no-unused-imports",
  "unused-imports/no-unused-vars",
  "no-unused-locals",
  "F401",
  "unused_variables",
  "dead_code",
]);

/** Only the repo-lint detector may reach Tier 0; agent-authored findings may not. */
const TIER_ZERO_DETECTOR = "linter";

/** Zero-fanout deletion candidates never auto-apply, however clean they look. */
const PERMANENT_TIER_ONE_DETECTORS = new Set<string>(["zero-fanout"]);
const PERMANENT_TIER_ONE_RULES = new Set<string>(["zero-fanout"]);

/** The one-line explanation shown when Tier 0 is gated instead of applied. */
export const TIER_ZERO_IN_SESSION_ONLY =
  "Tier 0 auto-applies only in an interactive session; outside it, confirm or rerun in pi";

/**
 * Tier decisions depend on measurements, and apply depends on where the sweep
 * runs. Interactive sessions may auto-apply Tier 0; CI never does.
 */
export interface GatePolicy {
  /** True only for an interactive pi session. Defaults to false. */
  interactive?: boolean;
  /** CI environments keep Tier 0 gated. Detected from `CI` when omitted. */
  ci?: boolean;
  /** jscpd duplicate size at or above which the block is machine-verified. */
  jscpdMinTokens?: number;
}

export interface GateOptions {
  policy?: GatePolicy;
}

export function isCiEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.CI;
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

/** Tier 0 auto-applies only inside an interactive session that is not CI. */
export function tierZeroMayApply(policy: GatePolicy = {}): boolean {
  return policy.interactive === true && policy.ci !== true;
}

function isAllowlistedRule(rule: string): boolean {
  if (TIER_ZERO_RULES.has(rule)) {
    return true;
  }
  const separator = rule.lastIndexOf("/");
  if (separator === -1) {
    return false;
  }
  return TIER_ZERO_RULES.has(rule.slice(separator + 1));
}

export function tierForDraft(draft: FindingDraft, policy: GatePolicy = {}): Tier {
  if (
    PERMANENT_TIER_ONE_DETECTORS.has(draft.detector) ||
    PERMANENT_TIER_ONE_RULES.has(draft.rule)
  ) {
    return 1;
  }
  if (draft.detector === TIER_ZERO_DETECTOR && isAllowlistedRule(draft.rule)) {
    return 0;
  }
  if (draft.detector === "jscpd" || draft.rule === "duplicate-code") {
    const minTokens = policy.jscpdMinTokens ?? DEFAULT_JSCPD_MIN_TOKENS;
    const tokens = draft.metrics?.tokens;
    if (typeof tokens === "number" && tokens >= minTokens) {
      return 0;
    }
    return 1;
  }
  return 2;
}

export function actionForTier(tier: Tier, autoApplyTierZero = true): GateAction {
  return tier === 0 && autoApplyTierZero ? "apply" : "ask";
}

export function finalizeFindings(
  drafts: FindingDraft[],
  options: GateOptions = {},
): Finding[] {
  const policy = options.policy ?? {};
  const mayApply = tierZeroMayApply(policy);
  const occurrences = new Map<string, number>();
  return drafts.map((draft) => {
    const identity = `${draft.detector}:${draft.rule}:${draft.file}:${draft.line}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const tier = tierForDraft(draft, policy);
    const action = actionForTier(tier, mayApply);
    const finding: Finding = {
      ...draft,
      id: `${identity}#${occurrence}`,
      tier,
      action,
    };
    if (tier === 0 && action !== "apply") {
      finding.reason = TIER_ZERO_IN_SESSION_ONLY;
    }
    return finding;
  });
}

/**
 * The apply engine's decision for a gate policy. Tier 0 applies only when the
 * policy allows it; every other tier waits for a human.
 */
export function decideForPolicy(
  policy: GatePolicy = {},
): (finding: Finding) => GateAction {
  const mayApply = tierZeroMayApply(policy);
  return (finding) => (finding.tier === 0 && mayApply ? "apply" : "ask");
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
