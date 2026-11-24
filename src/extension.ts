import { runSweep, type SweepKind } from "./pipeline.ts";
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
}

const KINDS = new Set<SweepKind>(["sweep", "code", "test", "prose"]);

export function parseSweepArgs(args: string): SweepCommandOptions {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let kind: SweepKind = "sweep";
  let base: string | undefined;
  let fullAudit = false;

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
    } else if (KINDS.has(token as SweepKind)) {
      kind = token as SweepKind;
    } else {
      throw new Error(`unknown sweep argument: ${token}`);
    }
  }

  return { kind, base, fullAudit };
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
  pi.registerCommand("sweep-report", {
    description:
      "Run a report-only sweep (code, test, or prose) over the current change",
    handler: async (args, ctx) => {
      const options = parseSweepArgs(args);
      const result = await runSweep({
        kind: options.kind,
        cwd: ctx.cwd,
        base: options.base,
        fullAudit: options.fullAudit,
        reportOnly: true,
        runner: createPiRunner(pi),
        lens: createLensClient(pi),
      });
      ctx.ui.notify(result.markdown, "info");
    },
  });
}
