import { fileURLToPath } from "node:url";
import type { DetectorInput, FindingDraft } from "../contract.ts";
import { repoPath } from "../paths.ts";
import { selectProseFiles } from "../scope.ts";
import { runTool } from "../tools.ts";

export interface ValeInput extends DetectorInput {
  /** Defaults to the SlopWords config bundled with pi-sweep. */
  configPath?: string;
}

interface ValeAlert {
  Check: string;
  Message: string;
  Severity: string;
  Match: string;
  Line: number;
  Span: [number, number];
  Suggestions?: string[];
}

type ValeReport = Record<string, ValeAlert[]>;

const bundledConfig = fileURLToPath(new URL("../../vale/.vale.ini", import.meta.url));

function draftFor(cwd: string, file: string, alert: ValeAlert): FindingDraft {
  const suggestion = alert.Suggestions?.[0];
  return {
    file: repoPath(cwd, file),
    line: alert.Line,
    rule: alert.Check,
    evidence: alert.Match ? `${alert.Message} ("${alert.Match}")` : alert.Message,
    detector: "vale",
    category: "slop",
    proposedFix: suggestion
      ? `Write '${suggestion}' instead`
      : "Cut the phrase or name the concrete thing",
  };
}

/**
 * Normalize vale's JSON report into drafts against the bundled SlopWords pack.
 * --no-global keeps user styles and network sync out of the run.
 */
export async function detect(input: ValeInput): Promise<FindingDraft[]> {
  const files = selectProseFiles(input.files);
  if (files.length === 0) {
    return [];
  }

  const result = await runTool(
    input.runner,
    "vale",
    [
      "--config",
      input.configPath ?? bundledConfig,
      "--no-global",
      "--output",
      "JSON",
      "--minAlertLevel",
      "warning",
      ...files,
    ],
    { cwd: input.cwd },
  );

  // Vale exits 1 when it reports alerts; anything else is a real failure.
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`vale failed (${result.code}): ${result.stderr.trim()}`);
  }

  const report = JSON.parse(result.stdout || "{}") as ValeReport;
  const drafts: FindingDraft[] = [];
  for (const [file, alerts] of Object.entries(report)) {
    for (const alert of alerts) {
      drafts.push(draftFor(input.cwd, file, alert));
    }
  }
  return drafts;
}
