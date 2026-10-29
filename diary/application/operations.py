import hashlib
import json
from enum import StrEnum
from typing import Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from diary.application.errors import OperationConflict


class OperationAction(StrEnum):
    CREATE_WATER = "create_water"
    EDIT_WATER = "edit_water"
    DELETE_WATER = "delete_water"
    RESTORE_WATER = "restore_water"
    EDIT_WATER_SETTINGS = "edit_water_settings"
    CREATE_MEAL = "create_meal"
    EDIT_MEAL = "edit_meal"
    DELETE_MEAL = "delete_meal"
    RESTORE_MEAL = "restore_meal"
    CREATE_PRODUCT = "create_product"
    EDIT_PRODUCT = "edit_product"
    CREATE_ENTRY = "create_entry"
    EDIT_ENTRY = "edit_entry"
    DELETE_ENTRY = "delete_entry"
    RESTORE_ENTRY = "restore_entry"
    CREATE_BASAL_SCHEDULE = "create_basal_schedule"
    CREATE_TEMPORARY_BASAL = "create_temporary_basal"
    EDIT_TEMPORARY_BASAL = "edit_temporary_basal"
    DELETE_TEMPORARY_BASAL = "delete_temporary_basal"
    RESTORE_TEMPORARY_BASAL = "restore_temporary_basal"


class ReceiptRecord(BaseModel):
    operation_id: str
    action: OperationAction
    request_hash: str
    result_id: str
    revision: int
    completed_at: int


class OperationInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    operation_id: str = Field(json_schema_extra={"format": "uuid"})

    @field_validator("operation_id")
    @classmethod
    def operation_uuid(cls, value: str) -> str:
        return str(UUID(value))


class RevisionInput(OperationInput):
    expected_revision: int = Field(ge=1, le=9223372036854775806)


class ReceiptResult(BaseModel):
    receipt: ReceiptRecord
    replayed: bool


class ReceiptStore(Protocol):
    def get(self, operation_id: str) -> ReceiptRecord | None: ...
    def add(self, receipt: ReceiptRecord) -> None: ...


def request_hash(normalized: dict[str, object]) -> str:
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def replay_receipt(store: ReceiptStore, action: OperationAction, operation_id: str,
                   normalized: dict[str, object]) -> ReceiptRecord | None:
    receipt = store.get(operation_id)
    if receipt is not None:
        if receipt.action != action:
            raise OperationConflict()
        if receipt.request_hash != request_hash(normalized):
            # Old meal receipts hashed the removed category; composition must still match exactly.
            if action not in (OperationAction.CREATE_MEAL, OperationAction.EDIT_MEAL) or not any(
                receipt.request_hash == request_hash(normalized | {"category": category})
                for category in (None, "breakfast", "lunch", "dinner", "snack")
            ):
                raise OperationConflict()
    return receipt


def save_receipt(store: ReceiptStore, action: OperationAction, operation_id: str,
                 normalized: dict[str, object], result_id: str, revision: int, now: int) -> ReceiptRecord:
    receipt = ReceiptRecord(operation_id=operation_id, action=action, request_hash=request_hash(normalized),
                            result_id=result_id, revision=revision, completed_at=now)
    store.add(receipt)
    return receipt
