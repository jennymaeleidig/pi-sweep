---
name: prose-sweep
description: Sweep drifted and sloppy prose over the current change. Runs lychee and vale as a deterministic pre-flight, then dispatches four sub-agent axes (claims in comments, docs vs shipped behavior, references, slop). Report-only.
---

# prose-sweep

Find prose that outlived the truth: comments naming deleted flags, docs with
stale paths, and AI-slop vocabulary. This skill is self-contained. Do not load
another skill to run it.

The sweep is **report-only**. It produces one gate table and never edits a file.
When apply is enabled later, it changes prose only.

## 1. Pin the point

Ask for the comparison point if the user did not name one: a SHA, branch, tag,
or `merge-base:<ref>`. Default to `HEAD`, which selects the uncommitted change.

## 2. Deterministic pre-flight

From this skill's directory (`skills/prose-sweep/`), run:

```sh
node ../../src/cli.ts prose --base <ref>
```

From the repo root, the same command is `node src/cli.ts prose --base <ref>`.
Add `--json` for machine output and `--full-audit` to sweep every prose file
instead of the diff. Exit 0 means the pipeline ran; findings do not change the
exit code.

The pipeline runs two detectors and renders the gate table:

- **lychee** offline. Only local paths and anchors are checked. Every URL with
  a scheme is ignored through `.lycheeignore`; no network request is made.
- **vale** with the bundled SlopWords pack under `vale/`. It runs with
  `--no-global`, so user styles and `vale sync` never enter the run.

Regenerate the pack only when the no-ai-slop word lists change:

```sh
node scripts/generate-slopwords.ts
```

The generated rules are checked in under `vale/styles/SlopWords/`. A test
compares them with the source lists.

### Exemption manifest

Treat every lychee and vale finding as settled evidence. Pass the rendered gate
table to every sub-agent. A sub-agent must not re-report a line, rule, or link
that a deterministic detector already reported.

These paths are out of scope for detection and apply:

- decision records: `docs/adr/**`
- vendored trees: `vendor/`, `node_modules/`, `dist/`, `third_party/`, `venv/`
- generated files: `generated/`, `gen/`, lock files, `*.min.js|css`
- external URLs of any scheme
- anything that is not prose: `.md`, `.mdx`, `.markdown`, `.rst`, `.txt`,
  `.adoc`, `.org` are prose; source files are read for comments only

Never propose an edit to a decision record, a vendored or generated file, or an
external URL. Say why in the finding if the only fix lives there.

## 3. Dispatch four axes

Send four briefs to the `subagent` tool, one per axis, in parallel. Paste each
brief **verbatim**; a sub-agent cannot see this conversation. Give every brief
the user's basepoint, the changed-file list, and the pre-flight gate table.

### Axis 1: claims in comments

```text
You are the claims-in-comments axis of a report-only prose sweep. Basepoint: <ref>. Files
selected by the sweep: <files>. Pre-flight gate table (already settled, never re-report these):
<gate table>.

Read the changed source files and their comments. Look for comments that state a fact the code
no longer honors: a flag, option, default, return type, parameter, environment variable, side
effect, ordering, or invariant that has changed or disappeared. A comment that is merely
verbose is not your finding.

Scope rules:
- Read comments only. Do not propose changes to executable code.
- Never edit or propose edits to docs/adr/**, vendor/**, node_modules/**, dist/**,
third_party/**, generated/**, lock files, or *.min.js|css.
- Never propose an edit to an external URL.
- Prose only: a proposed fix must change comment text, never code.

Report each finding as a row: file, line, rule ("stale-claim"), one sentence of evidence
quoting the comment and the code fact that contradicts it, and a proposed prose-only fix.
Report nothing when the comment is accurate. If a claim cannot be verified from the change,
mark it "ask" and say what evidence is missing.
```

### Axis 2: docs vs shipped behavior

```text
You are the docs-vs-shipped-behavior axis of a report-only prose sweep. Basepoint: <ref>. Files
selected by the sweep: <files>. Pre-flight gate table (already settled, never re-report these):
<gate table>.

Compare changed prose (README, guides, reference docs, help text) with what the change actually
ships. Look for documented flags, defaults, paths, commands, outputs, limits, and workflows
that the code, CLI, or config no longer matches. Evidence must name the shipped behavior, not
just the doc sentence.

Scope rules:
- Never edit or propose edits to docs/adr/**, vendor/**, node_modules/**, dist/**,
third_party/**, generated/**, lock files, or *.min.js|css.
- Never propose an edit to an external URL.
- Prose only: change the doc, never the code that documents it.

Report each finding as a row: file, line, rule ("docs-vs-shipped-behavior"), evidence quoting
the doc and the shipped behavior, and a proposed prose-only fix. Report nothing when docs and
behavior agree. If shipped behavior is ambiguous, mark it "ask" and name the missing evidence.
```

### Axis 3: references

