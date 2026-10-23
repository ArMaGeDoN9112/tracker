import hashlib
import json
from datetime import datetime
from uuid import UUID, uuid4

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import Connection, Engine, insert, select, update

from diary.application.basal import EditTemporaryBasalInput, IntervalInput, ScheduleInput, TemporaryBasalInput
from diary.application.entries import EntryInput
from diary.application.operations import OperationAction, ReceiptRecord, RevisionInput
from diary.domain.basal import BasalInterval, BasalSchedule, TemporaryBasalPeriod, basal_at
from diary.domain.precision import hundredths, rate_string
from diary.domain.time import milliseconds
from diary.dto import ScheduleConflictOutput
from diary.entries import ReceiptOutput, TemporaryBasalOutput, receipt_output, timestamp
from diary.security import now_ms
from diary.tables import basal_interval, basal_schedule, operation_receipt, temporary_basal


class ScheduleOutput(BaseModel):
    id: UUID
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    ends_at: str | None = Field(json_schema_extra={"format": "date-time"})
    created_at: str = Field(json_schema_extra={"format": "date-time"})
    intervals: list[IntervalInput]


class BasalOutput(BaseModel):
    basal: str | None = Field(pattern=r"^[0-9]+\.[0-9]{2}$", description="Скорость по расписанию в ед/ч, сотые; null до первой версии")


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
    return [TemporaryBasalPeriod(
        **row,
        effective_ends_at=min(row["ends_at"], rows[index + 1]["starts_at"]) if index + 1 < len(rows) else row["ends_at"],
    ) for index, row in enumerate(rows)]


def temporary_output(row: TemporaryBasalPeriod) -> TemporaryBasalOutput:
    return TemporaryBasalOutput(
        id=UUID(row.id), starts_at=timestamp(row.starts_at), ends_at=timestamp(row.ends_at),
        effective_ends_at=timestamp(row.effective_ends_at), duration_minutes=row.duration_minutes, percent=row.percent,
        created_at=timestamp(row.created_at), updated_at=timestamp(row.updated_at), revision=row.revision,
        deleted_at=timestamp(row.deleted_at) if row.deleted_at is not None else None,
    )


