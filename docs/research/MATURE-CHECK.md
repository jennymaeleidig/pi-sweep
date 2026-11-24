# MATURE-CHECK — Do mature tools already cover the test-slop categories?

Date: 2026-11-24. Companion to the test-slop tool evaluation. Numbers gathered from
GitHub API, npm downloads API, and PyPI stats on this date.

## Adoptions measured today

| Tool | Stars | Last push | Downloads/month |
|---|---|---|---|
| StrykerJS (stryker-mutator/stryker-js) | 3,427 | 2026-11-21 | 27.9M npm (`@stryker-mutator/core`) |
| Stryker.NET | 2,146 | 2026-11-24 | — |
| mutmut (boxed/mutmut) | 1,585 | 2026-11-19 | 9.2M PyPI |
| cargo-mutants (sourcefrog/cargo-mutants) | 1,414 | 2026-10-19 | crates.io |
| jscpd (kucherenko/jscpd) | 6,613 | 2026-11-24 | 23.4M npm |
| SonarQube (SonarSource/sonarqube) | 11,209 | 2026-11-24 | — |
| eslint-plugin-jest | 1,174 | 2026-11-23 | 73.0M npm |
| eslint-plugin-testing-library | 1,066 | 2026-11-23 | 44.7M npm |
| pytest-cov | 2,081 | 2026-10-18 | ~40M+ PyPI |
| codecov-action | 1,722 | 2026-09-17 | — |

## Category 1: Tests that cannot fail / no assertions

**Mature default behavior:**

- **Jest**: does NOT fail a test with zero `expect()` calls by default — this was
  debated and declined in facebook/jest#2209 and jestjs/jest#7908. Opt-in exists but is
  per-test boilerplate: `expect.hasAssertions()` / `expect.assertions(n)` inside each
  test. `jest-circus`'s empty-suite detection and `fail-fast` don't cover the hollow case.
- **Vitest**: same semantics as Jest — no global "require assertions" config. A test
  that only calls the unit under test and does nothing else passes green.
- **pytest**: no native mode fails a test with zero assertions; `--strict` /
  `--strict-markers` govern marker usage, not assertion presence. Python assert
  rewriting can even be *stripped* under `python -O`, and `pytest-cov` happily reports
  100% coverage on a test that never asserts anything.
- **Coverage tooling does not catch this** — pytest-cov measures execution, not
  verification.

**Verdict: NOT covered by mature tooling.** A global, framework-level
"every test must assert something" check is a genuine gap. The narrow tool in this
category survives the check — but a 20-line custom check (a pytest hook that inspects
rewritten asserts per test item, or a Vitest globalSetup hack) is trivial, so a
0-star single-maintainer dependency is not justified either. Best shape: small local
convention check, or adopt Stryker, which *does* catch most hollow tests because
hollow tests let mutants survive (see below).

## Category 2: Tautological / weak assertions

**Mature coverage:**

- **Branch coverage**: `pytest-cov --branch`, Jest/Vitest `coverageThreshold` with
  branches — mature, fast, already in most pipelines. Catches dead-branch tests but
  not weak assertions on live branches.
- **Mutation testing is the actual answer here.** StrykerJS 3.4k★, 27.9M downloads/mo,
  actively pushed (Nov 2026); Stryker.NET 2.1k★, same week pushes. mutmut 1.6k★,
  9.2M PyPI/mo. cargo-mutants 1.4k★, maintained.
- **CI speed / per-PR feasibility**: StrykerJS has `--incremental` (reuses the mutant
  matrix, reruns only mutants in changed files) and `--concurrency`; Stryker.NET has
  incremental since v3. mutmut has `--runner` sharding; cargo-mutants has
  `--test-timeout` and shard-friendly in-place cargo builds. Honest answer: for
  small/medium modules an incremental per-PR run is minutes, not hours; for large
  monorepos it's still a nightly job. Mutation testing is now *practical* per-PR on
  the changed-code slice.

**Verdict: fully covered by mature tooling.** Mutation testing kills the narrow
tautology tools' value: a tautological assertion is exactly a surviving mutant
detector's wheelhouse, with thousands of contributors' worth of engineering behind
it. Skip the narrow tools; run Stryker/mutmut/cargo-mutants incrementally per PR.

