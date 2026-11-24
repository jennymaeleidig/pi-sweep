import assert from "node:assert/strict";
import test from "node:test";
import {
  isExternalUrl,
  isProseFile,
  neverEditReason,
  selectProseFiles,
} from "../src/scope.ts";

test("selects prose files and drops code", () => {
  assert.deepEqual(
    selectProseFiles(["docs/guide.md", "README.md", "notes/a.rst", "src/app.ts", "log.txt"]),
    ["docs/guide.md", "README.md", "notes/a.rst", "log.txt"],
  );
});

test("never edits decision records, vendored files, or generated files", () => {
  assert.equal(neverEditReason("docs/adr/0001-choice.md"), "decision record");
  assert.equal(neverEditReason("vendor/lib/readme.md"), "vendored");
  assert.equal(neverEditReason("node_modules/pkg/readme.md"), "vendored");
  assert.equal(neverEditReason("dist/guide.md"), "vendored");
  assert.equal(neverEditReason("docs/generated/api.md"), "generated");
  assert.equal(neverEditReason("pnpm-lock.yaml"), "generated");
  assert.equal(neverEditReason("assets/app.min.js"), "generated");
  assert.equal(neverEditReason("docs/guide.md"), null);
});

test("never edits anything reachable only through an external URL", () => {
  assert.equal(isExternalUrl("https://example.com/guide"), true);
  assert.equal(isExternalUrl("mailto:team@example.com"), true);
  assert.equal(neverEditReason("https://example.com/docs/adr/0001.md"), "external URL");
  assert.equal(isProseFile("https://example.com/guide.md"), false);
});

test("excluded prose paths are never selected for detection or apply", () => {
  assert.deepEqual(
    selectProseFiles([
      "docs/guide.md",
      "docs/adr/0002-decision.md",
      "vendor/notes.md",
      "docs/generated/reference.md",
    ]),
    ["docs/guide.md"],
  );
});
