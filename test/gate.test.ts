import assert from "node:assert/strict";
import test from "node:test";
import type { Finding, FindingDraft } from "../src/contract.ts";
import {
  actionForTier,
  buildGateTable,
  finalizeFindings,
  renderGateTable,
} from "../src/gate.ts";

const findings: Finding[] = [
  {
    id: "b",
    file: "src/b.ts",
    line: 12,
    rule: "duplicate-code",
    evidence: "8 lines duplicated with src/a.ts:2-9",
    tier: 1,
    detector: "jscpd",
    proposedFix: "Extract the shared block",
  },
  {
    id: "a2",
    file: "src/a.ts",
    line: 9,
    rule: "stale-claim",
    evidence: "the comment names a deleted flag",
    tier: 2,
    detector: "agent:prose",
    proposedFix: "Remove the stale claim",
  },
  {
    id: "a1",
    file: "src/a.ts",
    line: 2,
    rule: "no-unused-vars",
    evidence: "'old' is declared but never used",
    tier: 0,
    detector: "eslint",
    proposedFix: "Remove the unused symbol",
  },
];

test("routes tier 0 to apply and gated tiers to ask", () => {
  assert.equal(actionForTier(0), "apply");
  assert.equal(actionForTier(1), "ask");
  assert.equal(actionForTier(2), "ask");
});

test("groups findings by file and orders them by line", () => {
  const table = buildGateTable(findings);

  assert.deepEqual(
    table.files.map((group) => group.file),
    ["src/a.ts", "src/b.ts"],
  );
  assert.deepEqual(
    table.files[0]?.findings.map((finding) => finding.id),
    ["a1", "a2"],
  );
  assert.deepEqual(table.totals, { 0: 1, 1: 1, 2: 1 });
});

test("renders tier, rule, evidence, and proposed fix per file", () => {
  const markdown = renderGateTable(buildGateTable(findings));

  assert.match(markdown, /### src\/a\.ts/);
  assert.match(markdown, /### src\/b\.ts/);
  assert.match(markdown, /\| Line \| Tier \| Rule \| Evidence \| Proposed fix \|/);
  assert.match(markdown, /\| 2 \| 0 \| no-unused-vars \| .*never used.* \| Remove the unused symbol \|/);
  assert.match(markdown, /\| 12 \| 1 \| duplicate-code \|/);
  assert.match(markdown, /\*\*Totals:\*\* Tier 0: 1, Tier 1: 1, Tier 2: 1/);
});

test("renders a clean report when nothing is found", () => {
  const markdown = renderGateTable(buildGateTable([]));

  assert.equal(markdown, "No findings.\n**Totals:** Tier 0: 0, Tier 1: 0, Tier 2: 0");
});

test("assigns jscpd duplicates machine-evidenced tier and stable ids", () => {
  const draft: FindingDraft = {
    file: "src/a.ts",
    line: 5,
    rule: "duplicate-code",
    evidence: "3 lines duplicated with src/b.ts:5-7",
    detector: "jscpd",
    evidenceClass: "machine",
    proposedFix: "Extract the shared block",
  };

  const first = finalizeFindings([draft])[0];
  const repeated = finalizeFindings([draft, draft]);

  assert.equal(first?.tier, 1);
  assert.equal(first?.action, "ask");
  assert.equal(first?.id, "jscpd:duplicate-code:src/a.ts:5#1");
  assert.equal(repeated[1]?.id, "jscpd:duplicate-code:src/a.ts:5#2");
});

test("keeps zero-fanout findings gated even when the graph looks clean", () => {
  const draft: FindingDraft = {
    file: "src/orphan.ts",
    line: 4,
    rule: "zero-fanout",
    evidence: "zero fanout for orphanHelper; string-grep found no references",
    detector: "zero-fanout",
  };

  const [finding] = finalizeFindings([draft]);

  assert.equal(finding?.tier, 1);
  assert.equal(finding?.action, "ask");
});

test("leaves findings no tool has evidenced for judgment", () => {
  const [finding] = finalizeFindings([
    {
      file: "docs/guide.md",
      line: 4,
      rule: "docs-vs-shipped-behavior",
      evidence: "the guide still shows the removed flag",
      detector: "agent:prose",
    },
  ]);

  assert.equal(finding?.tier, 2);
  assert.equal(finding?.action, "ask");
});
