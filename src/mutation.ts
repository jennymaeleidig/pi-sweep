import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { FindingDraft } from "./contract.ts";
import type { CommandRunner } from "./exec.ts";

/**
 * Mutation testing is opt-in per repository: a declared mise task runs it on a
 * per-PR or nightly cadence, and the sweep only ingests the JSON report it
 * leaves behind. Nothing here ever runs a mutation tool.
 */

export type MutationTool = "stryker" | "mutmut" | "cargo-mutants" | "unknown";

export interface MutationTask {
  name: string;
  source: "mise";
  reportPaths: string[];
}

export interface MutationSurvivor {
  file: string;
  line: number;
  mutator: string;
  status: string;
  replacement?: string;
}

export interface MutationReport {
  tool: MutationTool;
  path: string;
  mtimeMs: number;
  /** Every file the report actually covered with at least one mutant. */
  files: string[];
  survivors: MutationSurvivor[];
  /** Covered files with no surviving mutant; only a fresh report produces these. */
  cleanFiles: string[];
}

export type MutationStatus = "fresh" | "stale" | "absent" | "unknown-shape";

export interface MutationEvidence {
  status: MutationStatus;
  reason?: string;
  checkedAt: number;
  report?: MutationReport;
  findings: FindingDraft[];
  cleanFiles: string[];
}

/** Report locations the supported tools write by convention. */
export const CONVENTIONAL_REPORT_PATHS = [
  "reports/mutation/mutation.json",
  "reports/mutation-report.json",
  "mutation-report.json",
  "mutants/mutmut.json",
  "mutmut.json",
  "mutants.out/outcomes.json",
  "mutants.json",
] as const;

export const MUTATION_RULE = "mutation-survived";

const MUTATION_TASK = /^mutation(:|$)/;
const REPORT_PATH_ENV = /(?:PI_SWEEP_)?MUTATION_REPORT\s*=\s*["']([^"']+)["']/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function survivorStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  if (/surviv|missed|no.?coverage|suspicious/.test(normalized)) {
    return true;
  }
  if (
    /kill|caught|detected|timeout|compile|runtime|error|ignored|unviable|success|complete/.test(
      normalized,
    )
  ) {
    return false;
  }
  // An unrecognized status is never evidence of a clean file.
  return true;
}

function survivor(
  file: string,
  line: number | undefined,
  mutator: string | undefined,
  status: string,
  replacement: string | undefined,
): MutationSurvivor {
  return {
    file,
    line: line && line > 0 ? line : 1,
    mutator: mutator ?? "mutant",
    status,
    ...(replacement ? { replacement } : {}),
  };
}

