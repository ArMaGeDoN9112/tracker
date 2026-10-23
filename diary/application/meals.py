from typing import Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

from diary.application.entries import EntryInput
from diary.application.operations import OperationInput, RevisionInput
from diary.application.products import NamedInput, PortionInput, ProductInput
from diary.domain.nutrition import Category


class MealLineInput(NamedInput):
    id: str
    kind: Literal["product", "one_off"]
    basis_quantity: str | None = Field(default=None, max_length=10000, validate_default=True)
    quantity: str | None = Field(default=None, max_length=10000, validate_default=True)
    unit: Literal["g", "ml"] | None = Field(default=None, validate_default=True)
    protein: str | None = Field(default=None, max_length=10000)
    fat: str | None = Field(default=None, max_length=10000)
    carbohydrate: str | None = Field(default=None, max_length=10000)
    calories: str | None = Field(default=None, max_length=10000)
    product_id: str | None = Field(default=None, validate_default=True)
    product_revision: int | None = Field(default=None, ge=1, le=9223372036854775806, validate_default=True)
    portion: PortionInput | None = None

    @field_validator("id", "product_id")
    @classmethod
    def valid_uuid(cls, value: str | None) -> str | None:
        return str(UUID(value)) if value is not None else None

    @field_validator("quantity", "basis_quantity")
    @classmethod
    def amount(cls, value: str | None) -> str | None:
        return PortionInput.positive_quantity(value) if value is not None else None

    @field_validator("basis_quantity")
    @classmethod
    def product_basis(cls, value: str | None, info: ValidationInfo) -> str | None:
        if info.data.get("kind") == "product" and value != "100.00":
            raise ValueError("Основа продукта — 100 г или мл.")
        return value

    @field_validator("quantity")
    @classmethod
    def required_quantity(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None and (info.data.get("kind") == "product" or info.data.get("basis_quantity") is not None):
            raise ValueError("При известной основе нужно съеденное количество.")
        return value

    @field_validator("unit")
    @classmethod
    def required_unit(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None and (info.data.get("kind") == "product" or info.data.get("quantity") is not None or info.data.get("basis_quantity") is not None):
            raise ValueError("Для количества и основы выберите г или мл.")
        return value

    @field_validator("product_id", "product_revision", "portion")
    @classmethod
    def provenance(cls, value: str | int | PortionInput | None, info: ValidationInfo) -> str | int | PortionInput | None:
        if info.data.get("kind") == "one_off" and value is not None:
            raise ValueError("Разовая еда не имеет происхождения из каталога.")
        if info.data.get("kind") == "product" and info.field_name != "portion" and value is None:
            raise ValueError("Укажите происхождение продукта.")
        return value

    @model_validator(mode="after")
    def coherent_basis(self) -> Self:
        if self.kind == "one_off" and "basis_quantity" not in self.model_fields_set:
            self.basis_quantity = self.quantity
        return self

    @field_validator("protein", "fat", "carbohydrate", "calories")
    @classmethod
    def nutrient(cls, value: str | None) -> str | None:
        return ProductInput.nutrient(value)


class MealInput(OperationInput):
    occurred_at: str
    category: Category | None = None
    lines: list[MealLineInput] = Field(min_length=1)

    @field_validator("occurred_at")
    @classmethod
    def event_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @field_validator("lines")
    @classmethod
    def unique_lines(cls, value: list[MealLineInput]) -> list[MealLineInput]:
        if len({line.id for line in value}) != len(value):
            raise ValueError("UUID строк не должны повторяться.")
        return value


class EditMealInput(MealInput, RevisionInput):
    pass


class MealProductPreviewInput(BaseModel):
    line: MealLineInput
    basis_quantity: str | None = Field(default=None, max_length=10000)
    unit: Literal["g", "ml"]

    @field_validator("basis_quantity")
    @classmethod
    def amount(cls, value: str | None) -> str | None:
        return MealLineInput.amount(value)
