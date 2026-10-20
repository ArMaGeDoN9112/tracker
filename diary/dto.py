from enum import StrEnum
from typing import Literal

from pydantic import BaseModel


Reason = Literal["food", "correction", "food_and_correction"]


class OperationAction(StrEnum):
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


class EntryValues(BaseModel):
    occurred_at: int
    glucose: int | None
    bolus: int
    reason: Reason | None
    comment: str


class EntryRecord(EntryValues):
    id: str
    created_at: int
    updated_at: int
    revision: int
    deleted_at: int | None


class ReceiptRecord(BaseModel):
    operation_id: str
    action: OperationAction
    request_hash: str
    result_id: str
    revision: int
    completed_at: int


class BasalInterval(BaseModel):
    minute: int
    rate: int


class BasalSchedule(BaseModel):
    id: str
    starts_at: int
    created_at: int
    intervals: list[BasalInterval]


class TemporaryBasalPeriod(BaseModel):
    id: str
    starts_at: int
    ends_at: int
    effective_ends_at: int
    duration_minutes: int
    percent: int
    created_at: int
    updated_at: int
    revision: int
    deleted_at: int | None


class ErrorOutput(BaseModel):
    code: str
    message: str
    field: str | None = None


class ScheduleConflictOutput(ErrorOutput):
    existing_id: str
    href: str


class CsrfOutput(BaseModel):
    csrf_token: str


class SessionOutput(BaseModel):
    login: str


class LoginOutput(SessionOutput, CsrfOutput):
    pass


class EntryFormOutput(BaseModel):
    local_time: str
    basal: str | None


class MoscowTimeOutput(BaseModel):
    candidates: list[str]
