from typing import Callable, ContextManager, Protocol

from diary.application.operations import ReceiptStore
from diary.domain.basal import BasalSchedule, TemporaryBasalPeriod
from diary.domain.entries import EntryRecord


class EntryStore(Protocol):
    def get(self, entry_id: str) -> EntryRecord | None: ...
    def day(self, start: int, end: int) -> list[EntryRecord]: ...
    def save(self, record: EntryRecord, *, create: bool) -> None: ...


class BasalStore(Protocol):
    def schedules(self) -> list[BasalSchedule]: ...
    def temporary(self) -> list[TemporaryBasalPeriod]: ...
    def get_temporary(self, period_id: str) -> TemporaryBasalPeriod | None: ...
    def save_temporary(self, record: TemporaryBasalPeriod, *, create: bool) -> None: ...
    def add_schedule(self, record: BasalSchedule) -> None: ...


class DiaryUow(Protocol):
    entries: EntryStore
    basal: BasalStore
    receipts: ReceiptStore

    def commit(self) -> None: ...


DiaryUowFactory = Callable[[], ContextManager[DiaryUow]]
