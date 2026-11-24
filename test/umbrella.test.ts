import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { FindingDraft, SweepCharter } from "../src/contract.ts";
import type { Detector } from "../src/pipeline.ts";
import { realCommandRunner } from "../src/exec.ts";
import { parseRenameDiff, renameAwareProseFiles } from "../src/rename.ts";
import { runUmbrella } from "../src/umbrella.ts";
import { cleanup, commit, git, tempRepo, write } from "./helpers.ts";

function stub(name: string, drafts: FindingDraft[] = []): Detector {
  return { name, detect: async () => drafts };
}

function stubs(
  overrides: Partial<Record<SweepCharter, Detector[]>> = {},
): Record<SweepCharter, Detector[]> {
  return {
    code: overrides.code ?? [stub("code")],
    test: overrides.test ?? [stub("test")],
    prose: overrides.prose ?? [stub("prose")],
  };
}

async function emptyUmbrella(
  cwd: string,
  request: { base?: string; fullAudit?: boolean } = {},
) {
  return runUmbrella({
    cwd,
    runner: realCommandRunner,
    detectors: stubs(),
    ...request,
  });
}

test("runs all three sweeps once over one basepoint and merges their table", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");
  await write(cwd, "src/a.ts", "export const a = 1;\n");
  await write(cwd, "test/a.test.ts", "test('a', () => {});\n");
  await write(cwd, "guide.md", "# Guide\n");

  const shared = (detector: string): FindingDraft => ({
    file: "src/a.ts",
    line: 1,
    rule: "shared-rule",
    evidence: "the same evidence",
    detector,
    proposedFix: "fix it once",
  });
  const result = await runUmbrella({
    cwd,
    runner: realCommandRunner,
    detectors: {
      code: [stub("shared", [shared("code-detector")])],
      test: [
        stub("shared", [
          shared("test-detector"),
          {
            file: "test/a.test.ts",
            line: 1,
            rule: "test-rule",
            evidence: "test evidence",
            detector: "shared",
          },
        ]),
      ],
      prose: [
        stub("shared", [
          shared("prose-detector"),
          {
            file: "guide.md",
            line: 1,
            rule: "prose-rule",
            evidence: "prose evidence",
            detector: "shared",
          },
        ]),
      ],
    },
  });

  assert.deepEqual(
    Object.keys(result.report.sweeps),
    ["code", "test", "prose"],
  );
  assert.equal(result.report.findings.length, 3);
  assert.equal(
    result.report.findings.filter((finding) => finding.rule === "shared-rule").length,
    1,
  );
  assert.deepEqual(
    result.report.gate.files.map((group) => group.file),
    ["guide.md", "src/a.ts", "test/a.test.ts"],
  );
  assert.match(
    result.markdown,
    /\| Line \| Sweep \| Tier \| Rule \| Evidence \| Proposed fix \|/,
  );
  assert.match(result.markdown, /\| 1 \| code \| 2 \| shared-rule \|/);
  assert.match(result.markdown, /\| 1 \| test \| 2 \| test-rule \|/);
  assert.match(result.markdown, /\| 1 \| prose \| 2 \| prose-rule \|/);
  assert.equal(result.report.sweeps.code.findings[0]?.sweep, "code");
  assert.equal(result.report.sweeps.test.findings[0]?.sweep, "test");
});

test("renders detector coverage once even when unavailable strings repeat it", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "base.ts", "export const base = 1;\n");
  await commit(cwd, "base");

  const result = await runUmbrella({
    cwd,
    runner: realCommandRunner,
    detectors: stubs({
      code: [
        {
          name: "probe",
          probe: async () => ({
            available: false,
            reason: "probe tool is unavailable",
          }),
          detect: async () => [],
        },
        {
          name: "lens",
          detect: async () => [],
          unavailable: async () => ["pi-lens module_report is unavailable"],
        },
      ],
    }),
  });

  assert.deepEqual(result.report.unavailable, [
    "pi-lens module_report is unavailable",
  ]);
  assert.match(result.markdown, /probe: unavailable — probe tool is unavailable/);
  assert.match(
    result.markdown,
    /coverage: unavailable — pi-lens module_report is unavailable/,
  );
  assert.equal(
    (result.markdown.match(/pi-lens module_report is unavailable/g) ?? []).length,
    1,
  );
  assert.equal((result.markdown.match(/\*\*Detectors:\*\*/g) ?? []).length, 1);
  assert.doesNotMatch(result.markdown, /\*\*Unavailable:\*\*/);
});

