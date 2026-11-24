import { execFile } from "node:child_process";

export interface CommandOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export const realCommandRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        signal: options.signal,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(error);
          return;
        }
        let code = 0;
        if (error) {
          const exitCode = (error as NodeJS.ErrnoException).code;
          code = typeof exitCode === "number" ? exitCode : 1;
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code,
        });
      },
    );
  });
