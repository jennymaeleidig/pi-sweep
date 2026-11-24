import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { detect } from "../src/adapters/jscpd.ts";
import { realCommandRunner, type CommandRunner } from "../src/exec.ts";

interface FakeClone {
  firstFile: { name: string; start: number; end: number };
  secondFile: { name: string; start: number; end: number };
  lines: number;
  tokens: number;
}

function fakeRunner(clones: FakeClone[]): CommandRunner {
  return async (_command, args) => {
    const outputIndex = args.indexOf("--output");
    const outputDir = args[outputIndex + 1];
    if (!outputDir) {
      throw new Error("missing --output");
    }
    await writeFile(
      join(outputDir, "jscpd-report.json"),
      JSON.stringify({ duplicates: clones }),
    );
    return { stdout: "", stderr: "", code: 0 };
  };
}

test("normalizes each duplicate into drafts for both files", async () => {
  const cwd = join(import.meta.dirname, "fixtures", "jscpd");
  const runner = fakeRunner([
    {
      firstFile: { name: join(cwd, "src", "a.ts"), start: 5, end: 9 },
      secondFile: { name: join(cwd, "src", "b.ts"), start: 12, end: 16 },
      lines: 5,
      tokens: 40,
    },
  ]);

  const drafts = await detect({
    files: ["src/a.ts", "src/b.ts"],
    cwd,
    runner,
  });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line]),
    [
      ["src/a.ts", 5],
      ["src/b.ts", 12],
    ],
  );
  for (const draft of drafts) {
    assert.equal(draft.detector, "jscpd");
    assert.equal(draft.rule, "duplicate-code");
    assert.equal(draft.category, "duplication");
    assert.deepEqual(draft.metrics, { tokens: 40, lines: 5 });
    assert.ok(draft.proposedFix);
  }
  assert.match(drafts[0]?.evidence ?? "", /duplicated with src\/b\.ts:12-16/);
  assert.match(drafts[1]?.evidence ?? "", /duplicated with src\/a\.ts:5-9/);
});

test("returns no drafts when no files are selected", async () => {
  const runner: CommandRunner = async () => {
    throw new Error("jscpd must not run for an empty selection");
  };

  assert.deepEqual(
    await detect({ files: [], cwd: join(import.meta.dirname, "fixtures", "jscpd"), runner }),
    [],
  );
});

test("fails the sweep when jscpd itself fails", async () => {
  const runner: CommandRunner = async () => ({
    stdout: "",
    stderr: "boom",
    code: 2,
  });

  await assert.rejects(
    detect({
      files: ["src/a.ts"],
      cwd: join(import.meta.dirname, "fixtures", "jscpd"),
      runner,
    }),
    /jscpd failed \(2\): boom/,
  );
});

test("normalizes real jscpd output against a fixture repo", async () => {
  const cwd = join(import.meta.dirname, "fixtures", "jscpd");

  const drafts = await detect({
    files: ["a.ts", "b.ts"],
    cwd,
    runner: realCommandRunner,
  });

  assert.ok(drafts.length > 0, "jscpd should report the duplicated block");
  assert.deepEqual(
    [...new Set(drafts.map((draft) => draft.file))].sort(),
    ["a.ts", "b.ts"],
  );
  for (const draft of drafts) {
    assert.equal(draft.detector, "jscpd");
    assert.equal(draft.rule, "duplicate-code");
    assert.ok(Number.isInteger(draft.line) && draft.line > 0);
    assert.match(draft.evidence, /duplicated with a\.ts|duplicated with b\.ts/);
  }
});
