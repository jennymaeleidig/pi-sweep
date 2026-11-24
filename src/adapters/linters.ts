import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DetectorInput, FindingDraft } from "../contract.ts";
import { repoPath } from "../paths.ts";
import { runMise } from "../tools.ts";

export interface LinterInput extends DetectorInput {}

interface MiseTask {
  name?: unknown;
  tags?: unknown;
  hide?: unknown;
}

interface NormalizedMessage {
  file: string;
  line: number;
  rule: string;
  message: string;
}

interface EslintMessage {
  ruleId?: unknown;
  message?: unknown;
  line?: unknown;
}

interface EslintFile {
  filePath?: unknown;
  messages?: unknown;
}

interface SarifResult {
  ruleId?: unknown;
  message?: { text?: unknown };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: unknown };
      region?: { startLine?: unknown };
    };
  }>;
}

interface SarifLog {
  runs?: Array<{ results?: unknown }>;
}

const LINT_TASK_NAME = /^lint(?:[:._-]|$)/;
const ANSI = /\u001b\[[0-9;]*m/g;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function fromEslint(value: unknown, cwd: string): NormalizedMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: NormalizedMessage[] = [];
  for (const entry of value) {
    const file = asRecord(entry) as EslintFile | undefined;
    if (!file || typeof file.filePath !== "string" || !Array.isArray(file.messages)) {
      continue;
    }
    const path = repoPath(cwd, file.filePath);
    for (const rawMessage of file.messages) {
      const message = asRecord(rawMessage) as EslintMessage | undefined;
      if (!message || typeof message.message !== "string") {
        continue;
      }
      const line = typeof message.line === "number" && message.line > 0 ? message.line : 1;
      const rule = typeof message.ruleId === "string" && message.ruleId ? message.ruleId : "lint";
      messages.push({ file: path, line, rule, message: message.message });
    }
  }
  return messages;
}

function fromSarif(value: unknown, cwd: string): NormalizedMessage[] {
  const log = asRecord(value) as SarifLog | undefined;
  if (!log || !Array.isArray(log.runs)) {
    return [];
  }
  const messages: NormalizedMessage[] = [];
  for (const run of log.runs) {
    const results = asRecord(run)?.results;
    if (!Array.isArray(results)) {
      continue;
    }
    for (const rawResult of results) {
      const result = asRecord(rawResult) as SarifResult | undefined;
      const uri = result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
      const startLine = result?.locations?.[0]?.physicalLocation?.region?.startLine;
      const text = result?.message?.text;
      if (typeof uri !== "string" || typeof text !== "string") {
        continue;
      }
      const line = typeof startLine === "number" && startLine > 0 ? startLine : 1;
      const rule =
        result && typeof result.ruleId === "string" && result.ruleId
          ? result.ruleId
          : "lint";
      messages.push({ file: repoPath(cwd, uri), line, rule, message: text });
    }
  }
  return messages;
}

function fromGenericJson(value: unknown, cwd: string): NormalizedMessage[] {
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(asRecord(value)?.findings)
      ? (asRecord(value)?.findings as unknown[])
      : [];
  const messages: NormalizedMessage[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const file = record.file ?? record.path;
    const line = record.line ?? record.startLine;
    const message = record.message ?? record.evidence;
    if (typeof file !== "string" || typeof message !== "string") {
      continue;
    }
    const rule =
      typeof record.rule === "string" && record.rule
        ? record.rule
        : typeof record.ruleId === "string" && record.ruleId
          ? record.ruleId
          : "lint";
    messages.push({
      file: repoPath(cwd, file),
      line: typeof line === "number" && line > 0 ? line : 1,
      rule,
      message,
    });
  }
  return messages;
}

function fromTypeScriptDiagnostic(line: string, cwd: string): NormalizedMessage | undefined {
  const diagnostic = line.match(
    /^(.+?)\((\d+),(\d+)\):\s*(?:error|warning)\s+([A-Za-z]+\d+):\s*(.+)$/,
  );
  if (!diagnostic) {
    return undefined;
  }
  const file = repoPath(cwd, diagnostic[1] ?? "");
  const lineNumber = Number(diagnostic[2]);
  const message = diagnostic[5]?.trim();
  if (!file || !Number.isInteger(lineNumber) || lineNumber < 1 || !message) {
    return undefined;
  }
  return { file, line: lineNumber, rule: diagnostic[4] ?? "lint", message };
}

