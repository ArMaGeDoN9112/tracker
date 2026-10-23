from typing import Annotated

from pydantic import BaseModel, Field


Volume = Annotated[int, Field(strict=True, ge=1, le=2147483647)]


class WaterRecord(BaseModel):
    id: str
    volume_ml: Volume
    occurred_at: int
    revision: int
    created_at: int
    updated_at: int
    deleted_at: int | None
