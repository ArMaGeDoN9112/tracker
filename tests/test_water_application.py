from collections.abc import Generator
from contextlib import contextmanager
from copy import deepcopy
from uuid import uuid4

import pytest

from diary.application.errors import NotFound, OperationConflict, RevisionConflict, Unavailable, UndoExpired
from diary.application.water import (
    CreateWater, DeleteWater, EditWater, EditWaterCommand, EditWaterSettings,
    GetWater, GetWaterSettings, RestoreWater, WaterInput, WaterOperations,
    WaterQuery, WaterRevisionCommand, WaterSettingsInput, WaterSettingsOutput,
)


class MemoryWater:
    def __init__(self):
        self.records = {}
        self.settings = WaterSettingsOutput(volumes_ml=[200, 250, 500], revision=1)

    def get(self, water_id):
        return deepcopy(self.records.get(water_id))

    def save(self, record, *, create):
        self.records[record.id] = deepcopy(record)

    def get_settings(self):
        return deepcopy(self.settings)

    def save_settings(self, settings):
        self.settings = deepcopy(settings)


class MemoryReceipts:
    def __init__(self):
        self.records = {}

    def get(self, operation_id):
        return self.records.get(operation_id)

    def add(self, receipt):
        self.records[receipt.operation_id] = receipt


class MemoryUow:
    def __init__(self):
        self.water = MemoryWater()
        self.receipts = MemoryReceipts()

    @contextmanager
    def open(self) -> Generator['MemoryUow']:
        self.committed = False
        before = deepcopy((self.water, self.receipts))
        try:
            yield self
        finally:
            if not self.committed:
                self.water, self.receipts = before

    def commit(self):
        self.committed = True


def test_create_water_uses_supplied_time_and_id_and_replay_keeps_original():
    store = MemoryUow()
    clock = [1792400000000]
    ids = iter(['00000000-0000-0000-0000-000000000002'])
    create = CreateWater(WaterOperations(store.open, lambda: clock[0], lambda: next(ids)))
    payload = WaterInput(operation_id='00000000-0000-0000-0000-000000000003', volume_ml=250)
    first = create.execute(payload)
    clock[0] += 86400000
    replay = create.execute(payload)
    assert first.receipt.result_id == '00000000-0000-0000-0000-000000000002'
    assert replay.receipt == first.receipt
    assert replay.replayed is True
    saved = GetWater(store.open).execute(WaterQuery(water_id=first.receipt.result_id))
    assert (saved.volume_ml, saved.occurred_at, saved.revision) == (250, 1792400000000, 1)


@pytest.fixture
def water_app():
    store = MemoryUow()
    clock = [1792400000000]
    operations = WaterOperations(store.open, lambda: clock[0], lambda: str(uuid4()))
    return store, clock, operations


def test_edit_moves_water_between_days_and_rejects_stale_revision(water_app):
    store, clock, operations = water_app
    receipt = CreateWater(operations).execute(WaterInput(operation_id=str(uuid4()), volume_ml=250)).receipt
    edit = EditWaterCommand(operation_id=str(uuid4()), water_id=receipt.result_id, expected_revision=1,
                            volume_ml=500, occurred_at='2026-10-20T00:00:00+03:00')
    assert EditWater(operations).execute(edit).receipt.revision == 2
    record = GetWater(store.open).execute(WaterQuery(water_id=receipt.result_id))
    assert (record.volume_ml, record.occurred_at) == (500, 1792443600000)
    with pytest.raises(RevisionConflict):
        EditWater(operations).execute(edit.model_copy(update={'operation_id': str(uuid4())}))
    assert EditWater(operations).execute(edit).replayed is True
    with pytest.raises(OperationConflict):
        EditWater(operations).execute(edit.model_copy(update={'volume_ml': 600}))


@pytest.mark.parametrize('elapsed,expired', [(29999, False), (30000, True)])
def test_delete_replay_does_not_extend_restore_deadline(water_app, elapsed, expired):
    store, clock, operations = water_app
    created = CreateWater(operations).execute(WaterInput(operation_id=str(uuid4()), volume_ml=250)).receipt
    deletion = WaterRevisionCommand(operation_id=str(uuid4()), water_id=created.result_id, expected_revision=1)
    deleted = DeleteWater(operations).execute(deletion)
    clock[0] += elapsed
    assert DeleteWater(operations).execute(deletion).receipt == deleted.receipt
    with pytest.raises(OperationConflict):
        RestoreWater(operations).execute(deletion)
    restore = WaterRevisionCommand(operation_id=str(uuid4()), water_id=created.result_id, expected_revision=2)
    if expired:
        with pytest.raises(UndoExpired):
            RestoreWater(operations).execute(restore)
    else:
        assert RestoreWater(operations).execute(restore).receipt.revision == 3
        assert RestoreWater(operations).execute(restore).replayed is True
    saved = GetWater(store.open).execute(WaterQuery(water_id=created.result_id))
    assert saved.deleted_at == (1792400000000 if expired else None)


def test_settings_keep_order_and_empty_list_and_replay_does_not_revert(water_app):
    store, clock, operations = water_app
    edit = EditWaterSettings(operations)
    payload = WaterSettingsInput(operation_id=str(uuid4()), expected_revision=1, volumes_ml=[500, 100])
    first = edit.execute(payload)
    assert GetWaterSettings(store.open).execute().volumes_ml == [500, 100]
    with pytest.raises(RevisionConflict):
        edit.execute(payload.model_copy(update={'operation_id': str(uuid4())}))
    edit.execute(WaterSettingsInput(operation_id=str(uuid4()), expected_revision=2, volumes_ml=[]))
    assert edit.execute(payload).receipt == first.receipt
    assert GetWaterSettings(store.open).execute() == WaterSettingsOutput(volumes_ml=[], revision=3)


@pytest.mark.parametrize('settings', [False, True])
def test_failed_receipt_rolls_back_change_and_allows_retry(water_app, monkeypatch, settings):
    store, clock, operations = water_app
    water_id = str(uuid4())
    operations = WaterOperations(store.open, lambda: clock[0], lambda: water_id)
    payload = (WaterSettingsInput(operation_id=str(uuid4()), expected_revision=1, volumes_ml=[])
               if settings else WaterInput(operation_id=str(uuid4()), volume_ml=250))
    case = EditWaterSettings(operations) if settings else CreateWater(operations)
    with monkeypatch.context() as patch:
        def fail(receipt):
            raise Unavailable()
        patch.setattr(MemoryReceipts, 'add', lambda self, receipt: fail(receipt))
        with pytest.raises(Unavailable):
            case.execute(payload)
    with pytest.raises(NotFound):
        GetWater(store.open).execute(WaterQuery(water_id=water_id))
    assert GetWaterSettings(store.open).execute().revision == 1
    assert case.execute(payload).replayed is False


def test_missing_water_has_typed_error_for_read_and_changes(water_app):
    store, clock, operations = water_app
    water_id = str(uuid4())
    with pytest.raises(NotFound):
        GetWater(store.open).execute(WaterQuery(water_id=water_id))
    with pytest.raises(NotFound):
        DeleteWater(operations).execute(WaterRevisionCommand(operation_id=str(uuid4()), water_id=water_id, expected_revision=1))
