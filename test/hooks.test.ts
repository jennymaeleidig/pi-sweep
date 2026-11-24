import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateTest } from "../hooks/vitest-no-assertion/no-assertion.ts";

test("rejects a vitest test that finishes with no assertion", () => {
  const verdict = evaluateTest({ assertionCalls: 0 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /without any assertion/);
});

test("passes a vitest test that asserted", () => {
  assert.deepEqual(evaluateTest({ assertionCalls: 1 }), { ok: true });
});

test("leaves skipped, todo, and failed vitest tests alone", () => {
  assert.deepEqual(evaluateTest({ assertionCalls: 0, skipped: true }), { ok: true });
  assert.deepEqual(evaluateTest({ assertionCalls: 0, todo: true }), { ok: true });
  assert.deepEqual(evaluateTest({ assertionCalls: 0, failed: true }), { ok: true });
});

const python = process.env.PYTHON ?? "python3";
const checker = join(
  import.meta.dirname,
  "..",
  "hooks",
  "pytest-no-assertion",
  "no_assertion.py",
);

function pythonAvailable(): boolean {
  return spawnSync(python, ["--version"], { encoding: "utf8" }).error === undefined;
}

async function runChecker(
  source: string,
): Promise<ReturnType<typeof spawnSync>> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sweep-hook-"));
  try {
    const file = join(cwd, "test_example.py");
    await writeFile(file, source);
    return spawnSync(python, [checker, file], { encoding: "utf8" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("rejects a pytest test that finishes with no assertion", async (t) => {
  if (!pythonAvailable()) {
    t.skip(`${python} is not available`);
    return;
  }
  const result = await runChecker("def test_nothing():\n    value = 1 + 1\n");

  assert.equal(result.status, 1);
  assert.match(String(result.stderr), /test_nothing has no assertion/);
});

test("passes a pytest test that asserted", async (t) => {
  if (!pythonAvailable()) {
    t.skip(`${python} is not available`);
    return;
  }
  const result = await runChecker("def test_sum():\n    assert 1 + 1 == 2\n");

  assert.equal(result.status, 0, String(result.stderr));
});
