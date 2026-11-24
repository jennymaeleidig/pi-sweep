import assert from "node:assert/strict";
import test from "node:test";
import { detectorsFor, runSweep } from "../src/pipeline.ts";
import { realCommandRunner } from "../src/exec.ts";
import { cleanup, commit, tempRepo, write } from "./helpers.ts";

test("wires linters, duplication, and zero-fanout into code sweeps", () => {
  assert.deepEqual(
    detectorsFor("code").map((detector) => detector.name),
    ["linters", "jscpd", "zero-fanout"],
  );
  assert.deepEqual(
    detectorsFor("test").map((detector) => detector.name),
    ["jscpd"],
  );
});

test("a code sweep without a lens client reports zero-fanout unavailable", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "changed.ts", "export function orphan() {}\n");

  const result = await runSweep({
    kind: "code",
    cwd,
    runner: realCommandRunner,
    detectors: detectorsFor("code"),
  });

  assert.deepEqual(result.report.unavailable, [
    "pi-lens module_report is unavailable",
  ]);
  assert.match(result.markdown, /pi-lens module_report is unavailable/);
});
