"""Administrative backup commands; run in the Linux Compose image."""

import argparse
from contextlib import closing, contextmanager
from collections.abc import Generator
from datetime import datetime, timedelta, timezone
from enum import StrEnum
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from alembic.config import Config
from alembic.script import ScriptDirectory
from pydantic import AwareDatetime, BaseModel, Field
from sqlalchemy import delete, select, column, table

from diary.basal import schedules, temporary_basals
from diary.db import database_engine
from diary.dto import EntryRecord
from diary.tables import entry, pre_session, session


ROOT = Path(__file__).resolve().parent.parent
MOSCOW = ZoneInfo("Europe/Moscow")
GROUP = "diary-v1"


class BackupKind(StrEnum):
    DAILY = "daily"
    MANUAL = "manual"
    PREMIGRATION = "premigration"


class BackupStatus(BaseModel):
    last_external_success: AwareDatetime | None = None
    last_local_success: AwareDatetime | None = None
    last_verification: AwareDatetime | None = None
    verification_snapshot: str | None = None
    verification_seconds: float | None = None
    verification_release: str | None = None
    verification_error: str | None = None
    error: str | None = None
    overdue: bool = True


class Manifest(BaseModel):
    format_version: int = 1
    created_at: AwareDatetime
    release: str
    schema_version: str
    sqlite_version: str
    files: dict[str, str]


class Snapshot(BaseModel):
    id: str
    time: AwareDatetime
    tags: list[str] = Field(default_factory=list)


def status_path(database: Path) -> Path:
    return database.with_suffix(".backup-status.json")


def read_status(database: Path) -> BackupStatus:
    try:
        status = BackupStatus.model_validate_json(status_path(database).read_text())
    except FileNotFoundError:
        status = BackupStatus()
    except (ValueError, OSError):
        status = BackupStatus(error="Не удалось прочитать состояние резервирования.")
    status.overdue = status.last_external_success is None or datetime.now(timezone.utc) - status.last_external_success > timedelta(hours=26)
    return status


def save_status(database: Path, status: BackupStatus) -> None:
    target = status_path(database)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(status.model_dump_json(), encoding="utf-8")
    temporary.replace(target)


def register_backup_status(app: FastAPI, database: Path) -> None:
    @app.get("/api/backup-status")
    def backup_status() -> BackupStatus:
        return read_status(database)


@contextmanager
def exclusive(database: Path) -> Generator[None]:
    with database.with_suffix(".backup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def restic(*args: str, cwd: Path | None = None) -> str:
    # stderr may contain repository credentials or private paths; never relay it.
    result = subprocess.run(["restic", *args], cwd=cwd, capture_output=True, text=True, timeout=3600)
    if result.returncode:
        raise ValueError("Ошибка restic: проверьте доступ, ключ, место и соединение.")
    return result.stdout


def checksum(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_database(database: Path) -> str:
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)] or connection.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Снимок не прошёл проверку целостности или внешних ключей.")
    engine = database_engine(database)
    try:
        with engine.connect() as connection:
            version = str(connection.execute(select(column("version_num")).select_from(table("alembic_version"))).scalar_one())
            config = Config()
            config.set_main_option("script_location", str(ROOT / "migrations"))
            if version != ScriptDirectory.from_config(config).get_current_head():
                raise ValueError("Для схемы снимка нужен совместимый релиз.")
            # Read using the application's serializers, so incompatible schemas fail here.
            schedules(connection)
            temporary_basals(connection)
            for row in connection.execute(select(entry)).mappings():
                EntryRecord.model_validate(row)
            return version
    finally:
        engine.dispose()


def make_bundle(database: Path, bundle: Path, at: datetime) -> Manifest:
    bundle.mkdir(mode=0o700)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as source, closing(sqlite3.connect(bundle / "diary.sqlite3")) as target:
        source.backup(target, pages=256)
    version = validate_database(bundle / "diary.sqlite3")
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


def check_bundle(bundle: Path) -> Manifest:
    manifest = Manifest.model_validate_json((bundle / "manifest.json").read_text())
    if manifest.format_version != 1:
        raise ValueError("Неизвестный формат снимка.")
    for name, expected in manifest.files.items():
        path = (bundle / name).resolve()
        if not path.is_relative_to(bundle.resolve()) or path.is_symlink() or checksum(path) != expected:
            raise ValueError("Контрольные данные снимка не совпали.")
    if "diary.sqlite3" not in manifest.files or validate_database(bundle / "diary.sqlite3") != manifest.schema_version:
        raise ValueError("Версия схемы снимка не совпала.")
    return manifest


def snapshots(kind: BackupKind | None = None) -> list[Snapshot]:
    tag = GROUP + ("," + kind.value if kind else "")
    return [Snapshot.model_validate(row) for row in json.loads(restic("snapshots", "--json", "--tag", tag))]


