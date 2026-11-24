import assert from "node:assert/strict";
import test from "node:test";
import {
  detect,
  detectZeroFanout,
  type LensClient,
  type ModuleReport,
} from "../src/adapters/zero-fanout.ts";
import type { CommandRunner } from "../src/exec.ts";

const cwd = "/repo";

function lensReturning(report: ModuleReport | null): LensClient {
  return { moduleReport: async () => report };
}

function grepRunner(output: string, code = 0): CommandRunner {
  return async (command) => {
    assert.equal(command, "git");
    return { stdout: output, stderr: "", code };
  };
}

test("drafts a zero-fanout symbol and quotes its registry grep hit", async () => {
  const report: ModuleReport = {
    available: true,
    api: [
      {
        name: "orphanHelper",
        kind: "function",
        startLine: 4,
        usedBy: [],
        fanout: 0,
      },
    ],
  };
  const runner = grepRunner(
    [
      "src/orphan.ts:4:export function orphanHelper() {}",
      'src/registry.ts:12:  registry.set("orphanHelper", orphanHelper);',
    ].join("\n"),
  );

  const result = await detectZeroFanout({
    files: ["src/orphan.ts"],
    cwd,
    runner,
    lens: lensReturning(report),
  });

  assert.equal(result.available, true);
  assert.equal(result.drafts.length, 1);
  const draft = result.drafts[0];
  assert.equal(draft?.file, "src/orphan.ts");
  assert.equal(draft?.line, 4);
  assert.equal(draft?.rule, "zero-fanout");
  assert.equal(draft?.detector, "zero-fanout");
  assert.match(draft?.evidence ?? "", /registry\.ts:12/);
  assert.match(draft?.evidence ?? "", /registry\.set\("orphanHelper"/);
  assert.doesNotMatch(draft?.evidence ?? "", /orphan\.ts:4/);
});

test("does not draft a symbol the graph says is referenced", async () => {
  const report: ModuleReport = {
    available: true,
    api: [
      {
        name: "usedHelper",
        startLine: 2,
        usedBy: [{ file: "src/a.ts", line: 9, relation: "calls" }],
        fanout: 0,
      },
      {
        name: "fanoutHelper",
        startLine: 7,
        usedBy: [],
        fanout: 3,
      },
    ],
  };
  let grepCalls = 0;
  const runner: CommandRunner = async () => {
    grepCalls += 1;
    return { stdout: "", stderr: "", code: 1 };
  };

  const drafts = await detect({
    files: ["src/a.ts"],
    cwd,
    runner,
    lens: lensReturning(report),
  });

  assert.deepEqual(drafts, []);
  assert.equal(grepCalls, 0);
});

test("reports zero-fanout unavailable when no lens client is wired", async () => {
  const result = await detectZeroFanout({
    files: ["src/a.ts"],
    cwd,
    runner: grepRunner(""),
  });

  assert.equal(result.available, false);
  assert.deepEqual(result.drafts, []);
  assert.match(result.reason ?? "", /pi-lens module_report is unavailable/);
});

test("reports zero-fanout unavailable when the module report is missing", async () => {
  const result = await detectZeroFanout({
    files: ["src/a.ts"],
    cwd,
    runner: grepRunner(""),
    lens: lensReturning(null),
  });

  assert.equal(result.available, false);
  assert.match(result.reason ?? "", /module_report unavailable for src\/a\.ts/);
});

test("withholds a draft when string-grep corroboration cannot run", async () => {
  const result = await detectZeroFanout({
    files: ["src/a.ts"],
    cwd,
    runner: async () => ({ stdout: "", stderr: "not a git repository", code: 128 }),
    lens: lensReturning({
      available: true,
      internal: [{ name: "orphanHelper", startLine: 3, usedBy: [], fanout: 0 }],
    }),
  });

  assert.deepEqual(result.drafts, []);
  assert.equal(result.available, false);
  assert.match(result.reason ?? "", /string-grep could not corroborate orphanHelper/);
});

test("quotes an explicit no-hit corroboration when grep finds nothing", async () => {
  const result = await detectZeroFanout({
    files: ["src/a.ts"],
    cwd,
    runner: grepRunner("", 1),
    lens: lensReturning({
      available: true,
      internal: [{ name: "orphanHelper", startLine: 3, usedBy: [], fanout: 0 }],
    }),
  });

  assert.equal(result.drafts.length, 1);
  assert.match(result.drafts[0]?.evidence ?? "", /found no references outside the declaration/);
});
