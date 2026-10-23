from datetime import datetime, timedelta
from dataclasses import dataclass
from typing import Callable

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from diary.application.entries import EntryInput
from diary.application.diary import DiaryUowFactory
from diary.application.errors import ApplicationError, NotFound, RevisionConflict, UndoExpired
from diary.application.operations import OperationAction, OperationInput, ReceiptResult, RevisionInput, replay_receipt, save_receipt
from diary.domain.basal import BasalInterval, BasalSchedule, TemporaryBasalPeriod, basal_at
from diary.domain.precision import hundredths, rate_string
from diary.domain.time import MOSCOW, milliseconds


class IntervalInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    minute: int = Field(ge=0, le=1439, description="Минута от московской полуночи")
    rate: str = Field(max_length=10000, description="От 0 до 21474836.47 ед/ч; сотые, точка или запятая; завершающие нули допустимы")

    @field_validator("rate")
    @classmethod
    def rate_value(cls, value: str) -> str:
        return rate_string(hundredths(value))


class ScheduleInput(OperationInput):
    starts_at: str = Field(json_schema_extra={"format": "date-time"}, description="RFC 3339 со смещением, до миллисекунд")
    intervals: list[IntervalInput] = Field(min_length=1, max_length=1440)

    @field_validator("starts_at")
    @classmethod
    def start_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @field_validator("intervals")
    @classmethod
    def ordered_intervals(cls, value: list[IntervalInput]) -> list[IntervalInput]:
        minutes = [interval.minute for interval in value]
        if minutes[0] != 0 or any(a >= b for a, b in zip(minutes, minutes[1:])):
            raise ValueError("Начните с 00:00; интервалы должны идти строго по возрастанию без повторов.")
        return value


class TemporaryBasalInput(OperationInput):
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    duration_minutes: int = Field(ge=1, le=2147483647)
    percent: int = Field(ge=0, le=2147483647)

    @field_validator("starts_at")
    @classmethod
    def start_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @model_validator(mode="after")
    def representable_end(self) -> "TemporaryBasalInput":
        try:
            end = datetime.fromisoformat(self.starts_at) + timedelta(minutes=self.duration_minutes)
            end.astimezone(MOSCOW)
        except (ValueError, OverflowError) as error:
            raise ValueError("Окончание за пределами календаря.") from error
        return self


class EditTemporaryBasalInput(RevisionInput):
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    ends_at: str = Field(json_schema_extra={"format": "date-time"})
    percent: int = Field(ge=0, le=2147483647)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def event_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @model_validator(mode="after")
    def ordered_period(self) -> "EditTemporaryBasalInput":
        if self.ends_at < self.starts_at:
            raise ValueError("Окончание не может быть раньше начала.")
        return self


class BasalQuery(BaseModel):
    instant: int


class TemporaryQuery(BaseModel):
    period_id: str


class EditTemporaryCommand(EditTemporaryBasalInput):
    period_id: str


class TemporaryRevisionCommand(RevisionInput):
    period_id: str


class TemporaryConflict(ApplicationError):
    code = "temporary_conflict"
    field = "starts_at"


class ScheduleConflict(ApplicationError):
    code = "schedule_conflict"
    field = "starts_at"

    def __init__(self, existing_id: str) -> None:
        super().__init__("Начало уже занято сохранённой версией.")
        self.existing_id = existing_id


@dataclass
class GetSchedules:
    uow: DiaryUowFactory

    def execute(self) -> list[BasalSchedule]:
        with self.uow() as uow:
            return uow.basal.schedules()


@dataclass
class GetBasal:
    uow: DiaryUowFactory

    def execute(self, query: BasalQuery) -> str | None:
        with self.uow() as uow:
            return basal_at(uow.basal.schedules(), query.instant, uow.basal.temporary())


@dataclass
class GetTemporaryBasals:
    uow: DiaryUowFactory

    def execute(self) -> list[TemporaryBasalPeriod]:
        with self.uow() as uow:
            return uow.basal.temporary()


@dataclass
class GetTemporaryBasal:
    uow: DiaryUowFactory

    def execute(self, query: TemporaryQuery) -> TemporaryBasalPeriod:
        with self.uow() as uow:
            record = uow.basal.get_temporary(query.period_id)
            if record is None:
                raise NotFound("Временная база не найдена.")
            if record.deleted_at is None:
                record = next(row for row in uow.basal.temporary() if row.id == query.period_id)
            return record


