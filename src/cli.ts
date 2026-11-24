#!/usr/bin/env node
import { runSweep, type SweepKind } from "./pipeline.ts";

const KINDS = new Set<SweepKind>(["sweep", "code", "test", "prose"]);

interface CliOptions {
  kind: SweepKind;
  base?: string;
  fullAudit: boolean;
  json: boolean;
}

function usage(): string {
  return [
    "Usage: node src/cli.ts <sweep|code|test|prose> [options]",
    "",
    "Options:",
    "  --base <ref>       SHA, branch, tag, or merge-base:<ref> (default: HEAD)",
    "  --full-audit       Sweep every tracked and untracked file instead of the diff",
    "  --report-only      Report findings without applying (the only mode so far)",
    "  --json             Print the machine-readable report instead of markdown",
    "  --help             Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let kind: SweepKind = "sweep";
  let base: string | undefined;
  let fullAudit = false;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case "--base": {
        const value = argv[index + 1];
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
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h": {
        console.log(usage());
        process.exit(0);
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
        if (!KINDS.has(arg as SweepKind)) {
          throw new Error(`unknown sweep kind: ${arg}`);
        }
        kind = arg as SweepKind;
    }
  }

  return { kind, base, fullAudit, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runSweep({
    kind: options.kind,
    cwd: process.cwd(),
    base: options.base,
    fullAudit: options.fullAudit,
    reportOnly: true,
  });

  if (options.json) {
    console.log(JSON.stringify(result.report, null, 2));
  } else {
    console.log(result.markdown);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
