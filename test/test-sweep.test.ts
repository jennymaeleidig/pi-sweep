import assert from "node:assert/strict";
import test from "node:test";
import { detectorsFor, runSweep } from "../src/pipeline.ts";
import {
  BEHAVIOR_AXIS_RULES,
  axisScope,
  buildBehaviorAxis,
  buildExemptionManifest,
  jscpdCleanFiles,
  testDetectors,
} from "../src/sweeps/test.ts";
import { realCommandRunner } from "../src/exec.ts";
import { cleanup, commit, duplicateSource, git, tempRepo, write } from "./helpers.ts";

test("test kind wires assertion hygiene and test-scoped duplication", () => {
  assert.deepEqual(
    detectorsFor("test").map((detector) => detector.name),
    ["eslint-jest", "jscpd-tests", "no-assertion"],
  );
  assert.deepEqual(
    testDetectors().map((detector) => detector.name),
    ["eslint-jest", "jscpd-tests", "no-assertion"],
  );
  assert.equal(typeof testDetectors()[0]?.probe, "function");
});

test("exemption manifest unions mechanically-clean files", () => {
  const manifest = buildExemptionManifest({
    files: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    jscpdClean: ["test/b.test.ts", "test/a.test.ts"],
    mutationClean: ["test/a.test.ts", "test/c.test.ts"],
  });

  assert.deepEqual(manifest.jscpdClean, ["test/a.test.ts", "test/b.test.ts"]);
  assert.deepEqual(manifest.mutationClean, ["test/a.test.ts", "test/c.test.ts"]);
  assert.deepEqual(manifest.exempt, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
});

test("removes mechanically-clean files from the axis scope", () => {
  const axis = buildBehaviorAxis({
    files: ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    jscpdClean: ["test/a.test.ts"],
    mutationClean: ["test/b.test.ts"],
    baseRef: "main",
  });

  assert.deepEqual(axis.scope, ["test/c.test.ts"]);
  assert.deepEqual(axis.exemptions.exempt, ["test/a.test.ts", "test/b.test.ts"]);
  const scopeSection = axis.brief.match(/### Files in scope\n\n([\s\S]*?)\n\n### Exemption/)?.[1];
  assert.equal(scopeSection, "- test/c.test.ts");
  assert.match(axis.brief, /### Exemption manifest \(do not report these\)/);
  assert.match(axis.brief, /test\/a\.test\.ts/);
  assert.match(axis.brief, /mutation-clean: test\/b\.test\.ts/);
});

test("pastes every behavior-axis rule into the brief in full", () => {
  const axis = buildBehaviorAxis({ files: ["test/a.test.ts"], baseRef: "main" });

  for (const rule of BEHAVIOR_AXIS_RULES) {
    assert.ok(axis.brief.includes(rule), rule);
  }
  assert.match(axis.brief, /Review the test changes since `main`/);
});

test("derives jscpd-clean files from duplication findings", () => {
  const clean = jscpdCleanFiles(
    ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"],
    [{ file: "test/b.test.ts", detector: "jscpd-tests" }],
  );

  assert.deepEqual(clean, ["test/a.test.ts", "test/c.test.ts"]);
});

test("axisScope leaves an absent exemption list unchanged", () => {
  const manifest = buildExemptionManifest({ files: ["test/a.test.ts"] });

  assert.deepEqual(axisScope(["test/a.test.ts"], manifest), ["test/a.test.ts"]);
});

test("reports eslint-jest unavailable instead of clean when the repo has no ESLint", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  await write(cwd, "test/a.test.ts", duplicateSource);
  await write(cwd, "test/b.test.ts", duplicateSource);

  const result = await runSweep({
    kind: "test",
    cwd,
    runner: realCommandRunner,
    base,
  });

  const eslint = result.report.detectors?.find((detector) => detector.name === "eslint-jest");
  assert.equal(eslint?.available, false);
  assert.match(eslint?.reason ?? "", /no ESLint configuration/);
  assert.match(result.markdown, /eslint-jest: unavailable/);
  assert.ok(result.report.findings.every((finding) => finding.detector === "jscpd"));
  assert.ok(result.report.findings.every((finding) => finding.file.startsWith("test/")));
});
