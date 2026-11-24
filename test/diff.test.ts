import assert from "node:assert/strict";
import test from "node:test";
import { selectFiles, resolveBasepoint } from "../src/diff.ts";
import { realCommandRunner } from "../src/exec.ts";
import { cleanup, commit, git, tempRepo, write } from "./helpers.ts";

test("selects committed, uncommitted, and untracked changes in one sweep", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  await write(cwd, "committed.ts", "export const committed = 1;\n");
  await commit(cwd, "committed change");

  await write(cwd, "base.ts", "export const base = 2;\n");
  await write(cwd, "staged.ts", "export const staged = 1;\n");
  await git(cwd, ["add", "staged.ts"]);
  await write(cwd, "untracked.ts", "export const untracked = 1;\n");

  const selection = await selectFiles({ cwd, runner: realCommandRunner, base });

  assert.equal(selection.mode, "diff");
  assert.deepEqual(selection.files, [
    "base.ts",
    "committed.ts",
    "staged.ts",
    "untracked.ts",
  ]);
});

test("accepts a branch name as the basepoint", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await git(cwd, ["branch", "before"]);
  await write(cwd, "changed.ts", "export const changed = 1;\n");
  await commit(cwd, "changed");

  const selection = await selectFiles({ cwd, runner: realCommandRunner, base: "before" });

  assert.deepEqual(selection.files, ["changed.ts"]);
  assert.equal(selection.baseRef, "before");
});

test("accepts a tag as the basepoint", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await git(cwd, ["tag", "-a", "baseline", "-m", "baseline"]);
  await write(cwd, "changed.ts", "export const changed = 1;\n");
  await commit(cwd, "changed");

  const selection = await selectFiles({ cwd, runner: realCommandRunner, base: "baseline" });

  assert.deepEqual(selection.files, ["changed.ts"]);
});

test("resolves merge-base:<ref> to the branch point", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  const branchPoint = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  await git(cwd, ["checkout", "-q", "-b", "feature"]);
  await write(cwd, "feature.ts", "export const feature = 1;\n");
  await commit(cwd, "feature");

  await git(cwd, ["checkout", "-q", "main"]);
  await write(cwd, "main-only.ts", "export const mainOnly = 1;\n");
  await commit(cwd, "main only");
  await git(cwd, ["checkout", "-q", "feature"]);

  const resolved = await resolveBasepoint("merge-base:main", cwd, realCommandRunner);
  const selection = await selectFiles({
    cwd,
    runner: realCommandRunner,
    base: "merge-base:main",
  });

  assert.equal(resolved, branchPoint);
  assert.equal(selection.resolvedBase, branchPoint);
  assert.deepEqual(selection.files, ["feature.ts"]);
});

test("full audit selects tracked and untracked files", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "tracked.ts", "export const tracked = 1;\n");
  await commit(cwd, "tracked");
  await write(cwd, "untracked.ts", "export const untracked = 1;\n");

  const selection = await selectFiles({
    cwd,
    runner: realCommandRunner,
    fullAudit: true,
  });

  assert.equal(selection.mode, "full");
  assert.equal(selection.baseRef, null);
  assert.deepEqual(selection.files, ["tracked.ts", "untracked.ts"]);
});

test("selects the whole file when only one line changed", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  const original = Array.from({ length: 20 }, (_, index) => `export const line${index} = ${index};`).join("\n");
  await write(cwd, "src/module.ts", `${original}\n`);
  await commit(cwd, "module");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  await write(
    cwd,
    "src/module.ts",
    `${original.replace("line10 = 10", "line10 = 100")}\n`,
  );

  const selection = await selectFiles({ cwd, runner: realCommandRunner, base });

  assert.deepEqual(selection.files, ["src/module.ts"]);
});

test("records a rename's old path without sweeping the missing file", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "old-name.ts", "export const renamed = 1;\n");
  await commit(cwd, "before rename");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  await git(cwd, ["mv", "old-name.ts", "new-name.ts"]);
  await commit(cwd, "rename");

  const selection = await selectFiles({ cwd, runner: realCommandRunner, base });

  assert.deepEqual(selection.files, ["new-name.ts"]);
  assert.deepEqual(selection.renamedFrom, ["old-name.ts"]);
});

test("leaves deleted files out of the sweep", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "gone.ts", "export const gone = 1;\n");
  await write(cwd, "stays.ts", "export const stays = 1;\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  await git(cwd, ["rm", "-q", "gone.ts"]);
  await write(cwd, "stays.ts", "export const stays = 2;\n");

  const selection = await selectFiles({ cwd, runner: realCommandRunner, base });

  assert.deepEqual(selection.files, ["stays.ts"]);
});
