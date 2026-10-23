import base64
import binascii
from dataclasses import dataclass
from typing import Callable, ContextManager, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from diary.application.operations import OperationInput, RevisionInput
from diary.domain.precision import hundredths, rate_string
from diary.domain.products import ProductRecord
from diary.application.errors import ApplicationError, NotFound, RevisionConflict
from diary.application.operations import OperationAction, ReceiptResult, ReceiptStore, replay_receipt, save_receipt


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


class ProductResult(BaseModel):
    record: ProductRecord
    portions: list[PortionInput]


class ProductQuery(BaseModel):
    product_id: str


class EditProductCommand(EditProductInput):
    product_id: str


class ProductStore(Protocol):
    def get(self, product_id: str) -> ProductResult | None: ...
    def all(self) -> list[ProductResult]: ...
    def save(self, result: ProductResult, *, create: bool) -> None: ...


class ProductUow(Protocol):
    products: ProductStore
    receipts: ReceiptStore

    def commit(self) -> None: ...


ProductUowFactory = Callable[[], ContextManager[ProductUow]]


class UnitChange(ApplicationError):
    code = "unit_change"
    field = "unit"


@dataclass
class GetProducts:
    uow: ProductUowFactory

    def execute(self) -> list[ProductResult]:
        with self.uow() as uow:
            return uow.products.all()


@dataclass
class GetProduct:
    uow: ProductUowFactory

    def execute(self, query: ProductQuery) -> ProductResult:
        with self.uow() as uow:
            result = uow.products.get(query.product_id)
            if result is None:
                raise NotFound("Продукт не найден.")
            return result


@dataclass
class ProductOperations:
    uow: ProductUowFactory
    clock: Callable[[], int]
    new_id: Callable[[], str]

    def save(self, payload: ProductInput, product_id: str | None = None) -> ReceiptResult:
        action = OperationAction.EDIT_PRODUCT if product_id else OperationAction.CREATE_PRODUCT
        normalized = payload.model_dump(exclude={"operation_id", "product_id"})
        if "photo" not in payload.model_fields_set:
            normalized.pop("photo")
        normalized["product_id"] = product_id
        with self.uow() as uow:
            replay = replay_receipt(uow.receipts, action, payload.operation_id, normalized)
            if replay is not None:
                return ReceiptResult(receipt=replay, replayed=True)
            now = self.clock()
            record = ProductRecord(
                id=product_id or self.new_id(), name=payload.name, unit=payload.unit, photo=payload.photo,
                protein=hundredths(payload.protein) if payload.protein is not None else None,
                fat=hundredths(payload.fat) if payload.fat is not None else None,
                carbohydrate=hundredths(payload.carbohydrate) if payload.carbohydrate is not None else None,
                calories=hundredths(payload.calories) if payload.calories is not None else None,
                revision=1, created_at=now, updated_at=now,
            )
            if product_id:
                assert isinstance(payload, EditProductInput)
                saved = uow.products.get(product_id)
                if saved is None:
                    raise NotFound("Продукт не найден.")
                current = saved.record
                if "photo" not in payload.model_fields_set:
                    record.photo = current.photo
                if current.revision != payload.expected_revision:
                    raise RevisionConflict("Карточка изменена на другом устройстве. Загрузите актуальную для сравнения.")
                if current.unit != payload.unit:
                    old_ids = {portion.id for portion in saved.portions}
                    if not payload.unit_change_confirmed or old_ids.intersection(portion.id for portion in payload.portions):
                        raise UnitChange("Подтвердите новые значения и новый набор порций либо его очистку.")
                record.created_at = current.created_at
                record.revision = current.revision + 1
            uow.products.save(ProductResult(record=record, portions=payload.portions), create=product_id is None)
            receipt = save_receipt(uow.receipts, action, payload.operation_id, normalized, record.id, record.revision, now)
            uow.commit()
            return ReceiptResult(receipt=receipt, replayed=False)


@dataclass
class CreateProduct:
    operations: ProductOperations

    def execute(self, payload: ProductInput) -> ReceiptResult:
        return self.operations.save(payload)


@dataclass
class EditProduct:
    operations: ProductOperations

    def execute(self, payload: EditProductCommand) -> ReceiptResult:
        return self.operations.save(payload, payload.product_id)
