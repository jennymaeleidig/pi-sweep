import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { FindingDraft } from "../contract.ts";
import type { CommandRunner } from "../exec.ts";

export interface JscpdInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
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

function repoPath(cwd: string, name: string): string {
  const relativePath = relative(cwd, resolve(cwd, name));
  return relativePath.split(sep).join("/");
}

function draftFor(
  clone: JscpdClone,
  self: JscpdFile,
  other: JscpdFile,
  cwd: string,
): FindingDraft {
  const file = repoPath(cwd, self.name);
  const otherFile = repoPath(cwd, other.name);
  return {
    file,
    line: self.start,
    rule: "duplicate-code",
    evidence: `${clone.lines} lines (${clone.tokens} tokens) duplicated with ${otherFile}:${other.start}-${other.end}`,
    detector: "jscpd",
    category: "duplication",
    proposedFix: `Extract the block shared with ${otherFile} or reference the existing implementation`,
  };
}

/** Normalize jscpd's JSON report into findings drafts. No tiering or apply policy. */
export async function detect(input: JscpdInput): Promise<FindingDraft[]> {
  if (input.files.length === 0) {
    return [];
  }

  const outputDir = await mkdtemp(join(tmpdir(), "pi-sweep-jscpd-"));
  const root = await realpath(input.cwd);
  try {
    const result = await input.runner(
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
      drafts.push(draftFor(clone, clone.firstFile, clone.secondFile, root));
      drafts.push(draftFor(clone, clone.secondFile, clone.firstFile, root));
    }
    return drafts;
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
