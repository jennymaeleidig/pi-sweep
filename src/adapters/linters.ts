import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DetectorInput, FindingDraft, FindingEdit } from "../contract.ts";
import { fragmentText } from "../fragments.ts";
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
  endLine?: number;
  column?: number;
  endColumn?: number;
  /** The linter's own delete fix, resolved to its exact text from `source`. */
  fixText?: string;
}

interface EslintMessage {
  ruleId?: unknown;
  message?: unknown;
  line?: unknown;
  column?: unknown;
  endLine?: unknown;
  endColumn?: unknown;
  fix?: unknown;
}

interface EslintFile {
  filePath?: unknown;
  messages?: unknown;
  source?: unknown;
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

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Resolve a pure-delete ESLint fix to its exact text using the file's `source`. */
function resolveFixText(fix: unknown, source: string | undefined): string | undefined {
  const record = asRecord(fix);
  const range = record?.range;
  if (
    !record ||
    record.text !== "" ||
    !source ||
    !Array.isArray(range) ||
    !range.every((offset) => typeof offset === "number")
  ) {
    return undefined;
  }
  const [start, end] = range as [number, number];
  return source.slice(start, end);
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
    const source = typeof file.source === "string" ? file.source : undefined;
    for (const rawMessage of file.messages) {
      const message = asRecord(rawMessage) as EslintMessage | undefined;
      if (!message || typeof message.message !== "string") {
        continue;
      }
      const line = positiveNumber(message.line) ?? 1;
      const rule = typeof message.ruleId === "string" && message.ruleId ? message.ruleId : "lint";
      const endLine = positiveNumber(message.endLine);
      const column = positiveNumber(message.column);
      const endColumn = positiveNumber(message.endColumn);
      const fixText = resolveFixText(message.fix, source);
      messages.push({
        file: path,
        line,
        rule,
        message: message.message,
        ...(endLine !== undefined ? { endLine } : {}),
        ...(column !== undefined ? { column } : {}),
        ...(endColumn !== undefined ? { endColumn } : {}),
        ...(fixText !== undefined ? { fixText } : {}),
      });
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
    evidenceClass: "machine",
    category: "lint",
  };
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

/**
 * The delete edit for an allowlisted unused-symbol rule, derived from what the
 * linter itself reported — never from re-matching the file text by regex.
 *
 * ESLint's JSON formatter includes a message-level `fix` and a per-file
 * `source` for fixable rules (verified against the pinned eslint 9.39.5, so
 * `--fix-dry-run` adds nothing), which resolves to the exact deleted text;
 * rules that only suggest (core `no-unused-vars`) fall back to the reported
 * endLine/endColumn range. Either way the edit is attached only when the
 * reported range covers a whole, self-contained import or declaration line.
 */
function deleteEdit(
  content: string,
  message: NormalizedMessage,
): FindingEdit | undefined {
  if (message.endLine !== undefined && message.endLine !== message.line) {
    return undefined;
  }
  const fragment = fragmentText(content, message.line, message.line);
  if (fragment === undefined) {
    return undefined;
  }
  const line = fragment.replace(/\n$/, "");
  const covered =
    message.fixText !== undefined
      ? message.fixText.trim() === line.trim()
      : message.column !== undefined &&
        message.endColumn !== undefined &&
        line.slice(message.column - 1, message.endColumn).trim() === line.trim();
  if (!covered || !selfContainedLine(line)) {
    return undefined;
  }
  return { oldText: fragment, newText: "" };
}

async function attachEdits(
  input: LinterInput,
  messages: NormalizedMessage[],
): Promise<FindingDraft[]> {
  const contents = new Map<string, string>();
  const drafts: FindingDraft[] = [];
  for (const message of messages) {
    const draft = toDraft(message);
    if (!/unused|F401|dead_code/i.test(message.rule)) {
      drafts.push(draft);
      continue;
    }
    let content = contents.get(message.file);
    if (content === undefined) {
      try {
        content = await readFile(resolve(input.cwd, message.file), "utf8");
      } catch {
        drafts.push(draft);
        continue;
      }
      contents.set(message.file, content);
    }
    const edit = deleteEdit(content, message);
    drafts.push(edit ? { ...draft, edit } : draft);
  }
  return drafts;
}

function dedupe(messages: NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Set<string>();
  const unique: NormalizedMessage[] = [];
  for (const message of messages) {
    const key = `${message.file}:${message.line}:${message.rule}:${message.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(message);
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

  const selectedMessages: NormalizedMessage[] = [];
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
        selectedMessages.push(message);
      }
    }
  }
  return attachEdits(input, dedupe(selectedMessages));
}
