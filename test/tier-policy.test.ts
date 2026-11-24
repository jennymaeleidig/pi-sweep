import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Finding, FindingDraft } from "../src/contract.ts";
import {
  DEFAULT_JSCPD_MIN_TOKENS,
  TIER_ZERO_IN_SESSION_ONLY,
  decideForPolicy,
  finalizeFindings,
  isCiEnvironment,
  tierForDraft,
  tierZeroMayApply,
} from "../src/gate.ts";
import { isInteractiveSession } from "../src/extension.ts";
import { runSweep, type Detector } from "../src/pipeline.ts";
import { realCommandRunner, type CommandRunner } from "../src/exec.ts";
import type { TestCommand } from "../src/test-command.ts";
import { cleanup, commit, git, tempRepo, write } from "./helpers.ts";

const interactive = { interactive: true, ci: false };
const nonInteractive = { interactive: false, ci: false };

const stubTestCommand: TestCommand = {
  command: "check",
  args: [],
  source: "manifest",
  detail: "stub suite",
};

function linterDraft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    file: "code.ts",
    line: 1,
    rule: "no-unused-vars",
    evidence: "'unused' is declared but never used",
    detector: "linter",
    category: "lint",
    proposedFix: "Remove the unused symbol",
    edit: { oldText: "alpha", newText: "fixed" },
    ...overrides,
  };
}

function duplicateDraft(tokens: number): FindingDraft {
  return {
    file: "code.ts",
    line: 2,
    rule: "duplicate-code",
    evidence: "7 lines duplicated with other.ts:1-7",
    detector: "jscpd",
    category: "duplication",
    metrics: { tokens, lines: 7 },
  };
}

async function repoWithChangedFile(): Promise<string> {
  const cwd = await tempRepo();
  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "code.ts", "alpha\n");
  return cwd;
}

