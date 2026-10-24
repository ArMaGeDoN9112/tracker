import ast
from importlib.util import resolve_name
from pathlib import Path

import pytest


# Explicit pure dependencies: new I/O libraries must stay in adapters.
PURE_IMPORTS = {
    "__future__", "base64", "binascii", "datetime", "enum", "fractions",
    "re", "typing", "uuid", "zoneinfo", "pydantic", "dataclasses", "hashlib", "json",
}


def violations(source: str, module: str, package: str) -> list[str]:
    layer = module.split(".")[1]
    allowed_layers = {
        "domain": ("diary.domain",),
        "application": ("diary.domain", "diary.application"),
        "infrastructure": ("diary.domain", "diary.application", "diary.infrastructure", "diary.tables"),
        "interfaces": ("diary.domain", "diary.application", "diary.interfaces"),
    }[layer]
    errors = []
    for node in ast.walk(ast.parse(source)):
        imports = []
        if isinstance(node, ast.Import):
            imports = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            name = resolve_name("." * node.level + (node.module or ""), package) if node.level else node.module or ""
            imports = [name, *(name + "." + alias.name for alias in node.names)]
        for name in imports:
            if layer in {"infrastructure", "interfaces"} and name.split(".")[0] != "diary":
                continue
            # CLI composes dependencies lazily, after argparse; HTTP receives use cases.
            if module.startswith("diary.interfaces.cli.") and (name == "diary.bootstrap" or name.startswith("diary.bootstrap.")):
                continue
            if name.split(".")[0] in PURE_IMPORTS:
                continue
            if any(name == layer or name.startswith(layer + ".") for layer in allowed_layers):
                continue
            errors.append(f"{module}:{node.lineno}: forbidden import {name}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"open", "__import__", "eval", "exec"}:
            errors.append(f"{module}:{node.lineno}: forbidden call {node.func.id}")
    return errors


def test_package_dependency_direction():
    root = Path(__file__).resolve().parents[1]
    errors = []
    for layer in ("domain", "application", "infrastructure", "interfaces"):
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
    ("diary.infrastructure.access", "diary.infrastructure", "from diary.tables import account"),
    ("diary.infrastructure.reads", "diary.infrastructure", "from .water import SqliteWater"),
    ("diary.interfaces.http.access", "diary.interfaces.http", "from .dto import LoginOutput"),
    ("diary.interfaces.cli.admin", "diary.interfaces.cli", "def main():\n    from diary.bootstrap import admin_use_cases"),
])
def test_guard_allows_core_dependencies(module, package, source):
    assert violations(source, module, package) == []


@pytest.mark.parametrize("module,source", [
    ("diary.infrastructure.database", "from diary.interfaces.http import errors"),
    ("diary.infrastructure.access", "from diary import db"),
    ("diary.interfaces.http.access", "from diary.infrastructure import access"),
    ("diary.interfaces.http.access", "from ... import tables"),
    ("diary.interfaces.http.access", "from diary.dto import LoginOutput"),
])
def test_guard_rejects_adapter_cross_dependencies(module, source):
    assert violations(source, module, module.rpartition(".")[0])
