from collections.abc import Generator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
from typing import Callable

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import delete, select, column, table
from sqlalchemy.exc import SQLAlchemyError

from diary.application.backup import BackupFailure, BackupKind, BackupStatus, Manifest, Snapshot
from diary.application.export import ExportData
from diary.db import database_engine
from diary.infrastructure.export import SqliteExport
from diary.domain.time import MOSCOW
from diary.tables import pre_session, session


ROOT = Path(__file__).resolve().parents[2]
GROUP = "diary-v1"


def status_path(database: Path) -> Path:
    return database.with_suffix(".backup-status.json")


def read_status(database: Path) -> BackupStatus:
    try:
        status = BackupStatus.model_validate_json(status_path(database).read_text())
    except FileNotFoundError:
        status = BackupStatus()
    except (ValueError, OSError):
        status = BackupStatus(error="Не удалось прочитать состояние резервирования.")
    return status


def save_status(database: Path, status: BackupStatus) -> None:
    target = status_path(database)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(status.model_dump_json(), encoding="utf-8")
    temporary.replace(target)


@contextmanager
def exclusive(database: Path) -> Generator[None]:
    with database.with_suffix(".backup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def restic(*args: str, cwd: Path | None = None) -> str:
    # stderr may contain repository credentials or private paths; never relay it.
    result = subprocess.run(["restic", *args], cwd=cwd, capture_output=True, text=True, timeout=3600)
    if result.returncode:
        raise BackupFailure("Ошибка restic: проверьте доступ, ключ, место и соединение.")
    return result.stdout


def checksum(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_database(database: Path, validate_export: Callable[[ExportData], None]) -> str:
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or connection.execute("PRAGMA foreign_key_check").fetchall():
            raise BackupFailure("Снимок не прошёл проверку целостности или внешних ключей.")
    engine = database_engine(database)
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            version = str(connection.execute(select(column("version_num")).select_from(table("alembic_version"))).scalar_one())
            config = Config()
            config.set_main_option("script_location", str(ROOT / "migrations"))
            if version != ScriptDirectory.from_config(config).get_current_head():
                raise BackupFailure("Для схемы снимка нужен совместимый релиз.")
            # Read using the application's serializers, so incompatible schemas fail here.
            validate_export(SqliteExport(connection).read())
            return version
    finally:
        engine.dispose()


def make_bundle(database: Path, bundle: Path, at: datetime, validate_export: Callable[[ExportData], None]) -> Manifest:
    bundle.mkdir(mode=0o700)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source, closing(sqlite3.connect(bundle / "diary.sqlite3")) as target:
        source.backup(target, pages=256)
    version = validate_database(bundle / "diary.sqlite3", validate_export)
    for name in ("uv.lock", "pyproject.toml", "frontend/package-lock.json", "Dockerfile", "compose.yaml", "Caddyfile"):
        target_path = bundle / name
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target_path)
    shutil.copytree(ROOT / "diary", bundle / "diary", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(ROOT / "migrations", bundle / "migrations", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copyfile(os.environ["DIARY_RECOVERY_CONFIG"], bundle / "recovery.env")
    manifest = Manifest(created_at=at, release=os.environ.get("DIARY_RELEASE") or (ROOT / "RELEASE").read_text(),
                        schema_version=version, sqlite_version=sqlite3.sqlite_version,
                        files={p.relative_to(bundle).as_posix(): checksum(p) for p in bundle.rglob("*") if p.is_file()})
    (bundle / "manifest.json").write_text(manifest.model_dump_json(indent=2))
    return manifest


def check_bundle(bundle: Path, validate_export: Callable[[ExportData], None]) -> Manifest:
    manifest = Manifest.model_validate_json((bundle / "manifest.json").read_text())
    if manifest.format_version != 1:
        raise BackupFailure("Неизвестный формат снимка.")
    for name, expected in manifest.files.items():
        path = (bundle / name).resolve()
        if not path.is_relative_to(bundle.resolve()) or path.is_symlink() or checksum(path) != expected:
            raise BackupFailure("Контрольные данные снимка не совпали.")
    if "diary.sqlite3" not in manifest.files or validate_database(bundle / "diary.sqlite3", validate_export) != manifest.schema_version:
        raise BackupFailure("Версия схемы снимка не совпала.")
    return manifest


def snapshots(kind: BackupKind | None = None) -> list[Snapshot]:
    tag = GROUP + ("," + kind.value if kind else "")
    return [Snapshot.model_validate(row) for row in json.loads(restic("snapshots", "--json", "--tag", tag))]


@contextmanager
def backup_errors() -> Generator[None]:
    try:
        yield
    except (OSError, ValueError, sqlite3.Error, SQLAlchemyError, subprocess.SubprocessError, StopIteration, KeyError, TypeError) as error:
        raise BackupFailure("Ошибка хранилища резервных копий.") from error


@dataclass
class FileBackupStorage:
    database: Path
    validate_export: Callable[[ExportData], None]
    external: bool

    @contextmanager
    def exclusive(self) -> Generator[None]:
        with backup_errors(), exclusive(self.database):
            yield

    def read_status(self) -> BackupStatus:
        return read_status(self.database)

    def save_status(self, status: BackupStatus) -> None:
        with backup_errors():
            save_status(self.database, status)

    @contextmanager
    def workspace(self, prefix: str) -> Generator[str]:
        with backup_errors(), tempfile.TemporaryDirectory(prefix=prefix, dir=self.database.parent) as work:
            yield work

    def make_bundle(self, bundle: str, at: datetime) -> Manifest:
        with backup_errors():
            return make_bundle(self.database, Path(bundle), at, self.validate_export)

    def upload(self, bundle: str, kind: BackupKind, at: datetime) -> str:
        with backup_errors():
            output = restic("backup", ".", "--json", "--host", "diary", "--tag", GROUP, "--tag", kind.value, "--tag", "pending",
                            "--time", at.astimezone(MOSCOW).strftime("%Y-%m-%d %H:%M:%S"), cwd=Path(bundle))
            summaries = [json.loads(line) for line in output.splitlines() if line.strip()]
            return str(next(row["snapshot_id"] for row in summaries if row.get("message_type") == "summary"))

    def snapshots(self, kind: BackupKind | None = None) -> list[Snapshot]:
        with backup_errors():
            return snapshots(kind)

    def target_exists(self, target: str) -> bool:
        return Path(target).exists()

    def restore_files(self, snapshot: str, target: str) -> None:
        with backup_errors():
            Path(target).mkdir(mode=0o700, parents=True)
            restic("restore", snapshot, "--target", target)

    def check_bundle(self, target: str) -> Manifest:
        with backup_errors():
            return check_bundle(Path(target), self.validate_export)

    def revoke_sessions(self, target: str) -> None:
        with backup_errors():
            engine = database_engine(Path(target) / "diary.sqlite3")
            try:
                with engine.begin() as connection:
                    connection.execute(delete(session))
                    connection.execute(delete(pre_session))
            finally:
                engine.dispose()

    def validate_database(self, target: str) -> str:
        with backup_errors():
            return validate_database(Path(target) / "diary.sqlite3", self.validate_export)

    def mark_verified(self, snapshot: str) -> None:
        with backup_errors():
            restic("tag", "--remove", "pending", snapshot)

    def check_repository(self) -> None:
        with backup_errors():
            restic("check", "--read-data")

    def forget(self, snapshots: list[str]) -> None:
        with backup_errors():
            restic("forget", *snapshots)
            restic("prune")
