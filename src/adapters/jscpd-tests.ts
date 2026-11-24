import type { DetectorInput, FindingDraft } from "../contract.ts";
import { selectTestFiles } from "../test-paths.ts";
import { detect as detectJscpd } from "./jscpd.ts";

export const TEST_DUPLICATION_MIN_TOKENS = 70;
export const TEST_DUPLICATION_MIN_LINES = 5;

export interface JscpdTestsInput extends DetectorInput {
  minTokens?: number;
  minLines?: number;
}

/**
 * Run jscpd over the selected test files only, with thresholds tuned for the
 * small duplicated permutations that agents add to a test suite.
 */
export async function detect(input: JscpdTestsInput): Promise<FindingDraft[]> {
  const files = selectTestFiles(input.files);
  if (files.length === 0) {
    return [];
  }
  return detectJscpd({
    files,
    cwd: input.cwd,
    runner: input.runner,
    minTokens: input.minTokens ?? TEST_DUPLICATION_MIN_TOKENS,
    minLines: input.minLines ?? TEST_DUPLICATION_MIN_LINES,
  });
}
