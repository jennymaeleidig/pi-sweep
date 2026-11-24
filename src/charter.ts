import type { Finding, SweepCharter } from "./contract.ts";
import { isProseFile, isProsePath, neverEditReason } from "./scope.ts";
import { isTestPath } from "./test-paths.ts";

/** The path kinds each sweep is allowed to edit. */
export function charterAllows(charter: SweepCharter, path: string): boolean {
  if (neverEditReason(path) !== null) {
    return false;
  }
  if (charter === "test") {
    return isTestPath(path);
  }
  if (charter === "prose") {
    return isProseFile(path);
  }
  return !isTestPath(path) && !isProsePath(path);
}

/** Why a path falls outside a charter, or null when it belongs to it. */
export function charterReason(charter: SweepCharter, path: string): string | null {
  if (charterAllows(charter, path)) {
    return null;
  }
  const outOfBounds = neverEditReason(path);
  if (outOfBounds !== null) {
    return outOfBounds;
  }
  if (charter === "test") {
    return "not a test path";
  }
  if (charter === "prose") {
    return "not a prose file";
  }
  return isTestPath(path) ? "test path" : "prose file";
}

/** Mark findings outside a charter skipped before the apply engine sees them. */
export function applyWithinCharter(
  charter: SweepCharter,
  findings: Finding[],
): Finding[] {
  return findings.map((finding) => {
    const reason = charterReason(charter, finding.file);
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
