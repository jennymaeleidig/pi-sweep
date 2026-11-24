#!/usr/bin/env node
import { runSweep } from "./pipeline.ts";
import { runUmbrella } from "./umbrella.ts";
import { parseSweepArgs, type ParsedSweepArgs } from "./args.ts";

function usage(): string {
  return [
    "Usage: node src/cli.ts <sweep|code|test|prose> [options]",
    "",
    "The sweep kind runs code, test, and prose against one basepoint and merges their tables.",
    "",
    "Options:",
    "  --base <ref>       SHA, branch, tag, or merge-base:<ref> (default: HEAD)",
    "  --full-audit       Sweep every tracked and untracked file instead of the diff",
    "  --report-only      Report findings without applying (the default)",
    "  --apply            Run the apply engine after the gate (red hunks revert)",
    "  --json             Print the machine-readable report instead of markdown",
    "  --help             Show this help",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedSweepArgs {
  const options = parseSweepArgs(argv);
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const request = {
    cwd: process.cwd(),
    base: options.base,
    fullAudit: options.fullAudit,
    apply: options.apply,
  };
  const result =
    options.kind === "sweep"
      ? await runUmbrella(request)
      : await runSweep({ ...request, kind: options.kind });

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
