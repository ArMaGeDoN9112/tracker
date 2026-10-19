import hashlib
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Connection, Engine, text

from diary.entries import EPOCH, MOSCOW, EntryInput, OperationInput, ReceiptOutput, TemporaryBasalOutput, milliseconds, receipt_output, timestamp
from diary.security import now_ms


def hundredths(value: str) -> int:
    value = value.strip().replace(",", ".")
    if not re.fullmatch(r"\+?[0-9]+(?:\.[0-9]+)?", value):
        raise ValueError("Введите неотрицательное десятичное число.")
    whole, _, fraction = value.lstrip("+").partition(".")
    if fraction[2:].strip("0") or len(whole.lstrip("0")) > 8:
        raise ValueError("Допустимы сотые, максимум 21474836,47 ед/ч.")
    result = int(whole.lstrip("0") or "0") * 100 + int((fraction + "00")[:2])
    if result > 2147483647:
        raise ValueError("Превышен технический предел 21474836,47 ед/ч.")
    return result


def rate_string(value: int) -> str:
    return f"{value // 100}.{value % 100:02}"


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


class ScheduleOutput(BaseModel):
    id: UUID
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    ends_at: str | None = Field(json_schema_extra={"format": "date-time"})
    created_at: str = Field(json_schema_extra={"format": "date-time"})
    intervals: list[IntervalInput]


class BasalOutput(BaseModel):
    basal: str | None = Field(pattern=r"^[0-9]+\.[0-9]{2}$", description="Скорость по расписанию в ед/ч, сотые; null до первой версии")


def schedules(connection: Connection) -> list[dict[str, Any]]:
    rows = connection.execute(text(
        "SELECT s.id, s.starts_at, s.created_at, i.minute, i.rate FROM basal_schedule s "
        "JOIN basal_interval i ON i.schedule_id = s.id ORDER BY s.starts_at, i.minute"
    )).mappings()
    versions: list[dict[str, Any]] = []
    for row in rows:
        if not versions or versions[-1]["id"] != row["id"]:
            versions.append({"id": row["id"], "starts_at": row["starts_at"], "created_at": row["created_at"], "intervals": []})
        versions[-1]["intervals"].append({"minute": row["minute"], "rate": row["rate"]})
    return versions


