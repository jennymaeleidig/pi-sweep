# Test-slop detection tools — research report

Date: 2026-11-24. Context: deterministic pre-check layer before LLM review in a coding-agent pipeline. Already planned: repo linters, jscpd, LSP diagnostics, lychee, vale, agent-sh/deslop rules (test-cannot-fail, test-swallows-failure).

## 1. Summary table

| Tool | Stars | Languages | Slop categories covered | Deterministic? | Integration |
|---|---|---|---|---|---|
| **hollowtest** (jeffev/hollowtest) | ~0 (new, npm-published) | JS/TS (Jest, Vitest, Mocha, node:test, Playwright, Testing Library, supertest) + Python pytest/unittest | Cannot-fail, tautologies, no-assertions, mocked-subject (over-mock of code under test), swallowed errors, unawaited assertions, weak assertions, skipped/focused tests | Yes — AST pass, never runs tests | `npx hollowtest`, human-readable output with severities, exit code, optional Claude Code plugin; check JSON support before relying on it |
| **falsegreen / falsegreen-js** (vinicq) | 3 | Python/pytest, JS/TS, Robot Framework | False-green tests: 47 provable AST codes (assertion never runs, always-true, swallowed exception, typo'd mock assertion, dead code) | Yes — zero-dep AST pass | `pip install falsegreen` / `npx falsegreen-js`; HIGH blocks, LOW warns; pre-commit hook; grounded in rotten-green-test research (Delplanque ICSE'19) |
| **captain-obvious** (shmulc8) | 17 | TypeScript (compiler API), Python (batched mypy reveal_type) | Tests that re-assert what the type checker already proves (`assert isinstance(x, int)` on a `-> int` function), tautologies, mock-echo, assertions after return, duplicate detection | Yes — asks the type checker, one script run | Single script invocation per repo; findings split proven (auto-deletable) vs advisory |
| **hallucinot** (jayj221/hallucinot) | 2 | JS-centric, reads git diffs | Agent diff tricks: deleted assertions, disabled/skipped tests, stubs, gamed tests | Yes — 15 diff rules, milliseconds | `npx hallucinot`, staged-diff audit, no LLM calls |
| **eslint-plugin-jest** | 1,174 | JS/TS | `expect-expect` (test with no expect), `prefer-expect-assertions`, `no-conditional-expect`, `no-conditional-in-test`, `valid-expect`, `no-focused-tests`, `no-disabled-tests`; also ported to Oxlint/Rslint | Yes | ESLint CLI, JSON/SARIF output, exit codes |
| **eslint-plugin-testing-library** | 1,066 | JS/TS (React et al.) | Testing-implementation-details family (`no-container`, `no-node-access`, `prefer-query-by-error`, `prefer-presence-queries`, `no-debug`) | Yes | ESLint CLI |
| **eslint-plugin-playwright** | 398 | JS/TS | Playwright hygiene (no-focused-tests, no-skipped, no-wait-for-timeout, valid title etc.) | Yes | ESLint CLI |
| **Stryker ecosystem** (stryker-js 3,427; stryker.net 2,146; stryker4s 218) | — | JS/TS, C#/.NET, Scala | Indirect: mutation score per test — low score ⇒ tautological/over-mocked/weak tests survive mutants | Deterministic but slow (runs test suite per mutant) | `stryker` CLI, JSON reporter + shared `mutation-testing-report-schema.json`; CI-runnable; budget-gate per test |
| **mutmut** (boxed/mutmut) | 1,585 | Python | Same indirect signal for pytest | Deterministic, slow; `mutmut run` | CLI, `mutmut results`; JSON via `mutmut junitxml` (partial) |
| **PIT / pitest** (hcoles/pitest) | 1,895 | Java/JVM | Same indirect signal | Deterministic, slow | Maven/Gradle plugin, XML/HTML reports, thresholds (`mutationThreshold`) fail the build |
| **cargo-mutants** (sourcefrog) | 1,414 | Rust | Same indirect signal | Deterministic | CLI with documented exit codes (e.g. 4 = mutants survived/timeout), JSON/HTML reports, `--in-place` CI mode |
| **jscpd** (kucherenko) | 6,613 | 220+ langs | Duplicated/near-duplicate test cases (run scoped to test dirs; `--similarity` mode, token-based, tolerant of renamed identifiers) | Yes | Already in stack; JSON/SARIF output, exit code, min-thresholds |
| **CodeQL** (github/codeql) | 10,406 | Many | Security-focused; a few test-hygiene queries but no dedicated useless-test pack | Yes | Requires DB build + setup; heavyweight for this job |
| **Semgrep** (semgrep/semgrep) | 17,924 | Many | Only if you write the rules: tautological assert, empty test, `assert True`, useless eqeq exist in community rules; over-mock/impl-detail rules must be authored | Yes | `semgrep --json --config`, exit codes, SARIF; perfect for cross-language custom heuristics |
| **PyNose** (research, arXiv 2108.04639) | academic | Python | Test-smell catalog detector for Python incl. empty test, tautological assert, over-mocking patterns | Yes (prototype) | Research prototype; use as a rule source, not a product |
| aislop (773★), slopscore, sloplint, ai-slop-detector | 773 / 3 / 0 / 123 | Varies | General AI-slop scanners (dead code, placeholders, hallucinated imports); some touch tests but shallow on test semantics | Yes | CLIs with exit codes; not test-specialized |
| **exspec** (morodomi) | 2 | Rust tests | Verifies tests read as executable specs (assertions present per test) | Yes | Young; niche |

