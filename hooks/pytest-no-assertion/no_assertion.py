"""MANAGED BY pi-sweep: no-assertion hook logic. Do not remove or rewrite as boilerplate.

A pytest test that finishes without an assertion passes silently. This module
parses a test function's source and reports the ones that contain no assertion.
It has no pytest dependency so it can be exercised directly.
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

ASSERTION_NAMES = {"expect", "fail", "raises"}


def _call_name(node: ast.Call) -> str:
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return ""


def _is_assertion(node: ast.AST) -> bool:
    if isinstance(node, ast.Assert):
        return True
    if isinstance(node, ast.Call):
        name = _call_name(node)
        return name.startswith("assert") or name in ASSERTION_NAMES
    return False


def _has_assertion(body: list[ast.stmt]) -> bool:
    return any(_is_assertion(node) for stmt in body for node in ast.walk(stmt))


def violations(source: str, filename: str = "<test>") -> list[str]:
    """Return one message per test function whose body asserts nothing."""
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as error:
        raise SystemExit(f"{filename}: cannot parse test source: {error}") from error

    problems: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.name.startswith("test"):
            continue
        if not _has_assertion(node.body):
            problems.append(
                f"{filename}:{node.lineno}: {node.name} has no assertion; "
                "add one or mark it pytest.skip"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reject test functions with no assertion.")
    parser.add_argument("files", nargs="+", help="test source files to check")
    args = parser.parse_args(argv)

    problems: list[str] = []
    for name in args.files:
        path = Path(name)
        problems.extend(violations(path.read_text(encoding="utf8"), str(path)))

    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
