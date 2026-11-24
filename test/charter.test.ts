import assert from "node:assert/strict";
import test from "node:test";
import type { Finding } from "../src/contract.ts";
import { charterAllows, charterReason } from "../src/charter.ts";

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f1",
    file: "src/app.ts",
    line: 1,
    rule: "stale-comment",
    evidence: "the comment names a deleted flag",
    tier: 2,
    detector: "agent:prose",
    ...overrides,
  };
}

test("allows prose edits on comment findings in source files", () => {
  assert.equal(
    charterAllows("prose", "src/app.ts", finding({ category: "comment" })),
    true,
  );
  assert.equal(charterAllows("prose", "src/app.ts", finding({})), true);
  assert.equal(
    charterAllows("prose", "src/app.ts", finding({ detector: "agent:code", category: "lint" })),
    false,
  );
});

test("keeps prose charter exclusions for tests, decisions, and generated files", () => {
  assert.equal(
    charterAllows("prose", "test/app.test.ts", finding({ category: "comment" })),
    false,
  );
  assert.equal(
    charterAllows("prose", "docs/adr/0001-choice.md", finding({ category: "prose" })),
    false,
  );
  assert.equal(
    charterAllows("prose", "vendor/lib.ts", finding({ category: "comment" })),
    false,
  );
});

test("keeps code edits out of configuration and lockfiles", () => {
  for (const path of [
    "package.json",
    "config/settings.yaml",
    "pyproject.toml",
    ".env.local",
  ]) {
    assert.equal(charterAllows("code", path), false, path);
    assert.match(charterReason("code", path) ?? "", /configuration file/, path);
  }
  assert.equal(charterAllows("code", "pnpm-lock.yaml"), false);
  assert.match(charterReason("code", "pnpm-lock.yaml") ?? "", /generated/);
  assert.equal(charterAllows("code", "src/app.ts"), true);
});