```text
You are the references axis of a report-only prose sweep. Basepoint: <ref>. Files selected by
the sweep: <files>. Pre-flight gate table (already settled, never re-report these): <gate
table>.

Find prose that names something that no longer exists: a deleted file, path, symbol, command,
flag, option, heading anchor, example, or section. lychee already reports broken local paths
and anchors; do not repeat those. Look for named artifacts that are not links: `--old-flag`,
`src/removed.ts`, `npm run gone`, a heading referred to by title.

Scope rules:
- Never edit or propose edits to docs/adr/**, vendor/**, node_modules/**, dist/**,
third_party/**, generated/**, lock files, or *.min.js|css.
- Never propose an edit to an external URL and never check one over the network.
- Prose only.

Report each finding as a row: file, line, rule ("stale-reference"), evidence quoting the
reference and the fact that it is gone, and a proposed prose-only fix. Report nothing when the
reference resolves. If the target may live outside this repo, mark it "ask".
```

### Axis 4: slop

```text
You are the slop axis of a report-only prose sweep. Basepoint: <ref>. Files selected by the
sweep: <files>. Pre-flight gate table (already settled, never re-report these): <gate table>.

Vale already reports banned words, empty adverbs, empty phrases, and the mechanically
detectable slop patterns below. Do not repeat a vale finding. Judge the patterns a linter
cannot prove and any remaining prose that reads as machine-written.

Words to cut. Banned outright: delve, foster, leverage, utilize, facilitate, empower,
streamline, robust, cutting-edge, paradigm shift, game changer, this is huge, this changes
everything, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount,
transformative, elevate, embark, supercharge, harness, ever-evolving. Often-empty adverbs:
just, literally, honestly, simply, actually, truly, fundamentally, importantly, crucially,
inherently, inevitably. Cut them when they add nothing; keep them when they carry emphasis,
uncertainty, contrast, or a spoken rhythm. Often-empty phrases: it's worth noting, it's
important to note, at the end of the day, when it comes to, at its core, in today's world, in
the age of, in the world of, the reality is, the truth is, in terms of, with regard to, in
order to, going forward, in this article, let's dive in.

Patterns to cut. Binary contrasts: "This is not X. It's Y." State Y directly. Throat-clearing
openers: "Here's the thing," "Let me be clear," "I'll be honest," "The uncomfortable truth is."
Cut them and state the point. Faux-insight setups: "This is the part most people skip," "What
most people get wrong," "Here's what nobody tells you." Cut the setup; make the claim stand
alone. Colon reveals: a noun phrase, a colon, then a lowercase dramatic reveal. Rewrite as a
plain sentence; colons are for lists, labels, and quotes. Superficial analysis: trailing -ing
clauses such as "highlighting," "underscoring," "reflecting," "showcasing" that pretend to
explain meaning. Replace with the consequence. Importance puffery: "stands as a testament,"
"marks a pivotal moment," "plays a vital role," "solidifies its position," "underscores its
significance." State the fact. Interpretive metadiscourse: "That last part matters more than it
sounds," "The key point is," "As you can see," "This distinction matters," redundant "In other
words." Delete the aside or support the point. Weasel attribution: "Experts agree," "industry
reports suggest," "many argue," "widely regarded as," "studies show." Name the source or cut
the claim. Fake-strong verbs: prefer "is" and "has" over "serves as a centralized hub"
constructions. Synonym cycling: do not rotate terms for style; repeat the clear word. Negative
listing: "Not a X. Not a Y. A Z." Just say Z. Dramatic fragmentation: "X. And Y. And Z." or
"That's it. That's the whole thing." Use complete sentences. Robotic rhythm: repeated sentence
shapes and identical paragraph structures. Vary only when it helps the point. Rhetorical
setups: "What if I told you...", "Think about it:", "Plot twist:", self-answered question
pairs. Drop them. Fake-profound kickers: a final cute metaphor, aphorism, or mic-drop line.
Delete it and end on the clearest concrete sentence. Summary-recap endings: "In conclusion,"
"Ultimately," "Overall," or a final paragraph that restates the piece. End on the last concrete
point or next action. Formatting slop: emoji in headings, mid-sentence bold for emphasis,
bullet lists where two sentences read better, headers over two-sentence sections. Em dashes: do
not use them as a default rhythm crutch; in short copy use none, in longer drafts 1-2 only when
they beat commas, periods, or parentheses.

Scope rules:
- Never edit or propose edits to docs/adr/**, vendor/**, node_modules/**, dist/**,
third_party/**, generated/**, lock files, or *.min.js|css.
- Never propose an edit to an external URL.
- Prose only. Preserve the writer's point and voice; make the minimum effective edit.

Report each finding as a row: file, line, rule ("slop"), evidence quoting the sentence, and a
proposed prose-only rewrite. Report nothing for prose that is already direct. Mark "ask" when
cutting the phrase would change meaning.
```

## 4. Merge and report

Collect the four axes' rows, add them to the pre-flight gate table under the
same file headings, and render one table:

```text
| Line | Tier | Rule | Evidence | Proposed fix |
```

Deterministic detector findings are Tier 2 in this report-only phase, alongside
agent findings. Keep skipped findings with a one-line reason. Keep anything you
could not evidence as "ask". Print the table and stop. Do not edit files.

## Apply rules for later phases

When apply exists, it may rewrite prose only: comments, docs, and markdown.
It must refuse every path listed under the exemption manifest. A finding whose
only fix touches code, a decision record, a vendored or generated file, or an
external URL stays a report row with a reason.
