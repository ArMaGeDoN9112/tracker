from typing import Literal

from pydantic import BaseModel


class ProductRecord(BaseModel):
    id: str
    name: str
    unit: Literal["g", "ml"]
    photo: str | None
    protein: int | None
    fat: int | None
    carbohydrate: int | None
    calories: int | None
    revision: int
    created_at: int
    updated_at: int
