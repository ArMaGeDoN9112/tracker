from typing import Literal

from pydantic import BaseModel


Reason = Literal["food", "correction", "food_and_correction"]


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
