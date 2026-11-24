import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandRunner } from "./exec.ts";
import { unique } from "./paths.ts";

export interface DiffInput {
  cwd: string;
  runner: CommandRunner;
  base?: string;
  fullAudit?: boolean;
}

export interface DiffSelection {
  mode: "diff" | "full";
  baseRef: string | null;
  resolvedBase: string | null;
  files: string[];
  /** Old paths of renames, kept for prose expansion without sweeping missing files. */
  renamedFrom: string[];
}

async function git(
  cwd: string,
  runner: CommandRunner,
  args: string[],
): Promise<string> {
  const result = await runner("git", args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Resolve a SHA, branch, tag, or `merge-base:<ref>` to a commit SHA. */
export async function resolveBasepoint(
  base: string,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  if (base.startsWith("merge-base:")) {
    const ref = base.slice("merge-base:".length).trim();
    if (!ref) {
      throw new Error("merge-base basepoint needs a ref, for example merge-base:main");
    }
    const sha = (await git(cwd, runner, ["merge-base", ref, "HEAD"])).trim();
    if (!sha) {
      throw new Error(`no merge base between ${ref} and HEAD`);
    }
    return sha;
  }
  return (await git(cwd, runner, ["rev-parse", "--verify", `${base}^{commit}`])).trim();
}

interface NameStatus {
  paths: string[];
  renamedFrom: string[];
}

function parseNameStatus(output: string): NameStatus {
  const paths: string[] = [];
  const renamedFrom: string[] = [];
  const tokens = output.split("\0");
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    if (!status) {
      index += 1;
      continue;
    }
    const kind = status[0];
    const firstPath = tokens[index + 1];
    index += 2;
    if (!firstPath) {
      break;
    }
    if (kind === "R" || kind === "C") {
      const secondPath = tokens[index];
      index += 1;
      if (secondPath) {
        paths.push(secondPath);
      }
      if (kind === "R") {
        renamedFrom.push(firstPath);
      }
      continue;
    }
    if (kind === "D") {
      continue;
    }
    paths.push(firstPath);
  }
  return { paths, renamedFrom };
}

function parsePaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

function existing(cwd: string, paths: string[]): string[] {
  return paths.filter((path) => existsSync(resolve(cwd, path)));
}

async function diffNames(
  cwd: string,
  runner: CommandRunner,
  args: string[],
): Promise<NameStatus> {
  return parseNameStatus(await git(cwd, runner, ["diff", "--name-status", "-z", "-M", ...args]));
}

export async function selectFiles(input: DiffInput): Promise<DiffSelection> {
  const { cwd, runner } = input;

  if (input.fullAudit) {
    const tracked = parsePaths(
      await git(cwd, runner, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    );
    return {
      mode: "full",
      baseRef: null,
      resolvedBase: null,
      files: unique(existing(cwd, tracked)),
      renamedFrom: [],
    };
  }

  const baseRef = input.base ?? "HEAD";
  const resolvedBase = await resolveBasepoint(baseRef, cwd, runner);

  const committed = await diffNames(cwd, runner, [`${resolvedBase}`, "HEAD"]);
  const staged = await diffNames(cwd, runner, ["--cached"]);
  const unstaged = await diffNames(cwd, runner, []);
  const untracked = parsePaths(
    await git(cwd, runner, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );

  const changed = [
    ...committed.paths,
    ...staged.paths,
    ...unstaged.paths,
    ...untracked,
  ];

  return {
    mode: "diff",
    baseRef,
    resolvedBase,
    files: unique(existing(cwd, changed)),
    renamedFrom: unique([...committed.renamedFrom, ...staged.renamedFrom, ...unstaged.renamedFrom]),
  };
}
