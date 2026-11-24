import type { Finding, SweepCharter } from "./contract.ts";
import { isConfigPath, isProseFile, isProsePath, neverEditReason } from "./scope.ts";
import { isTestPath } from "./test-paths.ts";

const COMMENT_FINDING = /(?:^|[^a-z])(?:prose|comment|docstring|docs?)(?:[^a-z]|$)/i;

function isCommentFinding(finding: Finding | undefined): boolean {
  if (!finding) {
    return false;
  }
  return (
    COMMENT_FINDING.test(finding.category ?? "") ||
    COMMENT_FINDING.test(finding.detector)
  );
}

const DEFAULT_ALLOWS: Record<SweepCharter, (path: string) => boolean> = {
  code: (path) => !isTestPath(path) && !isProsePath(path) && !isConfigPath(path),
  test: (path) => isTestPath(path),
  prose: (path) => isProseFile(path),
};

const DEFAULT_REASON: Record<SweepCharter, (path: string) => string> = {
  code: (path) =>
    isTestPath(path)
      ? "test path"
      : isProsePath(path)
        ? "prose file"
        : "configuration file",
  test: () => "not a test path",
  prose: () => "not a prose file",
};

/** The path kinds each sweep is allowed to edit. */
export function charterAllows(
  charter: SweepCharter,
  path: string,
  finding?: Finding,
): boolean {
  if (neverEditReason(path) !== null) {
    return false;
  }
  if (DEFAULT_ALLOWS[charter](path)) {
    return true;
  }
  return charter === "prose" && isCommentFinding(finding) && !isTestPath(path);
}

/** Why a path falls outside a charter, or null when it belongs to it. */
export function charterReason(
  charter: SweepCharter,
  path: string,
  finding?: Finding,
): string | null {
  if (charterAllows(charter, path, finding)) {
    return null;
  }
  const outOfBounds = neverEditReason(path);
  if (outOfBounds !== null) {
    return outOfBounds;
  }
  return DEFAULT_REASON[charter](path);
}

/** Mark findings outside a charter skipped before the apply engine sees them. */
export function applyWithinCharter(
  charter: SweepCharter,
  findings: Finding[],
): Finding[] {
  return findings.map((finding) => {
    const reason = charterReason(charter, finding.file, finding);
    if (reason === null) {
      return finding;
    }
    return {
      ...finding,
      action: "skip",
      reason: `outside the ${charter} sweep's charter (${reason})`,
    };
  });
}
