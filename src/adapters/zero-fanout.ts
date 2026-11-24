import type { FindingDraft } from "../contract.ts";
import type { CommandRunner } from "../exec.ts";

export interface ModuleReportReference {
  file: string;
  symbol?: string;
  line?: number;
  relation?: string;
}

export interface ModuleReportSymbol {
  name: string;
  kind?: string;
  startLine: number;
  endLine?: number;
  exported?: boolean;
  fanout?: number;
  usedBy?: ModuleReportReference[];
}

export interface ModuleReport {
  path?: string;
  available?: boolean;
  api?: ModuleReportSymbol[];
  internal?: ModuleReportSymbol[];
  unclassified?: ModuleReportSymbol[];
}

export interface LensClient {
  moduleReport(file: string): Promise<ModuleReport | null>;
}

export interface ZeroFanoutInput {
  files: string[];
  cwd: string;
  runner: CommandRunner;
  lens?: LensClient;
}

export interface ZeroFanoutDetection {
  drafts: FindingDraft[];
  available: boolean;
  reason?: string;
}

interface GrepHit {
  file: string;
  line: number;
  text: string;
}

function symbolsFor(report: ModuleReport): ModuleReportSymbol[] {
  return [
    ...(report.api ?? []),
    ...(report.internal ?? []),
    ...(report.unclassified ?? []),
  ];
}

function parseGrepHits(output: string): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) {
      continue;
    }
    const lineNumber = Number(match[2]);
    if (!match[1] || !Number.isInteger(lineNumber)) {
      continue;
    }
    hits.push({ file: match[1], line: lineNumber, text: match[3] ?? "" });
  }
  return hits;
}

function isStringReference(name: string, text: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`["'\`][^"'\`]{0,80}${escaped}[^"'\`]{0,80}["'\`]`).test(text)) {
    return true;
  }
  return (
    /\b(register|registry|resolve|lookup|invoke|dispatch)\b/.test(text) &&
    text.includes(name)
  );
}

function quote(hits: GrepHit[]): string {
  return hits
    .slice(0, 3)
    .map((hit) => `${hit.file}:${hit.line}: ${hit.text.trim().replace(/\s+/g, " ")}`)
    .join(" | ");
}

async function corroborate(
  name: string,
  file: string,
  startLine: number,
  input: ZeroFanoutInput,
): Promise<{ evidence: string; failure?: string }> {
  const result = await input.runner(
    "git",
    ["grep", "-n", "-F", "--untracked", "-e", name, "--", "."],
    { cwd: input.cwd },
  );
  if (result.code !== 0 && result.code !== 1) {
    return {
      evidence: "",
      failure: `string-grep could not corroborate ${name}: ${result.stderr.trim() || `exit ${result.code}`}`,
    };
  }

  const hits =
    result.code === 1
      ? []
      : parseGrepHits(result.stdout).filter(
          (hit) => !(hit.file === file && hit.line === startLine),
        );
  const stringHits = hits.filter((hit) => isStringReference(name, hit.text));
  const detail =
    stringHits.length > 0
      ? `string-invocation hits: ${quote(stringHits)}`
      : hits.length > 0
        ? `string-grep hits outside the declaration: ${quote(hits)}`
        : "string-grep found no references outside the declaration";
  return {
    evidence: `zero fanout for "${name}" (usedBy=0, fanout=0); ${detail}`,
  };
}

function draftFor(symbol: ModuleReportSymbol, file: string, evidence: string): FindingDraft {
  return {
    file,
    line: symbol.startLine,
    rule: "zero-fanout",
    evidence,
    detector: "zero-fanout",
    category: "dead-code",
    proposedFix: `Remove ${symbol.name} only after confirming no dynamic caller uses it`,
  };
}

/**
 * Derive zero-fanout candidates from pi-lens module reports, then require a
 * string-grep corroboration pass before emitting each draft. Registry and
 * string-invocation hits stay quoted in the evidence.
 */
export async function detectZeroFanout(
  input: ZeroFanoutInput,
): Promise<ZeroFanoutDetection> {
  if (!input.lens) {
    return {
      drafts: [],
      available: false,
      reason: "pi-lens module_report is unavailable",
    };
  }

  const drafts: FindingDraft[] = [];
  const reasons = new Set<string>();
  let available = true;

  for (const file of input.files) {
    let report: ModuleReport | null;
    try {
      report = await input.lens.moduleReport(file);
    } catch (error) {
      available = false;
      reasons.add(
        `module_report failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!report || report.available === false) {
      available = false;
      reasons.add(`module_report unavailable for ${file}`);
      continue;
    }

    for (const symbol of symbolsFor(report)) {
      if (typeof symbol.name !== "string" || !Number.isInteger(symbol.startLine)) {
        continue;
      }
      const usedBy = Array.isArray(symbol.usedBy) ? symbol.usedBy.length : 0;
      const fanout = typeof symbol.fanout === "number" ? symbol.fanout : 0;
      if (usedBy > 0 || fanout > 0) {
        continue;
      }
      const corroboration = await corroborate(
        symbol.name,
        file,
        symbol.startLine,
        input,
      );
      if (corroboration.failure) {
        available = false;
        reasons.add(corroboration.failure);
        continue;
      }
      drafts.push(draftFor(symbol, file, corroboration.evidence));
    }
  }

  return {
    drafts,
    available,
    ...(reasons.size > 0 ? { reason: [...reasons].join("; ") } : {}),
  };
}

/** Normalize zero-fanout candidates into finding drafts. */
export async function detect(input: ZeroFanoutInput): Promise<FindingDraft[]> {
  return (await detectZeroFanout(input)).drafts;
}