def register_basal(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure

    @app.get("/api/basal-schedules", response_model=list[ScheduleOutput])
    def history() -> list[ScheduleOutput]:
        with engine.connect() as connection:
            versions = schedules(connection)
        return [ScheduleOutput(
            id=UUID(version.id), starts_at=timestamp(version.starts_at), created_at=timestamp(version.created_at),
            ends_at=timestamp(versions[index + 1].starts_at) if index + 1 < len(versions) else None,
            intervals=[IntervalInput(minute=interval.minute, rate=rate_string(interval.rate)) for interval in version.intervals],
        ) for index, version in enumerate(versions)]

    @app.get("/api/basal", response_model=BasalOutput)
    def read_basal(at: str = Query(description="RFC 3339 с явным смещением, точность до миллисекунд", json_schema_extra={"format": "date-time"})) -> BasalOutput | JSONResponse:
        try:
            instant = milliseconds(datetime.fromisoformat(EntryInput.event_time(at)))
        except ValueError:
            return failure("validation", "Укажите дату RFC 3339 с явным смещением.", 422, "at")
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            return BasalOutput(basal=basal_at(schedules(connection), instant, temporary_basals(connection)))

    @app.get("/api/temporary-basals", response_model=list[TemporaryBasalOutput])
    def temporary_history() -> list[TemporaryBasalOutput]:
        with engine.connect() as connection:
            return [temporary_output(row) for row in temporary_basals(connection)]

    @app.get("/api/temporary-basals/{period_id}", response_model=TemporaryBasalOutput)
    def read_temporary(period_id: UUID) -> TemporaryBasalOutput | JSONResponse:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            current = connection.execute(select(temporary_basal).where(temporary_basal.c.id == str(period_id))).mappings().first()
            if current is None:
                return failure("not_found", "Временная база не найдена.", 404)
            record = TemporaryBasalPeriod(**current, effective_ends_at=current["ends_at"])
            if record.deleted_at is None:
                record = next(row for row in temporary_basals(connection) if row.id == str(period_id))
            return temporary_output(record)

    @app.put("/api/temporary-basals/{period_id}", response_model=ReceiptOutput)
    def edit_temporary(period_id: UUID, payload: EditTemporaryBasalInput) -> ReceiptOutput | JSONResponse:
        return change_temporary(OperationAction.EDIT_TEMPORARY_BASAL, str(period_id), payload)

    @app.post("/api/temporary-basals/{period_id}/delete", response_model=ReceiptOutput)
    def delete_temporary(period_id: UUID, payload: RevisionInput) -> ReceiptOutput | JSONResponse:
        return change_temporary(OperationAction.DELETE_TEMPORARY_BASAL, str(period_id), payload)

    @app.post("/api/temporary-basals/{period_id}/restore", response_model=ReceiptOutput)
    def restore_temporary(period_id: UUID, payload: RevisionInput) -> ReceiptOutput | JSONResponse:
        return change_temporary(OperationAction.RESTORE_TEMPORARY_BASAL, str(period_id), payload)

    def change_temporary(action: OperationAction, period_id: str, payload: RevisionInput) -> ReceiptOutput | JSONResponse:
        normalized = {**payload.model_dump(exclude={"operation_id"}), "period_id": period_id}
        request_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(select(operation_receipt).where(operation_receipt.c.operation_id == payload.operation_id)).mappings().first()
            if existing:
                receipt = ReceiptRecord.model_validate(existing)
                if receipt.action != action or receipt.request_hash != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(receipt, True)
            current = connection.execute(select(temporary_basal).where(temporary_basal.c.id == period_id)).mappings().first()
            if current is None:
                return failure("not_found", "Временная база не найдена.", 404)
            record = TemporaryBasalPeriod(**current, effective_ends_at=current["ends_at"])
            if record.revision != payload.expected_revision or (record.deleted_at is not None) != (action == OperationAction.RESTORE_TEMPORARY_BASAL):
                return failure("revision_conflict", "Временная база изменена на другом устройстве. Загрузите актуальную запись для сравнения.", 409, "expected_revision")
            now = now_ms()
            if action == OperationAction.RESTORE_TEMPORARY_BASAL and record.deleted_at is not None and now >= record.deleted_at + 30000:
                return failure("undo_expired", "30 секунд истекли. Отменить удаление уже нельзя.", 409)
            start = milliseconds(datetime.fromisoformat(payload.starts_at)) if isinstance(payload, EditTemporaryBasalInput) else record.starts_at
            if action != OperationAction.DELETE_TEMPORARY_BASAL:
                occupied = connection.execute(select(temporary_basal.c.id).where(
                    temporary_basal.c.starts_at == start, temporary_basal.c.deleted_at.is_(None), temporary_basal.c.id != period_id)).scalar()
                if occupied:
                    return failure("temporary_conflict", "Начало уже занято другой временной базой. Выберите другое начало или освободите его перед отменой удаления.", 409, "starts_at")
            statement = update(temporary_basal).where(temporary_basal.c.id == period_id).values(updated_at=now, revision=record.revision + 1)
            if isinstance(payload, EditTemporaryBasalInput):
                statement = statement.values(starts_at=start, ends_at=milliseconds(datetime.fromisoformat(payload.ends_at)), percent=payload.percent)
            else:
                statement = statement.values(deleted_at=now if action == OperationAction.DELETE_TEMPORARY_BASAL else None)
            connection.execute(statement)
            receipt = ReceiptRecord(operation_id=payload.operation_id, action=action, request_hash=request_hash,
                                    result_id=period_id, revision=record.revision + 1, completed_at=now)
            connection.execute(insert(operation_receipt).values(receipt.model_dump()))
            connection.commit()
        return receipt_output(receipt, False)

    @app.post("/api/temporary-basals", response_model=ReceiptOutput)
    def create_temporary(payload: TemporaryBasalInput) -> ReceiptOutput | JSONResponse:
        request_hash = hashlib.sha256(json.dumps(payload.model_dump(exclude={"operation_id"}), sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        start = milliseconds(datetime.fromisoformat(payload.starts_at))
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(select(operation_receipt).where(operation_receipt.c.operation_id == payload.operation_id)).mappings().first()
            if existing:
                receipt = ReceiptRecord.model_validate(existing)
                if receipt.action != OperationAction.CREATE_TEMPORARY_BASAL or receipt.request_hash != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(receipt, True)
            occupied = connection.execute(select(temporary_basal.c.id).where(
                temporary_basal.c.starts_at == start, temporary_basal.c.deleted_at.is_(None))).scalar()
            if occupied:
                return failure("temporary_conflict", "Начало уже занято временной базой. Обновите историю.", 409, "starts_at")
            result_id, now = str(uuid4()), now_ms()
            connection.execute(insert(temporary_basal).values(
                id=result_id, starts_at=start, ends_at=start + payload.duration_minutes * 60000,
                duration_minutes=payload.duration_minutes, percent=payload.percent,
                created_at=now, updated_at=now, revision=1, deleted_at=None))
            receipt = ReceiptRecord(operation_id=payload.operation_id, action=OperationAction.CREATE_TEMPORARY_BASAL, request_hash=request_hash,
                                    result_id=result_id, revision=1, completed_at=now)
            connection.execute(insert(operation_receipt).values(receipt.model_dump()))
            connection.commit()
        return receipt_output(receipt, False)

    @app.post("/api/basal-schedules", response_model=ReceiptOutput)
    def create_schedule(payload: ScheduleInput) -> ReceiptOutput | JSONResponse:
        request_hash = hashlib.sha256(json.dumps(payload.model_dump(exclude={"operation_id"}), sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        start = milliseconds(datetime.fromisoformat(payload.starts_at))
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(select(operation_receipt).where(operation_receipt.c.operation_id == payload.operation_id)).mappings().first()
            if existing:
                receipt = ReceiptRecord.model_validate(existing)
                if receipt.action != OperationAction.CREATE_BASAL_SCHEDULE or receipt.request_hash != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(receipt, True)
            occupied = connection.execute(select(basal_schedule.c.id).where(basal_schedule.c.starts_at == start)).scalar()
            if occupied:
                conflict = ScheduleConflictOutput(
                    code="schedule_conflict", message="Начало уже занято сохранённой версией.",
                    field="starts_at", existing_id=occupied, href=f"#schedule-{occupied}",
                )
                return JSONResponse(conflict.model_dump(mode="json"), status_code=409)
            result_id, now = str(uuid4()), now_ms()
            connection.execute(insert(basal_schedule).values(id=result_id, starts_at=start, created_at=now))
            connection.execute(insert(basal_interval),
                               [{"schedule_id": result_id, "minute": interval.minute, "rate": hundredths(interval.rate)} for interval in payload.intervals])
            receipt = ReceiptRecord(operation_id=payload.operation_id, action=OperationAction.CREATE_BASAL_SCHEDULE, request_hash=request_hash,
                                    result_id=result_id, revision=1, completed_at=now)
            connection.execute(insert(operation_receipt).values(receipt.model_dump()))
            connection.commit()
        return receipt_output(receipt, False)
