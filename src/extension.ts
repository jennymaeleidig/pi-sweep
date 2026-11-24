import { runSweep, type SweepKind } from "./pipeline.ts";
import { runUmbrella } from "./umbrella.ts";
import type { CommandOptions, CommandRunner } from "./exec.ts";
import type { LensClient, ModuleReport } from "./adapters/zero-fanout.ts";

interface PiExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SweepCommandContext {
  cwd: string;
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
}

export interface SweepHost {
  exec(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<PiExecResult>;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: SweepCommandContext) => Promise<void> | void;
    },
  ): void;
  /** Optional bridge to pi-lens `module_report`; absent means zero-fanout is unavailable. */
  moduleReport?(file: string): Promise<ModuleReport | null>;
}

export interface SweepCommandOptions {
  kind: SweepKind;
  base?: string;
  fullAudit: boolean;
  apply?: boolean;
}

const KINDS = new Set<SweepKind>(["sweep", "code", "test", "prose"]);

export function parseSweepArgs(args: string): SweepCommandOptions {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let kind: SweepKind = "sweep";
  let base: string | undefined;
  let fullAudit = false;
  let apply = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--base") {
      base = tokens[index + 1];
      if (!base) {
        throw new Error("--base needs a ref");
      }
      index += 1;
    } else if (token === "--full-audit") {
      fullAudit = true;
    } else if (token === "--apply") {
      apply = true;
    } else if (KINDS.has(token as SweepKind)) {
      kind = token as SweepKind;
    } else {
      throw new Error(`unknown sweep argument: ${token}`);
    }
  }

  const options: SweepCommandOptions = { kind, base, fullAudit };
  if (apply) {
    options.apply = true;
  }
  return options;
}

export function createPiRunner(pi: Pick<SweepHost, "exec">): CommandRunner {
  return async (command, args, options) => {
    const result = await pi.exec(command, args, options);
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  };
}

export function createLensClient(
  pi: Pick<SweepHost, "moduleReport">,
): LensClient | undefined {
  const moduleReport = pi.moduleReport?.bind(pi);
  if (!moduleReport) {
    return undefined;
  }
  return { moduleReport: (file) => moduleReport(file) };
}

export default function sweepExtension(pi: SweepHost): void {
  const handler = async (args: string, ctx: SweepCommandContext) => {
    const options = parseSweepArgs(args);
    const request = {
      cwd: ctx.cwd,
      base: options.base,
      fullAudit: options.fullAudit,
      reportOnly: options.apply !== true,
      apply: options.apply,
      runner: createPiRunner(pi),
      lens: createLensClient(pi),
    };
    const result =
      options.kind === "sweep"
        ? await runUmbrella(request)
        : await runSweep({ ...request, kind: options.kind });
    ctx.ui.notify(result.markdown, "info");
  };

  pi.registerCommand("sweep", {
    description:
      "Run code, test, and prose sweeps over one basepoint and merge their gate tables",
    handler,
  });
  // Kept as an alias so existing invocations keep working with one implementation.
  pi.registerCommand("sweep-report", {
    description:
      "Sweep code, test, or prose over the current change (report-only unless --apply)",
    handler,
  });
}
