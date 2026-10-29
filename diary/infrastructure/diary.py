from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy import Connection, Engine, insert, select, update
from sqlalchemy.exc import SQLAlchemyError

from diary.application.diary import BasalStore, DiaryUow, EntryStore
from diary.application.errors import Unavailable
from diary.application.operations import ReceiptStore
from diary.domain.basal import BasalInterval, BasalSchedule, TemporaryBasalPeriod, effective_periods
from diary.domain.entries import EntryRecord
from diary.infrastructure.water import SqliteReceipts
from diary.tables import basal_interval, basal_schedule, entry, temporary_basal


def schedules(connection: Connection) -> list[BasalSchedule]:
    rows = connection.execute(
        select(basal_schedule.c.id, basal_schedule.c.starts_at, basal_schedule.c.created_at,
               basal_interval.c.minute, basal_interval.c.rate)
        .select_from(basal_schedule.join(basal_interval, basal_interval.c.schedule_id == basal_schedule.c.id))
        .order_by(basal_schedule.c.starts_at, basal_interval.c.minute)).mappings()
    versions: list[BasalSchedule] = []
    for row in rows:
        if not versions or versions[-1].id != row["id"]:
            versions.append(BasalSchedule(id=row["id"], starts_at=row["starts_at"], created_at=row["created_at"], intervals=[]))
        versions[-1].intervals.append(BasalInterval(minute=row["minute"], rate=row["rate"]))
    return versions


def temporary_basals(connection: Connection) -> list[TemporaryBasalPeriod]:
    rows = connection.execute(
        select(temporary_basal).where(temporary_basal.c.deleted_at.is_(None))
        .order_by(temporary_basal.c.starts_at)).mappings().all()
    return effective_periods([TemporaryBasalPeriod(
        **row,
        effective_ends_at=row["ends_at"],
    ) for row in rows])

@dataclass
class SqliteEntries:
    connection: Connection

    def get(self, entry_id: str) -> EntryRecord | None:
        row = self.connection.execute(select(entry).where(entry.c.id == entry_id)).mappings().first()
        return EntryRecord.model_validate(row) if row is not None else None

    def latest_glucose(self) -> EntryRecord | None:
        row = self.connection.execute(select(entry).where(
            entry.c.deleted_at.is_(None), entry.c.glucose.is_not(None)
        ).order_by(entry.c.occurred_at.desc(), entry.c.created_at.desc(), entry.c.id.desc()).limit(1)).mappings().first()
        return EntryRecord.model_validate(row) if row is not None else None

    def day(self, start: int, end: int) -> list[EntryRecord]:
        return [EntryRecord.model_validate(row) for row in self.connection.execute(select(entry).where(
            entry.c.deleted_at.is_(None), entry.c.occurred_at >= start, entry.c.occurred_at < end
        ).order_by(entry.c.occurred_at, entry.c.created_at, entry.c.id)).mappings()]

    def save(self, record: EntryRecord, *, create: bool) -> None:
        if create:
            self.connection.execute(insert(entry).values(record.model_dump()))
        else:
            self.connection.execute(update(entry).where(entry.c.id == record.id).values(record.model_dump(exclude={"id"})))


@dataclass
class SqliteBasal:
    connection: Connection

    def schedules(self) -> list[BasalSchedule]:
        return schedules(self.connection)

    def temporary(self) -> list[TemporaryBasalPeriod]:
        return temporary_basals(self.connection)

    def get_temporary(self, period_id: str) -> TemporaryBasalPeriod | None:
        row = self.connection.execute(select(temporary_basal).where(temporary_basal.c.id == period_id)).mappings().first()
        return TemporaryBasalPeriod(**row, effective_ends_at=row["ends_at"]) if row is not None else None

    def save_temporary(self, record: TemporaryBasalPeriod, *, create: bool) -> None:
        values = record.model_dump(exclude={"effective_ends_at"})
        if create:
            self.connection.execute(insert(temporary_basal).values(values))
        else:
            self.connection.execute(update(temporary_basal).where(temporary_basal.c.id == record.id).values(values))

    def add_schedule(self, record: BasalSchedule) -> None:
        self.connection.execute(insert(basal_schedule).values(record.model_dump(exclude={"intervals"})))
        self.connection.execute(insert(basal_interval), [
            {"schedule_id": record.id, **interval.model_dump()} for interval in record.intervals])


class SqliteDiaryUow:
    def __init__(self, connection: Connection) -> None:
        self.connection = connection
        self.entries: EntryStore = SqliteEntries(connection)
        self.basal: BasalStore = SqliteBasal(connection)
        self.receipts: ReceiptStore = SqliteReceipts(connection)

    def commit(self) -> None:
        self.connection.commit()


@contextmanager
def diary_uow(engine: Engine, *, write: bool = False) -> Generator[DiaryUow]:
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
            yield SqliteDiaryUow(connection)
    except SQLAlchemyError as error:
        raise Unavailable() from error
