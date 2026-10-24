from dataclasses import dataclass
from datetime import datetime
from typing import Callable, ContextManager, Protocol

from pydantic import BaseModel, field_validator

from diary.application.entries import EntryInput
from diary.application.errors import NotFound, RevisionConflict, UndoExpired
from diary.application.operations import (
    OperationAction, OperationInput, ReceiptResult, ReceiptStore, RevisionInput,
    replay_receipt, save_receipt,
)
from diary.domain.time import milliseconds
from diary.domain.water import Volume, WaterRecord


SETTINGS_ID = "00000000-0000-0000-0000-000000000001"


class WaterInput(OperationInput):
    volume_ml: Volume
    occurred_at: str | None = None

    @field_validator("occurred_at")
    @classmethod
    def event_time(cls, value: str | None) -> str | None:
        return EntryInput.event_time(value) if value is not None else None


class EditWaterInput(WaterInput, RevisionInput):
    occurred_at: str


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


class WaterQuery(BaseModel):
    water_id: str


class EditWaterCommand(EditWaterInput):
    water_id: str


class WaterRevisionCommand(RevisionInput):
    water_id: str


class WaterStore(Protocol):
    def get(self, water_id: str) -> WaterRecord | None: ...
    def get_settings(self) -> WaterSettingsOutput: ...
    def save(self, record: WaterRecord, *, create: bool) -> None: ...
    def save_settings(self, settings: WaterSettingsOutput) -> None: ...


class WaterUow(Protocol):
    water: WaterStore
    receipts: ReceiptStore

    def commit(self) -> None: ...


WaterUowFactory = Callable[[], ContextManager[WaterUow]]


@dataclass
class GetWater:
    uow: WaterUowFactory

    def execute(self, query: WaterQuery) -> WaterRecord:
        with self.uow() as uow:
            record = uow.water.get(query.water_id)
            if record is None:
                raise NotFound("Запись воды не найдена.")
            return record


@dataclass
class GetWaterSettings:
    uow: WaterUowFactory

    def execute(self) -> WaterSettingsOutput:
        with self.uow() as uow:
            return uow.water.get_settings()


@dataclass
class WaterOperations:
    uow: WaterUowFactory
    clock: Callable[[], int]
    new_id: Callable[[], str]

    def change(self, action: OperationAction, payload: WaterInput | RevisionInput,
               water_id: str | None = None) -> ReceiptResult:
        normalized = payload.model_dump(exclude={"operation_id", "water_id"})
        normalized["water_id"] = water_id
        with self.uow() as uow:
            replay = replay_receipt(uow.receipts, action, payload.operation_id, normalized)
            if replay is not None:
                return ReceiptResult(receipt=replay, replayed=True)
            now = self.clock()
            result_id = water_id or self.new_id()
            if isinstance(payload, WaterSettingsInput):
                settings = uow.water.get_settings()
                if settings.revision != payload.expected_revision:
                    raise RevisionConflict("Кнопки изменены на другом устройстве. Загрузите актуальные для сравнения.")
                revision = settings.revision + 1
                uow.water.save_settings(WaterSettingsOutput(volumes_ml=payload.volumes_ml, revision=revision))
            else:
                record = WaterRecord(id=result_id, volume_ml=1, occurred_at=now, revision=1,
                                     created_at=now, updated_at=now, deleted_at=None)
                if isinstance(payload, RevisionInput):
                    saved = uow.water.get(result_id)
                    if saved is None:
                        raise NotFound("Запись воды не найдена.")
                    record = saved
                    if record.revision != payload.expected_revision or (record.deleted_at is not None) != (action == OperationAction.RESTORE_WATER):
                        raise RevisionConflict("Запись воды изменена на другом устройстве. Загрузите актуальную для сравнения.")
                    if action == OperationAction.RESTORE_WATER and record.deleted_at is not None and now >= record.deleted_at + 30000:
                        raise UndoExpired()
                    record.revision += 1
                    record.updated_at = now
                if isinstance(payload, WaterInput):
                    record.volume_ml = payload.volume_ml
                    record.occurred_at = milliseconds(datetime.fromisoformat(payload.occurred_at)) if payload.occurred_at is not None else now
                else:
                    record.deleted_at = now if action == OperationAction.DELETE_WATER else None
                uow.water.save(record, create=water_id is None)
                revision = record.revision
            receipt = save_receipt(uow.receipts, action, payload.operation_id, normalized, result_id, revision, now)
            uow.commit()
            return ReceiptResult(receipt=receipt, replayed=False)


@dataclass
class CreateWater:
    operations: WaterOperations

    def execute(self, payload: WaterInput) -> ReceiptResult:
        return self.operations.change(OperationAction.CREATE_WATER, payload)


@dataclass
class EditWater:
    operations: WaterOperations

    def execute(self, payload: EditWaterCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.EDIT_WATER, payload, payload.water_id)


@dataclass
class DeleteWater:
    operations: WaterOperations

    def execute(self, payload: WaterRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.DELETE_WATER, payload, payload.water_id)


@dataclass
class RestoreWater:
    operations: WaterOperations

    def execute(self, payload: WaterRevisionCommand) -> ReceiptResult:
        return self.operations.change(OperationAction.RESTORE_WATER, payload, payload.water_id)


@dataclass
class EditWaterSettings:
    operations: WaterOperations

    def execute(self, payload: WaterSettingsInput) -> ReceiptResult:
        return self.operations.change(OperationAction.EDIT_WATER_SETTINGS, payload, SETTINGS_ID)
