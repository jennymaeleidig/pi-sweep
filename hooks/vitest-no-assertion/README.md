# vitest no-assertion hook

Vitest passes a test that never calls `expect`. This setup file fails such a test
in `afterEach` instead of letting it report green.

## Install

Copy `setup.ts` and `no-assertion.ts` into the repository, then register the setup
file in `vitest.config.ts`:

```ts
export default defineConfig({
  test: { setupFiles: ["./test/no-assertion/setup.ts"] },
});
```

## Managed marker

Both files carry a `MANAGED BY pi-sweep` comment. Treat them as managed artifacts:
cleanup passes, codemods, and agents must not delete, rename, or strip them as
boilerplate. Remove them only when deliberately retiring the hook.

## What counts as an assertion

Any `expect(...)` call. A test that is skipped, marked todo, or already failed is
left alone so the hook never masks the original outcome.
