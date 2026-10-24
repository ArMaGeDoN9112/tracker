from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest

from diary.application.backup import (
    BackupAction, BackupCommand, BackupFailure, BackupInput, BackupKind, BackupStatus,
    GetBackupStatus, Manifest, RestoreInput, RestorePoint, RunBackup, Snapshot,
)


AT = datetime(2026, 10, 24, tzinfo=timezone.utc)
OLD = AT - timedelta(days=1)


class MemoryStorage:
    external = True

    def __init__(self, fault=None):
        self.fault = fault
        self.status = BackupStatus(last_external_success=OLD, last_verification=OLD)
        self.saved = self.status.model_copy(deep=True)
        self.points = [Snapshot(id='old', time=OLD, tags=['daily'])]
        self.targets = {}
        self.revoked = set()
        self.forgotten = []

    @contextmanager
    def exclusive(self):
        if self.fault == 'lock':
            raise BackupFailure('locked')
        yield

    @contextmanager
    def workspace(self, prefix):
        yield '/work'

    def read_status(self):
        return self.status.model_copy(deep=True)

    def save_status(self, status):
        self.saved = status.model_copy(deep=True)

    def make_bundle(self, bundle, at):
        return self.manifest()

    def manifest(self):
        return Manifest(created_at=AT, release='test', schema_version='010_remove_product_archive', sqlite_version='3', files={})

    def upload(self, bundle, kind, at):
        if self.fault == 'upload':
            raise BackupFailure('no space')
        self.points.append(Snapshot(id='new', time=at, tags=[kind.value, 'pending']))
        return 'new'

    def snapshots(self, kind=None):
        return [point for point in self.points if kind is None or kind.value in point.tags]

    def target_exists(self, target):
        return target in self.targets

    def restore_files(self, snapshot, target):
        self.targets[target] = snapshot

    def check_bundle(self, target):
        if self.fault == 'readback':
            raise BackupFailure('checksum')
        return self.manifest()

    def revoke_sessions(self, target):
        self.revoked.add(target)

    def validate_database(self, target):
        return '010_remove_product_archive'

    def mark_verified(self, snapshot):
        if self.fault == 'tag':
            raise KeyboardInterrupt()
        next(point for point in self.points if point.id == snapshot).tags.remove('pending')

    def check_repository(self):
        if self.fault == 'verify':
            raise BackupFailure('unavailable')

    def forget(self, snapshots):
        self.forgotten.extend(snapshots)


def runner(storage):
    return RunBackup(storage, lambda: AT, lambda: 10.0)


def test_status_uses_injected_clock_and_26_hour_boundary():
    store = MemoryStorage()
    store.status.last_external_success = AT - timedelta(hours=26)
    assert GetBackupStatus(store, lambda: AT).execute().overdue is False
    assert GetBackupStatus(store, lambda: AT + timedelta(microseconds=1)).execute().overdue is True
    store.status.last_external_success = None
    assert GetBackupStatus(store, lambda: AT).execute().overdue is True


@pytest.mark.parametrize('fault', ['upload', 'readback', 'tag'])
def test_failure_keeps_previous_success_and_daily_points(fault):
    store = MemoryStorage(fault)
    with pytest.raises((BackupFailure, KeyboardInterrupt)):
        runner(store).execute(BackupCommand(action=BackupAction.BACKUP, backup=BackupInput(at=AT)))
    assert store.saved.last_external_success == OLD
    assert store.saved.error is not None
    assert store.points[0].id == 'old'
    assert store.forgotten == []
    if fault != 'upload':
        assert 'pending' in store.points[-1].tags


def test_success_is_published_after_readback_and_revocation():
    store = MemoryStorage()
    runner(store).execute(BackupCommand(action=BackupAction.BACKUP, backup=BackupInput(at=AT)))
    assert store.saved.last_external_success == AT
    assert store.saved.last_local_success is None
    assert store.saved.error is None
    assert store.points[-1].tags == ['daily']
    assert '/work/readback' in store.revoked


def test_verify_failure_keeps_last_verification():
    store = MemoryStorage('verify')
    with pytest.raises(BackupFailure):
        runner(store).execute(BackupCommand(action=BackupAction.VERIFY))
    assert store.saved.last_verification == OLD
    assert store.saved.verification_snapshot is None
    assert store.saved.verification_error is not None


def test_lock_failure_cannot_overwrite_status():
    store = MemoryStorage('lock')
    before = store.saved.model_copy(deep=True)
    with pytest.raises(BackupFailure):
        runner(store).execute(BackupCommand(action=BackupAction.VERIFY))
    assert store.saved == before


def test_latest_ignores_pending_and_existing_target_is_preserved():
    store = MemoryStorage()
    store.points.append(Snapshot(id='pending', time=AT, tags=['pending']))
    case = RestorePoint(store)
    case.execute(RestoreInput(snapshot='latest', target='/recovered'))
    assert '/recovered' in store.revoked
    assert store.targets['/recovered'] == 'old'
    with pytest.raises(BackupFailure):
        case.execute(RestoreInput(snapshot='latest', target='/recovered'))


def test_daily_retention_keeps_seven_moscow_days_and_manual_points():
    store = MemoryStorage()
    store.points = [Snapshot(id=str(day), time=AT - timedelta(days=day), tags=['daily']) for day in range(1, 10)]
    store.points += [Snapshot(id='manual', time=OLD, tags=['manual']), Snapshot(id='pending', time=AT, tags=['daily', 'pending'])]
    runner(store).execute(BackupCommand(action=BackupAction.BACKUP, backup=BackupInput(at=AT)))
    assert store.forgotten == ['7', '8', '9']


def test_naive_backup_time_records_failure_inside_locked_operation():
    store = MemoryStorage()
    with pytest.raises(BackupFailure):
        runner(store).execute(BackupCommand(action=BackupAction.BACKUP, backup=BackupInput(at=AT.replace(tzinfo=None))))
    assert store.saved.last_external_success == OLD
    assert store.saved.error is not None
    assert [point.id for point in store.points] == ['old']
