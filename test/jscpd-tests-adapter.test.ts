import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  TEST_DUPLICATION_MIN_LINES,
  TEST_DUPLICATION_MIN_TOKENS,
  detect,
} from "../src/adapters/jscpd-tests.ts";
import type { CommandRunner } from "../src/exec.ts";
import { isTestPath, selectTestFiles } from "../src/test-paths.ts";
import { cleanup, tempRepo } from "./helpers.ts";

test("recognizes test directories and test filenames as test paths", () => {
  for (const path of [
    "tests/auth.spec.ts",
    "test/helpers.ts",
    "src/__tests__/cart.tsx",
    "src/cart.test.ts",
    "src/cart.spec.jsx",
    "e2e/checkout.ts",
    "app/test_models.py",
    "app/models_test.py",
    "app/conftest.py",
  ]) {
    assert.equal(isTestPath(path), true, path);
  }

  for (const path of ["src/cart.ts", "src/latest.ts", "docs/testing.md", "app/models.py"]) {
    assert.equal(isTestPath(path), false, path);
  }
});

test("selects only test files from a mixed diff", () => {
  assert.deepEqual(
    selectTestFiles(["src/app.ts", "test/app.test.ts", "docs/testing.md"]),
    ["test/app.test.ts"],
  );
});

test("runs jscpd only over test files with tuned thresholds", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  const root = await realpath(cwd);

  let seen: string[] = [];
  const runner: CommandRunner = async (_command, args) => {
    seen = args;
    const outputIndex = args.indexOf("--output");
    const outputDir = args[outputIndex + 1];
    if (!outputDir) {
      throw new Error("missing --output");
    }
    await writeFile(
      join(outputDir, "jscpd-report.json"),
      JSON.stringify({
        duplicates: [
          {
            firstFile: { name: join(root, "test", "a.test.ts"), start: 4, end: 12 },
            secondFile: { name: join(root, "test", "b.test.ts"), start: 4, end: 12 },
            lines: 9,
            tokens: 120,
          },
        ],
      }),
    );
    return { stdout: "", stderr: "", code: 0 };
  };

  const drafts = await detect({
    files: ["src/app.ts", "test/a.test.ts", "test/b.test.ts"],
    cwd,
    runner,
  });

  assert.ok(seen.some((arg) => arg.endsWith(join("test", "a.test.ts"))));
  assert.ok(seen.some((arg) => arg.endsWith(join("test", "b.test.ts"))));
  assert.ok(!seen.some((arg) => arg.endsWith("src/app.ts")));
  assert.equal(seen[seen.indexOf("--min-tokens") + 1], String(TEST_DUPLICATION_MIN_TOKENS));
  assert.equal(seen[seen.indexOf("--min-lines") + 1], String(TEST_DUPLICATION_MIN_LINES));
  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line]),
    [
      ["test/a.test.ts", 4],
      ["test/b.test.ts", 4],
    ],
  );
});

test("does not invoke jscpd when the selection has no test files", async () => {
  const runner: CommandRunner = async () => {
    throw new Error("jscpd must not run without test files");
  };

  assert.deepEqual(
    await detect({ files: ["src/app.ts"], cwd: join(import.meta.dirname, "fixtures", "jscpd"), runner }),
    [],
  );
});
