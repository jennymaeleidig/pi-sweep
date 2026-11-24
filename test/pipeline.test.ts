import assert from "node:assert/strict";
import test from "node:test";
import type { Detector } from "../src/pipeline.ts";
import { runSweep } from "../src/pipeline.ts";
import { realCommandRunner } from "../src/exec.ts";
import { cleanup, commit, duplicateSource, git, tempRepo, write } from "./helpers.ts";

test("runs detectors over diff-selected files and groups the gate table", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  await write(cwd, "changed.ts", "export const changed = 1;\n");

  const seen: string[][] = [];
  const detector: Detector = {
    name: "stub",
    detect: async (input) => {
      seen.push(input.files);
      return [
        {
          file: "changed.ts",
          line: 2,
          rule: "stub-rule",
          evidence: "the stub saw a problem",
          detector: "stub",
          proposedFix: "do the stub fix",
        },
      ];
    },
  };

  const result = await runSweep({
    kind: "sweep",
    cwd,
    runner: realCommandRunner,
    base,
    detectors: [detector],
  });

  assert.deepEqual(seen, [["changed.ts"]]);
  assert.equal(result.report.mode, "diff");
  assert.deepEqual(result.report.files, ["changed.ts"]);
  assert.deepEqual(
    result.report.gate.files.map((group) => group.file),
    ["changed.ts"],
  );
  assert.equal(result.report.findings[0]?.tier, 2);
  assert.match(result.markdown, /the stub saw a problem/);
  assert.match(result.markdown, /do the stub fix/);
});

test("reports cleanly when detectors find nothing", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  const result = await runSweep({
    kind: "prose",
    cwd,
    runner: realCommandRunner,
    base,
    detectors: [{ name: "empty", detect: async () => [] }],
  });

  assert.deepEqual(result.report.findings, []);
  assert.match(result.markdown, /^No findings\./);
});

test("normalizes real jscpd findings end to end", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  await write(cwd, "a.ts", duplicateSource);
  await write(cwd, "b.ts", duplicateSource);

  const result = await runSweep({
    kind: "code",
    cwd,
    runner: realCommandRunner,
    base,
  });

  assert.ok(result.report.findings.length > 0);
  assert.deepEqual(
    [...new Set(result.report.findings.map((finding) => finding.file))].sort(),
    ["a.ts", "b.ts"],
  );
  assert.ok(result.report.findings.every((finding) => finding.tier === 1));
  assert.match(result.markdown, /### a\.ts/);
  assert.match(result.markdown, /duplicate-code/);
});
