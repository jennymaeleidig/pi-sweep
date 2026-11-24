import assert from "node:assert/strict";
import test from "node:test";
import { fragmentText } from "../src/fragments.ts";

const THREE_LINES = "alpha\nbeta\ngamma\n";

test("returns a mid-file fragment with its trailing newline", () => {
  assert.equal(fragmentText(THREE_LINES, 2, 2), "beta\n");
  assert.equal(fragmentText(THREE_LINES, 1, 2), "alpha\nbeta\n");
});

test("omits the trailing newline when the fragment ends at the last line", () => {
  const noFinalNewline = "alpha\nbeta\ngamma";
  assert.equal(fragmentText(noFinalNewline, 3, 3), "gamma");
  assert.equal(fragmentText(noFinalNewline, 1, 3), "alpha\nbeta\ngamma");
  assert.equal(fragmentText("no-newline-at-end", 1, 1), "no-newline-at-end");
});

test("returns nothing for ranges outside the content", () => {
  assert.equal(fragmentText(THREE_LINES, 0, 2), undefined);
  assert.equal(fragmentText(THREE_LINES, 2, 1), undefined);
  assert.equal(fragmentText(THREE_LINES, 5, 6), undefined);
});