async function baseOf(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

/** Real git for diff selection, a stub suite that always passes. */
function sweepRunner(): CommandRunner {
  return async (command, args, options) =>
    command === "check"
      ? { stdout: "", stderr: "", code: 0 }
      : realCommandRunner(command, args, options);
}

function detectorReturning(drafts: FindingDraft[]): Detector {
  return { name: "stub", detect: async () => drafts };
}

test("allows Tier 0 to auto-apply only inside an interactive session", () => {
  assert.equal(tierZeroMayApply(interactive), true);
  assert.equal(tierZeroMayApply(nonInteractive), false);
  assert.equal(tierZeroMayApply({ interactive: true, ci: true }), false);
  assert.equal(tierZeroMayApply({}), false);

  assert.equal(isCiEnvironment({ CI: "true" }), true);
  assert.equal(isCiEnvironment({ CI: "1" }), true);
  assert.equal(isCiEnvironment({ CI: "false" }), false);
  assert.equal(isCiEnvironment({}), false);
});

test("treats a session as interactive only with a terminal UI outside CI", () => {
  assert.equal(isInteractiveSession({ hasUI: true }, {}), true);
  assert.equal(isInteractiveSession({ hasUI: false }, {}), false);
  assert.equal(isInteractiveSession({}, {}), false);
  assert.equal(isInteractiveSession({ hasUI: true }, { CI: "true" }), false);
});

test("routes allowlisted linter unused-symbol rules to Tier 0 across plugin prefixes", () => {
  for (const rule of [
    "no-unused-vars",
    "@typescript-eslint/no-unused-vars",
    "unused-imports/no-unused-imports",
    "unused-imports/no-unused-vars",
    "no-unused-locals",
    "F401",
    "unused_variables",
    "dead_code",
  ]) {
    assert.equal(
      tierForDraft(linterDraft({ rule }), interactive),
      0,
      `${rule} should be machine-verified`,
    );
  }
});

test("keeps unlisted and agent-authored rules out of Tier 0", () => {
  assert.equal(tierForDraft(linterDraft({ rule: "no-console" }), interactive), 2);
  assert.equal(
    tierForDraft(linterDraft({ detector: "agent:code", rule: "no-unused-vars" }), interactive),
    2,
  );
});

test("keeps zero-fanout findings gated even when their rule looks allowlisted", () => {
  const [finding] = finalizeFindings(
    [
      linterDraft({
        detector: "zero-fanout",
        rule: "no-unused-vars",
        evidence: "zero fanout for orphanHelper; string-grep found no references",
      }),
    ],
    { policy: interactive },
  );

  assert.equal(finding?.tier, 1);
  assert.equal(finding?.action, "ask");
});

test("puts jscpd duplicates at or above the token threshold in Tier 0", () => {
  assert.equal(tierForDraft(duplicateDraft(DEFAULT_JSCPD_MIN_TOKENS), interactive), 0);
  assert.equal(tierForDraft(duplicateDraft(DEFAULT_JSCPD_MIN_TOKENS + 10), interactive), 0);
  assert.equal(tierForDraft(duplicateDraft(20), interactive), 1);
  assert.equal(
    tierForDraft(duplicateDraft(60), { ...interactive, jscpdMinTokens: 100 }),
    1,
  );
});

test("gates Tier 0 with a one-line reason when the run is not interactive", () => {
  const [finding] = finalizeFindings([linterDraft()], { policy: nonInteractive });

  assert.equal(finding?.tier, 0);
  assert.equal(finding?.action, "ask");
  assert.equal(finding?.reason, TIER_ZERO_IN_SESSION_ONLY);

  const [interactiveFinding] = finalizeFindings([linterDraft()], { policy: interactive });
  assert.equal(interactiveFinding?.action, "apply");
  assert.equal(interactiveFinding?.reason, undefined);
});

test("decides Tier 0 apply only for a policy that allows it", () => {
  const [tierZero] = finalizeFindings([linterDraft()], { policy: interactive });
  const [tierOne] = finalizeFindings([duplicateDraft(20)], { policy: interactive });
  assert.ok(tierZero);
  assert.ok(tierOne);

  assert.equal(decideForPolicy(interactive)(tierZero), "apply");
  assert.equal(decideForPolicy(nonInteractive)(tierZero), "ask");
  assert.equal(decideForPolicy(interactive)(tierOne), "ask");
});

test("auto-applies Tier 0 findings in an interactive session", async (t) => {
  const cwd = await repoWithChangedFile();
  t.after(() => cleanup(cwd));

  const result = await runSweep({
    kind: "code",
    cwd,
    base: await baseOf(cwd),
    runner: sweepRunner(),
    apply: true,
    interactive: true,
    ci: false,
    testCommand: stubTestCommand,
    detectors: [detectorReturning([linterDraft()])],
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "fixed\n");
  assert.equal(result.apply?.applied, 1);
  assert.equal(result.report.findings[0]?.action, "apply");
});

test("Tier 1 findings wait for confirmation even in an interactive session", async (t) => {
  const cwd = await repoWithChangedFile();
  t.after(() => cleanup(cwd));

  const result = await runSweep({
    kind: "code",
    cwd,
    base: await baseOf(cwd),
    runner: sweepRunner(),
    apply: true,
    interactive: true,
    ci: false,
    testCommand: stubTestCommand,
    detectors: [
      detectorReturning([
        linterDraft({ detector: "zero-fanout", rule: "zero-fanout" }),
      ]),
    ],
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha\n");
  assert.equal(result.report.findings[0]?.tier, 1);
  assert.equal(result.report.findings[0]?.action, "ask");
});

test("Tier 2 findings wait for confirmation even in an interactive session", async (t) => {
  const cwd = await repoWithChangedFile();
  t.after(() => cleanup(cwd));

  const result = await runSweep({
    kind: "code",
    cwd,
    base: await baseOf(cwd),
    runner: sweepRunner(),
    apply: true,
    interactive: true,
    ci: false,
    testCommand: stubTestCommand,
    detectors: [
      detectorReturning([
        linterDraft({ detector: "agent:code", rule: "docs-vs-shipped-behavior" }),
      ]),
    ],
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha\n");
  assert.equal(result.report.findings[0]?.tier, 2);
  assert.equal(result.report.findings[0]?.action, "ask");
});

test("a non-interactive run never writes even when apply is requested", async (t) => {
  const cwd = await repoWithChangedFile();
  t.after(() => cleanup(cwd));

  const result = await runSweep({
    kind: "code",
    cwd,
    base: await baseOf(cwd),
    runner: sweepRunner(),
    apply: true,
    interactive: false,
    ci: false,
    testCommand: stubTestCommand,
    detectors: [detectorReturning([linterDraft()])],
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha\n");
  assert.equal(result.apply?.applied, 0);
  const finding = result.report.findings[0];
  assert.equal(finding?.action, "ask");
  assert.equal(finding?.reason, TIER_ZERO_IN_SESSION_ONLY);
});

test("CI keeps Tier 0 gated even when a session claims to be interactive", async (t) => {
  const cwd = await repoWithChangedFile();
  t.after(() => cleanup(cwd));

  const result = await runSweep({
    kind: "code",
    cwd,
    base: await baseOf(cwd),
    runner: sweepRunner(),
    apply: true,
    interactive: true,
    ci: true,
    testCommand: stubTestCommand,
    detectors: [detectorReturning([linterDraft()])],
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha\n");
  assert.equal(result.report.findings[0]?.action, "ask");
  assert.equal(result.apply?.applied, 0);
});

test("a jscpd duplicate below the token threshold waits as Tier 1", async (t) => {
  const cwd = await repoWithChangedFile();
  t.after(() => cleanup(cwd));

  const result = await runSweep({
    kind: "code",
    cwd,
    base: await baseOf(cwd),
    runner: sweepRunner(),
    apply: true,
    interactive: true,
    ci: false,
    testCommand: stubTestCommand,
    detectors: [detectorReturning([duplicateDraft(20)])],
  });

  const finding: Finding | undefined = result.report.findings[0];
  assert.equal(finding?.tier, 1);
  assert.equal(finding?.action, "ask");
  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha\n");
});
