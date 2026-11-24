import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Normalize a tool-reported path to a repo-relative POSIX path. */
export function repoPath(cwd: string, path: string): string {
  let candidate = path.trim();
  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return "";
    }
  }
  if (!candidate) {
    return "";
  }
  const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  return relative(cwd, absolute).split(sep).join("/");
}

/** Sorted, de-duplicated copy of a string list. */
export function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
