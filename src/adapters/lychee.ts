import { existsSync, readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FindingDraft } from "../contract.ts";
import type { CommandRunner } from "../exec.ts";
import { selectProseFiles } from "../scope.ts";

export interface LycheeInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
  /** Defaults to the repo's .lycheeignore, then the bundled one. */
  excludeFile?: string;
}

interface LycheeSpan {
  line: number;
  column: number;
}

interface LycheeStatus {
  text: string;
  details?: string;
}

interface LycheeLink {
  url: string;
  status: LycheeStatus;
  span: LycheeSpan;
}

interface LycheeReport {
  error_map?: Record<string, LycheeLink[]>;
}

const bundledIgnore = fileURLToPath(new URL("../../.lycheeignore", import.meta.url));

function ignorePatterns(input: LycheeInput): string[] {
  const path = input.excludeFile ?? localIgnore(input.cwd);
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function localIgnore(cwd: string): string {
  const local = resolve(cwd, ".lycheeignore");
  return existsSync(local) ? local : bundledIgnore;
}

function repoPath(cwd: string, path: string): string {
  return relative(cwd, resolve(cwd, path)).split(sep).join("/");
}

function ruleFor(status: LycheeStatus): string {
  if (/fragment/i.test(status.text)) {
    return "broken-anchor";
  }
  if (/file not found|not found/i.test(status.text)) {
    return "broken-path";
  }
  return "broken-link";
}

function draftFor(cwd: string, file: string, link: LycheeLink): FindingDraft {
  const rule = ruleFor(link.status);
  return {
    file: repoPath(cwd, file),
    line: link.span.line,
    rule,
    evidence: `${link.url}: ${link.status.text}`,
    detector: "lychee",
    category: "references",
    proposedFix:
      rule === "broken-anchor"
        ? "Point the anchor at an existing heading or remove the fragment"
        : "Point the link at an existing local file or remove it",
  };
}

/**
 * Normalize lychee's JSON report into drafts. Runs offline with external URLs
 * excluded, so only local paths and anchors are checked. No tiering policy.
 */
export async function detect(input: LycheeInput): Promise<FindingDraft[]> {
  const files = selectProseFiles(input.files);
  if (files.length === 0) {
    return [];
  }

  const result = await input.runner(
    "lychee",
    [
      "--offline",
      "--no-progress",
      "--format",
      "json",
      "--include-fragments=anchor-only",
      ...ignorePatterns(input).flatMap((pattern) => ["--exclude", pattern]),
      ...files,
    ],
    { cwd: input.cwd },
  );

  if (result.code !== 0 && result.code !== 2) {
    throw new Error(`lychee failed (${result.code}): ${result.stderr.trim()}`);
  }

  const report = JSON.parse(result.stdout || "{}") as LycheeReport;
  const drafts: FindingDraft[] = [];
  for (const [file, links] of Object.entries(report.error_map ?? {})) {
    for (const link of links) {
      drafts.push(draftFor(input.cwd, file, link));
    }
  }
  return drafts;
}
