import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cleanup, commit, tempRepo, write, duplicateSource } from "./helpers.ts";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "..", "src", "cli.ts");

test("prints a JSON report and exits zero even when findings exist", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "a.ts", duplicateSource);
  await write(cwd, "b.ts", duplicateSource);

  const { stdout } = await exec(process.execPath, [cli, "code", "--json"], { cwd });
  const report = JSON.parse(stdout) as {
    mode: string;
    files: string[];
    findings: Array<{ rule: string; tier: number }>;
  };

  assert.equal(report.mode, "diff");
  assert.ok(report.files.includes("a.ts"));
  assert.ok(report.findings.some((finding) => finding.rule === "duplicate-code"));
  assert.ok(report.findings.every((finding) => finding.tier === 1));
});

test("prints the markdown gate table by default", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "a.ts", duplicateSource);
  await write(cwd, "b.ts", duplicateSource);

  const { stdout } = await exec(process.execPath, [cli, "code"], { cwd });

  assert.match(stdout, /### a\.ts/);
  assert.match(stdout, /\| Line \| Tier \| Rule \| Evidence \| Proposed fix \|/);
});

test("runs the umbrella when the sweep kind is named", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "a.ts", duplicateSource);
  await write(cwd, "b.ts", duplicateSource);

  const { stdout } = await exec(process.execPath, [cli, "sweep", "--json"], { cwd });
  const report = JSON.parse(stdout) as {
    sweeps: Record<string, { findings: Array<{ rule: string }> }>;
    findings: Array<{ rule: string; sweep?: string }>;
  };

  assert.deepEqual(Object.keys(report.sweeps), ["code", "test", "prose"]);
  assert.ok(report.findings.some((finding) => finding.rule === "duplicate-code"));
  assert.ok(report.findings.every((finding) => finding.sweep !== undefined));
});
