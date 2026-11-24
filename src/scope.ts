/**
 * Which paths a sweep may read as prose, and which paths no sweep may ever
 * edit. Detection and apply share the same selection so an excluded file can
 * never gain a finding that apply would then rewrite.
 */

const PROSE_EXTENSIONS = new Set([
  ".adoc",
  ".asciidoc",
  ".markdown",
  ".md",
  ".mdx",
  ".mdown",
  ".mdwn",
  ".mkd",
  ".org",
  ".rst",
  ".txt",
]);

const VENDORED_SEGMENTS = new Set([
  "bower_components",
  "dist",
  "node_modules",
  "site-packages",
  "third_party",
  "third-party",
  "vendor",
  "vendors",
  "venv",
  ".venv",
]);

const GENERATED_SEGMENTS = new Set(["generated", "gen", "codegen"]);

const GENERATED_NAMES = new Set([
  "Cargo.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const EXTERNAL_HANDLE = /^(?:mailto|tel|data|urn):/i;

export function isExternalUrl(reference: string): boolean {
  return EXTERNAL_SCHEME.test(reference) || EXTERNAL_HANDLE.test(reference);
}

function segments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

/** Why a path is out of bounds for editing, or null when it is editable. */
export function neverEditReason(path: string): string | null {
  if (isExternalUrl(path)) {
    return "external URL";
  }
  const parts = segments(path);
  const lower = parts.map((part) => part.toLowerCase());
  const name = parts.at(-1) ?? "";

  const adrIndex = lower.findIndex((part, index) => part === "adr" && lower[index - 1] === "docs");
  if (adrIndex !== -1) {
    return "decision record";
  }

  if (lower.some((part) => VENDORED_SEGMENTS.has(part))) {
    return "vendored";
  }
  if (lower.some((part) => GENERATED_SEGMENTS.has(part))) {
    return "generated";
  }
  if (GENERATED_NAMES.has(name) || /\.min\.(?:js|css|mjs)$/i.test(name)) {
    return "generated";
  }
  return null;
}

export function isProseFile(path: string): boolean {
  if (neverEditReason(path) !== null) {
    return false;
  }
  const name = segments(path).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && PROSE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** Paths a prose detector may read and a prose apply may rewrite. */
export function selectProseFiles(paths: string[]): string[] {
  return paths.filter(isProseFile);
}
