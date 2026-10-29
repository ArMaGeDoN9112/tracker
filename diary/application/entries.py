import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Callable

from pydantic import BaseModel, Field, field_validator, model_validator

from diary.application.diary import DiaryUowFactory
from diary.application.errors import ApplicationError, NotFound, RevisionConflict, UndoExpired
from diary.application.operations import OperationAction, OperationInput, ReceiptResult, RevisionInput, replay_receipt, save_receipt
from diary.domain.basal import BasalChange, TemporaryBasalPeriod, basal_at, basal_changes
from diary.domain.entries import EntryRecord, Reason
from diary.domain.precision import decimal_string, tenths
from diary.domain.time import EPOCH, MOSCOW, milliseconds


class EntryInput(OperationInput):
    occurred_at: str = Field(json_schema_extra={"format": "date-time"}, description="RFC 3339 с явным смещением; точность до миллисекунд")
    glucose: str | None = Field(default=None, max_length=10000, description="Положительное десятичное число, до 214748364.7; точка или запятая, десятые без скрытого округления; завершающие нули допустимы")
    bolus: str = Field(default="0.0", max_length=10000, description="От 0 до 214748364.7, точность до десятых, точка или запятая; пустая строка равна нулю")
    reason: Reason | None = None
    comment: str = Field(default="", max_length=10000)

    @field_validator("occurred_at")
    @classmethod
    def event_time(cls, value: str) -> str:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])", value):
            raise ValueError("Нужна дата RFC 3339 со смещением и точностью до миллисекунд.")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            # Ensure both UTC and the calendar display can represent the instant.
            parsed.astimezone(MOSCOW)
            return (EPOCH + timedelta(milliseconds=milliseconds(parsed))).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except OverflowError as error:
            raise ValueError("Дата за пределами календаря.") from error

    @field_validator("glucose")
    @classmethod
    def glucose_value(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        result = tenths(value)
        if result == 0:
            raise ValueError("Сахар должен быть положительным.")
        return decimal_string(result)

    @field_validator("bolus")
    @classmethod
    def bolus_value(cls, value: str) -> str:
        return decimal_string(tenths(value) if value.strip() else 0)

    @model_validator(mode="after")
    def meaningful(self) -> "EntryInput":
        if self.bolus == "0.0":
            self.reason = None
        if self.glucose is None and self.bolus == "0.0" and not self.comment.strip():
            raise ValueError("Укажите сахар, ненулевую подколку или комментарий.")
        return self


class EditEntryInput(EntryInput, RevisionInput):
    pass


class EntryQuery(BaseModel):
    entry_id: str


class EditEntryCommand(EditEntryInput):
    entry_id: str


class EntryRevisionCommand(RevisionInput):
    entry_id: str


class EntryResult(BaseModel):
    record: EntryRecord
    basal: str | None


class DayQuery(BaseModel):
    day: date


class DayResult(BaseModel):
    day: date
    basal: str | None
    entries: list[EntryResult]
    basal_changes: list[BasalChange]
    temporary_basals: list[TemporaryBasalPeriod]
    temporary_percent: int | None


class EntryFormResult(BaseModel):
    latest_glucose_at: int | None
    local_time: datetime
    basal: str | None


class MoscowTimeQuery(BaseModel):
    local_time: str


class MoscowTimeResult(BaseModel):
    candidates: list[datetime]


class InvalidDay(ApplicationError):
    code = "validation"
    field = "day"


class InvalidMoscowTime(ApplicationError):
    code = "validation"
    field = "occurred_at"


class NonexistentTime(InvalidMoscowTime):
    code = "nonexistent_time"


@dataclass
class GetMoscowTime:
    def execute(self, query: MoscowTimeQuery) -> MoscowTimeResult:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}", query.local_time):
            raise InvalidMoscowTime("Проверьте московское время.")
        try:
            local = datetime.fromisoformat(query.local_time)
            candidates = []
            for fold in (0, 1):
                instant = local.replace(tzinfo=MOSCOW, fold=fold)
                if instant.astimezone(UTC).astimezone(MOSCOW).replace(tzinfo=None) == local:
                    candidates.append(instant)
        except (ValueError, OverflowError):
            candidates = []
        if not candidates:
            raise NonexistentTime("Такого московского времени не существует. Укажите другое время.")
        return MoscowTimeResult(candidates=candidates)


@dataclass
class GetEntry:
    uow: DiaryUowFactory

    def execute(self, query: EntryQuery) -> EntryResult:
        with self.uow() as uow:
            record = uow.entries.get(query.entry_id)
            if record is None:
                raise NotFound("Запись не найдена.")
            return EntryResult(record=record, basal=basal_at(uow.basal.schedules(), record.occurred_at, uow.basal.temporary()))


