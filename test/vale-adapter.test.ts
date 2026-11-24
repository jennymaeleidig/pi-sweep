import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { detect } from "../src/adapters/vale.ts";
import { realCommandRunner, type CommandRunner } from "../src/exec.ts";

const fixture = join(import.meta.dirname, "fixtures", "prose");

function fakeRunner(report: unknown, seen: string[][] = []): CommandRunner {
  return async (_command, args) => {
    seen.push(args);
    return { stdout: JSON.stringify(report), stderr: "", code: 1 };
  };
}

test("normalizes vale alerts into drafts with rule, line, and match", async () => {
  const seen: string[][] = [];
  const runner = fakeRunner(
    {
      "guide.md": [
        {
          Check: "SlopWords.Banned",
          Message: "Banned word 'delve'; cut it or name the concrete thing.",
          Severity: "error",
          Match: "delve",
          Line: 10,
          Span: [4, 8],
          Suggestions: [],
        },
      ],
    },
    seen,
  );

  const drafts = await detect({ files: ["guide.md"], cwd: fixture, runner });

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.file, "guide.md");
  assert.equal(drafts[0]?.line, 10);
  assert.equal(drafts[0]?.rule, "SlopWords.Banned");
  assert.equal(drafts[0]?.detector, "vale");
  assert.equal(drafts[0]?.category, "slop");
  assert.match(drafts[0]?.evidence ?? "", /^Banned word 'delve'.*\("delve"\)$/);

  const args = seen[0] ?? [];
  assert.ok(args.includes("--no-global"), "vale must not load global styles");
  assert.match(args.join(" "), /--config .*vale\/\.vale\.ini/);
});

test("skips excluded prose paths and never invokes vale for an empty set", async () => {
  const runner: CommandRunner = async () => {
    throw new Error("vale must not run when nothing is selected");
  };

  assert.deepEqual(
    await detect({
      files: ["docs/adr/0001-decision.md", "vendor/lib.md", "script.ts"],
      cwd: fixture,
      runner,
    }),
    [],
  );
});

test("fails the sweep when vale itself fails", async () => {
  const runner: CommandRunner = async () => ({ stdout: "", stderr: "boom", code: 2 });

  await assert.rejects(
    detect({ files: ["guide.md"], cwd: fixture, runner }),
    /vale failed \(2\): boom/,
  );
});

test("normalizes real vale output against the bundled SlopWords pack", async () => {
  const drafts = await detect({
    files: ["guide.md", "notes/topic.md", "docs/adr/0001-decision.md", "vendor/lib.md"],
    cwd: fixture,
    runner: realCommandRunner,
  });

  assert.deepEqual([...new Set(drafts.map((draft) => draft.file))], ["guide.md"]);
  assert.ok(drafts.some((draft) => draft.rule === "SlopWords.Banned"));
  assert.ok(
    drafts.some(
      (draft) => draft.rule === "SlopWords.EmptyPhrases" || draft.rule === "SlopWords.Patterns",
    ),
  );
  assert.ok(drafts.every((draft) => Number.isInteger(draft.line) && draft.line > 0));
});
