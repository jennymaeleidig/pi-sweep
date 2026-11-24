import assert from "node:assert/strict";
import test from "node:test";
import { detectorsFor, runSweep } from "../src/pipeline.ts";
import { realCommandRunner } from "../src/exec.ts";
import { cleanup, commit, git, tempRepo, write } from "./helpers.ts";

const guide = `# Guide

Open the [missing notes](./missing.md) and the [missing anchor](#nowhere).

## Limits

We delve into robust tooling, leveraging every idea. It's worth noting that
it's not just a tool, it's a paradigm.
`;

test("prose runs the deterministic lychee and vale pre-flight", () => {
  assert.deepEqual(
    detectorsFor("prose").map((detector) => detector.name),
    ["lychee", "vale"],
  );
});

test("renders prose findings and skips excluded files", async (t) => {
  const cwd = await tempRepo();
  t.after(() => cleanup(cwd));

  await write(cwd, "README.md", "# Base\n");
  await commit(cwd, "base");
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();

  await write(cwd, "guide.md", guide);
  await write(cwd, "docs/adr/0001-choice.md", "# Choice\n\nWe delve into robust things.\n");
  await write(cwd, "vendor/lib.md", "# Lib\n\nWe leverage a robust tapestry.\n");

  const result = await runSweep({
    kind: "prose",
    cwd,
    runner: realCommandRunner,
    base,
  });

  assert.deepEqual(
    [...new Set(result.report.findings.map((finding) => finding.file))],
    ["guide.md"],
  );
  assert.ok(result.report.findings.some((finding) => finding.rule === "broken-path"));
  assert.ok(result.report.findings.some((finding) => finding.rule === "broken-anchor"));
  assert.ok(result.report.findings.some((finding) => finding.detector === "vale"));
  assert.ok(result.report.findings.every((finding) => finding.tier === 2));

  assert.match(result.markdown, /### guide\.md/);
  assert.match(result.markdown, /broken-path/);
  assert.match(result.markdown, /SlopWords\.Banned/);
  assert.doesNotMatch(result.markdown, /docs\/adr/);
  assert.doesNotMatch(result.markdown, /vendor\//);
});
