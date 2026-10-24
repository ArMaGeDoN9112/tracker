from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Callable, ContextManager, Protocol

from pydantic import AwareDatetime, BaseModel, Field

from diary.application.errors import ApplicationError
from diary.domain.time import MOSCOW


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


class BackupFailure(ApplicationError):
    code = "backup_failure"


class BackupInput(BaseModel):
    kind: BackupKind = BackupKind.DAILY
    at: datetime


class RestoreInput(BaseModel):
    snapshot: str
    target: str


class BackupStorage(Protocol):
    external: bool

    def exclusive(self) -> ContextManager[None]: ...
    def read_status(self) -> BackupStatus: ...
    def save_status(self, status: BackupStatus) -> None: ...
    def workspace(self, prefix: str) -> ContextManager[str]: ...
    def make_bundle(self, bundle: str, at: datetime) -> Manifest: ...
    def upload(self, bundle: str, kind: BackupKind, at: datetime) -> str: ...
    def snapshots(self, kind: BackupKind | None = None) -> list[Snapshot]: ...
    def target_exists(self, target: str) -> bool: ...
    def restore_files(self, snapshot: str, target: str) -> None: ...
    def check_bundle(self, target: str) -> Manifest: ...
    def revoke_sessions(self, target: str) -> None: ...
    def validate_database(self, target: str) -> str: ...
    def mark_verified(self, snapshot: str) -> None: ...
    def check_repository(self) -> None: ...
    def forget(self, snapshots: list[str]) -> None: ...


@dataclass
class GetBackupStatus:
    storage: BackupStorage
    clock: Callable[[], datetime]

    def execute(self) -> BackupStatus:
        status = self.storage.read_status()
        status.overdue = status.last_external_success is None or self.clock() - status.last_external_success > timedelta(hours=26)
        return status


@dataclass
class RestorePoint:
    storage: BackupStorage

    def execute(self, payload: RestoreInput) -> Manifest:
        if self.storage.target_exists(payload.target):
            raise BackupFailure("Восстановление требует нового, несуществующего каталога.")
        points = self.storage.snapshots()
        candidates = ([point for point in points if "pending" not in point.tags] if payload.snapshot == "latest"
                      else [point for point in points if point.id.startswith(payload.snapshot)])
        if not candidates or (payload.snapshot != "latest" and len(candidates) != 1):
            raise BackupFailure("Точка дневника не найдена; укажите полный ID.")
        selected = max(candidates, key=lambda point: point.time)
        self.storage.restore_files(selected.id, payload.target)
        manifest = self.storage.check_bundle(payload.target)
        self.storage.revoke_sessions(payload.target)
        self.storage.validate_database(payload.target)
        return manifest


def rotate_daily(storage: BackupStorage) -> None:
    points = sorted((point for point in storage.snapshots(BackupKind.DAILY) if "pending" not in point.tags),
                    key=lambda point: (point.time, point.id), reverse=True)
    days: set[str] = set()
    remove = []
    for point in points:
        day = point.time.astimezone(MOSCOW).date().isoformat()
        if day in days or len(days) >= 7:
            remove.append(point.id)
        else:
            days.add(day)
    if remove:
        storage.forget(remove)


@dataclass
class CreateBackup:
    storage: BackupStorage
    clock: Callable[[], datetime]

    def execute(self, payload: BackupInput, status: BackupStatus) -> None:
        if payload.at.tzinfo is None:
            raise BackupFailure("Укажите UTC-смещение даты.")
        with self.storage.workspace("diary-backup-") as work:
            bundle = work + "/bundle"
            self.storage.make_bundle(bundle, payload.at)
            snapshot = self.storage.upload(bundle, payload.kind, payload.at)
            RestorePoint(self.storage).execute(RestoreInput(snapshot=snapshot, target=work + "/readback"))
            self.storage.mark_verified(snapshot)
        completed = self.clock()
        if self.storage.external:
            status.last_external_success = completed
        else:
            status.last_local_success = completed
        status.error = None
        self.storage.save_status(status)
        if payload.kind == BackupKind.DAILY:
            rotate_daily(self.storage)


@dataclass
class VerifyBackup:
    storage: BackupStorage
    clock: Callable[[], datetime]
    monotonic: Callable[[], float]

    def execute(self, status: BackupStatus) -> None:
        started = self.monotonic()
        points = [point for point in self.storage.snapshots() if "pending" not in point.tags]
        if not points:
            raise BackupFailure("Точка дневника не найдена; укажите полный ID.")
        point = max(points, key=lambda row: row.time)
        self.storage.check_repository()
        with self.storage.workspace("diary-verify-") as work:
            manifest = RestorePoint(self.storage).execute(RestoreInput(snapshot=point.id, target=work + "/recovered"))
        status.last_verification = self.clock()
        status.verification_snapshot = point.id
        status.verification_release = manifest.release
        status.verification_seconds = round(self.monotonic() - started, 3)
        status.verification_error = None


class BackupAction(StrEnum):
    BACKUP = "backup"
    VERIFY = "verify"
    RESTORE = "restore"


class BackupCommand(BaseModel):
    action: BackupAction
    backup: BackupInput | None = None
    restore: RestoreInput | None = None


@dataclass
class RunBackup:
    storage: BackupStorage
    clock: Callable[[], datetime]
    monotonic: Callable[[], float]

    def execute(self, payload: BackupCommand) -> None:
        with self.storage.exclusive():
            status = GetBackupStatus(self.storage, self.clock).execute()
            status.error = "Запуск ещё не завершён. Если процесс прерван, повторите его."
            self.storage.save_status(status)
            try:
                if payload.action == BackupAction.BACKUP:
                    if payload.backup is None:
                        raise BackupFailure("Не заданы параметры резервирования.")
                    CreateBackup(self.storage, self.clock).execute(payload.backup, status)
                elif payload.action == BackupAction.VERIFY:
                    VerifyBackup(self.storage, self.clock, self.monotonic).execute(status)
                else:
                    if payload.restore is None:
                        raise BackupFailure("Не заданы параметры восстановления.")
                    RestorePoint(self.storage).execute(payload.restore)
                status.error = None
            except (Exception, KeyboardInterrupt):
                status.error = "Запуск не завершён: проверьте хранилище, ключ, свободное место и совместимость релиза."
                if payload.action == BackupAction.VERIFY:
                    status.verification_error = "Проверка восстановления не прошла."
                self.storage.save_status(status)
                raise
            self.storage.save_status(status)
