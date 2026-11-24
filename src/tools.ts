import type { CommandOptions, CommandResult, CommandRunner } from "./exec.ts";

/** Arguments that run an external tool through mise's pinned environment. */
export function miseExecArgs(tool: string, args: string[]): string[] {
  return ["exec", "--", tool, ...args];
}

/** Run a mise subcommand, keeping every adapter's mise invocation in one place. */
export function runMise(
  runner: CommandRunner,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  return runner("mise", args, options);
}

/** Run an external tool through `mise exec --`, never a bare shim. */
export function runTool(
  runner: CommandRunner,
  tool: string,
  args: string[],
  options?: CommandOptions,
): Promise<CommandResult> {
  return runner("mise", miseExecArgs(tool, args), options);
}
