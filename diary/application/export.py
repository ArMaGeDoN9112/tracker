from dataclasses import dataclass
from typing import Callable, ContextManager, Protocol

from pydantic import BaseModel

from diary.application.water import WaterSettingsOutput
from diary.application.products import ProductResult
from diary.application.meals import MealResult
from diary.domain.basal import BasalSchedule, TemporaryBasalPeriod
from diary.domain.entries import EntryRecord
from diary.domain.water import WaterRecord


class ExportAccountRecord(BaseModel):
    id: int
    login: str
    created_at: int


class ExportData(BaseModel):
    exported_at: int = 0
    account: ExportAccountRecord
    settings: WaterSettingsOutput
    entries: list[EntryRecord]
    schedules: list[BasalSchedule]
    temporary: list[TemporaryBasalPeriod]
    products: list[ProductResult]
    meals: list[MealResult]
    water: list[WaterRecord]


class ExportStore(Protocol):
    def read(self) -> ExportData: ...


@dataclass
class ExportDiary:
    snapshot: Callable[[], ContextManager[ExportStore]]
    clock: Callable[[], int]

    def execute(self) -> ExportData:
        with self.snapshot() as store:
            result = store.read()
            result.exported_at = self.clock()
            return result
