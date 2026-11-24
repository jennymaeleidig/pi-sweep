import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function tempRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sweep-test-"));
  await git(cwd, ["init", "-q", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  // Keep the pinned tool file out of the git-selected fixture files.
  await writeFile(
    join(cwd, "mise.toml"),
    [
      "[tools]",
      '"npm:jscpd" = "5.4.3"',
      '"aqua:lycheeverse/lychee" = "0.24.2"',
      '"aqua:vale-cli/vale" = "3.28.1"',
      "",
    ].join("\n"),
  );
  await appendFile(join(cwd, ".git", "info", "exclude"), "\nmise.toml\n");
  return cwd;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout;
}

export async function write(
  cwd: string,
  path: string,
  content: string,
): Promise<string> {
  const absolute = join(cwd, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

export async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message]);
}

export async function cleanup(cwd: string): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
}

export const duplicateSource = `export function total(values: number[]): number {
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum;
}
`;
