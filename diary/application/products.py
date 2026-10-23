import base64
import binascii
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from diary.application.operations import OperationInput, RevisionInput
from diary.domain.precision import hundredths, rate_string


class NamedInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str

    @field_validator("name")
    @classmethod
    def trimmed_name(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= len(value) <= 200:
            raise ValueError("Название: от 1 до 200 символов.")
        return value


class PortionInput(NamedInput):
    id: str
    quantity: str = Field(max_length=10000)

    @field_validator("id")
    @classmethod
    def portion_uuid(cls, value: str) -> str:
        return str(UUID(value))

    @field_validator("quantity")
    @classmethod
    def positive_quantity(cls, value: str) -> str:
        amount = hundredths(value)
        if amount == 0:
            raise ValueError("Количество должно быть положительным.")
        return rate_string(amount)


class ProductInput(NamedInput, OperationInput):
    unit: Literal["g", "ml"]
    protein: str | None = Field(max_length=10000)
    fat: str | None = Field(max_length=10000)
    carbohydrate: str | None = Field(max_length=10000)
    calories: str | None = Field(max_length=10000)
    portions: list[PortionInput]
    photo: str | None = Field(default=None, max_length=45000)

    @field_validator("photo")
    @classmethod
    def photo_thumbnail(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.startswith("data:image/jpeg;base64,"):
            raise ValueError("Фото должно быть JPEG-миниатюрой.")
        try:
            image = base64.b64decode(value.removeprefix("data:image/jpeg;base64,"), validate=True)
        except binascii.Error as error:
            raise ValueError("Некорректное фото.") from error
        if not image.startswith(b"\xff\xd8\xff") or not image.endswith(b"\xff\xd9"):
            raise ValueError("Некорректное JPEG-фото.")
        return value

    @field_validator("protein", "fat", "carbohydrate", "calories")
    @classmethod
    def nutrient(cls, value: str | None) -> str | None:
        return rate_string(hundredths(value)) if value is not None and value.strip() else None

    @field_validator("portions")
    @classmethod
    def unique_portions(cls, value: list[PortionInput]) -> list[PortionInput]:
        if len({portion.id for portion in value}) != len(value):
            raise ValueError("Идентификаторы порций не должны повторяться.")
        return value


class EditProductInput(ProductInput, RevisionInput):
    unit_change_confirmed: bool = False
