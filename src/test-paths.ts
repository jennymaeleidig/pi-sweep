const TEST_DIRECTORY =
  /(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|integration-tests?|cypress|playwright)(\/|$)/i;

const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(test_.*\.py|.*_test\.py|conftest\.py)$/i;

/** A path belongs to the test suite when it lives in a test directory or is named as a test. */
export function isTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return TEST_DIRECTORY.test(normalized) || TEST_FILE.test(normalized);
}

export function selectTestFiles(files: string[]): string[] {
  return files.filter((file) => isTestPath(file));
}
