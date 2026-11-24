import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestCommand } from "../src/test-command.ts";
import { write } from "./helpers.ts";

async function emptyRepo(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sweep-cmd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("resolves the declared mise task before manifest scripts", async (t) => {
  const cwd = await emptyRepo(t);
  await write(cwd, "mise.toml", '[tasks.test]\nrun = "node --test"\n');
  await write(cwd, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));

  const resolved = await resolveTestCommand(cwd);

  assert.deepEqual(resolved, {
    command: "mise",
    args: ["run", "test"],
    source: "mise",
    detail: "mise task test",
  });
});

test("resolves the package manifest test script when no mise task exists", async (t) => {
  const cwd = await emptyRepo(t);
  await write(cwd, "package.json", JSON.stringify({ scripts: { test: "vitest run" } }));

  const resolved = await resolveTestCommand(cwd);

  assert.equal(resolved?.command, "npm");
  assert.deepEqual(resolved?.args, ["run", "test"]);
  assert.equal(resolved?.source, "manifest");
});

test("falls back to the framework default when no test script is declared", async (t) => {
  const cwd = await emptyRepo(t);
  await write(
    cwd,
    "package.json",
    JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
  );

  const resolved = await resolveTestCommand(cwd);

  assert.equal(resolved?.source, "framework");
  assert.equal(resolved?.command, "mise");
  assert.deepEqual(resolved?.args, [
    "exec",
    "--",
    "npx",
    "--no-install",
    "vitest",
    "run",
  ]);
});

test("resolves no test command when the repo declares none", async (t) => {
  const cwd = await emptyRepo(t);

  assert.equal(await resolveTestCommand(cwd), null);
});