## 2. Per-tool detail

### hollowtest — best single "cannot-fail" detector (JS/TS + Python)
New (2026) but exactly on-target: rule table covers `no-assertions`, `empty-test`, `tautology` (`expect(x).toBe(x)`), `bare-expect` (`toBeNull` without `()`), `swallowed-error`, `unawaited-assertion`, **`mocked-subject`** (test that `vi.mock`s the very module under test — your over-mocking category), `focused-test`, `conditional-assertion`, `weak-assertions`, `commented-assertion`, `skipped-test`, `snapshot-only`. Python gets the same rules plus the classic `assert (cond, "msg")` always-truthy tuple and `except Exception:` swallowing `AssertionError`. Understands Testing Library throwing queries, `expect.assertions(n)`, mocha `done`, type-level tests (`expectTypeOf`, `@ts-expect-error`) to avoid false positives. Fast: 7,400 tests in ~3s, never executes tests. Also has a mutation-verification mode ("break code on purpose to prove no test notices"). Watch: 0 stars / single maintainer — verify JSON output and pin a version.

### falsegreen / falsegreen-js — Python-first twin
Zero-dependency AST pass, 47 provable false-positive codes, HIGH findings gate the commit. Explicitly motivated by AI assistants producing false greens "at scale", cites Delplanque et al. (ICSE 2019) rotten-green-test research. Family covers pytest, JS/TS, Robot Framework; a separate `falsegreen-skill` does the semantic LLM pass — same architecture as our pipeline.

### captain-obvious — the "asserts what the compiler already knows" niche
Novel deterministic angle: uses the project's TypeScript compiler API / batched mypy `reveal_type` to flag assertions that restate static types (`typeof x === 'number'` when x is `number`), plus AST tautologies, mock-echo tests, assertions after return, and duplicate-test detection. Deterministic, one script invocation. Small but the type-checker idea generalizes well to any language with an LSP (we already have LSP in the pipeline).

### hallucinot — diff-level agent gaming
Reads the staged diff, not files: catches agents *deleting* assertions or skipping tests to force green — something file-level linters structurally cannot see. 15 deterministic rules, milliseconds. JS-centric but diff rules port easily to any language.

### eslint-plugin-jest / testing-library / playwright
The mature layer for JS/TS: `expect-expect` (no-assertion), `prefer-expect-assertions` (missing `expect.assertions`), `no-conditional-expect`/`no-conditional-in-test` (assertions that may not run), `valid-expect` (un-awaited/bare matchers), `no-disabled-tests`/`no-focused-tests`. testing-library plugin is the best available proxy for "assert behavior not implementation" (`no-node-access`, `no-container` = reaching into DOM internals). Rules also available in Oxlint (fast) and Bun lint. JSON output, exit codes, fully CI-deterministic.

