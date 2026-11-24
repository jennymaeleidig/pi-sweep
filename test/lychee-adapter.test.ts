import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { detect } from "../src/adapters/lychee.ts";
import { realCommandRunner, type CommandRunner } from "../src/exec.ts";

const fixture = join(import.meta.dirname, "fixtures", "prose");

function fakeRunner(
  report: unknown,
  seen: string[][] = [],
): CommandRunner {
  return async (_command, args) => {
    seen.push(args);
    return { stdout: JSON.stringify(report), stderr: "", code: 2 };
  };
}

test("normalizes file and fragment failures into relative-path drafts", async () => {
  const seen: string[][] = [];
  const runner = fakeRunner(
    {
      error_map: {
        [join(fixture, "guide.md")]: [
          {
            url: "file:///tmp/missing.md",
            status: { text: "File not found. Check if file exists and path is correct" },
            span: { line: 3, column: 62 },
          },
          {
            url: "file:///tmp/guide.md#absent",
            status: { text: "Cannot find fragment" },
            span: { line: 5, column: 8 },
          },
        ],
      },
    },
    seen,
  );

  const drafts = await detect({ files: ["guide.md"], cwd: fixture, runner });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line, draft.rule]),
    [
      ["guide.md", 3, "broken-path"],
      ["guide.md", 5, "broken-anchor"],
    ],
  );
  for (const draft of drafts) {
    assert.equal(draft.detector, "lychee");
    assert.equal(draft.category, "references");
    assert.ok(draft.proposedFix);
  }
  assert.ok(seen[0]?.includes("--offline"), "lychee must run offline");
  assert.match(seen[0]?.join(" ") ?? "", /--include-fragments=anchor-only/);
});

test("skips excluded prose paths and never invokes lychee for an empty set", async () => {
  const runner: CommandRunner = async () => {
    throw new Error("lychee must not run when nothing is selected");
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

test("fails the sweep when lychee itself fails", async () => {
  const runner: CommandRunner = async () => ({ stdout: "", stderr: "boom", code: 1 });

  await assert.rejects(
    detect({ files: ["guide.md"], cwd: fixture, runner }),
    /lychee failed \(1\): boom/,
  );
});

test("normalizes real offline lychee output against a fixture repo", async () => {
  const drafts = await detect({
    files: ["guide.md", "notes/topic.md", "docs/adr/0001-decision.md", "vendor/lib.md"],
    cwd: fixture,
    runner: realCommandRunner,
  });

  assert.deepEqual(
    [...new Set(drafts.map((draft) => draft.file))],
    ["guide.md"],
  );
  assert.deepEqual(
    [...new Set(drafts.map((draft) => draft.rule))].sort(),
    ["broken-anchor", "broken-path"],
  );
  assert.ok(
    drafts.every((draft) => !draft.evidence.includes("example.com")),
    "external URLs must be excluded, not checked",
  );
});
