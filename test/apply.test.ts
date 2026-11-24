import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../src/contract.ts";
import {
  applyFindings,
  renderApplyReport,
  type ApplyResult,
} from "../src/apply.ts";
import type { CommandRunner } from "../src/exec.ts";
import type { TestCommand } from "../src/test-command.ts";
import { buildGateTable } from "../src/gate.ts";
import { runSweep } from "../src/pipeline.ts";
import { cleanup, commit, git, tempRepo, write } from "./helpers.ts";

const stubTestCommand: TestCommand = {
  command: "check",
  args: [],
  source: "manifest",
  detail: "stub suite",
};

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    file: "code.ts",
    line: 1,
    rule: "unused-symbol",
    evidence: "declared but never used",
    tier: 0,
    detector: "eslint",
    ...overrides,
  };
}

function runnerChecking(cwd: string, breaks: string): CommandRunner {
  return async (command) => {
    assert.equal(command, "check");
    const content = await readFile(join(cwd, "code.ts"), "utf8");
    return { stdout: "", stderr: "", code: content.includes(breaks) ? 1 : 0 };
  };
}

function statusOf(result: ApplyResult, id: string): string | undefined {
  return result.batches
    .flatMap((batch) => batch.outcomes)
    .find((outcome) => outcome.finding.id === id)?.status;
}

test("reverts only the failing hunk when the suite goes red", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "code.ts", "alpha\nbeta\ngamma\n");

  const result = await applyFindings({
    cwd,
    runner: runnerChecking(cwd, "beta-broken"),
    testCommand: stubTestCommand,
    findings: [
      finding({
        id: "good",
        line: 1,
        edit: { oldText: "alpha", newText: "alpha-fixed" },
      }),
      finding({
        id: "bad",
        line: 2,
        edit: { oldText: "beta", newText: "beta-broken" },
      }),
    ],
    decide: () => "apply",
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha-fixed\nbeta\ngamma\n");
  assert.equal(statusOf(result, "good"), "applied");
  assert.equal(statusOf(result, "bad"), "reverted");
  assert.equal(result.applied, 1);
  assert.equal(result.reverted, 1);
  assert.match(result.findings.find((f) => f.id === "bad")?.reason ?? "", /test/i);
});

test("degrades to report-only when no test command resolves", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "code.ts", "alpha\n");

  const result = await applyFindings({
    cwd,
    runner: async () => {
      throw new Error("the suite must not run without a resolved test command");
    },
    findings: [
      finding({ id: "only", edit: { oldText: "alpha", newText: "fixed" } }),
    ],
    decide: () => "apply",
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha\n");
  assert.equal(result.reportOnly, true);
  assert.equal(result.testCommand, null);
  const resolved = result.findings.find((f) => f.id === "only");
  assert.equal(resolved?.action, "skip");
  assert.match(resolved?.reason ?? "", /no test command/i);
  assert.equal(result.applied, 0);
});

test("batches applied edits per file so each diff stays local", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "code.ts", "one\ntwo\n");
  await write(cwd, "other.ts", "three\n");

  const result = await applyFindings({
    cwd,
    runner: async () => ({ stdout: "", stderr: "", code: 0 }),
    testCommand: stubTestCommand,
    findings: [
      finding({ id: "one", file: "code.ts", line: 1, edit: { oldText: "one", newText: "1" } }),
      finding({ id: "two", file: "code.ts", line: 2, edit: { oldText: "two", newText: "2" } }),
      finding({ id: "three", file: "other.ts", line: 1, edit: { oldText: "three", newText: "3" } }),
    ],
    decide: () => "apply",
  });

  assert.deepEqual(
    result.batches.map((batch) => batch.file),
    ["code.ts", "other.ts"],
  );
  assert.deepEqual(
    result.batches[0]?.outcomes.map((outcome) => outcome.finding.id),
    ["one", "two"],
  );
  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "1\n2\n");
  assert.equal(await readFile(join(cwd, "other.ts"), "utf8"), "3\n");
  assert.equal(result.applied, 3);
});

test("keeps skipped findings in the report with a one-line reason", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "code.ts", "alpha\n");

  const result = await applyFindings({
    cwd,
    runner: async () => ({ stdout: "", stderr: "", code: 0 }),
    testCommand: stubTestCommand,
    findings: [
      finding({ id: "exempt", action: "skip", reason: "exempt: generated file" }),
      finding({ id: "no-edit", action: "apply" }),
    ],
    decide: (entry) => entry.action ?? "ask",
  });

  const exempt = result.findings.find((f) => f.id === "exempt");
  const noEdit = result.findings.find((f) => f.id === "no-edit");
  assert.equal(exempt?.action, "skip");
  assert.equal(exempt?.reason, "exempt: generated file");
  assert.equal(noEdit?.action, "skip");
  assert.match(noEdit?.reason ?? "", /no structured edit/i);
  assert.equal(result.skipped, 2);
  assert.equal(buildGateTable(result.findings).files[0]?.file, "code.ts");
  assert.match(renderApplyReport(result), /exempt: generated file/);
});

test("asks findings the gate has not resolved and leaves their files alone", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "code.ts", "alpha\n");

  const result = await applyFindings({
    cwd,
    runner: async () => {
      throw new Error("ask findings must not run the suite");
    },
    testCommand: stubTestCommand,
    findings: [
      finding({ id: "review", action: "ask", edit: { oldText: "alpha", newText: "fixed" } }),
    ],
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "alpha\n");
  assert.equal(result.findings[0]?.action, "ask");
  assert.equal(result.applied, 0);
  assert.equal(result.reportOnly, false);
});

test("applies explicitly decided findings through the pipeline", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  await write(cwd, "code.ts", "alpha\n");

  const result = await runSweep({
    kind: "sweep",
    cwd,
    base,
    apply: true,
    decide: () => "apply",
    testCommand: stubTestCommand,
    runner: async (command) =>
      command === "git"
        ? { stdout: "", stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0 },
    detectors: [
      {
        name: "stub",
        detect: async () => [
          {
            file: "code.ts",
            line: 1,
            rule: "stub-rule",
            evidence: "the stub saw a problem",
            detector: "stub",
            edit: { oldText: "alpha", newText: "fixed" },
          },
        ],
      },
    ],
  });

  assert.equal(await readFile(join(cwd, "code.ts"), "utf8"), "fixed\n");
  assert.equal(result.report.findings[0]?.action, "apply");
  assert.equal(result.apply?.applied, 1);
  assert.match(result.markdown, /Apply:/);
});
