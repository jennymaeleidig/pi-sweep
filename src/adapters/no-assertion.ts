import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DetectorInput, FindingDraft } from "../contract.ts";
import { selectTestFiles } from "../test-paths.ts";

export interface NoAssertionInput extends DetectorInput {}

export interface HookStatus {
  available: boolean;
  reason?: string;
  files: string[];
}

export const MANAGED_MARKER = "MANAGED BY pi-sweep";

export const NO_ASSERTION_HOOK_ENV = "PI_SWEEP_NO_ASSERTION_HOOK";

const HOOK_CANDIDATES = [
  "hooks/vitest-no-assertion/setup.ts",
  "hooks/pytest-no-assertion/conftest.py",
  "test/no-assertion/setup.ts",
  "tests/no-assertion/setup.ts",
  "vitest.setup.ts",
  "vitest.setup.mts",
  "test/setup.ts",
  "tests/setup.ts",
  "conftest.py",
  "tests/conftest.py",
];

const JS_TEST = /\b(?:it|test)(?:\.(?:each|only|concurrent))*\s*\(/g;
const JS_ASSERTION = /\b(?:expect|assert)\s*[.(]/;
const PY_TEST = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/;
const PY_ASSERTION = /^\s*(?:assert\b|.*\bassert\w*\s*\(|.*\bpytest\.raises\s*\()/;

function isTestSource(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py)$/.test(file);
}

/**
 * Locate a managed no-assertion hook so an absent hook is never read as
 * clean. The `PI_SWEEP_NO_ASSERTION_HOOK` env override (absolute or
 * repo-relative) is consulted first, then any caller-declared paths, then
 * the default candidates.
 */
export function hookStatus(
  cwd: string,
  hookPaths: string[] = [],
  env: Record<string, string | undefined> = process.env,
): HookStatus {
  const envPath = env[NO_ASSERTION_HOOK_ENV];
  const candidates = [
    ...(envPath ? [envPath] : []),
    ...hookPaths,
    ...HOOK_CANDIDATES,
  ];
  const files = candidates.filter((file) => {
    const path = join(cwd, file);
    if (!existsSync(path)) {
      return false;
    }
    try {
      return readFileSync(path, "utf8").includes(MANAGED_MARKER);
    } catch {
      return false;
    }
  });
  if (files.length > 0) {
    return { available: true, files };
  }
  return {
    available: false,
    files: [],
    reason:
      "managed no-assertion hook is absent; install hooks/vitest-no-assertion or hooks/pytest-no-assertion",
  };
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function jsBody(source: string, open: number): string {
  const brace = source.indexOf("{", open);
  const paren = source.indexOf(")", open);
  if (brace === -1 || (paren !== -1 && paren < brace)) {
    const end = source.indexOf(");", open);
    return source.slice(open, end === -1 ? source.length : end);
  }
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(brace, index + 1);
      }
    }
  }
  return source.slice(brace);
}

function jsFindings(file: string, source: string): FindingDraft[] {
  const findings: FindingDraft[] = [];
  for (const match of source.matchAll(JS_TEST)) {
    const token = match[0];
    if (/\.(?:skip|todo)\b/.test(token)) {
      continue;
    }
    const open = (match.index ?? 0) + token.length;
    const body = jsBody(source, open);
    if (JS_ASSERTION.test(body)) {
      continue;
    }
    findings.push({
      file,
      line: lineAt(source, match.index ?? 0),
      rule: "no-assertion",
      evidence: "test block has no assertion call",
      detector: "no-assertion",
      evidenceClass: "machine",
      category: "assertion-hygiene",
      proposedFix: "Add an assertion or mark the test skip/todo",
    });
  }
  return findings;
}

function pyFindings(file: string, source: string): FindingDraft[] {
  const lines = source.split(/\r?\n/);
  const findings: FindingDraft[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = PY_TEST.exec(lines[index] ?? "");
    if (!match) {
      continue;
    }
    const indent = match[1]?.length ?? 0;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? "";
      if (line.trim().length === 0) {
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) {
        break;
      }
      body.push(line);
    }
    if (body.some((line) => PY_ASSERTION.test(line))) {
      continue;
    }
    findings.push({
      file,
      line: index + 1,
      rule: "no-assertion",
      evidence: `${match[2] ?? "test"} has no assertion`,
      detector: "no-assertion",
      evidenceClass: "machine",
      category: "assertion-hygiene",
      proposedFix: "Add an assertion or mark the test pytest.skip",
    });
  }
  return findings;
}

/** Flag test functions that contain no assertion call. */
export async function detect(input: NoAssertionInput): Promise<FindingDraft[]> {
  const files = selectTestFiles(input.files).filter(isTestSource);
  const findings: FindingDraft[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(input.cwd, file), "utf8");
    } catch {
      continue;
    }
    findings.push(
      ...(/\.py$/.test(file) ? pyFindings(file, source) : jsFindings(file, source)),
    );
  }
  return findings;
}
