import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { detect } from "../src/adapters/linters.ts";
import { realCommandRunner, type CommandRunner } from "../src/exec.ts";
import { cleanup, tempRepo, write } from "./helpers.ts";

function tasks(names: Array<{ name: string; tags?: string[] }>): string {
  return JSON.stringify(names.map((task) => ({ ...task, tags: task.tags ?? [] })));
}

test("runs only declared lint tasks over the changed files", async () => {
  const cwd = join(import.meta.dirname, "fixtures", "jscpd");
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "mise" && args[0] === "tasks") {
      return { stdout: tasks([{ name: "lint" }, { name: "test" }]), stderr: "", code: 0 };
    }
    if (command === "mise" && args[0] === "run") {
      return {
        stdout: JSON.stringify([
          {
            filePath: join(cwd, "a.ts"),
            messages: [
              { ruleId: "no-unused-vars", line: 3, message: "'old' is never used" },
            ],
          },
        ]),
        stderr: "",
        code: 1,
      };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const drafts = await detect({ files: ["a.ts"], cwd, runner });

  assert.deepEqual(calls[0], ["mise", "tasks", "ls", "--json", "--no-global"]);
  assert.deepEqual(calls[1], ["mise", "run", "lint", "--", "a.ts"]);
  assert.deepEqual(drafts, [
    {
      file: "a.ts",
      line: 3,
      rule: "no-unused-vars",
      evidence: "'old' is never used",
      detector: "linter",
      category: "lint",
    },
  ]);
});

test("normalizes SARIF task output", async () => {
  const cwd = join(import.meta.dirname, "fixtures", "jscpd");
  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "tasks") {
      return { stdout: tasks([{ name: "lint:code", tags: ["lint"] }]), stderr: "", code: 0 };
    }
    return {
      stdout: JSON.stringify({
        runs: [
          {
            results: [
              {
                ruleId: "unused-symbol",
                message: { text: "'gone' is declared but never used" },
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "b.ts" },
                      region: { startLine: 8 },
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
      stderr: "",
      code: 0,
    };
  };

  const drafts = await detect({ files: ["b.ts"], cwd, runner });

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.file, "b.ts");
  assert.equal(drafts[0]?.line, 8);
  assert.equal(drafts[0]?.rule, "unused-symbol");
});

test("normalizes plain text linter output", async () => {
  const cwd = join(import.meta.dirname, "fixtures", "jscpd");
  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "tasks") {
      return { stdout: tasks([{ name: "lint" }]), stderr: "", code: 0 };
    }
    return {
      stdout: "a.ts:7:3: warning: remove the debugger statement [no-debugger]\n",
      stderr: "",
      code: 1,
    };
  };

  const drafts = await detect({ files: ["a.ts"], cwd, runner });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line, draft.rule]),
    [["a.ts", 7, "no-debugger"]],
  );
});

test("ignores lint findings outside the changed file selection", async () => {
  const cwd = join(import.meta.dirname, "fixtures", "jscpd");
  const runner: CommandRunner = async (_command, args) => {
    if (args[0] === "tasks") {
      return { stdout: tasks([{ name: "lint" }]), stderr: "", code: 0 };
    }
    return {
      stdout: "other.ts:1:1: warning: stale finding [no-debugger]\n",
      stderr: "",
      code: 1,
    };
  };

  assert.deepEqual(await detect({ files: ["a.ts"], cwd, runner }), []);
});

test("does not run anything when the repo declares no lint task", async () => {
  const cwd = join(import.meta.dirname, "fixtures", "jscpd");
  const calls: string[] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    return { stdout: tasks([{ name: "test" }]), stderr: "", code: 0 };
  };

  assert.deepEqual(await detect({ files: ["a.ts"], cwd, runner }), []);
  assert.deepEqual(calls, ["mise tasks ls --json --no-global"]);
});

test("runs a real declared mise lint task over a fixture repo", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(
    cwd,
    "mise.toml",
    '[tasks.lint]\ndescription = "fixture lint"\nrun = "node lint.mjs"\n',
  );
  await write(
    cwd,
    "lint.mjs",
    [
      "for (const file of process.argv.slice(2)) {",
      '  console.log(`${file}:2:1: unused import [no-unused-vars]`);',
      "}",
      "",
    ].join("\n"),
  );
  await write(cwd, "src/a.ts", "import { old } from './old.ts';\n");

  const drafts = await detect({
    files: ["src/a.ts"],
    cwd,
    runner: realCommandRunner,
  });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line, draft.rule, draft.evidence]),
    [["src/a.ts", 2, "no-unused-vars", "unused import [no-unused-vars]"]],
  );
});

test("normalizes a real compiler diagnostic from a declared mise lint task", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "mise.toml", '[tasks.lint]\nrun = "tsc --noEmit --pretty false"\n');
  await write(cwd, "src/a.ts", 'const count: number = "not a number";\n');

  const drafts = await detect({
    files: ["src/a.ts"],
    cwd,
    runner: realCommandRunner,
  });

  assert.deepEqual(
    drafts.map((draft) => [draft.file, draft.line, draft.rule]),
    [["src/a.ts", 1, "TS2322"]],
  );
  assert.match(drafts[0]?.evidence ?? "", /not assignable to type 'number'/);
});
