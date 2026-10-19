import hashlib
import json
import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Engine, text

from diary.security import now_ms

MOSCOW = ZoneInfo("Europe/Moscow")
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def milliseconds(value: datetime) -> int:
    delta = value.astimezone(UTC) - EPOCH
    return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000


def timestamp(value: int) -> str:
    return (EPOCH + timedelta(milliseconds=value)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def tenths(value: str) -> int:
    value = value.strip().replace(",", ".")
    if not re.fullmatch(r"\+?[0-9]+(?:\.[0-9]+)?", value):
        raise ValueError("Введите десятичное число.")
    whole, _, fraction = value.lstrip("+").partition(".")
    if fraction[1:].strip("0") or len(whole.lstrip("0")) > 9:
        raise ValueError("Допустим один значащий знак после запятой и значение до 214748364,7.")
    result = int(whole.lstrip("0") or "0") * 10 + int((fraction + "0")[0])
    if result > 2147483647:
        raise ValueError("Превышен технический предел 214748364,7.")
    return result


def decimal_string(value: int) -> str:
    return f"{value // 10}.{value % 10}"


class OperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str = Field(json_schema_extra={"format": "uuid"})

    @field_validator("operation_id")
    @classmethod
    def operation_uuid(cls, value: str) -> str:
        return str(UUID(value))


class RevisionInput(OperationInput):
    expected_revision: int = Field(ge=1, le=9223372036854775806)


class EntryInput(OperationInput):
    occurred_at: str = Field(json_schema_extra={"format": "date-time"}, description="RFC 3339 с явным смещением; точность до миллисекунд")
    glucose: str | None = Field(default=None, max_length=10000, description="Положительное десятичное число, до 214748364.7; точка или запятая, десятые без скрытого округления; завершающие нули допустимы")
    bolus: str = Field(default="0.0", max_length=10000, description="От 0 до 214748364.7, точность до десятых, точка или запятая; пустая строка равна нулю")
    reason: Literal["food", "correction", "food_and_correction"] | None = None
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
            return timestamp(milliseconds(parsed))
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


class EntryOutput(BaseModel):
    id: UUID
    occurred_at: str = Field(json_schema_extra={"format": "date-time"})
    glucose: str | None = Field(pattern=r"^[0-9]+\.[0-9]$")
    bolus: str = Field(pattern=r"^[0-9]+\.[0-9]$")
    reason: Literal["food", "correction", "food_and_correction"] | None
    comment: str
    created_at: str = Field(json_schema_extra={"format": "date-time"})
    updated_at: str = Field(json_schema_extra={"format": "date-time"})
    revision: int
    deleted_at: str | None
    basal: str | None


class DayOutput(BaseModel):
    day: date
    basal: str | None
    entries: list[EntryOutput]
    basal_changes: list["BasalChangeOutput"]
    temporary_basals: list["TemporaryBasalOutput"]
    temporary_percent: int | None


class TemporaryBasalOutput(BaseModel):
    id: UUID
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    ends_at: str = Field(json_schema_extra={"format": "date-time"})
    effective_ends_at: str = Field(json_schema_extra={"format": "date-time"})
    duration_minutes: int
    percent: int
    created_at: str = Field(json_schema_extra={"format": "date-time"})
    updated_at: str = Field(json_schema_extra={"format": "date-time"})
    revision: int
    deleted_at: str | None


class BasalChangeOutput(BaseModel):
    occurred_at: str = Field(json_schema_extra={"format": "date-time"})
    basal: str | None


class ReceiptOutput(BaseModel):
    operation_id: UUID
    action: str
    request_hash: str
    result_id: UUID
    revision: int
    completed_at: str = Field(json_schema_extra={"format": "date-time"})
    replayed: bool
    undo_remaining_ms: int = 0


def receipt_output(receipt: Any, replayed: bool) -> dict[str, Any]:
    return {**dict(receipt), "completed_at": timestamp(receipt["completed_at"]), "replayed": replayed,
            "undo_remaining_ms": max(0, min(30000, receipt["completed_at"] + 30000 - now_ms()))
            if receipt["action"] == "delete_entry" else 0}


def entry_output(row: Any, basal: str | None) -> dict[str, Any]:
    return {**dict(row), "glucose": decimal_string(row["glucose"]) if row["glucose"] is not None else None,
            "bolus": decimal_string(row["bolus"]), "occurred_at": timestamp(row["occurred_at"]),
            "created_at": timestamp(row["created_at"]), "updated_at": timestamp(row["updated_at"]),
            "deleted_at": timestamp(row["deleted_at"]) if row["deleted_at"] is not None else None, "basal": basal}


def register_entries(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure
    from diary.basal import basal_at, basal_changes, schedules, temporary_basals, temporary_output

    @app.get("/api/entry-form")
    def entry_form() -> dict[str, str | None]:
        now = (EPOCH + timedelta(milliseconds=now_ms())).astimezone(MOSCOW)
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            basal = basal_at(schedules(connection), milliseconds(now), temporary_basals(connection))
        return {"local_time": now.isoformat(timespec="minutes")[:16], "basal": basal}

    @app.get("/api/moscow-time")
    def moscow_time(local_time: str) -> Any:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}", local_time):
            return failure("validation", "Проверьте московское время.", 422, "occurred_at")
        try:
            local = datetime.fromisoformat(local_time)
            instants = set()
            for fold in (0, 1):
                instant = local.replace(tzinfo=MOSCOW, fold=fold)
                if instant.astimezone(UTC).astimezone(MOSCOW).replace(tzinfo=None) == local:
                    # Pre-1919 Moscow offsets include seconds, which RFC 3339 cannot express.
                    value = instant.isoformat()
                    instants.add(timestamp(milliseconds(instant)) if len(value) > 25 else value)
            candidates = sorted(instants)
        except (ValueError, OverflowError):
            candidates = []
        if not candidates:
            return failure("nonexistent_time", "Такого московского времени не существует. Укажите другое время.", 422, "occurred_at")
        return {"candidates": candidates}

    @app.post("/api/entries", response_model=ReceiptOutput)
    def create_entry(payload: EntryInput) -> Any:
        return change_entry("create_entry", payload)

    @app.put("/api/entries/{entry_id}", response_model=ReceiptOutput)
    def edit_entry(entry_id: UUID, payload: EditEntryInput) -> Any:
        return change_entry("edit_entry", payload, str(entry_id))

    @app.post("/api/entries/{entry_id}/delete", response_model=ReceiptOutput)
    def delete_entry(entry_id: UUID, payload: RevisionInput) -> Any:
        return change_entry("delete_entry", payload, str(entry_id))

    @app.post("/api/entries/{entry_id}/restore", response_model=ReceiptOutput)
    def restore_entry(entry_id: UUID, payload: RevisionInput) -> Any:
        return change_entry("restore_entry", payload, str(entry_id))

    @app.get("/api/entries/{entry_id}", response_model=EntryOutput)
    def read_entry(entry_id: UUID) -> Any:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            row = connection.execute(text("SELECT * FROM entry WHERE id = :id"), {"id": str(entry_id)}).mappings().first()
            versions = schedules(connection)
            temporary = temporary_basals(connection)
        if row is None:
            return failure("not_found", "Запись не найдена.", 404)
        return entry_output(row, basal_at(versions, row["occurred_at"], temporary))

    def change_entry(action: str, payload: EntryInput | RevisionInput, entry_id: str | None = None) -> Any:
        normalized = payload.model_dump(exclude={"operation_id"})
        if entry_id is not None:
            normalized["entry_id"] = entry_id
        request_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(text("SELECT * FROM operation_receipt WHERE operation_id = :id"),
                                          {"id": payload.operation_id}).mappings().first()
            if existing:
                if existing["action"] != action or existing["request_hash"] != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(existing, True)
            now = now_ms()
            result_id = entry_id or str(uuid4())
            values: dict[str, Any] = {"id": result_id, "now": now}
            if isinstance(payload, EntryInput):
                values.update({"occurred_at": milliseconds(datetime.fromisoformat(payload.occurred_at)),
                    "glucose": tenths(payload.glucose) if payload.glucose else None,
                    "bolus": tenths(payload.bolus), "reason": payload.reason, "comment": payload.comment})
            revision = 1
            if isinstance(payload, RevisionInput):
                current = connection.execute(text("SELECT * FROM entry WHERE id = :id"), {"id": result_id}).mappings().first()
                if current is None:
                    return failure("not_found", "Запись не найдена.", 404)
                if current["revision"] != payload.expected_revision or (current["deleted_at"] is not None) != (action == "restore_entry"):
                    return failure("revision_conflict", "Запись изменена на другом устройстве. Загрузите актуальную запись для сравнения.", 409, "expected_revision")
                revision = payload.expected_revision + 1
                if action == "restore_entry" and now >= current["deleted_at"] + 30000:
                    return failure("undo_expired", "30 секунд истекли. Отменить удаление уже нельзя.", 409)
                if action == "edit_entry":
                    assignments = "occurred_at = :occurred_at, glucose = :glucose, bolus = :bolus, reason = :reason, comment = :comment"
                else:
                    assignments = "deleted_at = :now" if action == "delete_entry" else "deleted_at = NULL"
                connection.execute(text(
                    f"UPDATE entry SET {assignments}, updated_at = :now, revision = revision + 1 WHERE id = :id"
                ), values)
            else:
                connection.execute(text(
                    "INSERT INTO entry VALUES (:id, :occurred_at, :glucose, :bolus, :reason, :comment, :now, :now, 1, NULL)"
                ), values)
            receipt = {"operation_id": payload.operation_id, "action": action, "request_hash": request_hash,
                       "result_id": result_id, "revision": revision, "completed_at": now}
            connection.execute(text("INSERT INTO operation_receipt VALUES (:operation_id, :action, :request_hash, :result_id, :revision, :completed_at)"), receipt)
            connection.commit()
        return receipt_output(receipt, False)

    @app.get("/api/day", response_model=DayOutput)
    def read_day(day: date) -> Any:
        try:
            start = milliseconds(datetime.combine(day, time(), MOSCOW))
            end = milliseconds(datetime.combine(day + timedelta(days=1), time(), MOSCOW))
        except (ValueError, OverflowError):
            return failure("validation", "Дата за пределами календаря.", 422, "day")
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            rows = connection.execute(text(
                "SELECT * FROM entry WHERE deleted_at IS NULL AND occurred_at >= :start AND occurred_at < :end "
                "ORDER BY occurred_at, created_at, id"
            ), {"start": start, "end": end}).mappings().all()
            versions = schedules(connection)
            temporary = temporary_basals(connection)
        entries = [entry_output(row, basal_at(versions, row["occurred_at"], temporary)) for row in rows]
        return {"day": day.isoformat(), "basal": basal_at(versions, start, temporary), "entries": entries,
                "basal_changes": basal_changes(versions, start, end, temporary),
                "temporary_percent": next((row["percent"] for row in temporary if row["starts_at"] <= start < row["effective_ends_at"]), None),
                "temporary_basals": [temporary_output(row) for row in temporary if row["starts_at"] < end and row["effective_ends_at"] > start]}
