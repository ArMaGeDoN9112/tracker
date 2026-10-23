import hashlib
import json
from datetime import datetime
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import Connection, Engine, insert, select, update

from diary.application.entries import EntryInput
from diary.application.operations import OperationAction, OperationInput, ReceiptRecord, RevisionInput
from diary.domain.time import milliseconds
from diary.entries import ReceiptOutput, receipt_output, timestamp
from diary.security import now_ms
from diary.tables import operation_receipt, water, water_settings


Volume = Annotated[int, Field(strict=True, ge=1, le=2147483647)]


class WaterInput(OperationInput):
    volume_ml: Volume
    occurred_at: str | None = None

    @field_validator("occurred_at")
    @classmethod
    def event_time(cls, value: str | None) -> str | None:
        return EntryInput.event_time(value) if value is not None else None


class EditWaterInput(WaterInput, RevisionInput):
    occurred_at: str


class WaterRecord(BaseModel):
    id: str
    volume_ml: Volume
    occurred_at: int
    revision: int
    created_at: int
    updated_at: int
    deleted_at: int | None


class WaterOutput(BaseModel):
    id: str
    volume_ml: Volume
    occurred_at: str
    revision: int
    created_at: str
    updated_at: str
    deleted_at: str | None


class WaterSettingsOutput(BaseModel):
    volumes_ml: list[Volume]
    revision: int


class WaterSettingsInput(RevisionInput):
    volumes_ml: list[Volume]

    @field_validator("volumes_ml")
    @classmethod
    def unique_volumes(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value):
            raise ValueError("Объёмы не должны повторяться.")
        return value


def water_output(record: WaterRecord) -> WaterOutput:
    return WaterOutput(**record.model_dump(exclude={"occurred_at", "created_at", "updated_at", "deleted_at"}),
                       occurred_at=timestamp(record.occurred_at), created_at=timestamp(record.created_at),
                       updated_at=timestamp(record.updated_at), deleted_at=timestamp(record.deleted_at) if record.deleted_at is not None else None)


def day_water(connection: Connection, start: int, end: int) -> list[WaterOutput]:
    return [water_output(WaterRecord.model_validate(row)) for row in connection.execute(select(water).where(
        water.c.deleted_at.is_(None), water.c.occurred_at >= start, water.c.occurred_at < end
    ).order_by(water.c.occurred_at, water.c.created_at, water.c.id)).mappings()]


def register_water(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure

    @app.get("/api/water-settings", response_model=WaterSettingsOutput)
    def read_settings() -> WaterSettingsOutput:
        with engine.connect() as connection:
            row = connection.execute(select(water_settings)).mappings().one()
            return WaterSettingsOutput(volumes_ml=json.loads(row["volumes_ml"]), revision=row["revision"])

    @app.put("/api/water-settings", response_model=ReceiptOutput)
    def edit_settings(payload: WaterSettingsInput) -> ReceiptOutput | JSONResponse:
        return change_water(OperationAction.EDIT_WATER_SETTINGS, payload, "00000000-0000-0000-0000-000000000001")

    @app.get("/api/water/{water_id}", response_model=WaterOutput)
    def read_water(water_id: UUID) -> WaterOutput | JSONResponse:
        with engine.connect() as connection:
            row = connection.execute(select(water).where(water.c.id == str(water_id))).mappings().first()
            return water_output(WaterRecord.model_validate(row)) if row else failure("not_found", "Запись воды не найдена.", 404)

    @app.post("/api/water", response_model=ReceiptOutput)
    def create_water(payload: WaterInput) -> ReceiptOutput | JSONResponse:
        return change_water(OperationAction.CREATE_WATER, payload)

    @app.put("/api/water/{water_id}", response_model=ReceiptOutput)
    def edit_water(water_id: UUID, payload: EditWaterInput) -> ReceiptOutput | JSONResponse:
        return change_water(OperationAction.EDIT_WATER, payload, str(water_id))

    @app.post("/api/water/{water_id}/delete", response_model=ReceiptOutput)
    def delete_water(water_id: UUID, payload: RevisionInput) -> ReceiptOutput | JSONResponse:
        return change_water(OperationAction.DELETE_WATER, payload, str(water_id))

    @app.post("/api/water/{water_id}/restore", response_model=ReceiptOutput)
    def restore_water(water_id: UUID, payload: RevisionInput) -> ReceiptOutput | JSONResponse:
        return change_water(OperationAction.RESTORE_WATER, payload, str(water_id))

    def change_water(action: OperationAction, payload: WaterInput | RevisionInput, water_id: str | None = None) -> ReceiptOutput | JSONResponse:
        normalized = payload.model_dump(exclude={"operation_id"})
        normalized["water_id"] = water_id
        request_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(select(operation_receipt).where(operation_receipt.c.operation_id == payload.operation_id)).mappings().first()
            if existing:
                receipt = ReceiptRecord.model_validate(existing)
                if receipt.action != action or receipt.request_hash != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(receipt, True)
            now = now_ms()
            result_id = water_id or str(uuid4())
            if isinstance(payload, WaterSettingsInput):
                row = connection.execute(select(water_settings)).mappings().one()
                if row["revision"] != payload.expected_revision:
                    return failure("revision_conflict", "Кнопки изменены на другом устройстве. Загрузите актуальные для сравнения.", 409, "expected_revision")
                revision = row["revision"] + 1
                connection.execute(update(water_settings).values(volumes_ml=json.dumps(payload.volumes_ml), revision=revision))
            else:
                record = WaterRecord(id=result_id, volume_ml=1, occurred_at=now, revision=1, created_at=now, updated_at=now, deleted_at=None)
                if isinstance(payload, RevisionInput):
                    saved = connection.execute(select(water).where(water.c.id == result_id)).mappings().first()
                    if saved is None:
                        return failure("not_found", "Запись воды не найдена.", 404)
                    record = WaterRecord.model_validate(saved)
                    if record.revision != payload.expected_revision or (record.deleted_at is not None) != (action == OperationAction.RESTORE_WATER):
                        return failure("revision_conflict", "Запись воды изменена на другом устройстве. Загрузите актуальную для сравнения.", 409, "expected_revision")
                    if action == OperationAction.RESTORE_WATER and record.deleted_at is not None and now >= record.deleted_at + 30000:
                        return failure("undo_expired", "30 секунд истекли. Отменить удаление уже нельзя.", 409)
                    record.revision += 1
                    record.updated_at = now
                if isinstance(payload, WaterInput):
                    record.volume_ml = payload.volume_ml
                    record.occurred_at = milliseconds(datetime.fromisoformat(payload.occurred_at)) if payload.occurred_at is not None else now
                else:
                    record.deleted_at = now if action == OperationAction.DELETE_WATER else None
                if water_id:
                    connection.execute(update(water).where(water.c.id == result_id).values(record.model_dump(exclude={"id"})))
                else:
                    connection.execute(insert(water).values(record.model_dump()))
                revision = record.revision
            receipt = ReceiptRecord(operation_id=payload.operation_id, action=action, request_hash=request_hash,
                                    result_id=result_id, revision=revision, completed_at=now)
            connection.execute(insert(operation_receipt).values(receipt.model_dump()))
            connection.commit()
        return receipt_output(receipt, False)
