---
name: test-sweep
description: Sweep the current change for test slop — assertion hygiene, duplicated test permutations, and tests that verify implementation instead of behavior — report-only, changing tests only.
---

# test-sweep

Sweep test code in the current change. The skill is self-contained: every rule and
brief it needs is pasted below. Do not load another sweep skill or assume a shared
include mechanism.

Charter: every proposed edit changes test files only. Never edit production code,
configuration, or prose. The pilot is report-only: render the gate table, do not
apply findings unless the user explicitly asks after seeing the table.

## 1. Pin the comparison point

Use the basepoint the user names: a SHA, branch, tag, or `merge-base:<ref>`. Default
to `merge-base:main` when the user gives none and the repository has a `main`
branch; otherwise default to `HEAD`.

## 2. Deterministic pre-flight

Run from this skill's directory:

```sh
node ../../src/cli.ts test --base <ref>
```

The command is relative to `skills/test-sweep/`. Add `--full-audit` only when the
user asks for a whole-repository sweep. The CLI selects the three-part diff union
(committed since the basepoint, uncommitted, untracked), runs the test-sweep
detectors, and prints the gate table. Findings from tools keep the gate's tier:
Tier 0 only when allowlisted or measured, otherwise Tier 1. Never hand-edit their
tier.

The detectors are:

- `eslint-jest` — assertion hygiene from eslint-plugin-jest and
  eslint-plugin-testing-library over JavaScript and TypeScript test files:
  `expect-expect`, `no-conditional-expect`, `no-focused-tests`,
  `no-disabled-tests`, `valid-expect`, `no-container`, `no-node-access`, `no-debug`.
- `jscpd-tests` — duplication scoped to test directories and test-named files,
  with thresholds tuned for small repeated permutations.
- `no-assertion` — test blocks in JavaScript/TypeScript (`it`, `test`) and Python
  (`def test_`) that contain no assertion call. The managed runtime hook covers the
  same gap; when it is not installed the sweep reports the hook as absent rather
  than calling the suite clean.

Read the `Detectors:` section of the output. A detector reported **unavailable**
(no ESLint setup, no JavaScript/TypeScript test files, or a missing executable) has
not run; say so in the report and never describe that check as clean.

## 2a. Install the managed no-assertion hook

The detector is static; the hook is what fails a zero-assertion test in the real
suite. Install both pieces so a test that passes today cannot slip through later.

- New repositories: let chezmoi apply the hook from the dotfiles source, so the
  managed copy stays current.
- Existing repositories: copy `hooks/vitest-no-assertion/` into the repo and
  register `setup.ts` in `vitest.config.ts` (`test.setupFiles`), or copy
  `hooks/pytest-no-assertion/conftest.py` and `no_assertion.py` into the pytest
  conftest root. No plugin configuration is needed for Python.

Both files carry a `MANAGED BY pi-sweep` marker. Never delete, rename, or strip
that marker during cleanup, codemods, or a sweep; remove the hook only when
deliberately retiring it.

A repo with the hook installed elsewhere can point the sweep at it: set
`PI_SWEEP_NO_ASSERTION_HOOK` to that file's absolute or repo-relative path, or
pass extra `hookPaths` in the sweep request. Both are checked before the
default candidate locations; a missing declaration still reports the hook as
absent rather than clean.

## 2b. Mutation testing is opt-in, never per-session

The sweep never runs a mutation tool. A repository that wants mutation evidence
declares a mise task named `mutation`, `mutation:<language>`, or tagged `mutation`
and runs it on a per-PR or nightly cadence, outside the sweep:

```toml
# mise.toml — JavaScript/TypeScript
[tasks.mutation]
run = "npx stryker run"
env = { MUTATION_REPORT = "reports/mutation/mutation.json" }

# Python
[tasks."mutation:py"]
run = "mutmut run && mutmut export-json > mutmut.json"

# Rust
[tasks."mutation:rs"]
tags = ["mutation"]
run = "cargo mutants --json"
```