def restore_point(snapshot: str, target: Path) -> Manifest:
    if target.exists():
        raise ValueError("Восстановление требует нового, несуществующего каталога.")
    points = snapshots()
    candidates = [point for point in points if "pending" not in point.tags] if snapshot == "latest" else [point for point in points if point.id.startswith(snapshot)]
    if not candidates or (snapshot != "latest" and len(candidates) != 1):
        raise ValueError("Точка дневника не найдена; укажите полный ID.")
    selected = max(candidates, key=lambda point: point.time)
    target.mkdir(mode=0o700, parents=True)
    restic("restore", selected.id, "--target", str(target))
    manifest = check_bundle(target)
    engine = database_engine(target / "diary.sqlite3")
    try:
        with engine.begin() as connection:
            connection.execute(delete(session))
            connection.execute(delete(pre_session))
    finally:
        engine.dispose()
    validate_database(target / "diary.sqlite3")
    return manifest


def rotate_daily() -> None:
    points = sorted((point for point in snapshots(BackupKind.DAILY) if "pending" not in point.tags), key=lambda point: (point.time, point.id), reverse=True)
    days: set[str] = set()
    remove = []
    for point in points:
        day = point.time.astimezone(MOSCOW).date().isoformat()
        if day in days or len(days) >= 7:
            remove.append(point.id)
        else:
            days.add(day)
    if remove:
        restic("forget", *remove)
        restic("prune")


def backup(database: Path, kind: BackupKind, at: datetime, status: BackupStatus) -> None:
    with tempfile.TemporaryDirectory(prefix="diary-backup-", dir=database.parent) as temporary:
        work = Path(temporary)
        bundle = work / "bundle"
        make_bundle(database, bundle, at)
        output = restic("backup", ".", "--json", "--host", "diary", "--tag", GROUP, "--tag", kind.value, "--tag", "pending",
                        "--time", at.astimezone(MOSCOW).strftime("%Y-%m-%d %H:%M:%S"), cwd=bundle)
        summaries = [json.loads(line) for line in output.splitlines() if line.strip()]
        snapshot_id = next(row["snapshot_id"] for row in summaries if row.get("message_type") == "summary")
        restore_point(snapshot_id, work / "readback")
        restic("tag", "--remove", "pending", snapshot_id)
    completed = datetime.now(timezone.utc)
    repository = os.environ["RESTIC_REPOSITORY"]
    external = repository.startswith(("s3:", "sftp:", "rest:", "rclone:", "azure:", "gs:", "b2:"))
    if external:
        status.last_external_success = completed
    else:
        status.last_local_success = completed
    status.error = None
    save_status(database, status)
    if kind == BackupKind.DAILY:
        rotate_daily()


def main() -> None:
    os.umask(0o077)
    os.environ["TZ"] = "Europe/Moscow"
    time.tzset()
    parser = argparse.ArgumentParser(description="Зашифрованные копии дневника (restic)")
    parser.add_argument("--database", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("backup")
    create.add_argument("--kind", type=BackupKind, choices=list(BackupKind), default=BackupKind.DAILY)
    create.add_argument("--at", type=datetime.fromisoformat, default=None, help="Дата точки с UTC-смещением; для учений")
    commands.add_parser("verify")
    restore = commands.add_parser("restore")
    restore.add_argument("--snapshot", required=True)
    restore.add_argument("--target", required=True, type=Path)
    args = parser.parse_args()
    database = args.database.resolve()
    try:
        with exclusive(database):
            status = read_status(database)
            status.error = "Запуск ещё не завершён. Если процесс прерван, повторите его."
            save_status(database, status)
            try:
                if args.command == "backup":
                    at = args.at or datetime.now(timezone.utc)
                    if at.tzinfo is None:
                        raise ValueError("Укажите UTC-смещение даты.")
                    backup(database, args.kind, at, status)
                elif args.command == "verify":
                    started = time.monotonic()
                    points = [point for point in snapshots() if "pending" not in point.tags]
                    point = max(points, key=lambda row: row.time)
                    restic("check", "--read-data")
                    with tempfile.TemporaryDirectory(prefix="diary-verify-", dir=database.parent) as temporary:
                        manifest = restore_point(point.id, Path(temporary) / "recovered")
                    status.last_verification = datetime.now(timezone.utc)
                    status.verification_snapshot = point.id
                    status.verification_release = manifest.release
                    status.verification_seconds = round(time.monotonic() - started, 3)
                    status.verification_error = None
                else:
                    restore_point(args.snapshot, args.target.resolve())
                status.error = None
            except (Exception, KeyboardInterrupt):
                status.error = "Запуск не завершён: проверьте хранилище, ключ, свободное место и совместимость релиза."
                if args.command == "verify":
                    status.verification_error = "Проверка восстановления не прошла."
                save_status(database, status)
                raise
            save_status(database, status)
    except (Exception, KeyboardInterrupt):
        parser.exit(1, "Ошибка резервирования/восстановления. Проверьте состояние в настройках; параллельный запуск запрещён.\n")
    print("Готово.")


if __name__ == "__main__":
    main()
