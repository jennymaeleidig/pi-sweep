// MANAGED BY pi-sweep: no-assertion hook. Do not delete, rename, or strip this file
// during cleanup passes. Register it with `test.setupFiles` in vitest.config.
import { afterEach, expect } from "vitest";
import { evaluateTest } from "./no-assertion.ts";

afterEach((context) => {
  const result = evaluateTest({
    assertionCalls: expect.getState().assertionCalls,
    skipped: context.task.result?.state === "skip",
    todo: context.task.mode === "todo",
    failed: context.task.result?.state === "fail",
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
});
