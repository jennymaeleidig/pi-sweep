import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FindingDraft } from "../contract.ts";
import type { CommandRunner } from "../exec.ts";
import { selectTestFiles } from "../test-paths.ts";

/** Versions pinned in mise.toml; a test keeps the two declarations honest. */
export const TOOL_VERSIONS = {
  eslint: "9.39.5",
  eslintPluginJest: "29.17.1",
  eslintPluginTestingLibrary: "7.16.3",
  typescriptEslintParser: "8.74.0",
} as const;

export interface EslintJestInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
  /** Override the generated flat config, mainly for tests. */
  configPath?: string;
}

export interface EslintJestAvailability {
  available: boolean;
  reason?: string;
}

interface EslintMessage {
  ruleId: string | null;
  line: number;
  column?: number;
  message: string;
  severity?: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

const RULE_MAP: Record<string, string> = {
  "jest/expect-expect": "expect-expect",
  "jest/no-conditional-expect": "no-conditional-expect",
  "jest/no-focused-tests": "no-focused-tests",
  "jest/no-disabled-tests": "no-disabled-tests",
  "jest/valid-expect": "valid-expect",
  "testing-library/no-container": "no-container",
  "testing-library/no-node-access": "no-node-access",
  "testing-library/no-debug": "no-debug",
};

const RULES: Record<string, "error"> = Object.fromEntries(
  Object.keys(RULE_MAP).map((rule) => [rule, "error"]),
);

const SETUP_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

function isJsOrTs(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path);
}

function packageDeclaresEslint(cwd: string): boolean {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) {
    return false;
  }
  try {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
      eslintConfig?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (manifest.eslintConfig) {
      return true;
    }
    return Boolean(
      manifest.dependencies?.eslint ?? manifest.devDependencies?.eslint,
    );
  } catch {
    return false;
  }
}

function hasEslintSetup(cwd: string): boolean {
  return (
    SETUP_FILES.some((name) => existsSync(join(cwd, name))) ||
    packageDeclaresEslint(cwd)
  );
}

function relevantFiles(files: string[]): string[] {
  return selectTestFiles(files).filter(isJsOrTs);
}

/**
 * Availability is explicit: a repo without JavaScript/TypeScript test files or
 * without an ESLint setup reports unavailable rather than a clean suite.
 */
export function checkSetup(input: Pick<EslintJestInput, "files" | "cwd">): EslintJestAvailability {
  if (relevantFiles(input.files).length === 0) {
    return { available: false, reason: "no JavaScript or TypeScript test files selected" };
  }
  if (!hasEslintSetup(input.cwd)) {
    return { available: false, reason: "no ESLint configuration or dependency found" };
  }
  return { available: true };
}

/** Probe the executable before the sweep, so a missing tool is not read as clean. */
export async function probe(input: EslintJestInput): Promise<EslintJestAvailability> {
  const setup = checkSetup(input);
  if (!setup.available) {
    return setup;
  }
  try {
    const result = await input.runner("eslint", ["--version"], { cwd: input.cwd });
    if (result.code !== 0) {
      return {
        available: false,
        reason: `eslint --version exited ${result.code}: ${result.stderr.trim()}`,
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildEslintConfigSource(): string {
  return [
    'import jest from "eslint-plugin-jest";',
    'import testingLibrary from "eslint-plugin-testing-library";',
    'import tsParser from "@typescript-eslint/parser";',
    "",
    "export default [",
    "  {",
    '    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],',
    "    plugins: { jest, \"testing-library\": testingLibrary },",
    "    languageOptions: {",
    "      parser: tsParser,",
    '      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },',
    "    },",
    `    rules: ${JSON.stringify(RULES, null, 2)},`,
    "  },",
    "];",
    "",
  ].join("\n");
}

function repoPath(cwd: string, filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  return relative(cwd, absolute).split(sep).join("/");
}

function draftFor(message: EslintMessage, file: string): FindingDraft {
  return {
    file,
    line: message.line,
    rule: RULE_MAP[message.ruleId ?? ""] ?? message.ruleId ?? "eslint-jest",
    evidence: message.message,
    detector: "eslint-jest",
    category: "assertion-hygiene",
  };
}

/** Normalize ESLint's JSON output into finding drafts. No tiering or apply policy. */
export async function detect(input: EslintJestInput): Promise<FindingDraft[]> {
  const setup = checkSetup(input);
  if (!setup.available) {
    throw new Error(`eslint-jest unavailable: ${setup.reason}`);
  }

  const files = relevantFiles(input.files);
  let configPath = input.configPath;
  let temporaryConfig: string | undefined;

  try {
    if (!configPath) {
      temporaryConfig = join(
        input.cwd,
        `.pi-sweep-eslint-${process.pid}-${Date.now()}.config.mjs`,
      );
      await writeFile(temporaryConfig, buildEslintConfigSource(), "utf8");
      configPath = temporaryConfig;
    }

    const result = await input.runner(
      "eslint",
      [
        "--no-config-lookup",
        "--config",
        configPath,
        "--format",
        "json",
        "--no-error-on-unmatched-pattern",
        ...files,
      ],
      { cwd: input.cwd },
    );

    let parsed: EslintFileResult[];
    try {
      parsed = JSON.parse(result.stdout) as EslintFileResult[];
    } catch {
      throw new Error(
        `eslint-jest failed (${result.code}): ${result.stderr.trim() || "unparseable JSON"}`,
      );
    }

    const drafts: FindingDraft[] = [];
    for (const file of parsed) {
      for (const message of file.messages) {
        if (message.ruleId && RULE_MAP[message.ruleId]) {
          drafts.push(draftFor(message, repoPath(input.cwd, file.filePath)));
        }
      }
    }
    return drafts;
  } finally {
    if (temporaryConfig) {
      await rm(temporaryConfig, { force: true });
    }
  }
}
