import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandRunner } from "./exec.ts";
import { isProseFile } from "./scope.ts";

export interface RenameInput {
  cwd: string;
  runner: CommandRunner;
  base: string;
}

export interface RenamedPublicName {
  file: string;
  oldName: string;
  newName: string;
}

export interface RenameExpansion {
  file: string;
  oldName: string;
  newName: string;
  evidence: string;
}

export interface RenameExpansionResult {
  files: string[];
  expansions: RenameExpansion[];
  renames: RenamedPublicName[];
}

const EXPORTED_DECL =
  /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;

interface Hunk {
  removed: string[];
  added: string[];
}

interface FileDiff {
  file: string;
  hunks: Hunk[];
}

function exportedName(line: string): string | undefined {
  return EXPORTED_DECL.exec(line)?.[1];
}

function targetPath(line: string): string | undefined {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    const value = line.slice(4).split("\t")[0] ?? "";
    if (value === "/dev/null") {
      return undefined;
    }
    return value.replace(/^[ab]\//, "");
  }
  return undefined;
}

function parseDiff(output: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let hunk: Hunk | undefined;

  const closeHunk = () => {
    if (current && hunk && (hunk.removed.length > 0 || hunk.added.length > 0)) {
      current.hunks.push(hunk);
    }
    hunk = undefined;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      closeHunk();
      current = undefined;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const file = targetPath(line);
      if (file) {
        current = { file, hunks: [] };
        files.push(current);
      } else {
        current = undefined;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      closeHunk();
      if (current) {
        hunk = { removed: [], added: [] };
      }
      continue;
    }
    if (!current || !hunk) {
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      const name = exportedName(line.slice(1));
      if (name) {
        hunk.removed.push(name);
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const name = exportedName(line.slice(1));
      if (name) {
        hunk.added.push(name);
      }
    }
  }
  closeHunk();
  return files;
}

function uniqueRenames(renames: RenamedPublicName[]): RenamedPublicName[] {
  const seen = new Set<string>();
  return renames.filter((rename) => {
    const key = `${rename.file}\0${rename.oldName}\0${rename.newName}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Pair removed and added exported names by position, hunks first, then file. */
export function parseRenameDiff(output: string): RenamedPublicName[] {
  const renames: RenamedPublicName[] = [];
  for (const file of parseDiff(output)) {
    const removed = file.hunks.flatMap((hunk) => hunk.removed);
    const added = file.hunks.flatMap((hunk) => hunk.added);
    const usedRemoved = new Set<number>();
    const usedAdded = new Set<number>();
    let removedOffset = 0;
    let addedOffset = 0;

    for (const hunk of file.hunks) {
      const count = Math.min(hunk.removed.length, hunk.added.length);
      for (let index = 0; index < count; index += 1) {
        const removedIndex = removedOffset + index;
        const addedIndex = addedOffset + index;
        const oldName = removed[removedIndex];
        const newName = added[addedIndex];
        usedRemoved.add(removedIndex);
        usedAdded.add(addedIndex);
        if (oldName && newName && oldName !== newName) {
          renames.push({ file: file.file, oldName, newName });
        }
      }
      removedOffset += hunk.removed.length;
      addedOffset += hunk.added.length;
    }

    const remainingRemoved = removed
      .map((name, index) => ({ name, index }))
      .filter((entry) => !usedRemoved.has(entry.index));
    const remainingAdded = added
      .map((name, index) => ({ name, index }))
      .filter((entry) => !usedAdded.has(entry.index));
    const remaining = Math.min(remainingRemoved.length, remainingAdded.length);
    for (let index = 0; index < remaining; index += 1) {
      const oldName = remainingRemoved[index]?.name;
      const newName = remainingAdded[index]?.name;
      if (oldName && newName && oldName !== newName) {
        renames.push({ file: file.file, oldName, newName });
      }
    }
  }
  return uniqueRenames(renames);
}

async function git(
  cwd: string,
  runner: CommandRunner,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runner("git", args, { cwd });
}

async function renameDiff(
  input: RenameInput,
  args: string[],
): Promise<string> {
  const result = await git(input.cwd, input.runner, [
    "diff",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    ...args,
    "--",
  ]);
  if (result.code !== 0) {
    throw new Error(`git diff failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Find public names that a committed, staged, or unstaged diff replaces. */
export async function detectRenamedPublicNames(
  input: RenameInput,
): Promise<RenamedPublicName[]> {
  const diffs = await Promise.all([
    renameDiff(input, [input.base, "HEAD"]),
    renameDiff(input, ["--cached"]),
    renameDiff(input, []),
  ]);
  return parseRenameDiff(diffs.join("\n"));
}

async function proseMentions(
  input: RenameInput,
  rename: RenamedPublicName,
): Promise<string[]> {
  const result = await git(input.cwd, input.runner, [
    "grep",
    "-l",
    "-F",
    "-e",
    rename.oldName,
    "-e",
    rename.newName,
    "--",
  ]);
  if (result.code === 1) {
    return [];
  }
  if (result.code !== 0) {
    throw new Error(`git grep failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Add existing prose that names a renamed public name, so drift outside the
 * diff joins the prose sweep. Missing paths are never added.
 */
export async function renameAwareProseFiles(
  input: RenameInput,
): Promise<RenameExpansionResult> {
  const renames = await detectRenamedPublicNames(input);
  const files = new Set<string>();
  const expansions: RenameExpansion[] = [];
  const seen = new Set<string>();

  for (const rename of renames) {
    for (const file of await proseMentions(input, rename)) {
      if (!isProseFile(file) || !existsSync(resolve(input.cwd, file))) {
        continue;
      }
      files.add(file);
      const key = `${file}\0${rename.oldName}\0${rename.newName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      expansions.push({
        file,
        oldName: rename.oldName,
        newName: rename.newName,
        evidence: `prose names the renamed public name ${rename.oldName} -> ${rename.newName}`,
      });
    }
  }

  return {
    files: [...files].sort(),
    expansions: expansions.sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.oldName.localeCompare(right.oldName) ||
        left.newName.localeCompare(right.newName),
    ),
    renames,
  };
}
