#!/usr/bin/env node
/**
 * Regenerate the Vale SlopWords pack from the no-ai-slop word and pattern lists.
 *
 * Source of truth: the "Words to cut" and "Patterns to cut" sections of the
 * no-ai-slop skill's SKILL.md. The default is read from PI_SWEEP_SLOP_SOURCE,
 * then the skill under the current home directory. Pass --source to read a copy
 * instead, which is how tests stay independent of that skill.
 *
 *   node scripts/generate-slopwords.ts [--source <md>] [--out <dir>]
 *
 * The output is deterministic: same input, same bytes, in sorted category order.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOut = join(repoRoot, "vale", "styles", "SlopWords");

/** Resolve the skill source without baking a home path into the repository. */
export function defaultSlopSource(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.PI_SWEEP_SLOP_SOURCE ??
    join(homedir(), ".agents", "skills", "no-ai-slop", "SKILL.md")
  );
}

/** Mechanical tokens for each "Patterns to cut" category. */
const PATTERN_TOKENS: Record<string, string[]> = {
  "Binary contrasts": [
    "\\b(?:it|this) (?:is|was) not (?:just )?\\w[^.!?\\n]{1,50}\\bit's\\b",
    "\\bthe (?:question|point|issue|problem) isn't [^.!?\\n]{1,50}, it's\\b",
  ],
  "Throat-clearing openers": [
    "\\bhere'?s the thing\\b",
    "\\bhere'?s what I mean\\b",
    "\\blet me be clear\\b",
    "\\bI'll be honest\\b",
    "\\bthe uncomfortable truth is\\b",
  ],
  "Faux-insight setups": [
    "\\bthis is the part most people skip\\b",
    "\\bwhat most people get wrong\\b",
    "\\bhere'?s what nobody tells you\\b",
    "\\bthe part everyone misses\\b",
  ],
  "Colon reveals": [],
  "Superficial analysis": [
    ",\\s+(?:highlighting|underscoring|reflecting|showcasing|demonstrating|signaling)\\b",
  ],
  "Importance puffery": [
    "\\bstands? as a testament\\b",
    "\\bmarks? a pivotal moment\\b",
    "\\bplays? a vital role\\b",
    "\\bsolidifies? its position\\b",
    "\\bunderscores? its significance\\b",
  ],
  "Interpretive metadiscourse": [
    "\\bthat last part matters\\b",
    "\\bthe key point is\\b",
    "\\bas you can see\\b",
    "\\bthis distinction matters\\b",
    "\\bin other words\\b",
  ],
  "Weasel attribution": [
    "\\bexperts agree\\b",
    "\\bindustry reports suggest\\b",
    "\\bmany argue\\b",
    "\\bwidely regarded as\\b",
    "\\bstudies show\\b",
  ],
  "Fake-strong verbs": [
    "\\bserves? as an? (?:centralized )?(?:hub|testament|cornerstone)\\b",
  ],
  "Synonym cycling": [],
  "Negative listing": ["\\bnot an? \\w+\\. not an? \\w+\\."],
  "Dramatic fragmentation": ["(?:^|\\. )\\w+\\. (?:And|But|So) \\w+\\."],
  "Robotic rhythm": [],
  "Rhetorical setups": [
    "\\bwhat if I told you\\b",
    "\\bthink about it:",
    "\\bplot twist:",
  ],
  "Fake-profound kickers": [],
  "Summary-recap endings": ["\\b(?:in conclusion|ultimately|overall)\\b"],
  "Formatting slop": [
    "^#{1,6} .*[\\x{1F300}-\\x{1FAFF}\\x{2600}-\\x{27BF}]",
    "\\S\\s\\*\\*[^*]+\\*\\*\\s",
  ],
  "Em dashes": ["\\s—\\s", "—"],
};

interface Options {
  source: string;
  out: string;
}

interface WordLists {
  banned: string[];
  adverbs: string[];
  phrases: string[];
}

interface Pattern {
  name: string;
  description: string;
}

export interface GeneratedPack {
  files: Record<string, string>;
  skipped: string[];
}

function parseArgs(argv: string[]): Options | null {
  let source = defaultSlopSource();
  let out = defaultOut;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      source = argv[++index] ?? "";
    } else if (arg === "--out") {
      out = argv[++index] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/generate-slopwords.ts [--source <md>] [--out <dir>]");
      return null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!source || !out) {
    throw new Error("--source and --out need a path");
  }
  return { source, out };
}

