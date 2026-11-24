---
name: sweep
description: Run code, test, and prose sweeps against one basepoint and review one merged gate table. Use when a change needs every sweep in one pass instead of three separate habits.
---

# Sweep

Run all three sweeps against the **same** comparison point and merge their findings into one review surface. The narrow skills remain the source for each charter's rules; this umbrella only coordinates them.

## 1. Pin the point once

Pick a SHA, branch, tag, `merge-base:<ref>`, or a full audit. Every sweep uses that same selection, including the three-part union of committed, uncommitted, and untracked files. Do not let the sweeps resolve different bases.

From this skill's directory (`skills/sweep/`):

```sh
node ../../src/cli.ts sweep --base <ref>
```

From the repository root:

```sh
node src/cli.ts sweep --base <ref> --full-audit
```

`/sweep` inside pi runs the same umbrella. `/sweep-report` remains an alias for the same handler; never invoke both for one change.

## 2. Read the merged table

The report groups findings by file and adds a **Sweep** column (`code`, `test`, or `prose`) so each row names the charter that produced it. Identical findings from shared detectors appear once; distinct positions stay.

Detector coverage is rendered once. A detector marked **unavailable** has not run — say so in the report and never describe that check as clean.

Rename-aware expansion searches prose for the old and new values of public names changed since the base. Matching prose files join the prose sweep even when they are outside the diff; missing and deleted paths never join.

## 3. Respect each charter on apply

Apply is off unless the user explicitly asks after seeing the table. When enabled, each finding is checked against its sweep's charter before any edit:

- **code** changes code only. It never edits tests, prose, decision records, vendored files, or generated files.
- **test** changes test paths only.
- **prose** changes prose only. It never edits decision records (`docs/adr/**`), vendored or generated files, or external URLs.

A finding outside its charter is skipped with a one-line reason and stays in the report. Report-only is the default; a red suite reverts the hunk that caused it.

## 4. Report

Return the merged gate table, the rename-expansion evidence, and the final detector coverage. Keep skipped findings with their reasons. If the user then asks for the per-charter detail, point them at the code-sweep, test-sweep, or prose-sweep skill rather than re-running a different base.
