import assert from "node:assert/strict";
import { utimes } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { realCommandRunner } from "../src/exec.ts";
import {
  loadMutationEvidence,
  mutationCleanFiles,
  parseMiseMutationTasks,
  parseMutationReport,
  type MutationEvidence,
} from "../src/mutation.ts";
import { runSweep } from "../src/pipeline.ts";
import { buildBehaviorAxis } from "../src/sweeps/test.ts";
import { cleanup, commit, tempRepo, write } from "./helpers.ts";

const STRYDER_REPORT = {
  files: {
    "src/math.ts": {
      mutants: [
        {
          id: "1",
          mutatorName: "ArithmeticOperator",
          status: "Survived",
          replacement: "-",
          location: { start: { line: 4, column: 3 } },
        },
        {
          id: "2",
          mutatorName: "BooleanLiteral",
          status: "Killed",
          location: { start: { line: 9, column: 1 } },
        },
      ],
    },
    "src/clean.ts": {
      mutants: [
        {
          id: "3",
          mutatorName: "StringLiteral",
          status: "Killed",
          location: { start: { line: 2, column: 1 } },
        },
      ],
    },
  },
};

async function mutationRepo(t: { after: (fn: () => Promise<void>) => void }) {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(
    cwd,
    "mise.toml",
    [
      "[tasks.mutation]",
      'run = "npx stryker run"',
      'env = { MUTATION_REPORT = "reports/mutation/mutation.json" }',
      "",
    ].join("\n"),
  );
  await write(cwd, "reports/mutation/mutation.json", JSON.stringify(STRYDER_REPORT));
  return cwd;
}

test("discovers mutation, mutation:*, and mutation-tagged mise tasks", () => {
  const tasks = parseMiseMutationTasks(
    [
      "[tasks.mutation]",
      'run = "npx stryker run"',
      "",
      '[tasks."mutation:py"]',
      'run = "mutmut run"',
      "",
      "[tasks.nightly]",
      'tags = ["mutation"]',
      'run = "cargo mutants"',
      "",
      "[tasks.test]",
      'run = "node --test"',
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    tasks.map((task) => task.name).sort(),
    ["mutation", "mutation:py", "nightly"],
  );
  assert.ok(tasks.every((task) => task.source === "mise"));
});

test("finds an inline mutation task under the tasks table", () => {
  const tasks = parseMiseMutationTasks(
    [
      "[tasks]",
      'mutation = "npx stryker run"',
      'test = "node --test"',
      "",
      "[env]",
      'MUTATION_REPORT = "out/mutation.json"',
      "",
    ].join("\n"),
  );

  assert.deepEqual(tasks.map((task) => task.name), ["mutation"]);
  assert.deepEqual(tasks[0]?.reportPaths, ["out/mutation.json"]);
});

test("reads a repo-declared mutation report path from mise", async (t: TestContext) => {
  const cwd = await mutationRepo(t);
  const evidence = await loadMutationEvidence({
    cwd,
    runner: realCommandRunner,
    latestChangeMs: 0,
  });

  assert.equal(evidence.status, "fresh");
  assert.equal(evidence.report?.tool, "stryker");
  assert.equal(evidence.findings.length, 1);
  assert.deepEqual(evidence.findings[0], {
    file: "src/math.ts",
    line: 4,
    rule: "mutation-survived",
    evidence: "ArithmeticOperator — Survived (-)",
    detector: "mutation",
    evidenceClass: "machine",
  });
  assert.deepEqual(evidence.cleanFiles, ["src/clean.ts"]);
});

test("ignores a stale mutation score instead of treating it as clean", async (t: TestContext) => {
  const cwd = await mutationRepo(t);
  const reportPath = `${cwd}/reports/mutation/mutation.json`;
  const old = new Date(Date.now() - 60_000);
  await utimes(reportPath, old, old);

  const evidence = await loadMutationEvidence({ cwd, runner: realCommandRunner });

  assert.equal(evidence.status, "stale");
  assert.match(evidence.reason ?? "", /older than the latest test or source change/);
  assert.deepEqual(evidence.findings, []);
  assert.deepEqual(evidence.cleanFiles, []);
  assert.deepEqual(mutationCleanFiles(evidence), []);
});

test("accepts a fresh report measured against the repository baseline", async (t: TestContext) => {
  const cwd = await mutationRepo(t);
  const evidence = await loadMutationEvidence({ cwd, runner: realCommandRunner });

  assert.equal(evidence.status, "fresh");
  assert.equal(evidence.findings.length, 1);
});

test("normalizes mutmut survivors and keeps covered killed files clean", () => {
  const parsed = parseMutationReport({
    mutants: {
      "app/service.py": [
        { line: 3, status: "survived", description: "replace return value" },
        { line: 8, status: "killed" },
      ],
      "app/clean.py": [{ line: 1, status: "killed" }],
    },
  });

  assert.equal(parsed?.tool, "mutmut");
  assert.deepEqual(parsed?.survivors, [
    {
      file: "app/service.py",
      line: 3,
      mutator: "replace return value",
      status: "survived",
    },
  ]);
});

test("normalizes cargo-mutants outcomes and reports surviving mutants", () => {
  const parsed = parseMutationReport([
    {
      scenario: {
        Mutant: {
          file: "src/lib.rs",
          name: "replace + with -",
          replacement: "-",
          span: { start: { line: 7, column: 5 } },
        },
      },
      summary: "Mutant survived",
    },
    {
      scenario: { Mutant: { file: "src/safe.rs", span: { start: { line: 2 } } } },
      summary: "Mutant killed",
    },
  ]);

  assert.equal(parsed?.tool, "cargo-mutants");
  assert.equal(parsed?.survivors.length, 1);
  assert.equal(parsed?.survivors[0]?.file, "src/lib.rs");
  assert.equal(parsed?.survivors[0]?.line, 7);
  assert.equal(parsed?.survivors[0]?.mutator, "replace + with -");
});

test("an unknown report shape yields no findings and no crash", async (t: TestContext) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "base.ts", "export const base = 1;\n");
  await write(cwd, "odd.json", JSON.stringify({ hello: "world" }));
  await commit(cwd, "base");

  const evidence = await loadMutationEvidence({
    cwd,
    runner: realCommandRunner,
    reportPath: "odd.json",
    latestChangeMs: 0,
  });

  assert.equal(evidence.status, "unknown-shape");
  assert.deepEqual(evidence.findings, []);
  assert.deepEqual(evidence.cleanFiles, []);
});

