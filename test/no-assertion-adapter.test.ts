import assert from "node:assert/strict";
import test from "node:test";
import { detect, hookStatus, MANAGED_MARKER } from "../src/adapters/no-assertion.ts";
import { runSweep } from "../src/pipeline.ts";
import { testDetectors } from "../src/sweeps/test.ts";
import { realCommandRunner } from "../src/exec.ts";
import { cleanup, commit, git, tempRepo, write } from "./helpers.ts";

test("flags a test block that never asserts", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(
    cwd,
    "test/empty.test.ts",
    "test('does nothing', () => {\n  const value = 1 + 1;\n});\n" +
      "it('asserts', () => {\n  expect(1 + 1).toBe(2);\n});\n",
  );

  const drafts = await detect({
    files: ["test/empty.test.ts"],
    cwd,
    runner: realCommandRunner,
  });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line, draft.rule]),
    [["test/empty.test.ts", 1, "no-assertion"]],
  );
});

test("flags a Python test that never asserts", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(
    cwd,
    "tests/test_math.py",
    "def test_nothing():\n    value = 1 + 1\n\ndef test_sum():\n    assert 1 + 1 == 2\n",
  );

  const drafts = await detect({
    files: ["tests/test_math.py"],
    cwd,
    runner: realCommandRunner,
  });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line, draft.rule]),
    [["tests/test_math.py", 1, "no-assertion"]],
  );
});

test("leaves a test with an assertion alone", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(
    cwd,
    "test/asserts.test.ts",
    "test('asserts', () => {\n  expect(add(1, 1)).toBe(2);\n});\n",
  );

  assert.deepEqual(
    await detect({
      files: ["test/asserts.test.ts"],
      cwd,
      runner: realCommandRunner,
    }),
    [],
  );
});

test("reports the managed hook as absent rather than clean", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "test/empty.test.ts", "test('empty', () => {});\n");

  assert.equal(hookStatus(cwd).available, false);

  const noAssertion = testDetectors().find((detector) => detector.name === "no-assertion");
  assert.ok(noAssertion?.unavailable);
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const result = await runSweep({
    kind: "test",
    cwd,
    runner: realCommandRunner,
    base,
    detectors: noAssertion ? [noAssertion] : [],
  });

  assert.match(result.report.unavailable?.join(" ") ?? "", /no-assertion hook is absent/);
});

test("recognizes an installed managed hook", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(
    cwd,
    "test/no-assertion/setup.ts",
    `// ${MANAGED_MARKER}: no-assertion hook\n`,
  );

  assert.equal(hookStatus(cwd).available, true);
});
