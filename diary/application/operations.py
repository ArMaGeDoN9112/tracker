from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
