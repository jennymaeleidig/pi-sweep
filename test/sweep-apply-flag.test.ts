import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseSweepArgs } from "../src/extension.ts";
import { cleanup, commit, duplicateSource, tempRepo, write } from "./helpers.ts";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "..", "src", "cli.ts");

test("accepts --apply on the extension command while defaulting to report-only", () => {
  assert.equal(parseSweepArgs("code --apply").apply, true);
  assert.equal(parseSweepArgs("code").apply, undefined);
});

test("accepts --apply on the cli and still exits zero with findings", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "a.ts", duplicateSource);
  await write(cwd, "b.ts", duplicateSource);

  const { stdout } = await exec(process.execPath, [cli, "code", "--apply", "--json"], { cwd });
  const report = JSON.parse(stdout) as { findings: Array<{ rule: string }> };

  assert.ok(report.findings.some((entry) => entry.rule === "duplicate-code"));
});