def basal_at(versions: list[dict[str, Any]], instant: int, temporary: list[dict[str, Any]]) -> str | None:
    version = next((version for version in reversed(versions) if version["starts_at"] <= instant), None)
    if version is None:
        return None
    local = (EPOCH + timedelta(milliseconds=instant)).astimezone(MOSCOW)
    minute = local.hour * 60 + local.minute
    interval = next(interval for interval in reversed(version["intervals"]) if interval["minute"] <= minute)
    period = next((row for row in reversed(temporary) if row["starts_at"] <= instant < row["effective_ends_at"]), None)
    return rate_string((interval["rate"] * period["percent"] + 50) // 100 if period else interval["rate"])


def basal_changes(versions: list[dict[str, Any]], start: int, end: int, temporary: list[dict[str, Any]]) -> list[dict[str, Any]]:
    day = (EPOCH + timedelta(milliseconds=start)).astimezone(MOSCOW).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    boundaries = {version["starts_at"] for version in versions if start < version["starts_at"] < end}
    temporary_boundaries = {row[key] for row in temporary for key in ("starts_at", "effective_ends_at") if start < row[key] < end}
    boundaries.update(temporary_boundaries)
    for version in versions:
        for interval in version["intervals"]:
            local = day + timedelta(minutes=interval["minute"])
            for fold in (0, 1):
                candidate = local.replace(tzinfo=MOSCOW, fold=fold)
                if candidate.astimezone(UTC).astimezone(MOSCOW).replace(tzinfo=None) == local:
                    instant = milliseconds(candidate)
                    if start < instant < end:
                        boundaries.add(instant)
    # A clock rollback can select an earlier interval without crossing its start.
    cursor = start
    while cursor < end:
        next_cursor = min(cursor + 3600000, end)
        offset = (EPOCH + timedelta(milliseconds=cursor)).astimezone(MOSCOW).utcoffset()
        if (EPOCH + timedelta(milliseconds=next_cursor)).astimezone(MOSCOW).utcoffset() != offset:
            low, high = cursor, next_cursor
            while high - low > 1:
                middle = (low + high) // 2
                if (EPOCH + timedelta(milliseconds=middle)).astimezone(MOSCOW).utcoffset() == offset:
                    low = middle
                else:
                    high = middle
            if start < high < end:
                boundaries.add(high)
        cursor = next_cursor
    return [{"occurred_at": timestamp(instant), "basal": basal_at(versions, instant, temporary)} for instant in sorted(boundaries)
            if instant in temporary_boundaries or basal_at(versions, instant, temporary) != basal_at(versions, instant - 1, temporary)]


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


def temporary_basals(connection: Connection) -> list[dict[str, Any]]:
    rows = [dict(row) for row in connection.execute(text(
        "SELECT * FROM temporary_basal WHERE deleted_at IS NULL ORDER BY starts_at"
    )).mappings()]
    for index, row in enumerate(rows):
        row["effective_ends_at"] = min(row["ends_at"], rows[index + 1]["starts_at"]) if index + 1 < len(rows) else row["ends_at"]
    return rows


def temporary_output(row: dict[str, Any]) -> dict[str, Any]:
    return {**row, **{key: timestamp(row[key]) for key in ("starts_at", "ends_at", "effective_ends_at", "created_at", "updated_at")},
            "deleted_at": timestamp(row["deleted_at"]) if row["deleted_at"] is not None else None}


def register_basal(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure

    @app.get("/api/basal-schedules", response_model=list[ScheduleOutput])
    def history() -> Any:
        with engine.connect() as connection:
            versions = schedules(connection)
        return [{**version, "starts_at": timestamp(version["starts_at"]), "created_at": timestamp(version["created_at"]),
                 "ends_at": timestamp(versions[index + 1]["starts_at"]) if index + 1 < len(versions) else None,
                 "intervals": [{**interval, "rate": rate_string(interval["rate"])} for interval in version["intervals"]]}
                for index, version in enumerate(versions)]

    @app.get("/api/basal", response_model=BasalOutput)
    def read_basal(at: str = Query(description="RFC 3339 с явным смещением, точность до миллисекунд", json_schema_extra={"format": "date-time"})) -> Any:
        try:
            instant = milliseconds(datetime.fromisoformat(EntryInput.event_time(at)))
        except ValueError:
            return failure("validation", "Укажите дату RFC 3339 с явным смещением.", 422, "at")
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            return {"basal": basal_at(schedules(connection), instant, temporary_basals(connection))}

    @app.get("/api/temporary-basals", response_model=list[TemporaryBasalOutput])
    def temporary_history() -> Any:
        with engine.connect() as connection:
            return [temporary_output(row) for row in temporary_basals(connection)]

    @app.post("/api/temporary-basals", response_model=ReceiptOutput)
    def create_temporary(payload: TemporaryBasalInput) -> Any:
        request_hash = hashlib.sha256(json.dumps(payload.model_dump(exclude={"operation_id"}), sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        start = milliseconds(datetime.fromisoformat(payload.starts_at))
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(text("SELECT * FROM operation_receipt WHERE operation_id = :id"),
                                          {"id": payload.operation_id}).mappings().first()
            if existing:
                if existing["action"] != "create_temporary_basal" or existing["request_hash"] != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(existing, True)
            occupied = connection.execute(text("SELECT id FROM temporary_basal WHERE starts_at = :start AND deleted_at IS NULL"), {"start": start}).scalar()
            if occupied:
                return failure("temporary_conflict", "Начало уже занято временной базой. Обновите историю.", 409, "starts_at")
            result_id, now = str(uuid4()), now_ms()
            connection.execute(text("INSERT INTO temporary_basal VALUES (:id, :start, :end, :duration, :percent, :now, :now, 1, NULL)"),
                               {"id": result_id, "start": start, "end": start + payload.duration_minutes * 60000,
                                "duration": payload.duration_minutes, "percent": payload.percent, "now": now})
            receipt = {"operation_id": payload.operation_id, "action": "create_temporary_basal", "request_hash": request_hash,
                       "result_id": result_id, "revision": 1, "completed_at": now}
            connection.execute(text("INSERT INTO operation_receipt VALUES (:operation_id, :action, :request_hash, :result_id, :revision, :completed_at)"), receipt)
            connection.commit()
        return receipt_output(receipt, False)

    @app.post("/api/basal-schedules", response_model=ReceiptOutput)
    def create_schedule(payload: ScheduleInput) -> Any:
        request_hash = hashlib.sha256(json.dumps(payload.model_dump(exclude={"operation_id"}), sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        start = milliseconds(datetime.fromisoformat(payload.starts_at))
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(text("SELECT * FROM operation_receipt WHERE operation_id = :id"),
                                          {"id": payload.operation_id}).mappings().first()
            if existing:
                if existing["action"] != "create_basal_schedule" or existing["request_hash"] != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(existing, True)
            occupied = connection.execute(text("SELECT id FROM basal_schedule WHERE starts_at = :start"), {"start": start}).scalar()
            if occupied:
                from fastapi.responses import JSONResponse
                return JSONResponse({"code": "schedule_conflict", "message": "Начало уже занято сохранённой версией.",
                                     "field": "starts_at", "existing_id": occupied,
                                     "href": f"#schedule-{occupied}"}, status_code=409)
            result_id, now = str(uuid4()), now_ms()
            connection.execute(text("INSERT INTO basal_schedule VALUES (:id, :start, :now)"), {"id": result_id, "start": start, "now": now})
            connection.execute(text("INSERT INTO basal_interval VALUES (:id, :minute, :rate)"),
                               [{"id": result_id, "minute": interval.minute, "rate": hundredths(interval.rate)} for interval in payload.intervals])
            receipt = {"operation_id": payload.operation_id, "action": "create_basal_schedule", "request_hash": request_hash,
                       "result_id": result_id, "revision": 1, "completed_at": now}
            connection.execute(text("INSERT INTO operation_receipt VALUES (:operation_id, :action, :request_hash, :result_id, :revision, :completed_at)"), receipt)
            connection.commit()
        return receipt_output(receipt, False)
