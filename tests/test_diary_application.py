from contextlib import contextmanager
from collections.abc import Generator
from copy import deepcopy
from datetime import date
from uuid import uuid4

import pytest

from diary.application.basal import (
    BasalOperations, BasalQuery, CreateSchedule, CreateTemporaryBasal, DeleteTemporaryBasal,
    EditTemporaryBasal, EditTemporaryCommand, GetBasal, GetSchedules, GetTemporaryBasal,
    GetTemporaryBasals, IntervalInput, RestoreTemporaryBasal, ScheduleConflict, ScheduleInput,
    TemporaryBasalInput, TemporaryConflict, TemporaryQuery, TemporaryRevisionCommand,
)
from diary.application.entries import (
    CreateEntry, DayQuery, DeleteEntry, EditEntry, EditEntryCommand, EntryInput,
    EntryOperations, EntryQuery, EntryRevisionCommand, GetDay, GetEntry, GetEntryForm,
    GetMoscowTime, InvalidDay, InvalidMoscowTime, MoscowTimeQuery, NonexistentTime, RestoreEntry,
)
from diary.application.errors import NotFound, OperationConflict, RevisionConflict, Unavailable, UndoExpired
from test_water_application import MemoryReceipts


class MemoryEntries:
    def __init__(self):
        self.records = {}

    def get(self, entry_id):
        return deepcopy(self.records.get(entry_id))

    def save(self, record, *, create):
        self.records[record.id] = deepcopy(record)

    def day(self, start, end):
        return sorted((deepcopy(r) for r in self.records.values()
                       if r.deleted_at is None and start <= r.occurred_at < end),
                      key=lambda r: (r.occurred_at, r.created_at, r.id))


class MemoryBasal:
    def __init__(self):
        self.versions = []
        self.periods = {}

    def schedules(self):
        return sorted(deepcopy(self.versions), key=lambda r: r.starts_at)

    def temporary(self):
        from diary.domain.basal import effective_periods
        return effective_periods(sorted((deepcopy(r) for r in self.periods.values()
                                         if r.deleted_at is None), key=lambda r: r.starts_at))

    def get_temporary(self, period_id):
        return deepcopy(self.periods.get(period_id))

    def save_temporary(self, record, *, create):
        self.periods[record.id] = deepcopy(record)

    def add_schedule(self, record):
        self.versions.append(deepcopy(record))


class MemoryDiaryUow:
    def __init__(self):
        self.entries = MemoryEntries()
        self.basal = MemoryBasal()
        self.receipts = MemoryReceipts()

    @contextmanager
    def open(self) -> Generator['MemoryDiaryUow']:
        self.committed = False
        before = deepcopy((self.entries, self.basal, self.receipts))
        try:
            yield self
        finally:
            if not self.committed:
                self.entries, self.basal, self.receipts = before

    def commit(self):
        self.committed = True


def test_entry_creation_and_replay_use_supplied_clock_and_id():
    store = MemoryDiaryUow()
    ids = iter(['00000000-0000-0000-0000-000000000002'])
    create = CreateEntry(EntryOperations(store.open, lambda: 1792400000000, lambda: next(ids)))
    payload = EntryInput(operation_id='00000000-0000-0000-0000-000000000003',
                         occurred_at='2026-10-19T00:00:00+03:00', glucose='5,60')
    first = create.execute(payload)
    assert create.execute(payload).receipt == first.receipt
    saved = GetEntry(store.open).execute(EntryQuery(entry_id=first.receipt.result_id))
    assert (saved.record.glucose, saved.record.occurred_at, saved.record.created_at, saved.basal) == (
        56, 1792357200000, 1792400000000, None)


@pytest.fixture
def diary_app():
    store = MemoryDiaryUow()
    clock = [1792400000000]
    args = (store.open, lambda: clock[0], lambda: str(uuid4()))
    return store, clock, EntryOperations(*args), BasalOperations(*args)


