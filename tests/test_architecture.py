import ast
from importlib.util import resolve_name
from pathlib import Path

import pytest


# Explicit pure dependencies: new I/O libraries must stay in adapters.
PURE_IMPORTS = {
    "__future__", "base64", "binascii", "datetime", "enum", "fractions",
    "re", "typing", "uuid", "zoneinfo", "pydantic",
}


def violations(source: str, module: str, package: str) -> list[str]:
    allowed_layers = ("diary.domain",) if module.startswith("diary.domain") else ("diary.domain", "diary.application")
    errors = []
    for node in ast.walk(ast.parse(source)):
        imports = []
        if isinstance(node, ast.Import):
            imports = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            name = resolve_name("." * node.level + (node.module or ""), package) if node.level else node.module or ""
            imports = [name, *(name + "." + alias.name for alias in node.names)]
        for name in imports:
            if name.split(".")[0] in PURE_IMPORTS:
                continue
            if any(name == layer or name.startswith(layer + ".") for layer in allowed_layers):
                continue
            errors.append(f"{module}:{node.lineno}: forbidden import {name}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"open", "__import__", "eval", "exec"}:
            errors.append(f"{module}:{node.lineno}: forbidden call {node.func.id}")
    return errors


def test_core_dependency_direction():
    root = Path(__file__).resolve().parents[1]
    errors = []
    for layer in ("domain", "application"):
        files = list((root / "diary" / layer).rglob("*.py"))
        assert files, f"Missing {layer} package"
        for path in files:
            parts = path.relative_to(root).with_suffix("").parts
            module = ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
            package = module if parts[-1] == "__init__" else module.rpartition(".")[0]
            errors.extend(violations(path.read_text(encoding="utf-8"), module, package))
    assert not errors, "\n".join(errors)


@pytest.mark.parametrize("source", [
    "import sqlalchemy", "from fastapi import FastAPI",
    "def helper():\n    from diary.entries import milliseconds",
    "from ... import security", "from ...security import now_ms",
    "from diary import entries", "import diary.infrastructure.sqlite",
    "from ...application.operations import OperationAction",
    "from pathlib import Path", "open('data')",
    "__import__('diary.entries')", "import importlib",
])
def test_guard_rejects_external_and_legacy_dependencies(source):
    assert violations(source, "diary.domain.nested.rules", "diary.domain.nested")


@pytest.mark.parametrize("module,package,source", [
    ("diary.domain.basal", "diary.domain", "from .time import milliseconds"),
    ("diary.domain.nested.rules", "diary.domain.nested", "from .. import basal"),
    ("diary.application", "diary.application", "from . import entries"),
    ("diary.application.entries", "diary.application", "from ..domain import time"),
    ("diary.application.entries", "diary.application", "def helper():\n    from .operations import OperationInput"),
])
def test_guard_allows_core_dependencies(module, package, source):
    assert violations(source, module, package) == []
