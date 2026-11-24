/**
 * MANAGED BY pi-sweep: no-assertion hook logic. Do not remove or rewrite as boilerplate.
 *
 * Vitest lets a test finish without calling expect; this decision function keeps
 * that check testable without importing vitest.
 */
export interface TestCompletion {
  assertionCalls: number;
  skipped?: boolean;
  todo?: boolean;
  failed?: boolean;
}

export interface TestVerdict {
  ok: boolean;
  reason?: string;
}

export function evaluateTest(state: TestCompletion): TestVerdict {
  if (state.skipped || state.todo || state.failed) {
    return { ok: true };
  }
  if (state.assertionCalls > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "test completed without any assertion; add expect(...) or mark it skip/todo",
  };
}