test("skips cross-charter findings with a reason instead of editing them", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "src/code.ts", "export const code = 'original code';\n");
  await write(cwd, "test/a.test.ts", "const value = 'original test';\n");
  await write(cwd, "README.md", "original readme\n");
  await write(cwd, "docs/adr/0001-choice.md", "original decision\n");
  await commit(cwd, "base");

  const edit = (oldText: string, newText: string) => ({ oldText, newText });
  const result = await runUmbrella({
    cwd,
    runner: realCommandRunner,
    apply: true,
    detectors: {
      code: [
        stub("code", [
          {
            file: "test/a.test.ts",
            line: 1,
            rule: "code-rule",
            evidence: "code detector reached a test",
            detector: "code",
            edit: edit("original test", "changed test"),
          },
          {
            file: "README.md",
            line: 1,
            rule: "code-rule",
            evidence: "code detector reached prose",
            detector: "code",
            edit: edit("original readme", "changed readme"),
          },
        ]),
      ],
      test: [
        stub("test", [
          {
            file: "src/code.ts",
            line: 1,
            rule: "test-rule",
            evidence: "test detector reached code",
            detector: "test",
            edit: edit("original code", "changed code"),
          },
        ]),
      ],
      prose: [
        stub("prose", [
          {
            file: "docs/adr/0001-choice.md",
            line: 1,
            rule: "prose-rule",
            evidence: "prose detector reached a decision record",
            detector: "prose",
            edit: edit("original decision", "changed decision"),
          },
        ]),
      ],
    },
  });

  assert.ok(result.apply);
  assert.equal(result.apply?.applied, 0);
  assert.equal(
    result.report.findings.every((finding) => finding.action === "skip"),
    true,
  );
  assert.match(
    result.report.findings.find((finding) => finding.file === "test/a.test.ts")
      ?.reason ?? "",
    /outside the code sweep's charter \(test path\)/,
  );
  assert.match(
    result.report.findings.find((finding) => finding.file === "README.md")
      ?.reason ?? "",
    /outside the code sweep's charter \(prose file\)/,
  );
  assert.match(
    result.report.findings.find((finding) => finding.file === "docs/adr/0001-choice.md")
      ?.reason ?? "",
    /decision record/,
  );
  assert.equal(await readFile(join(cwd, "src/code.ts"), "utf8"), "export const code = 'original code';\n");
  assert.equal(await readFile(join(cwd, "test/a.test.ts"), "utf8"), "const value = 'original test';\n");
  assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "original readme\n");
  assert.equal(
    await readFile(join(cwd, "docs/adr/0001-choice.md"), "utf8"),
    "original decision\n",
  );
});

test("pairs changed exported names by position in a diff hunk", () => {
  const diff = [
    "diff --git a/src/flag.ts b/src/flag.ts",
    "--- a/src/flag.ts",
    "+++ b/src/flag.ts",
    "@@ -1 +1 @@",
    "-export function oldFlag() {",
    "+export function newFlag() {",
    "@@ -8 +8 @@",
    "-export const oldValue = 1;",
    "+export const newValue = 2;",
    "@@ -20 +20 @@",
    "-export interface OldShape {",
    "@@ -40 +40 @@",
    "+export interface NewShape {",
  ].join("\n");

  assert.deepEqual(parseRenameDiff(diff), [
    { file: "src/flag.ts", oldName: "oldFlag", newName: "newFlag" },
    { file: "src/flag.ts", oldName: "oldValue", newName: "newValue" },
    { file: "src/flag.ts", oldName: "OldShape", newName: "NewShape" },
  ]);
});

