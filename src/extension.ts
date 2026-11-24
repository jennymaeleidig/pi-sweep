import { runSweep, type SweepKind } from "./pipeline.ts";
import type { CommandOptions, CommandRunner } from "./exec.ts";

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

export default function sweepExtension(pi: SweepHost): void {
  pi.registerCommand("sweep-report", {
    description:
      "Sweep code, test, or prose over the current change (report-only unless --apply)",
    handler: async (args, ctx) => {
      const options = parseSweepArgs(args);
      const result = await runSweep({
        kind: options.kind,
        cwd: ctx.cwd,
        base: options.base,
        fullAudit: options.fullAudit,
        reportOnly: options.apply !== true,
        apply: options.apply,
        runner: createPiRunner(pi),
      });
      ctx.ui.notify(result.markdown, "info");
    },
  });
}
