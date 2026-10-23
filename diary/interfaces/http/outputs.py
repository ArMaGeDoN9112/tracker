from datetime import timedelta
from uuid import UUID

from pydantic import BaseModel, Field

from diary.application.operations import OperationAction, ReceiptRecord
from diary.domain.time import EPOCH


def timestamp(value: int) -> str:
    return (EPOCH + timedelta(milliseconds=value)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class ReceiptOutput(BaseModel):
    operation_id: UUID
    action: OperationAction
    request_hash: str
    result_id: UUID
    revision: int
    completed_at: str = Field(json_schema_extra={"format": "date-time"})
    replayed: bool
    undo_remaining_ms: int = 0


def receipt_output(receipt: ReceiptRecord, replayed: bool, now: int) -> ReceiptOutput:
    return ReceiptOutput(
        operation_id=UUID(receipt.operation_id), action=receipt.action, request_hash=receipt.request_hash,
        result_id=UUID(receipt.result_id), revision=receipt.revision, completed_at=timestamp(receipt.completed_at),
        replayed=replayed,
        undo_remaining_ms=max(0, min(30000, receipt.completed_at + 30000 - now))
        if receipt.action in (OperationAction.DELETE_ENTRY, OperationAction.DELETE_TEMPORARY_BASAL,
                              OperationAction.DELETE_MEAL, OperationAction.DELETE_WATER) else 0,
    )