test("feeds surviving mutants to the gate as tier-1 evidence", async (t: TestContext) => {
  const cwd = await mutationRepo(t);

  const result = await runSweep({
    kind: "test",
    cwd,
    runner: realCommandRunner,
    base: "HEAD",
    detectors: [{ name: "stub", detect: async () => [] }],
    mutationLatestChangeMs: 0,
  });

  const finding = result.report.findings.find((entry) => entry.detector === "mutation");
  assert.equal(finding?.tier, 1);
  assert.equal(finding?.action, "ask");
  assert.equal(result.mutation?.status, "fresh");
});

test("exempts mutation-clean files from the behavior axis scope", async (t: TestContext) => {
  const cwd = await mutationRepo(t);
  const evidence: MutationEvidence = await loadMutationEvidence({
    cwd,
    runner: realCommandRunner,
    latestChangeMs: 0,
  });
  const clean = mutationCleanFiles(evidence);

  const axis = buildBehaviorAxis({
    files: ["src/math.ts", "src/clean.ts"],
    mutationClean: clean,
  });

  assert.deepEqual(clean, ["src/clean.ts"]);
  assert.deepEqual(axis.scope, ["src/math.ts"]);
  assert.deepEqual(axis.exemptions.mutationClean, ["src/clean.ts"]);
});

test("reports a stale score as unavailable without adding findings", async (t: TestContext) => {
  const cwd = await mutationRepo(t);

  const result = await runSweep({
    kind: "test",
    cwd,
    runner: realCommandRunner,
    base: "HEAD",
    detectors: [{ name: "stub", detect: async () => [] }],
    mutationLatestChangeMs: Date.now() + 60_000,
  });

  assert.ok(result.report.findings.every((entry) => entry.detector !== "mutation"));
  assert.equal(result.mutation?.status, "stale");
  assert.match(result.report.unavailable?.join("; ") ?? "", /mutation: .*older/);
});

test("a repository without mutation testing runs unchanged", async (t: TestContext) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");

  const result = await runSweep({
    kind: "test",
    cwd,
    runner: realCommandRunner,
    base: "HEAD",
    detectors: [{ name: "stub", detect: async () => [] }],
  });

  assert.deepEqual(result.report.findings, []);
  assert.equal(result.mutation, undefined);
  assert.equal(result.report.unavailable, undefined);
  assert.doesNotMatch(result.markdown, /mutation/i);
  assert.match(result.markdown, /^No findings\./);
});
