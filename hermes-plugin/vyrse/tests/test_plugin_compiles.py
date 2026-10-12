import py_compile
from pathlib import Path


def test_every_plugin_module_compiles():
    # A syntax error anywhere makes Hermes skip the whole plugin (no VYRSE tools, styles or voice).
    root = Path(__file__).resolve().parents[1]
    for path in root.rglob("*.py"):
        if "pylib" not in path.parts:
            py_compile.compile(str(path), doraise=True)