@dataclass
class BasalOperations:
    uow: DiaryUowFactory
    clock: Callable[[], int]
    new_id: Callable[[], str]

    def change(self, action: OperationAction, payload: ScheduleInput | TemporaryBasalInput | RevisionInput,
               period_id: str | None = None) -> ReceiptResult:
        normalized = payload.model_dump(exclude={"operation_id", "period_id"})
        if period_id is not None:
            normalized["period_id"] = period_id
        with self.uow() as uow:
            replay = replay_receipt(uow.receipts, action, payload.operation_id, normalized)
            if replay is not None:
                return ReceiptResult(receipt=replay, replayed=True)
            if isinstance(payload, ScheduleInput):
                start = milliseconds(datetime.fromisoformat(payload.starts_at))
                occupied = next((row.id for row in uow.basal.schedules() if row.starts_at == start), None)
                if occupied is not None:
                    raise ScheduleConflict(occupied)
                result_id, now = self.new_id(), self.clock()
                uow.basal.add_schedule(BasalSchedule(
                    id=result_id, starts_at=start, created_at=now,
                    intervals=[BasalInterval(minute=row.minute, rate=hundredths(row.rate)) for row in payload.intervals]))
                revision = 1
            else:
                if isinstance(payload, TemporaryBasalInput):
                    start = milliseconds(datetime.fromisoformat(payload.starts_at))
                    if any(row.starts_at == start for row in uow.basal.temporary()):
                        raise TemporaryConflict("Начало уже занято временной базой. Обновите историю.")
                    result_id, now = self.new_id(), self.clock()
                    record = TemporaryBasalPeriod(
                        id=result_id, starts_at=start, ends_at=start + payload.duration_minutes * 60000,
                        effective_ends_at=start + payload.duration_minutes * 60000,
                        duration_minutes=payload.duration_minutes, percent=payload.percent,
                        created_at=now, updated_at=now, revision=1, deleted_at=None)
                else:
                    assert period_id is not None
                    result_id = period_id
                    saved = uow.basal.get_temporary(period_id)
                    if saved is None:
                        raise NotFound("Временная база не найдена.")
                    record = saved
                    if record.revision != payload.expected_revision or (record.deleted_at is not None) != (action == OperationAction.RESTORE_TEMPORARY_BASAL):
                        raise RevisionConflict("Временная база изменена на другом устройстве. Загрузите актуальную запись для сравнения.")
                    now = self.clock()
                    if action == OperationAction.RESTORE_TEMPORARY_BASAL and record.deleted_at is not None and now >= record.deleted_at + 30000:
                        raise UndoExpired()
                    start = milliseconds(datetime.fromisoformat(payload.starts_at)) if isinstance(payload, EditTemporaryBasalInput) else record.starts_at
                    if action != OperationAction.DELETE_TEMPORARY_BASAL and any(
                        row.starts_at == start and row.id != period_id for row in uow.basal.temporary()
                    ):
                        raise TemporaryConflict("Начало уже занято другой временной базой. Выберите другое начало или освободите его перед отменой удаления.")
                    record.updated_at, record.revision = now, record.revision + 1
                    if isinstance(payload, EditTemporaryBasalInput):
                        record.starts_at, record.ends_at = start, milliseconds(datetime.fromisoformat(payload.ends_at))
                        record.percent = payload.percent
                    else:
                        record.deleted_at = now if action == OperationAction.DELETE_TEMPORARY_BASAL else None
                uow.basal.save_temporary(record, create=period_id is None)
                revision = record.revision
            receipt = save_receipt(uow.receipts, action, payload.operation_id, normalized, result_id, revision, now)
            uow.commit()
            return ReceiptResult(receipt=receipt, replayed=False)


@dataclass
class CreateSchedule:
    operations: BasalOperations

    def execute(self, payload: ScheduleInput) -> ReceiptResult:
        return self.operations.change(OperationAction.CREATE_BASAL_SCHEDULE, payload)


@dataclass
class CreateTemporaryBasal:
    operations: BasalOperations

    def execute(self, payload: TemporaryBasalInput) -> ReceiptResult:
        return self.operations.change(OperationAction.CREATE_TEMPORARY_BASAL, payload)


@dataclass
class EditTemporaryBasal:
    operations: BasalOperations

    def execute(self, payload: EditTemporaryCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.EDIT_TEMPORARY_BASAL, payload, payload.period_id)


@dataclass
class DeleteTemporaryBasal:
    operations: BasalOperations

    def execute(self, payload: TemporaryRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.DELETE_TEMPORARY_BASAL, payload, payload.period_id)


@dataclass
class RestoreTemporaryBasal:
    operations: BasalOperations

    def execute(self, payload: TemporaryRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.RESTORE_TEMPORARY_BASAL, payload, payload.period_id)
