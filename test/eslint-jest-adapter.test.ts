import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  TOOL_VERSIONS,
  buildEslintConfigSource,
  checkSetup,
  detect,
  probe,
} from "../src/adapters/eslint-jest.ts";
import type { CommandRunner } from "../src/exec.ts";
import { cleanup, tempRepo, write } from "./helpers.ts";

function eslintJson(cwd: string, messages: Array<Record<string, unknown>>): string {
  return JSON.stringify([
    {
      filePath: join(cwd, "test", "checkout.test.ts"),
      messages,
    },
  ]);
}

function fakeRunner(stdout: string): CommandRunner {
  return async () => ({ stdout, stderr: "", code: 0 });
}

test("maps assertion-hygiene rule ids to finding drafts", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "package.json", JSON.stringify({ devDependencies: { eslint: "9.39.5" } }));

  const runner = fakeRunner(
    eslintJson(cwd, [
      {
        ruleId: "jest/expect-expect",
        line: 7,
        message: "Test has no assertions",
        severity: 2,
      },
      {
        ruleId: "testing-library/no-debug",
        line: 12,
        message: "Unexpected debug()",
        severity: 2,
      },
      {
        ruleId: "jest/no-focused-tests",
        line: 3,
        message: "Focused test",
        severity: 2,
      },
      { ruleId: "no-unused-vars", line: 1, message: "ignored", severity: 2 },
      { ruleId: null, line: 1, message: "parse problem", severity: 2 },
    ]),
  );

  const drafts = await detect({
    files: ["test/checkout.test.ts"],
    cwd,
    runner,
    configPath: join(cwd, "eslint.config.mjs"),
  });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line, draft.rule]),
    [
      ["test/checkout.test.ts", 7, "expect-expect"],
      ["test/checkout.test.ts", 12, "no-debug"],
      ["test/checkout.test.ts", 3, "no-focused-tests"],
    ],
  );
  for (const draft of drafts) {
    assert.equal(draft.detector, "eslint-jest");
    assert.equal(draft.category, "assertion-hygiene");
  }
  assert.equal(drafts[0]?.evidence, "Test has no assertions");
});

test("reports unavailable when the project has no ESLint setup", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "test/checkout.test.ts", "test('x', () => expect(1).toBe(1));\n");

  const availability = checkSetup({ files: ["test/checkout.test.ts"], cwd });

  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /no ESLint configuration or dependency/);
});

test("reports unavailable when no JavaScript or TypeScript test file is selected", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "package.json", JSON.stringify({ devDependencies: { eslint: "9.39.5" } }));

  const availability = checkSetup({ files: ["src/app.ts", "tests/test_app.py"], cwd });

  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /no JavaScript or TypeScript test files/);
});

test("probe reports unavailable when the eslint executable cannot start", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "package.json", JSON.stringify({ devDependencies: { eslint: "9.39.5" } }));

  const runner: CommandRunner = async () => {
    throw new Error("spawn eslint ENOENT");
  };

  const availability = await probe({ files: ["test/checkout.test.ts"], cwd, runner });

  assert.equal(availability.available, false);
  assert.match(availability.reason ?? "", /ENOENT/);
});

test("refuses to report clean when used while unavailable", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));
  await write(cwd, "test/checkout.test.ts", "test('x', () => expect(1).toBe(1));\n");

  await assert.rejects(
    detect({ files: ["test/checkout.test.ts"], cwd, runner: fakeRunner("[]") }),
    /eslint-jest unavailable: no ESLint configuration/,
  );
});

test("generates a flat config that enables each mapped rule", () => {
  const source = buildEslintConfigSource();

  for (const rule of [
    "jest/expect-expect",
    "jest/no-conditional-expect",
    "jest/no-focused-tests",
    "jest/no-disabled-tests",
    "jest/valid-expect",
    "testing-library/no-container",
    "testing-library/no-node-access",
    "testing-library/no-debug",
  ]) {
    assert.match(source, new RegExp(`"${rule.replace("/", "\\/")}"`));
  }
});

test("keeps the declared tool versions in sync with mise.toml", async () => {
  const mise = await readFile(join(import.meta.dirname, "..", "mise.toml"), "utf8");

  for (const [name, version] of Object.entries(TOOL_VERSIONS)) {
    assert.ok(version.length > 0, `${name} has a pinned version`);
    assert.match(mise, new RegExp(`"npm:[^"]+" = "${version}"`));
  }
});