@dataclass
class GetEntryForm:
    uow: DiaryUowFactory
    clock: Callable[[], int]

    def execute(self) -> EntryFormResult:
        instant = self.clock()
        now = (EPOCH + timedelta(milliseconds=instant)).astimezone(MOSCOW)
        with self.uow() as uow:
            basal = basal_at(uow.basal.schedules(), instant, uow.basal.temporary())
            latest = uow.entries.latest_glucose()
        return EntryFormResult(local_time=now, basal=basal, latest_glucose_at=latest.occurred_at if latest else None)


@dataclass
class GetDay:
    uow: DiaryUowFactory

    def execute(self, query: DayQuery) -> DayResult:
        try:
            start = milliseconds(datetime.combine(query.day, time(), MOSCOW))
            end = milliseconds(datetime.combine(query.day + timedelta(days=1), time(), MOSCOW))
        except (ValueError, OverflowError) as error:
            raise InvalidDay("Дата за пределами календаря.") from error
        with self.uow() as uow:
            records = uow.entries.day(start, end)
            versions, temporary = uow.basal.schedules(), uow.basal.temporary()
        return DayResult(
            day=query.day, basal=basal_at(versions, start, temporary),
            entries=[EntryResult(record=row, basal=basal_at(versions, row.occurred_at, temporary)) for row in records],
            basal_changes=basal_changes(versions, start, end, temporary),
            temporary_percent=next((row.percent for row in temporary if row.starts_at <= start < row.effective_ends_at), None),
            temporary_basals=[row for row in temporary if row.starts_at < end and row.effective_ends_at > start],
        )


@dataclass
class EntryOperations:
    uow: DiaryUowFactory
    clock: Callable[[], int]
    new_id: Callable[[], str]

    def change(self, action: OperationAction, payload: EntryInput | RevisionInput, entry_id: str | None = None) -> ReceiptResult:
        normalized = payload.model_dump(exclude={"operation_id", "entry_id"})
        if entry_id is not None:
            normalized["entry_id"] = entry_id
        with self.uow() as uow:
            replay = replay_receipt(uow.receipts, action, payload.operation_id, normalized)
            if replay is not None:
                return ReceiptResult(receipt=replay, replayed=True)
            now = self.clock()
            result_id = entry_id or self.new_id()
            record = EntryRecord(id=result_id, occurred_at=now, glucose=None, bolus=0, reason=None,
                                 comment="", created_at=now, updated_at=now, revision=1, deleted_at=None)
            if isinstance(payload, RevisionInput):
                saved = uow.entries.get(result_id)
                if saved is None:
                    raise NotFound("Запись не найдена.")
                record = saved
                if record.revision != payload.expected_revision or (record.deleted_at is not None) != (action == OperationAction.RESTORE_ENTRY):
                    raise RevisionConflict("Запись изменена на другом устройстве. Загрузите актуальную запись для сравнения.")
                if action == OperationAction.RESTORE_ENTRY and record.deleted_at is not None and now >= record.deleted_at + 30000:
                    raise UndoExpired()
                record.updated_at, record.revision = now, record.revision + 1
            if isinstance(payload, EntryInput):
                record.occurred_at = milliseconds(datetime.fromisoformat(payload.occurred_at))
                record.glucose = tenths(payload.glucose) if payload.glucose else None
                record.bolus, record.reason, record.comment = tenths(payload.bolus), payload.reason, payload.comment
            else:
                record.deleted_at = now if action == OperationAction.DELETE_ENTRY else None
            uow.entries.save(record, create=entry_id is None)
            receipt = save_receipt(uow.receipts, action, payload.operation_id, normalized, result_id, record.revision, now)
            uow.commit()
            return ReceiptResult(receipt=receipt, replayed=False)


@dataclass
class CreateEntry:
    operations: EntryOperations

    def execute(self, payload: EntryInput) -> ReceiptResult:
        return self.operations.change(OperationAction.CREATE_ENTRY, payload)


@dataclass
class EditEntry:
    operations: EntryOperations

    def execute(self, payload: EditEntryCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.EDIT_ENTRY, payload, payload.entry_id)


@dataclass
class DeleteEntry:
    operations: EntryOperations

    def execute(self, payload: EntryRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.DELETE_ENTRY, payload, payload.entry_id)


@dataclass
class RestoreEntry:
    operations: EntryOperations

    def execute(self, payload: EntryRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.RESTORE_ENTRY, payload, payload.entry_id)