def test_edit_moves_entry_and_rejects_stale_revision(diary_app):
    store, clock, operations, _ = diary_app
    create = CreateEntry(operations)
    first = create.execute(EntryInput(operation_id=str(uuid4()), occurred_at='2026-10-19T00:00:00+03:00', glucose='5.6'))
    payload = EditEntryCommand(operation_id=str(uuid4()), entry_id=first.receipt.result_id, expected_revision=1,
                               occurred_at='2026-10-20T00:00:00+03:00', bolus='1.5', reason='food')
    edited = EditEntry(operations).execute(payload)
    assert edited.receipt.revision == 2
    assert EditEntry(operations).execute(payload).replayed
    with pytest.raises(OperationConflict):
        EditEntry(operations).execute(payload.model_copy(update={'bolus': '2.0'}))
    with pytest.raises(RevisionConflict):
        EditEntry(operations).execute(payload.model_copy(update={'operation_id': str(uuid4())}))
    assert GetDay(store.open).execute(DayQuery(day=date(2026, 10, 19))).entries == []
    day = GetDay(store.open).execute(DayQuery(day=date(2026, 10, 20)))
    assert [(row.record.bolus, row.record.glucose, row.basal) for row in day.entries] == [(15, None, None)]


@pytest.mark.parametrize('kind', ['entry', 'temporary'])
@pytest.mark.parametrize('elapsed', [29999, 30000])
def test_delete_replay_preserves_deadline_and_revision(diary_app, kind, elapsed):
    store, clock, entries, basal = diary_app
    if kind == 'entry':
        created = CreateEntry(entries).execute(EntryInput(operation_id=str(uuid4()), occurred_at='2026-10-19T00:00:00Z', comment='x'))
        command = EntryRevisionCommand
        target = {'entry_id': created.receipt.result_id}
        delete, restore = DeleteEntry(entries), RestoreEntry(entries)
    else:
        created = CreateTemporaryBasal(basal).execute(TemporaryBasalInput(operation_id=str(uuid4()), starts_at='2026-10-19T00:00:00Z', duration_minutes=60, percent=120))
        command = TemporaryRevisionCommand
        target = {'period_id': created.receipt.result_id}
        delete, restore = DeleteTemporaryBasal(basal), RestoreTemporaryBasal(basal)
    deletion = command(operation_id=str(uuid4()), expected_revision=1, **target)
    deleted = delete.execute(deletion)
    clock[0] += elapsed
    assert delete.execute(deletion).receipt == deleted.receipt
    with pytest.raises(OperationConflict):
        restore.execute(deletion)
    undo = command(operation_id=str(uuid4()), expected_revision=2, **target)
    if elapsed == 30000:
        with pytest.raises(UndoExpired):
            restore.execute(undo)
    else:
        assert restore.execute(undo).receipt.revision == 3
        assert restore.execute(undo).replayed


def test_schedule_history_temporary_overlap_and_day_share_rules(diary_app):
    store, clock, entries, basal = diary_app
    assert GetBasal(store.open).execute(BasalQuery(instant=1792400000000)) is None
    schedule = ScheduleInput(operation_id=str(uuid4()), starts_at='2026-10-19T00:00:00+03:00',
                             intervals=[IntervalInput(minute=0, rate='0.55')])
    saved = CreateSchedule(basal).execute(schedule)
    assert CreateSchedule(basal).execute(schedule).replayed
    with pytest.raises(ScheduleConflict) as conflict:
        CreateSchedule(basal).execute(schedule.model_copy(update={'operation_id': str(uuid4())}))
    assert conflict.value.existing_id == saved.receipt.result_id
    first = CreateTemporaryBasal(basal).execute(TemporaryBasalInput(
        operation_id=str(uuid4()), starts_at='2026-10-19T10:00:00+03:00', duration_minutes=120, percent=150))
    second = CreateTemporaryBasal(basal).execute(TemporaryBasalInput(
        operation_id=str(uuid4()), starts_at='2026-10-19T11:00:00+03:00', duration_minutes=60, percent=0))
    query = TemporaryQuery(period_id=first.receipt.result_id)
    assert GetTemporaryBasal(store.open).execute(query).effective_ends_at == 1792396800000
    edit = EditTemporaryCommand(operation_id=str(uuid4()), period_id=second.receipt.result_id, expected_revision=1,
                                starts_at='2026-10-19T11:30:00+03:00', ends_at='2026-10-19T11:45:00+03:00', percent=120)
    assert EditTemporaryBasal(basal).execute(edit).receipt.revision == 2
    assert EditTemporaryBasal(basal).execute(edit).replayed
    assert GetTemporaryBasal(store.open).execute(TemporaryQuery(period_id=second.receipt.result_id)).duration_minutes == 60
    assert GetBasal(store.open).execute(BasalQuery(instant=1792396800000)) == '0.83'
    assert GetBasal(store.open).execute(BasalQuery(instant=1792399200000)) == '0.66'
    assert GetBasal(store.open).execute(BasalQuery(instant=1792399500000)) == '0.55'
    with pytest.raises(TemporaryConflict):
        EditTemporaryBasal(basal).execute(edit.model_copy(update={
            'operation_id': str(uuid4()), 'expected_revision': 2, 'starts_at': '2026-10-19T07:00:00.000Z'}))
    assert len(GetSchedules(store.open).execute()) == 1
    assert len(GetTemporaryBasals(store.open).execute()) == 2
    day = GetDay(store.open).execute(DayQuery(day=date(2026, 10, 19)))
    assert day.basal == '0.55'
    assert [row.basal for row in day.basal_changes] == ['0.83', '0.66', '0.55']
    form = GetEntryForm(store.open, lambda: 1792396800000).execute()
    assert (form.local_time.hour, form.basal) == (11, '0.83')


