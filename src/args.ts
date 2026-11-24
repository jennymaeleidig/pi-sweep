import type { SweepKind } from "./pipeline.ts";

export const KINDS = new Set<SweepKind>(["sweep", "code", "test", "prose"]);

export interface ParsedSweepArgs {
  kind: SweepKind;
  base?: string;
  fullAudit: boolean;
  apply: boolean;
  json: boolean;
  help: boolean;
}

/** Parse the flags shared by the CLI and the extension command. */
export function parseSweepArgs(tokens: string[]): ParsedSweepArgs {
  let kind: SweepKind = "sweep";
  let base: string | undefined;
  let fullAudit = false;
  let apply = false;
  let json = false;
  let help = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    switch (token) {
      case "--base": {
        const value = tokens[index + 1];
        if (!value) {
          throw new Error("--base needs a ref");
        }
        base = value;
        index += 1;
        break;
      }
      case "--full-audit":
        fullAudit = true;
        break;
      case "--report-only":
        apply = false;
        break;
      case "--apply":
        apply = true;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (token.startsWith("-")) {
          throw new Error(`unknown option: ${token}`);
        }
        if (!KINDS.has(token as SweepKind)) {
          throw new Error(`unknown sweep kind: ${token}`);
        }
        kind = token as SweepKind;
    }
  }

  return { kind, base, fullAudit, apply, json, help };
}