test("expands prose that names the old and new public name without adding deleted paths", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "src/flag.ts", "export function oldFlag() {\n  return true;\n}\n");
  await write(cwd, "docs/guide.md", "# Guide\n\nCall oldFlag to enable it.\n");
  await write(cwd, "docs/gone.md", "# Gone\n\noldFlag used to live here.\n");
  await write(cwd, "vendor/lib.md", "# Lib\n\noldFlag is vendored.\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  await write(cwd, "src/flag.ts", "export function newFlag() {\n  return false;\n}\n");
  await git(cwd, ["rm", "-q", "docs/gone.md"]);
  await commit(cwd, "rename flag");

  const expansion = await renameAwareProseFiles({
    cwd,
    runner: realCommandRunner,
    base,
  });

  assert.deepEqual(expansion.renames, [
    { file: "src/flag.ts", oldName: "oldFlag", newName: "newFlag" },
  ]);
  assert.deepEqual(expansion.files, ["docs/guide.md"]);
  assert.equal(existsSync(join(cwd, "docs/gone.md")), false);
  assert.ok(expansion.expansions.every((entry) => existsSync(join(cwd, entry.file))));
  assert.match(expansion.expansions[0]?.evidence ?? "", /oldFlag -> newFlag/);

  const result = await emptyUmbrella(cwd, { base });
  assert.deepEqual(result.report.renameExpansions, expansion.expansions);
  assert.ok(result.report.files.includes("docs/guide.md"));
  assert.ok(!result.report.files.includes("docs/gone.md"));
  assert.ok(result.report.sweeps.prose.files.includes("docs/guide.md"));
  assert.ok(!result.report.sweeps.prose.files.includes("vendor/lib.md"));
  assert.match(result.markdown, /Rename expansion/);
});

test("resolves SHA, branch, tag, merge-base, and full-audit basepoints through the umbrella", async (t) => {
  await t.test("SHA", async (t) => {
    const cwd = await tempRepo();
    t.after(() => cleanup(cwd));
    await write(cwd, "base.ts", "export const base = 1;\n");
    await commit(cwd, "base");
    const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    await write(cwd, "changed.ts", "export const changed = 1;\n");
    await commit(cwd, "changed");

    const result = await emptyUmbrella(cwd, { base });

    assert.equal(result.report.mode, "diff");
    assert.equal(result.report.resolvedBase, base);
    assert.deepEqual(result.report.files, ["changed.ts"]);
  });

  await t.test("branch", async (t) => {
    const cwd = await tempRepo();
    t.after(() => cleanup(cwd));
    await write(cwd, "base.ts", "export const base = 1;\n");
    await commit(cwd, "base");
    await git(cwd, ["branch", "before"]);
    await write(cwd, "changed.ts", "export const changed = 1;\n");
    await commit(cwd, "changed");

    const result = await emptyUmbrella(cwd, { base: "before" });

    assert.equal(result.report.baseRef, "before");
    assert.deepEqual(result.report.files, ["changed.ts"]);
  });

  await t.test("tag", async (t) => {
    const cwd = await tempRepo();
    t.after(() => cleanup(cwd));
    await write(cwd, "base.ts", "export const base = 1;\n");
    await commit(cwd, "base");
    await git(cwd, ["tag", "-a", "baseline", "-m", "baseline"]);
    await write(cwd, "changed.ts", "export const changed = 1;\n");
    await commit(cwd, "changed");

    const result = await emptyUmbrella(cwd, { base: "baseline" });

    assert.equal(result.report.baseRef, "baseline");
    assert.deepEqual(result.report.files, ["changed.ts"]);
  });

  await t.test("merge-base", async (t) => {
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

    const result = await emptyUmbrella(cwd, { base: "merge-base:main" });

    assert.equal(result.report.resolvedBase, branchPoint);
    assert.deepEqual(result.report.files, ["feature.ts"]);
  });

  await t.test("full audit", async (t) => {
    const cwd = await tempRepo();
    t.after(() => cleanup(cwd));
    await write(cwd, "tracked.ts", "export const tracked = 1;\n");
    await commit(cwd, "tracked");
    await write(cwd, "untracked.ts", "export const untracked = 1;\n");

    const result = await emptyUmbrella(cwd, { fullAudit: true });

    assert.equal(result.report.mode, "full");
    assert.equal(result.report.baseRef, null);
    assert.deepEqual(result.report.files, ["tracked.ts", "untracked.ts"]);
  });
});
