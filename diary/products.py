import base64
import binascii
import hashlib
import json
from typing import Literal
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import Connection, Engine, delete, insert, select, update

from diary.basal import hundredths, rate_string
from diary.dto import OperationAction, ReceiptRecord
from diary.entries import OperationInput, ReceiptOutput, RevisionInput, receipt_output, timestamp
from diary.security import now_ms
from diary.tables import operation_receipt, product, product_portion


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
    archived: bool = False
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


class ProductRecord(BaseModel):
    id: str
    name: str
    unit: Literal["g", "ml"]
    photo: str | None
    protein: int | None
    fat: int | None
    carbohydrate: int | None
    calories: int | None
    archived: bool
    revision: int
    created_at: int
    updated_at: int


class ProductOutput(BaseModel):
    id: str
    name: str
    unit: Literal["g", "ml"]
    photo: str | None = None
    protein: str | None
    fat: str | None
    carbohydrate: str | None
    calories: str | None
    portions: list[PortionInput]
    archived: bool
    revision: int
    created_at: str
    updated_at: str


def product_output(connection: Connection, record: ProductRecord) -> ProductOutput:
    portions = [PortionInput(id=row.id, name=row.name, quantity=rate_string(row.quantity))
                for row in connection.execute(select(product_portion).where(
                    product_portion.c.product_id == record.id).order_by(product_portion.c.position))]
    return ProductOutput(
        **record.model_dump(exclude={"protein", "fat", "carbohydrate", "calories", "created_at", "updated_at"}),
        protein=rate_string(record.protein) if record.protein is not None else None,
        fat=rate_string(record.fat) if record.fat is not None else None,
        carbohydrate=rate_string(record.carbohydrate) if record.carbohydrate is not None else None,
        calories=rate_string(record.calories) if record.calories is not None else None,
        portions=portions, created_at=timestamp(record.created_at), updated_at=timestamp(record.updated_at),
    )


def register_products(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure

    @app.get("/api/products")
    def products() -> list[ProductOutput]:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            return [product_output(connection, ProductRecord.model_validate(row)) for row in
                    connection.execute(select(product).order_by(product.c.created_at, product.c.id)).mappings()]

    @app.get("/api/products/{product_id}", response_model=ProductOutput)
    def read_product(product_id: UUID) -> ProductOutput | JSONResponse:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            row = connection.execute(select(product).where(product.c.id == str(product_id))).mappings().first()
            return product_output(connection, ProductRecord.model_validate(row)) if row else failure("not_found", "Продукт не найден.", 404)

    @app.post("/api/products", response_model=ReceiptOutput)
    def create_product(payload: ProductInput) -> ReceiptOutput | JSONResponse:
        return save_product(payload)

    @app.put("/api/products/{product_id}", response_model=ReceiptOutput)
    def edit_product(product_id: UUID, payload: EditProductInput) -> ReceiptOutput | JSONResponse:
        return save_product(payload, str(product_id))

    def save_product(payload: ProductInput, product_id: str | None = None) -> ReceiptOutput | JSONResponse:
        action = OperationAction.EDIT_PRODUCT if product_id else OperationAction.CREATE_PRODUCT
        normalized = payload.model_dump(exclude={"operation_id"})
        if "photo" not in payload.model_fields_set:
            normalized.pop("photo")
        normalized["product_id"] = product_id
        request_hash = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            existing = connection.execute(select(operation_receipt).where(operation_receipt.c.operation_id == payload.operation_id)).mappings().first()
            if existing:
                receipt = ReceiptRecord.model_validate(existing)
                if receipt.action != action or receipt.request_hash != request_hash:
                    return failure("operation_conflict", "UUID уже использован с другими данными.", 409, "operation_id")
                return receipt_output(receipt, True)
            now = now_ms()
            record = ProductRecord(
                id=product_id or str(uuid4()), name=payload.name, unit=payload.unit, photo=payload.photo,
                protein=hundredths(payload.protein) if payload.protein is not None else None,
                fat=hundredths(payload.fat) if payload.fat is not None else None,
                carbohydrate=hundredths(payload.carbohydrate) if payload.carbohydrate is not None else None,
                calories=hundredths(payload.calories) if payload.calories is not None else None,
                archived=payload.archived, revision=1, created_at=now, updated_at=now,
            )
            if product_id:
                assert isinstance(payload, EditProductInput)
                row = connection.execute(select(product).where(product.c.id == product_id)).mappings().first()
                if row is None:
                    return failure("not_found", "Продукт не найден.", 404)
                current = ProductRecord.model_validate(row)
                if "photo" not in payload.model_fields_set:
                    record.photo = current.photo
                if current.revision != payload.expected_revision:
                    return failure("revision_conflict", "Карточка изменена на другом устройстве. Загрузите актуальную для сравнения.", 409, "expected_revision")
                if current.unit != payload.unit:
                    old_ids: set[str] = set(connection.execute(select(product_portion.c.id).where(product_portion.c.product_id == product_id)).scalars())
                    if not payload.unit_change_confirmed or old_ids.intersection(portion.id for portion in payload.portions):
                        return failure("unit_change", "Подтвердите новые значения и новый набор порций либо его очистку.", 422, "unit")
                record.created_at = current.created_at
                record.revision = current.revision + 1
                connection.execute(update(product).where(product.c.id == product_id).values(record.model_dump(exclude={"id"})))
                connection.execute(delete(product_portion).where(product_portion.c.product_id == product_id))
            else:
                connection.execute(insert(product).values(record.model_dump()))
            for position, portion in enumerate(payload.portions):
                connection.execute(insert(product_portion).values(product_id=record.id, id=portion.id, position=position,
                                                                  name=portion.name, quantity=hundredths(portion.quantity)))
            receipt = ReceiptRecord(operation_id=payload.operation_id, action=action, request_hash=request_hash,
                                    result_id=record.id, revision=record.revision, completed_at=now)
            connection.execute(insert(operation_receipt).values(receipt.model_dump()))
            connection.commit()
        return receipt_output(receipt, False)