### Mutation testing — the ground-truth backstop
Mutation score is the only deterministic measure that directly answers "can this test fail?" per behavior. Stryker (JS/TS/C#/Scala, JSON reporter + shared schema), mutmut (Python), PIT (JVM, `mutationThreshold` build gate), cargo-mutants (Rust, documented exit codes incl. "mutants survived", JSON output). All deterministic but expensive (run the suite per mutant) — best used scoped to changed files/tests per PR, or as a sampled/nightly gate, not a per-turn pre-check. Every tool listed above approximates mutation testing cheaply; mutation tools prove it.

### jscpd on test dirs — duplicate/near-duplicate tests
Already planned for source; the same tool scoped to test dirs (and `--min-tokens` tuned lower, since test boilerplate is heavy) covers "agent writes ten permutations of the same test". Token-based similarity tolerates renamed variables (`--similarity` mode finds near-duplicates among functions). JSON output, exit-code threshold. This remains the best-in-class deterministic option for near-duplicates; no dedicated duplicate-test tool beats it.

### CodeQL / Semgrep
CodeQL has no dedicated useless-test query pack — heavyweight DB build for little test-specific payoff; skip. Semgrep is the right substrate for the custom cross-language heuristics you'll need (write rules per language: `assert True`, `def test_*` with no assert, `expect(x).toBe(x)`, mock-the-module-under-test, `except: pass` around assertions). `--json`, SARIF, exit codes, ~30 langs.

## 3. Coverage gaps (honest assessment)

Well-covered deterministically:
- **Tests that cannot fail / no assertions / tautologies**: hollowtest, falsegreen, eslint-plugin-jest, captain-obvious, Semgrep rules — solid.
- **Tautological mocks (mock-echo, mocking the subject)**: hollowtest `mocked-subject`, captain-obvious `mock-echo`, falsegreen typo'd mock assertions — decent, syntax-level.
- **Assertion-free smoke tests**: covered (as warnings vs errors — policy question, since "does not throw" is sometimes intentional).
- **Near-duplicate test cases**: jscpd token-similarity works but needs tuning; test boilerplate inflates similarity, so threshold calibration matters. No dedicated tool exists. Partial gap.
- **Over-mocking that tests the mock not the code**: only the crude syntactic form (mocking the module under test) is catchable. "Mock-heavy test where the asserted values flow only from mock setup" needs data-flow analysis — no general tool does it. **Gap: LLM review or new heuristic** (e.g. ratio of assertions whose operands trace to mock return values — buildable as a per-language AST/CFG heuristic, PyNose catalogs the smell).

No good tool, needs LLM review or new heuristics:
- **Tests asserting implementation details instead of behavior**: only the Testing-Library-specific DOM rules exist. In general code (asserting private method calls, internal state, call-counts of collaborators, snapshot-only tests) this is semantic and language-agnostic — **no deterministic tool covers it; this is the strongest candidate for LLM review**, with lint rules as cheap partial proxies.
- **Redundant permutations beyond exact similarity**: jscpd catches literal duplication; semantically-redundant tests (same *behavior* expressed differently, e.g. duplicated boundary cases) require either mutation testing (proves redundancy) or LLM judgment.
- **Weak-but-not-empty assertions** (only `toBeTruthy`/`toBeDefined`): flagged as warnings by hollowtest; severity judgment is inherently fuzzy — good LLM-review feed, not a hard gate.
- **Cross-language uniformity**: hollowtest/falsegreen cover JS+Python only; for Go/Rust/Java you currently assemble from eslint-equivalents + mutation tools + custom Semgrep rules. Nothing gives one uniform rule set across languages — that's the actual gap the LLM layer fills.

## 4. Recommended stack (deterministic phase before LLM review)

1. **hollowtest** (JS/TS/Python) — primary cannot-fail/tautology/over-mock-subject detector; fast, severity-graded output feeds the LLM reviewer as a findings list.
2. **falsegreen** for pytest-heavy Python repos (or instead of hollowtest for Python); eslint-plugin-jest + testing-library + playwright for JS/TS depth and the behavior-vs-implementation partial proxy.
3. **jscpd scoped to test dirs with `--similarity` and tuned `--min-tokens`** for duplicate/near-duplicate test cases; JSON output.
4. **hallucinot** (or its rules ported) on the agent's staged diff — catches deleted/disabled tests, which file-level tools miss.
5. **Semgrep with a small custom rulepack** (one rule family per slop category, per language) as the language-flexible glue; SARIF/JSON, exit-code gated.
6. **Mutation testing as a budgeted backstop, not a per-turn check**: Stryker/mutmut/PIT/cargo-mutants scoped to changed files per PR, or nightly sampling — mutation score is the ground truth for "can this test fail" and "is this test redundant".
7. **Feed-forward contract**: all of the above emit structured findings (JSON/SARIF) + exit codes; the pipeline aggregates them into a findings file the LLM reviewer reads, so the LLM spends its budget only on the two true gaps: implementation-detail assertions and semantic redundancy.

Open verification items: hollowtest/falsegreen are new, single-maintainer projects — pin versions, confirm machine-readable (JSON) output before making them hard gates; keep the agent-sh/deslop rule set as a reference for the Semgrep rulepack.
