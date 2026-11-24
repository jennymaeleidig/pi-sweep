import assert from "node:assert/strict";
import test from "node:test";
import sweepExtension, {
  parseSweepArgs,
  type SweepCommandContext,
  type SweepHost,
} from "../src/extension.ts";
import { realCommandRunner } from "../src/exec.ts";
import { cleanup, commit, duplicateSource, tempRepo, write } from "./helpers.ts";

test("parses a sweep kind, basepoint, and full-audit flag", () => {
  assert.deepEqual(parseSweepArgs("code --base merge-base:main"), {
    kind: "code",
    base: "merge-base:main",
    fullAudit: false,
  });
  assert.deepEqual(parseSweepArgs("--full-audit prose"), {
    kind: "prose",
    base: undefined,
    fullAudit: true,
  });
  assert.throws(() => parseSweepArgs("--base"), /--base needs a ref/);
});

test("registers a command that reports findings through the pipeline", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "a.ts", duplicateSource);
  await write(cwd, "b.ts", duplicateSource);

  let registered:
    | {
        name: string;
        handler: (args: string, ctx: SweepCommandContext) => Promise<void> | void;
      }
    | undefined;

  const pi: SweepHost = {
    exec: (command, args, options) => realCommandRunner(command, args, options),
    registerCommand: (name, options) => {
      registered = { name, handler: options.handler };
    },
  };

  sweepExtension(pi);

  assert.equal(registered?.name, "sweep-report");
  const notices: string[] = [];
  await registered?.handler("sweep", {
    cwd,
    ui: { notify: (message) => notices.push(message) },
  });

  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /duplicate-code/);
});

test("uses the host module report bridge for zero-fanout findings", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "orphan.ts", "export function orphanHelper() {\n  return 1;\n}\n");

  let registered:
    | {
        name: string;
        handler: (args: string, ctx: SweepCommandContext) => Promise<void> | void;
      }
    | undefined;

  const pi: SweepHost = {
    exec: (command, args, options) => realCommandRunner(command, args, options),
    registerCommand: (name, options) => {
      registered = { name, handler: options.handler };
    },
    moduleReport: async (file) => {
      if (file !== "orphan.ts") {
        return null;
      }
      return {
        available: true,
        api: [
          {
            name: "orphanHelper",
            kind: "function",
            startLine: 1,
            usedBy: [],
            fanout: 0,
          },
        ],
      };
    },
  };

  sweepExtension(pi);

  const notices: string[] = [];
  await registered?.handler("code", {
    cwd,
    ui: { notify: (message) => notices.push(message) },
  });

  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /zero-fanout/);
  assert.match(notices[0] ?? "", /orphanHelper/);
});
