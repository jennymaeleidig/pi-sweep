import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DetectorInput, FindingDraft } from "../contract.ts";
import { repoPath } from "../paths.ts";
import { runTool } from "../tools.ts";

export interface JscpdInput extends DetectorInput {
  minTokens?: number;
  minLines?: number;
}

interface JscpdFile {
  name: string;
  start: number;
  end: number;
}

interface JscpdClone {
  firstFile: JscpdFile;
  secondFile: JscpdFile;
  lines: number;
  tokens: number;
}

interface JscpdReport {
  duplicates: JscpdClone[];
}

function fragmentText(content: string, start: number, end: number): string | undefined {
  const lines = content.split("\n");
  if (start < 1 || end < start || start > lines.length) {
    return undefined;
  }
  const selected = lines.slice(start - 1, end);
  if (selected.length === 0) {
    return undefined;
  }
  const trailing = end < lines.length ? "\n" : "";
  return `${selected.join("\n")}${trailing}`;
}

async function readFragment(
  cwd: string,
  file: string,
  start: number,
  end: number,
): Promise<string | undefined> {
  try {
    return fragmentText(await readFile(resolve(cwd, file), "utf8"), start, end);
  } catch {
    return undefined;
  }
}

function isLater(self: JscpdFile, other: JscpdFile, cwd: string): boolean {
  const selfFile = repoPath(cwd, self.name);
  const otherFile = repoPath(cwd, other.name);
  if (selfFile !== otherFile) {
    return selfFile > otherFile;
  }
  return self.start > other.start;
}

function draftFor(
  clone: JscpdClone,
  self: JscpdFile,
  other: JscpdFile,
  cwd: string,
  edit?: { oldText: string; newText: string },
): FindingDraft {
  const file = repoPath(cwd, self.name);
  const otherFile = repoPath(cwd, other.name);
  const draft: FindingDraft = {
    file,
    line: self.start,
    rule: "duplicate-code",
    evidence: `${clone.lines} lines (${clone.tokens} tokens) duplicated with ${otherFile}:${other.start}-${other.end}`,
    detector: "jscpd",
    evidenceClass: "machine",
    category: "duplication",
    metrics: { tokens: clone.tokens, lines: clone.lines },
    proposedFix: `Extract the block shared with ${otherFile} or reference the existing implementation`,
  };
  return edit ? { ...draft, edit } : draft;
}

/** Normalize jscpd's JSON report into findings drafts. No tiering or apply policy. */
export async function detect(input: JscpdInput): Promise<FindingDraft[]> {
  if (input.files.length === 0) {
    return [];
  }

  const outputDir = await mkdtemp(join(tmpdir(), "pi-sweep-jscpd-"));
  const root = await realpath(input.cwd);
  try {
    const result = await runTool(
      input.runner,
      "jscpd",
      [
        "--pattern",
        "**/*",
        "--absolute",
        "--silent",
        "--reporters",
        "json",
        "--output",
        outputDir,
        "--min-tokens",
        String(input.minTokens ?? 10),
        "--min-lines",
        String(input.minLines ?? 3),
        ...input.files.map((file) => resolve(root, file)),
      ],
      { cwd: input.cwd },
    );

    if (result.code !== 0) {
      throw new Error(`jscpd failed (${result.code}): ${result.stderr.trim()}`);
    }

    const report = JSON.parse(
      await readFile(join(outputDir, "jscpd-report.json"), "utf8"),
    ) as JscpdReport;

    const drafts: FindingDraft[] = [];
    for (const clone of report.duplicates ?? []) {
      const firstLater = isLater(clone.firstFile, clone.secondFile, root);
      const later = firstLater ? clone.firstFile : clone.secondFile;
      const laterFragment = await readFragment(root, later.name, later.start, later.end);
      drafts.push(
        draftFor(
          clone,
          clone.firstFile,
          clone.secondFile,
          root,
          firstLater && laterFragment
            ? { oldText: laterFragment, newText: "" }
            : undefined,
        ),
      );
      drafts.push(
        draftFor(
          clone,
          clone.secondFile,
          clone.firstFile,
          root,
          !firstLater && laterFragment
            ? { oldText: laterFragment, newText: "" }
            : undefined,
        ),
      );
    }
    return drafts;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