## Category 3: Duplicate / near-duplicate tests

**Mature coverage:** SonarQube/SonarCloud has built-in duplication detection
(11.2k★, pushed this week) that applies to *all* analyzed files including test
sources unless you explicitly exclude them — so Sonar users already have this, at
block-token granularity. jscpd (6.6k★, 23.4M npm/mo) does the same token/AST-based
copy-paste detection and can be pointed at test dirs plus has thresholds for CI
(`--min-tokens`, exit code).

**Verdict: fully covered.** Nothing narrow survives here; jscpd in CI or the Sonar
duplication metric both work.

## Category 4: Over-mocking / behavior-vs-implementation

**Mature coverage:** eslint-plugin-jest (1.2k★, 73M/mo) and eslint-plugin-testing-library
(1.1k★, 44.7M/mo) are both actively maintained and cover assertion hygiene
(no-identical-title, valid-expect, no-conditional-expect; prefer-query-by-assertions,
no-container, no-debug). They do NOT cover "you mocked too much / you're testing the
mock" — that's a semantic judgment neither package makes. Python has no mature
equivalent even of the ESLint-plugin level for mock abuse: flake8-pytest and
flake8-mock (abandoned-ish, legacy `import mock` checks only) don't come close.

**Verdict: partially covered.** The narrow tools' *lint-level* overlap (titles,
assertion validity, stray mocks) is redundant with the ESLint plugins; genuine
over-mocking detection is neither mature nor well-solved by the narrow tools — it's
mostly caught well by mutation testing (mocked-out code lets mutants survive) and by
code review.

## Category 5: Diff-relative test weakening (assertions removed in a PR)

**Mature coverage:** Codecov's patch coverage flags *uncovered changed lines* — it
says nothing about a PR that removes assertions or weakens an existing expectation
while keeping line counts fine. No mature general-purpose tool (Codecov, Coveralls,
Sonar, diff-quality) diffs the *semantics* of test changes. What exists at the edges:
Sonar's "coverage on new code" has the same blind spot; `danger.js` rules are
per-project custom code, i.e., roll-your-own.

**Verdict: NOT covered — the only category where narrow tooling would be the sole
coverage.** But note it is also the easiest to fake confidence in: removing an
assertion and removing a whole failing test look the same only to a crude regex-based
tool. A pragmatic substitute is Stryker incremental on the changed files plus review
discipline (require test files touched by the author to be called out).

## Category 6: Framework-native maturity

- **Go**: `go test` + `vet` are strict by construction — a test that calls nothing
  still runs, but the ecosystem idiom is direct comparison with `t.Errorf`; hollow
  tests are rarer because there is no mock-chaining culture. staticcheck (SA/QF
  checks), `gocyclo`-style lint via golangci-lint (widely adopted). Coverage:
  `go test -covermode=atomic`. No native "assertion-less test" check, but mutants via
  `go-mutesting` is niche; convention + review carry it.
- **Rust**: clippy is mature and opinionated; `#[should_panic]`, `assert!`/`assert_eq!`
  macros make hollow tests visually obvious; cargo-mutants (1.4k★, maintained Oct 2026)
  is the strongest native-story mutation tool across all languages considered — it
  even auto-discovers tests per function. The Rust ecosystem needs none of the narrow
  tools.

**Verdict: mature ecosystems largely carry their own weight**, with cargo-mutants as
the standout.

## Bottom line per category

1. No-assertion tests: gap in mature tooling — but solve with a tiny local check or via
   mutation testing; don't adopt a 0-star dependency for it.
2. Tautological assertions: **redundant** — Stryker/mutmut/cargo-mutants cover it,
   now CI-practical in incremental mode.
3. Duplicate tests: **redundant** — jscpd or Sonar built-in.
4. Over-mocking: partially redundant (ESLint plugins) / partially a review + mutation
   problem; no mature Python equivalent, but the narrow tools don't beat review either.
5. Diff-relative weakening: **genuine gap**, no mature coverage; narrow tool is the
   only automated coverage, with real false-comfort caveats.
6. Framework-native: Go/Rust mature ecosystems mostly self-sufficient; Rust in
   particular via cargo-mutants + clippy.
