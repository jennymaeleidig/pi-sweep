# pytest no-assertion hook

pytest passes a test that never asserts anything. This checked-in hook fails such
a test during setup instead of letting it report green.

## Install

Copy both `conftest.py` and `no_assertion.py` into the repository's test root (the
directory pytest treats as the conftest root). No plugin configuration is needed.

## Managed marker

Both files carry a `MANAGED BY pi-sweep` comment. Treat them as managed artifacts:
cleanup passes, codemods, and agents must not delete, rename, or strip them as
boilerplate. Remove them only when deliberately retiring the hook.

## What counts as an assertion

An `assert` statement, or a call whose name starts with `assert` (`self.assertEqual`,
`numpy.testing.assert_allclose`, ...) or is one of `expect`, `fail`, or `raises`
(for example `with pytest.raises(...)`). Skipped tests should be marked with
`pytest.skip` rather than left assertion-free.

## Check directly

```sh
python3 no_assertion.py path/to/test_example.py
```
