import type { Detector } from "../pipeline.ts";
import { detect as detectJscpdTests } from "../adapters/jscpd-tests.ts";
import {
  detect as detectEslintJest,
  probe as probeEslintJest,
} from "../adapters/eslint-jest.ts";
import {
  detect as detectNoAssertion,
  hookStatus,
} from "../adapters/no-assertion.ts";

const eslintJestDetector: Detector = {
  name: "eslint-jest",
  probe: (input) => probeEslintJest(input),
  detect: (input) => detectEslintJest(input),
};

const jscpdTestsDetector: Detector = {
  name: "jscpd-tests",
  detect: (input) => detectJscpdTests(input),
};

const noAssertionDetector: Detector = {
  name: "no-assertion",
  detect: (input) => detectNoAssertion(input),
  async unavailable(input) {
    const status = hookStatus(input.cwd);
    return status.available ? [] : [status.reason ?? "managed no-assertion hook is absent"];
  },
};

/** Assertion hygiene first, then duplication scoped to the test directories. */
export function testDetectors(): Detector[] {
  return [eslintJestDetector, jscpdTestsDetector, noAssertionDetector];
}

export interface ExemptionInput {
  /** Files the axis would otherwise judge. */
  files: string[];
  /** Test files jscpd found no duplicates in. */
  jscpdClean?: string[];
  /** Files a fresh mutation score found no surviving mutants in. */
  mutationClean?: string[];
}

export interface ExemptionManifest {
  jscpdClean: string[];
  mutationClean: string[];
  /** Every mechanically-clean file, de-duplicated. */
  exempt: string[];
}

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

export function buildExemptionManifest(input: ExemptionInput): ExemptionManifest {
  const jscpdClean = sortedUnique(input.jscpdClean);
  const mutationClean = sortedUnique(input.mutationClean);
  return {
    jscpdClean,
    mutationClean,
    exempt: sortedUnique([...jscpdClean, ...mutationClean]),
  };
}

/** Drop mechanically-clean files so the axis judges only what tools cannot. */
export function axisScope(files: string[], manifest: ExemptionManifest): string[] {
  const exempt = new Set(manifest.exempt);
  return [...new Set(files)].filter((file) => !exempt.has(file)).sort();
}

export function jscpdCleanFiles(
  files: string[],
  findings: Array<{ file: string; detector: string }>,
): string[] {
  const duplicated = new Set(
    findings
      .filter((finding) => finding.detector === "jscpd" || finding.detector === "jscpd-tests")
      .map((finding) => finding.file),
  );
  return sortedUnique(files.filter((file) => !duplicated.has(file)));
}

export const BEHAVIOR_AXIS_RULES = [
  "Behavior vs implementation: flag a test whose assertions mirror the implementation instead of a known-good literal or worked example. Test names, helper names, and snapshots derived from the implementation are evidence.",
  "Tautology: flag an assertion that recomputes the expected value the way the production code does, so it can never disagree with the code.",
  "Mock echo: flag a test whose only assertion restates what a mock was told to return, or whose mocks replace the collaborator under test.",
  "Behavioral redundancy: flag permutations of the same case that exercise identical inputs and outcomes, or several tests that cannot fail independently.",
  "Missing behavior: flag a test that only checks a call happened, a value exists, or the code did not throw, where a user-visible outcome is available to assert.",
  "Weak matchers: flag generic truthiness or snapshot-only assertions where a specific value, error, or state transition is observable.",
  "Do not flag style, coverage, test names, or anything already proven by a deterministic detector or listed in the exemption manifest.",
] as const;

export interface BehaviorAxisInput extends ExemptionInput {
  baseRef?: string;
}

export interface BehaviorAxis {
  axis: "behavior-vs-implementation";
  scope: string[];
  exemptions: ExemptionManifest;
  brief: string;
}

export function renderBehaviorAxisBrief(axis: BehaviorAxis, baseRef?: string): string {
  const lines: string[] = [
    "## Axis: behavior vs implementation, behavioral redundancy",
    "",
    baseRef
      ? `Review the test changes since \`${baseRef}\` and judge only the files in scope.`
      : "Review the test changes and judge only the files in scope.",
    "",
    "Report findings as one row per issue: `file:line | rule | evidence | proposed test-only fix`. Return `No findings.` when nothing survives the rules.",
    "",
    "### Files in scope",
    "",
    ...(axis.scope.length > 0 ? axis.scope.map((file) => `- ${file}`) : ["- (none)"]),
    "",
    "### Exemption manifest (do not report these)",
    "",
    ...(axis.exemptions.exempt.length > 0
      ? axis.exemptions.exempt.map((file) => `- ${file}`)
      : ["- (none)"]),
    "",
    `jscpd-clean: ${axis.exemptions.jscpdClean.join(", ") || "(none)"}`,
    `mutation-clean: ${axis.exemptions.mutationClean.join(", ") || "(none)"}`,
    "",
    "### Rules",
    "",
    ...BEHAVIOR_AXIS_RULES.map((rule, index) => `${index + 1}. ${rule}`),
  ];
  return lines.join("\n");
}

/** Build the single test axis: scope minus mechanical exemptions, plus the full brief. */
export function buildBehaviorAxis(input: BehaviorAxisInput): BehaviorAxis {
  const exemptions = buildExemptionManifest(input);
  const axis = {
    axis: "behavior-vs-implementation" as const,
    scope: axisScope(input.files, exemptions),
    exemptions,
    brief: "",
  };
  axis.brief = renderBehaviorAxisBrief(axis, input.baseRef);
  return axis;
}
