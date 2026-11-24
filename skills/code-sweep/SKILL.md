---
name: code-sweep
description: Report-only sweep of dead, duplicate, and over-complex code over the current change. Runs the deterministic pre-flight first, then one judgment sub-agent axis, and merges everything into one gate table.
---

# Code sweep

This sweep changes **code only**. It never edits tests, prose, documentation, configuration, lockfiles, generated files, or vendored files. It is report-only while the pilot runs: collect findings, render the gate table, and apply nothing.

The deterministic pre-flight always runs before any model spends tokens. If a checker already settled an item, the judgment axis must not re-litigate it.

## 1. Pin the change and run the pre-flight

The bundled CLI lives two directories above this skill: `src/cli.ts`. From this skill's directory run:

```sh
node ../../src/cli.ts code --base <ref> --report-only
```

From the repository root the same command is:

```sh
node src/cli.ts code --base <ref> --report-only
```

`<ref>` is the comparison point: a SHA, branch, tag, or `merge-base:<branch>`. The CLI handles committed changes, uncommitted changes, and untracked files as one union, and selects whole files.

Add `--full-audit` to sweep the whole repository instead of a diff. Add `--json` when a machine-readable report is more convenient; the markdown default already contains the gate table.

The pre-flight runs these detectors:

- **Repo-declared linters** — mise tasks named `lint`, `lint:*`, or tagged `lint`, executed with the changed files. Their commands are opaque to the sweep, so language knowledge stays in the repository's own mise configuration.
- **Duplication** — jscpd over the changed files.
- **Zero-fanout symbols** — pi-lens `module_report` `usedBy`/`fanout`, with a string-grep corroboration pass before any candidate is proposed. Inside pi the extension supplies this through its host bridge; outside pi it is reported as unavailable.

Never report a detector as clean when the report says it was unavailable. Copy the CLI's `**Unavailable:**` line into the final report unchanged.

## 2. Build the exemption manifest

From the pre-flight gate table, record every deterministic finding as settled:

```json
{
  "settled": [
    {
      "file": "src/pay.ts",
      "line": 42,
      "rule": "no-unused-vars",
      "detector": "linter",
      "evidence": "'oldTotal' is assigned a value but never used"
    }
  ],
  "unavailable": ["pi-lens module_report is unavailable"]
}
```

The manifest is the axis's exemption list. An item in `settled` is already evidenced and already belongs in the gate table. The axis must not repeat it, weaken it, or spend judgment deciding whether it is real.

## 3. Dispatch exactly one judgment axis

Call the installed `subagent` tool once with `agent: "general"`. Pass the brief below **verbatim**, replacing only `<BASE>`, `<FILES>`, and `<EXEMPTION_MANIFEST>`. Do not dispatch separate axes for dead, duplicate, and over-complex code: one axis reviews all three categories together.

```text
You are the single judgment axis of a code sweep. Review code for dead, duplicate, and over-complex code. Do not edit any file. You only return findings.

Basepoint: <BASE>
Files selected by the diff (review every file in full): <FILES>
Exemption manifest (already settled mechanically): <EXEMPTION_MANIFEST>

WHOLE-FILE REVIEW
Read each selected file completely, not only the changed lines. The diff chose the file; the file is the review unit. A stale comment, dead branch, or bloated function on an unchanged line next to changed code is in scope. Acceptance example: a function body changes in src/pay.ts, and the comment two lines above on an unchanged line still describes the old behavior — report that stale comment.

RULES

1. Dead code
- Report symbols with no live caller, no export consumed elsewhere, and no dynamic use that survives the exemption manifest.
- A zero-fanout candidate already in the manifest is settled; do not repeat it.
- Before proposing deletion, look for dynamic dispatch, registries, string lookups, reflection, framework hooks, entry points, event handlers, and tests that call the symbol by name. If a string or registry reference exists, say so in the evidence and mark the item ask; never claim the symbol is unused without that check.
- Do not report a symbol merely because it is exported, large, or unfamiliar.

2. Duplicate code
- Report near-identical logic and structural clones that jscpd's token threshold does not cover: the same decision table written twice, the same validation in two modules, two functions that differ only by a renamed parameter.
- Exact token clones already in the manifest are settled; do not repeat them.
- Name both locations and quote the shared lines. A duplication finding needs the other copy, not just the block you noticed.
- Do not report two short lines that merely look alike.

3. Over-complex code
- Report functions with deep nesting, long branch chains, mixed responsibilities, or flag parameters that split one behavior into several.
- Propose a behavior-preserving extraction or guard clause. State what moves and what stays.
- Do not report complexity that the change did not touch merely because the file is old, unless it directly obstructs the changed code.

EVIDENCE
- Every finding needs an exact file and line, a quoted fragment or a precise description of the code at that line, and the reason it is a finding.
- If you cannot evidence a claim, do not make it. If it is ambiguous, return it with rule "code-review-ask" and say what evidence is missing.
- Do not report style preferences, formatting, naming taste, lint rules, or anything a formatter or linter decides.

OUTPUT
Return only a JSON array. Each entry is a FindingDraft:
{
  "file": "repo/relative/path.ts",
  "line": 12,
  "rule": "dead-symbol | duplicate-logic | over-complex | code-review-ask",
  "evidence": "quoted code or precise description, plus why it is a finding",
  "detector": "agent:code-axis",
  "category": "dead-code | duplication | complexity | judgment",
  "proposedFix": "the smallest behavior-preserving change"
}
Do not include tier, action, id, or any field outside this shape. Do not wrap the array in prose.
```

## 4. Merge the axis into the gate table

Keep the pre-flight findings and their tiers unchanged. Add each axis entry as Tier 2 with action `ask`; a finding the axis could not evidence is still `ask`, with its missing evidence in the text.

Render one gate table for the whole sweep:

```markdown
### src/pay.ts

| Line | Tier | Rule | Evidence | Proposed fix |
| ---: | ---: | --- | --- | --- |
| 12 | 1 | duplicate-code | 8 lines duplicated with src/fee.ts:40-47 | Extract the shared block |
| 31 | 2 | dead-symbol | `legacyFee` has no caller; no registry or string reference found | Remove `legacyFee` |

**Totals:** Tier 0: 0, Tier 1: 1, Tier 2: 1
```

Tier 0 is auto-apply in session, Tier 1 is machine-evidenced and waits for confirmation, Tier 2 is judgment and always waits. Zero-fanout findings are permanently Tier 1, even when they look clean. The exemption manifest entries are not repeated as Tier 2.

In report-only mode, end here: show the gate table, list skipped or unavailable coverage with one-line reasons, and apply nothing.

## 5. Applying later (charter, not part of report-only)

When apply is enabled, this skill may change code files only. Apply per file, keeping the diff reviewable. Never apply a zero-fanout finding automatically, never apply a Tier 2 finding without confirmation, and never widen a code fix into a test, prose, configuration, or generated-file edit.