function fromText(text: string, cwd: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const rawLine of text.replace(ANSI, "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const diagnostic = fromTypeScriptDiagnostic(line, cwd);
    if (diagnostic) {
      messages.push(diagnostic);
      continue;
    }
    const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/);
    if (!match) {
      continue;
    }
    const file = repoPath(cwd, match[1] ?? "");
    const lineNumber = Number(match[2]);
    const message = match[4]?.trim();
    if (!file || !Number.isInteger(lineNumber) || lineNumber < 1 || !message) {
      continue;
    }
    const bracketed = message.match(/[\[(]([^()[\]]+)[\])]\s*$/);
    const rule = bracketed?.[1]?.trim() || "lint";
    messages.push({ file, line: lineNumber, rule, message });
  }
  return messages;
}

function parseOutput(text: string, cwd: string): NormalizedMessage[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    const eslint = fromEslint(parsed, cwd);
    if (eslint.length > 0) {
      return eslint;
    }
    const sarif = fromSarif(parsed, cwd);
    if (sarif.length > 0) {
      return sarif;
    }
    const generic = fromGenericJson(parsed, cwd);
    if (generic.length > 0) {
      return generic;
    }
  }
  return fromText(trimmed, cwd);
}

async function discoverLintTasks(input: LinterInput): Promise<string[]> {
  let result;
  try {
    result = await runMise(
      input.runner,
      ["tasks", "ls", "--json", "--no-global"],
      { cwd: input.cwd },
    );
  } catch {
    return [];
  }
  if (result.code !== 0) {
    return [];
  }
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const names = new Set<string>();
  for (const entry of parsed) {
    const task = asRecord(entry) as MiseTask | undefined;
    if (!task || typeof task.name !== "string" || task.hide === true) {
      continue;
    }
    const tags = Array.isArray(task.tags)
      ? task.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    if (LINT_TASK_NAME.test(task.name) || tags.includes("lint")) {
      names.add(task.name);
    }
  }
  return [...names].sort();
}

function toDraft(message: NormalizedMessage): FindingDraft {
  return {
    file: message.file,
    line: message.line,
    rule: message.rule,
    evidence: message.message,
    detector: "linter",
    category: "lint",
  };
}

function unusedRule(rule: string): boolean {
  return /unused|F401|dead_code/i.test(rule);
}

function selfContainedLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^import\b.*(?:;|["'])\s*$/.test(trimmed)) {
    return true;
  }
  if (!/^(?:export\s+)?(?:const|let|var)\b/.test(trimmed)) {
    return false;
  }
  return trimmed.endsWith(";");
}

async function attachEdits(input: LinterInput, drafts: FindingDraft[]): Promise<FindingDraft[]> {
  const contents = new Map<string, string[]>();
  const attached: FindingDraft[] = [];
  for (const draft of drafts) {
    if (!unusedRule(draft.rule)) {
      attached.push(draft);
      continue;
    }
    let lines = contents.get(draft.file);
    if (!lines) {
      try {
        lines = (await readFile(resolve(input.cwd, draft.file), "utf8")).split("\n");
      } catch {
        attached.push(draft);
        continue;
      }
      contents.set(draft.file, lines);
    }
    const line = lines[draft.line - 1];
    if (line === undefined || !selfContainedLine(line)) {
      attached.push(draft);
      continue;
    }
    const trailing = draft.line < lines.length ? "\n" : "";
    attached.push({ ...draft, edit: { oldText: `${line}${trailing}`, newText: "" } });
  }
  return attached;
}

function dedupe(drafts: FindingDraft[]): FindingDraft[] {
  const seen = new Set<string>();
  const unique: FindingDraft[] = [];
  for (const draft of drafts) {
    const key = `${draft.file}:${draft.line}:${draft.rule}:${draft.evidence}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(draft);
    }
  }
  return unique;
}

/**
 * Normalize the output of repo-declared mise lint tasks into finding drafts.
 * Only tasks named `lint` / `lint:*` or tagged `lint` run; their command text
 * is opaque, so the adapter carries no language knowledge.
 */
export async function detect(input: LinterInput): Promise<FindingDraft[]> {
  if (input.files.length === 0) {
    return [];
  }
  const selected = new Set(input.files.map((file) => repoPath(input.cwd, file)));
  const tasks = await discoverLintTasks(input);
  if (tasks.length === 0) {
    return [];
  }

  const drafts: FindingDraft[] = [];
  for (const task of tasks) {
    const result = await runMise(
      input.runner,
      ["run", task, "--", ...input.files],
      { cwd: input.cwd },
    );
    const stdout = parseOutput(result.stdout, input.cwd);
    const messages = stdout.length > 0 ? stdout : parseOutput(result.stderr, input.cwd);
    for (const message of messages) {
      if (selected.has(message.file)) {
        drafts.push(toDraft(message));
      }
    }
  }
  return attachEdits(input, dedupe(drafts));
}
