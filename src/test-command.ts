import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { miseExecArgs } from "./tools.ts";

export interface TestCommand {
  command: string;
  args: string[];
  source: "mise" | "manifest" | "framework";
  detail: string;
}

interface Manifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

function readText(cwd: string, path: string): string | null {
  try {
    return readFileSync(join(cwd, path), "utf8");
  } catch {
    return null;
  }
}

function readManifest(cwd: string): Manifest | null {
  const text = readText(cwd, "package.json");
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as Manifest;
  } catch {
    return null;
  }
}

function isTestTaskName(name: string): boolean {
  return name.replace(/["']/g, "").trim() === "test";
}

/** Find a `test` task in mise's TOML config without a TOML dependency. */
export function hasMiseTestTask(config: string): boolean {
  let section = "";
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    const headerText = header?.[1];
    if (headerText) {
      const parts = headerText.split(".").map((part) => part.trim());
      const taskName = parts[0] === "tasks" ? parts[1] : undefined;
      if (taskName !== undefined && isTestTaskName(taskName)) {
        return true;
      }
      section = parts.join(".");
      continue;
    }
    if (section === "tasks") {
      const key = /^["']?([A-Za-z0-9_-]+)["']?\s*[=:]/.exec(line)?.[1];
      if (key !== undefined && isTestTaskName(key)) {
        return true;
      }
    }
  }
  return false;
}

function resolveMiseTask(cwd: string): TestCommand | null {
  for (const file of ["mise.toml", ".mise.toml"]) {
    const config = readText(cwd, file);
    if (config !== null && hasMiseTestTask(config)) {
      return {
        command: "mise",
        args: ["run", "test"],
        source: "mise",
        detail: "mise task test",
      };
    }
  }
  return null;
}

function packageManager(cwd: string, manifest: Manifest | null): string {
  const declared = manifest?.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") {
    return declared;
  }
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  return "npm";
}

function resolveManifestScript(
  cwd: string,
  manifest: Manifest | null,
): TestCommand | null {
  const script = manifest?.scripts?.test;
  if (typeof script !== "string" || script.trim().length === 0) {
    return null;
  }
  return {
    command: packageManager(cwd, manifest),
    args: ["run", "test"],
    source: "manifest",
    detail: "package.json scripts.test",
  };
}

function existsAny(cwd: string, names: string[]): boolean {
  return names.some((name) => existsSync(join(cwd, name)));
}

function declaresDependency(manifest: Manifest | null, name: string): boolean {
  return Boolean(
    manifest?.dependencies?.[name] ?? manifest?.devDependencies?.[name],
  );
}

function resolveFramework(cwd: string, manifest: Manifest | null): TestCommand | null {
  if (
    declaresDependency(manifest, "vitest") ||
    existsAny(cwd, [
      "vitest.config.ts",
      "vitest.config.js",
      "vitest.config.mts",
      "vitest.config.mjs",
      "vitest.config.cts",
      "vitest.config.cjs",
    ])
  ) {
    return {
      command: "mise",
      args: miseExecArgs("npx", ["--no-install", "vitest", "run"]),
      source: "framework",
      detail: "vitest default",
    };
  }

  if (
    declaresDependency(manifest, "jest") ||
    existsAny(cwd, [
      "jest.config.ts",
      "jest.config.js",
      "jest.config.mts",
      "jest.config.mjs",
      "jest.config.cts",
      "jest.config.cjs",
      "jest.config.json",
    ])
  ) {
    return {
      command: "mise",
      args: miseExecArgs("npx", ["--no-install", "jest"]),
      source: "framework",
      detail: "jest default",
    };
  }

  const pyproject = readText(cwd, "pyproject.toml") ?? "";
  const tox = readText(cwd, "tox.ini") ?? "";
  if (
    existsAny(cwd, ["pytest.ini", "conftest.py"]) ||
    pyproject.includes("[tool.pytest") ||
    tox.includes("[pytest]")
  ) {
    return {
      command: "mise",
      args: miseExecArgs("pytest", []),
      source: "framework",
      detail: "pytest default",
    };
  }

  if (existsSync(join(cwd, "Cargo.toml"))) {
    return {
      command: "mise",
      args: miseExecArgs("cargo", ["test"]),
      source: "framework",
      detail: "cargo test default",
    };
  }

  return null;
}

/**
 * Resolve the repo's real suite: a declared mise task, then a package manifest
 * script, then a framework default. `null` means verification is impossible.
 */
export async function resolveTestCommand(
  cwd: string,
): Promise<TestCommand | null> {
  const miseTask = resolveMiseTask(cwd);
  if (miseTask) {
    return miseTask;
  }

  const manifest = readManifest(cwd);
  const script = resolveManifestScript(cwd, manifest);
  if (script) {
    return script;
  }

  return resolveFramework(cwd, manifest);
}