@pytest.mark.parametrize('kind', ['entry', 'temporary', 'schedule'])
def test_receipt_failure_rolls_back_and_allows_retry(diary_app, monkeypatch, kind):
    store, _, entries, basal = diary_app
    if kind == 'entry':
        case = CreateEntry(entries)
        payload = EntryInput(operation_id=str(uuid4()), occurred_at='2026-10-19T00:00:00Z', comment='x')
    elif kind == 'temporary':
        case = CreateTemporaryBasal(basal)
        payload = TemporaryBasalInput(operation_id=str(uuid4()), starts_at='2026-10-19T00:00:00Z', duration_minutes=60, percent=100)
    else:
        case = CreateSchedule(basal)
        payload = ScheduleInput(operation_id=str(uuid4()), starts_at='2026-10-19T00:00:00Z', intervals=[IntervalInput(minute=0, rate='1')])
    with monkeypatch.context() as patch:
        def fail(self, receipt):
            raise Unavailable()
        patch.setattr(MemoryReceipts, 'add', fail)
        with pytest.raises(Unavailable):
            case.execute(payload)
    assert GetSchedules(store.open).execute() == []
    assert GetTemporaryBasals(store.open).execute() == []
    assert GetDay(store.open).execute(DayQuery(day=date(2026, 10, 19))).entries == []
    assert case.execute(payload).replayed is False


def test_reads_and_changes_report_missing_records(diary_app):
    store, _, entries, basal = diary_app
    missing = str(uuid4())
    with pytest.raises(NotFound):
        GetEntry(store.open).execute(EntryQuery(entry_id=missing))
    with pytest.raises(NotFound):
        GetTemporaryBasal(store.open).execute(TemporaryQuery(period_id=missing))
    with pytest.raises(NotFound):
        DeleteEntry(entries).execute(EntryRevisionCommand(operation_id=str(uuid4()), expected_revision=1, entry_id=missing))
    with pytest.raises(NotFound):
        DeleteTemporaryBasal(basal).execute(TemporaryRevisionCommand(operation_id=str(uuid4()), expected_revision=1, period_id=missing))
    with pytest.raises(InvalidDay):
        GetDay(store.open).execute(DayQuery(day=date.max))


def test_historical_moscow_time_candidates_without_http():
    case = GetMoscowTime()
    candidates = case.execute(MoscowTimeQuery(local_time='2014-10-26T01:30')).candidates
    assert {row.isoformat() for row in candidates} == {'2014-10-26T01:30:00+03:00', '2014-10-26T01:30:00+04:00'}
    with pytest.raises(NonexistentTime):
        case.execute(MoscowTimeQuery(local_time='2011-03-27T02:30'))
    with pytest.raises(InvalidMoscowTime):
        case.execute(MoscowTimeQuery(local_time='2026-01-01'))