The sweep only **ingests** the JSON report when it exists. Conventional locations:
`reports/mutation/mutation.json` or `mutation-report.json` (Stryker),
`mutmut.json` or `mutants/mutmut.json` (mutmut), and
`mutants.out/outcomes.json` (cargo-mutants). A task or `[env]` block may declare a
different path in `MUTATION_REPORT` (or `PI_SWEEP_MUTATION_REPORT`); the same name
is also read from the environment. Surviving mutants enter the gate as Tier 1
findings with detector `mutation` — they are evidence, never auto-applied.

Freshness is mandatory: the report must be at least as new as HEAD and the changed
test/source files. An older report is reported as **unavailable — stale**, its
score is ignored, and it never makes a file mutation-clean. No declared task and no
report means no mutation evidence at all; the rest of the sweep is unchanged.

## 3. Build deterministic exemptions

Before dispatching any sub-agent, mark what the tools already settled:

- **jscpd-clean** — test files with no `jscpd-tests` finding.
- **mutation-clean** — test files from a fresh mutation score, when the repository
  provides one: files the report covered with no surviving mutant. A stale report
  yields no mutation-clean files. If no fresh score exists, omit this list rather
  than guessing.

The axis judges only files outside both lists. Never send an exempt file to the
sub-agent for a second opinion on the thing that was already proven.

## 4. Dispatch exactly one sub-agent axis

Use the installed `subagent` tool. Make exactly one call with one task on the
`general` role:

```text
subagent({
  tasks: [{
    agent: "general",
    name: "test-sweep-behavior-axis",
    task: <the brief below, with the scope and exemption lists filled in>
  }]
})
```

Fill `FILES IN SCOPE` with the test files remaining after exemptions and
`JSCPD-CLEAN` / `MUTATION-CLEAN` with the deterministic lists. Then pass the whole
brief verbatim. Do not summarise the rules, and do not add or remove rules.

```markdown
## Axis: behavior vs implementation, behavioral redundancy

Review the test changes since `<BASE_REF>` and judge only the files in scope.

Report findings as one row per issue: `file:line | rule | evidence | proposed test-only fix`. Return `No findings.` when nothing survives the rules.

### Files in scope

- <FILES IN SCOPE>
- (none when every file was exempted)

### Exemption manifest (do not report these)

- <JSCPD-CLEAN + MUTATION-CLEAN files>
- (none when there are no exemptions)

jscpd-clean: <JSCPD-CLEAN>
mutation-clean: <MUTATION-CLEAN>

### Rules

1. Behavior vs implementation: flag a test whose assertions mirror the implementation instead of a known-good literal or worked example. Test names, helper names, and snapshots derived from the implementation are evidence.
2. Tautology: flag an assertion that recomputes the expected value the way the production code does, so it can never disagree with the code.
3. Mock echo: flag a test whose only assertion restates what a mock was told to return, or whose mocks replace the collaborator under test.
4. Behavioral redundancy: flag permutations of the same case that exercise identical inputs and outcomes, or several tests that cannot fail independently.
5. Missing behavior: flag a test that only checks a call happened, a value exists, or the code did not throw, where a user-visible outcome is available to assert.
6. Weak matchers: flag generic truthiness or snapshot-only assertions where a specific value, error, or state transition is observable.
7. Do not flag style, coverage, test names, or anything already proven by a deterministic detector or listed in the exemption manifest.
```

## 5. Merge findings

Normalize every sub-agent row to the same contract as the tool findings: `file`,
`line`, `rule`, `evidence`, `tier`, `detector`, and an optional `proposedFix` and
`reason`. The axis detector is `agent:test`. Its findings are Tier 2 and always
ask. Drop a row that:

- names a file outside the scope or in the exemption manifest,
- duplicates a deterministic finding already in the gate,
- cannot cite a line and concrete evidence.

Keep skipped rows in the report with a one-line reason instead of deleting them.

## 6. Render the gate table and report

Render one markdown table grouped by file with columns
`Line | Tier | Rule | Evidence | Proposed fix`. Include the tier totals and a
`Detectors:` section listing every detector as `ran` or `unavailable — <reason>`.

Report-only means: show the table and stop. If the user then asks to apply a
finding, change test files only. Do not touch production code, test configuration,
or the managed no-assertion hooks under `hooks/` in the swept repository.

## 7. Verify before claiming success

If anything was applied, or if the user asks for verification, run the repository's
test command and report its real outcome. Never mark a finding fixed on the
strength of the edit alone.
