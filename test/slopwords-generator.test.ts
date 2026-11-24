import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { defaultSlopSource, generate } from "../scripts/generate-slopwords.ts";

const fixtureSource = join(import.meta.dirname, "fixtures", "slopwords", "source.md");
const checkedIn = join(import.meta.dirname, "..", "vale", "styles", "SlopWords");

test("regenerating the SlopWords pack is deterministic", async () => {
  const first = await generate(fixtureSource);
  const second = await generate(fixtureSource);

  assert.deepEqual(second.files, first.files);
  assert.deepEqual(Object.keys(first.files).sort(), [
    "Banned.yml",
    "EmptyAdverbs.yml",
    "EmptyPhrases.yml",
    "Patterns.yml",
  ]);
});

test("the checked-in pack matches the source word lists", async () => {
  const { files } = await generate(fixtureSource);

  for (const [name, body] of Object.entries(files)) {
    assert.equal(
      await readFile(join(checkedIn, name), "utf8"),
      body,
      `${name} is stale; run node scripts/generate-slopwords.ts`,
    );
  }
});

test("generates banned words, empty phrases, and mechanically detectable patterns", async () => {
  const { files, skipped } = await generate(fixtureSource);

  assert.match(files["Banned.yml"], /"delve"/);
  assert.match(files["Banned.yml"], /"cutting-edge"/);
  assert.match(files["EmptyAdverbs.yml"], /"simply"/);
  assert.match(files["EmptyPhrases.yml"], /it's worth noting/);
  assert.match(files["Patterns.yml"], /here'\?s the thing/);
  assert.deepEqual(skipped.sort(), [
    "Colon reveals",
    "Fake-profound kickers",
    "Robotic rhythm",
    "Synonym cycling",
  ]);
});

test("resolves the default source from the environment instead of a home path", () => {
  assert.equal(
    defaultSlopSource({ PI_SWEEP_SLOP_SOURCE: "/tmp/skill.md" }),
    "/tmp/skill.md",
  );
  assert.match(defaultSlopSource({}), /SKILL\.md$/);
});

test("fails with an actionable message when the source is missing", async () => {
  await assert.rejects(
    generate(join(import.meta.dirname, "fixtures", "slopwords", "missing.md")),
    /Set PI_SWEEP_SLOP_SOURCE or pass --source/,
  );
});