function section(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    throw new Error(`missing section: ## ${heading}`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## /.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

function parseWordLists(markdown: string): WordLists {
  const lines = section(markdown, "Words to cut");
  const words: WordLists = { banned: [], adverbs: [], phrases: [] };
  const keys: Record<string, keyof WordLists> = {
    "Banned outright": "banned",
    "Often-empty adverbs": "adverbs",
    "Often-empty phrases": "phrases",
  };
  for (const line of lines) {
    const match = /^(Banned outright|Often-empty adverbs|Often-empty phrases):\s*(.+)$/.exec(
      line.trim(),
    );
    if (!match) {
      continue;
    }
    const key = keys[match[1] ?? ""];
    if (!key) {
      continue;
    }
    // The trailing guidance after the list starts at ". Cut" / ". Keep".
    const list = (match[2] ?? "").split(/\.\s+(?:Cut|Keep)\b/)[0] ?? "";
    words[key] = splitList(list);
  }
  for (const [key, value] of Object.entries(words)) {
    if (value.length === 0) {
      throw new Error(`empty word list: ${key}`);
    }
  }
  return words;
}

function parsePatterns(markdown: string): Pattern[] {
  const patterns: Pattern[] = [];
  for (const line of section(markdown, "Patterns to cut")) {
    const match = /^\*\*([^*]+?)\.\*\*\s*(.+)$/.exec(line.trim());
    if (match) {
      patterns.push({ name: match[1] ?? "", description: (match[2] ?? "").trim() });
    }
  }
  if (patterns.length === 0) {
    throw new Error("no patterns found");
  }
  return patterns;
}

function yamlLine(value: string): string {
  return `  - ${JSON.stringify(value)}`;
}

interface RuleInput {
  message: string;
  level: string;
  words?: string[];
  regexes?: string[];
}

function rule({ message, level, words, regexes }: RuleInput): string {
  const lines = [
    "extends: existence",
    `message: ${JSON.stringify(message)}`,
    `level: ${level}`,
    "ignorecase: true",
  ];
  if (regexes) {
    lines.push("nonword: true");
  }
  lines.push("tokens:");
  for (const value of words ?? regexes ?? []) {
    lines.push(yamlLine(value));
  }
  return `${lines.join("\n")}\n`;
}

export async function generate(sourcePath: string): Promise<GeneratedPack> {
  let markdown: string;
  try {
    markdown = await readFile(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `SlopWords source not found at ${sourcePath}. Set PI_SWEEP_SLOP_SOURCE or pass --source.`,
      );
    }
    throw error;
  }
  const words = parseWordLists(markdown);
  const patterns = parsePatterns(markdown);

  const patternTokens: string[] = [];
  const skipped: string[] = [];
  for (const pattern of patterns) {
    const tokens = PATTERN_TOKENS[pattern.name];
    if (!tokens) {
      throw new Error(
        `pattern category has no mechanical tokens yet: ${pattern.name}. ` +
          "Add it to PATTERN_TOKENS or document why it stays agent-only.",
      );
    }
    if (tokens.length === 0) {
      skipped.push(pattern.name);
      continue;
    }
    patternTokens.push(...tokens);
  }

  const files: Record<string, string> = {
    "Banned.yml": rule({
      message: "Banned word '%s'; cut it or name the concrete thing.",
      level: "error",
      words: words.banned,
    }),
    "EmptyAdverbs.yml": rule({
      message: "Often-empty adverb '%s'; cut it unless it carries emphasis.",
      level: "warning",
      words: words.adverbs,
    }),
    "EmptyPhrases.yml": rule({
      message: "Often-empty phrase '%s'; cut it unless it earns its place.",
      level: "warning",
      words: words.phrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    }),
    "Patterns.yml": rule({
      message: "Slop pattern '%s'; state the point plainly.",
      level: "warning",
      regexes: [...new Set(patternTokens)],
    }),
  };

  return { files, skipped };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }
  const { files, skipped } = await generate(options.source);
  await mkdir(options.out, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(options.out, name), body);
  }
  if (skipped.length > 0) {
    console.log(`Agent-only pattern categories: ${skipped.join(", ")}`);
  }
  console.log(`Wrote ${Object.keys(files).length} rules to ${options.out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