/** Parse a mise config enough to find a mutation task and its report path. */
export function parseMiseMutationTasks(config: string): MutationTask[] {
  const tasks = new Map<string, MutationTask>();
  let headerTask: string | undefined;
  let headerTagged = false;
  let tasksTable = false;

  const flush = (): void => {
    if (headerTask === undefined) {
      return;
    }
    const name = headerTask;
    if (MUTATION_TASK.test(name) || headerTagged) {
      const existing = tasks.get(name);
      tasks.set(name, {
        name,
        source: "mise",
        reportPaths: existing?.reportPaths ?? [],
      });
    }
    headerTask = undefined;
    headerTagged = false;
  };

  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    const headerText = header?.[1];
    if (headerText) {
      flush();
      const parts = headerText.split(".").map((part) => part.trim());
      tasksTable = parts.length === 1 && parts[0] === "tasks";
      if (parts[0] === "tasks" && parts[1] !== undefined) {
        const name = parts[1].replace(/^["']|["']$/g, "");
        headerTask = name;
        headerTagged = false;
      }
      continue;
    }
    if (tasksTable && headerTask === undefined) {
      const key = /^["']?([A-Za-z0-9_:-]+)["']?\s*[=:]/.exec(line)?.[1];
      if (key !== undefined && MUTATION_TASK.test(key)) {
        tasks.set(key, { name: key, source: "mise", reportPaths: [] });
      }
      continue;
    }
    if (headerTask === undefined) {
      continue;
    }
    const tag = /^tags?\s*=\s*(.+)$/.exec(line)?.[1];
    if (tag && /["']mutation["']/.test(tag)) {
      headerTagged = true;
    }
  }
  flush();

  const reportPaths = [...config.matchAll(REPORT_PATH_ENV)].map((match) => match[1]!);
  return [...tasks.values()].map((task) => ({
    name: task.name,
    source: "mise",
    reportPaths: [...new Set(reportPaths)],
  }));
}

export async function discoverMutationTask(
  cwd: string,
  files: string[] = ["mise.toml", ".mise.toml"],
): Promise<MutationTask | null> {
  for (const file of files) {
    const path = join(cwd, file);
    if (!existsSync(path)) {
      continue;
    }
    const config = readFileSync(path, "utf8");
    const tasks = parseMiseMutationTasks(config);
    if (tasks.length > 0) {
      return tasks[0]!;
    }
    if ([...config.matchAll(REPORT_PATH_ENV)].length > 0) {
      return {
        name: "mutation",
        source: "mise",
        reportPaths: [...new Set([...config.matchAll(REPORT_PATH_ENV)].map((m) => m[1]!))],
      };
    }
  }
  return null;
}

interface ParsedMutation {
  tool: MutationTool;
  files: string[];
  survivors: MutationSurvivor[];
}

function parseStryker(value: unknown): ParsedMutation | null {
  if (!isRecord(value) || !isRecord(value.files)) {
    return null;
  }
  const files: string[] = [];
  const survivors: MutationSurvivor[] = [];
  let strykerShape = false;

  for (const [file, entry] of Object.entries(value.files)) {
    if (!isRecord(entry)) {
      continue;
    }
    const mutants = asArray(entry.mutants);
    if (mutants.length === 0) {
      continue;
    }
    const normalized = normalizeFile(file);
    files.push(normalized);
    for (const raw of mutants) {
      if (!isRecord(raw)) {
        continue;
      }
      if ("mutatorName" in raw || "location" in raw) {
        strykerShape = true;
      }
      const status = asString(raw.status) ?? "unknown";
      if (!survivorStatus(status)) {
        continue;
      }
      const location = isRecord(raw.location) ? raw.location : undefined;
      const start = location && isRecord(location.start) ? location.start : undefined;
      survivors.push(
        survivor(
          normalized,
          asNumber(start?.line) ?? asNumber(raw.line),
          asString(raw.mutatorName) ?? asString(raw.mutator),
          status,
          asString(raw.replacement),
        ),
      );
    }
  }

  return strykerShape ? { tool: "stryker", files, survivors } : null;
}

function cargoMutant(raw: Record<string, unknown>): Record<string, unknown> {
  const scenario = isRecord(raw.scenario) ? raw.scenario : undefined;
  if (scenario) {
    if (isRecord(scenario.Mutant)) {
      return scenario.Mutant;
    }
    if (isRecord(scenario.mutant)) {
      return scenario.mutant;
    }
  }
  return raw;
}

function parseCargoMutants(value: unknown): ParsedMutation | null {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value)
      ? asArray(value.outcomes)
      : [];
  if (entries.length === 0) {
    return null;
  }
  const cargoShape = entries.some(
    (entry) => isRecord(entry) && ("scenario" in entry || "summary" in entry),
  );
  if (!cargoShape) {
    return null;
  }

  const files: string[] = [];
  const survivors: MutationSurvivor[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const mutant = cargoMutant(entry);
    const file = asString(mutant.file) ?? asString(entry.file);
    if (!file) {
      continue;
    }
    const normalized = normalizeFile(file);
    files.push(normalized);
    const span = isRecord(mutant.span) ? mutant.span : undefined;
    const start = span && isRecord(span.start) ? span.start : undefined;
    const status =
      asString(entry.summary) ?? asString(entry.outcome) ?? asString(mutant.status) ?? "unknown";
    if (!survivorStatus(status)) {
      continue;
    }
    survivors.push(
      survivor(
        normalized,
        asNumber(start?.line) ?? asNumber(mutant.line),
        asString(mutant.name) ?? asString(mutant.function),
        status,
        asString(mutant.replacement),
      ),
    );
  }
  return { tool: "cargo-mutants", files, survivors };
}

interface MutantEntry {
  file?: string;
  raw: Record<string, unknown>;
}

function collectMutantEntries(value: unknown): MutantEntry[] {
  const entries: MutantEntry[] = [];
  const push = (raw: unknown, file?: string): void => {
    if (isRecord(raw)) {
      entries.push({ ...(file ? { file } : {}), raw });
    }
  };

  if (Array.isArray(value)) {
    for (const raw of value) {
      push(raw);
    }
    return entries;
  }
  if (!isRecord(value)) {
    return entries;
  }
  if (Array.isArray(value.mutants)) {
    for (const raw of value.mutants) {
      push(raw);
    }
    return entries;
  }
  const map = isRecord(value.mutants)
    ? value.mutants
    : isRecord(value.files)
      ? value.files
      : undefined;
  if (map) {
    for (const [file, list] of Object.entries(map)) {
      for (const raw of asArray(list)) {
        push(raw, file);
      }
    }
  }
  return entries;
}

function parseMutmut(value: unknown): ParsedMutation | null {
  const entries = collectMutantEntries(value);
  if (entries.length === 0) {
    return null;
  }
  const files: string[] = [];
  const survivors: MutationSurvivor[] = [];
  for (const { file, raw } of entries) {
    const resolved = normalizeFile(
      asString(raw.file_path) ??
        asString(raw.file) ??
        asString(raw.filename) ??
        asString(raw.path) ??
        file ??
        "",
    );
    if (!resolved) {
      continue;
    }
    files.push(resolved);
    const status = asString(raw.status) ?? asString(raw.outcome) ?? asString(raw.result) ?? "unknown";
    if (!survivorStatus(status)) {
      continue;
    }
    survivors.push(
      survivor(
        resolved,
        asNumber(raw.line) ?? asNumber(raw.line_number) ?? asNumber(raw.lineNumber),
        asString(raw.mutator) ?? asString(raw.mutation) ?? asString(raw.description),
        status,
        asString(raw.replacement),
      ),
    );
  }
  return { tool: "mutmut", files, survivors };
}

/** Parse any supported report shape; an unrecognized shape parses to null. */
export function parseMutationReport(value: unknown): ParsedMutation | null {
  return parseStryker(value) ?? parseCargoMutants(value) ?? parseMutmut(value);
}

function cleanFiles(files: string[], survivors: MutationSurvivor[]): string[] {
  const covered = [...new Set(files)];
  const survived = new Set(survivors.map((entry) => entry.file));
  return covered.filter((file) => !survived.has(file)).sort();
}

export function mutationFindings(report: MutationReport): FindingDraft[] {
  return report.survivors.map((entry) => ({
    file: entry.file,
    line: entry.line,
    rule: MUTATION_RULE,
    evidence: `${entry.mutator} — ${entry.status}${entry.replacement ? ` (${entry.replacement})` : ""}`,
    detector: "mutation",
  }));
}

export function mutationCleanFiles(value: MutationReport | MutationEvidence): string[] {
  if ("status" in value) {
    return value.status === "fresh" ? [...value.cleanFiles].sort() : [];
  }
  return [...value.cleanFiles].sort();
}

export interface MutationFreshness {
  fresh: boolean;
  reportMtimeMs: number;
  latestChangeMs: number;
}

export interface FreshnessOptions {
  cwd: string;
  runner: CommandRunner;
  reportPath: string;
  files?: string[];
  /** Override the measured latest change, mainly for tests. */
  latestChangeMs?: number;
}

/**
 * A report is fresh only when it is at least as new as the latest relevant test
 * or source change (HEAD commit time plus changed-file mtimes).
 */
export async function mutationFreshness(options: FreshnessOptions): Promise<MutationFreshness> {
  const reportMtimeMs = statSync(options.reportPath).mtimeMs;
  let latestChangeMs = 0;
  if (typeof options.latestChangeMs === "number") {
    latestChangeMs = options.latestChangeMs;
  } else {
    const head = await options.runner("git", ["log", "-1", "--format=%ct"], {
      cwd: options.cwd,
    });
    if (head.code === 0) {
      const seconds = Number(head.stdout.trim());
      if (Number.isFinite(seconds)) {
        latestChangeMs = seconds * 1000;
      }
    }
    for (const file of options.files ?? []) {
      try {
        const stat = statSync(resolve(options.cwd, file));
        latestChangeMs = Math.max(latestChangeMs, stat.mtimeMs);
      } catch {
        // A deleted file cannot be newer than the report.
      }
    }
  }
  return { fresh: reportMtimeMs >= latestChangeMs, reportMtimeMs, latestChangeMs };
}

function relativeReport(cwd: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  return absolute.startsWith(`${resolve(cwd)}/`)
    ? absolute.slice(resolve(cwd).length + 1)
    : absolute;
}

export interface MutationLoadOptions {
  cwd: string;
  runner: CommandRunner;
  /** Diff-selected files, used for the freshness comparison. */
  files?: string[];
  /** Explicit report path, overriding the declared and conventional ones. */
  reportPath?: string;
  latestChangeMs?: number;
  now?: () => number;
  env?: Record<string, string | undefined>;
  /** Mise config filenames to inspect, mainly for tests. */
  declarationFiles?: string[];
}

function declaredReportPath(
  cwd: string,
  declaration: MutationTask | null,
  explicit: string | undefined,
): string | null {
  const candidates = explicit
    ? [explicit]
    : [...(declaration?.reportPaths ?? []), ...CONVENTIONAL_REPORT_PATHS];
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

export async function loadMutationEvidence(
  options: MutationLoadOptions,
): Promise<MutationEvidence> {
  const env = options.env ?? process.env;
  const checkedAt = (options.now ?? Date.now)();
  const declaration = await discoverMutationTask(options.cwd, options.declarationFiles);
  const explicit =
    options.reportPath ?? env.PI_SWEEP_MUTATION_REPORT ?? env.MUTATION_REPORT ?? undefined;

  if (!declaration && !explicit) {
    return { status: "absent", checkedAt, findings: [], cleanFiles: [] };
  }

  const reportPath = declaredReportPath(options.cwd, declaration, explicit);
  if (!reportPath) {
    return {
      status: "absent",
      checkedAt,
      reason: "a mutation task is declared but no report was found",
      findings: [],
      cleanFiles: [],
    };
  }

  const freshness = await mutationFreshness({
    cwd: options.cwd,
    runner: options.runner,
    reportPath,
    ...(options.files ? { files: options.files } : {}),
    ...(typeof options.latestChangeMs === "number"
      ? { latestChangeMs: options.latestChangeMs }
      : {}),
  });

  const reportName = relativeReport(options.cwd, reportPath);
  if (!freshness.fresh) {
    return {
      status: "stale",
      checkedAt,
      reason: `${reportName} is older than the latest test or source change`,
      findings: [],
      cleanFiles: [],
    };
  }

  let parsed: ParsedMutation | null = null;
  try {
    parsed = parseMutationReport(JSON.parse(readFileSync(reportPath, "utf8")));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return {
      status: "unknown-shape",
      checkedAt,
      reason: `${reportName} has an unrecognized report shape`,
      findings: [],
      cleanFiles: [],
    };
  }

  const report: MutationReport = {
    tool: parsed.tool,
    path: reportPath,
    mtimeMs: freshness.reportMtimeMs,
    files: [...new Set(parsed.files)].sort(),
    survivors: parsed.survivors,
    cleanFiles: cleanFiles(parsed.files, parsed.survivors),
  };
  return {
    status: "fresh",
    checkedAt,
    report,
    findings: mutationFindings(report),
    cleanFiles: report.cleanFiles,
  };
}
