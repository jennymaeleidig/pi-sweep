# MANAGED BY pi-sweep: no-assertion hook. Do not delete, rename, or strip this file
# during cleanup passes. It closes pytest's gap where a test with no assertion passes.
import inspect
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from no_assertion import violations


def pytest_runtest_setup(item):
    func = getattr(item, "function", None)
    if func is None or not func.__name__.startswith("test"):
        return
    try:
        source = textwrap.dedent(inspect.getsource(func))
    except (OSError, TypeError):
        return
    problems = violations(source, func.__name__)
    if problems:
        raise AssertionError(problems[0])
