import hashlib
import json
from datetime import date, datetime, time, timedelta
from fractions import Fraction
from typing import Literal
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import Connection, Engine, delete, insert, select, update

from diary.basal import hundredths, rate_string
from diary.dto import OperationAction, ReceiptRecord
from diary.entries import MOSCOW, EntryInput, OperationInput, ReceiptOutput, RevisionInput, milliseconds, receipt_output, timestamp
from diary.products import NamedInput, PortionInput, ProductInput
from diary.security import now_ms
from diary.tables import meal, meal_line, operation_receipt

NUTRIENTS = ("protein", "fat", "carbohydrate", "calories")
Category = Literal["breakfast", "lunch", "dinner", "snack"]


class MealLineInput(NamedInput):
    id: str
    kind: Literal["product"]
    unit: Literal["g", "ml"]
    quantity: str = Field(max_length=10000)
    basis_quantity: str = Field(max_length=10000)
    protein: str | None = Field(max_length=10000)
    fat: str | None = Field(max_length=10000)
    carbohydrate: str | None = Field(max_length=10000)
    calories: str | None = Field(max_length=10000)
    product_id: str
    product_revision: int = Field(ge=1, le=9223372036854775806)
    portion: PortionInput | None = None

    @field_validator("id", "product_id")
    @classmethod
    def valid_uuid(cls, value: str) -> str:
        return str(UUID(value))

    @field_validator("quantity")
    @classmethod
    def amount(cls, value: str) -> str:
        return PortionInput.positive_quantity(value)

    @field_validator("basis_quantity")
    @classmethod
    def basis(cls, value: str) -> str:
        if hundredths(value) != 10000:
            raise ValueError("Основа продукта — 100 г или мл.")
        return "100.00"

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


class MealRecord(BaseModel):
    id: str
    occurred_at: int
    category: Category | None
    revision: int
    created_at: int
    updated_at: int
    deleted_at: int | None


class MealLineRecord(BaseModel):
    meal_id: str
    id: str
    position: int
    kind: Literal["product"]
    name: str
    unit: Literal["g", "ml"]
    quantity: int
    basis_quantity: int
    protein: int | None
    fat: int | None
    carbohydrate: int | None
    calories: int | None
    product_id: str
    product_revision: int
    portion_id: str | None
    portion_name: str | None
    portion_quantity: int | None


class NutrientValues(BaseModel):
    protein: str | None
    fat: str | None
    carbohydrate: str | None
    calories: str | None


class NutrientTotal(BaseModel):
    value: str | None
    known_count: int
    unknown_count: int
    incomplete: bool


class NutritionTotals(BaseModel):
    protein: NutrientTotal
    fat: NutrientTotal
    carbohydrate: NutrientTotal
    calories: NutrientTotal


class MealLineOutput(MealLineInput):
    totals: NutrientValues


class MealOutput(BaseModel):
    id: str
    occurred_at: str
    category: Category | None
    revision: int
    created_at: str
    updated_at: str
    deleted_at: str | None
    lines: list[MealLineOutput]
    totals: NutritionTotals


class NutritionDayOutput(BaseModel):
    day: date
    meals: list[MealOutput]
    totals: NutritionTotals


def rounded(value: Fraction) -> str:
    # Values are nonnegative hundredths; round half-up without a Decimal context limit.
    return rate_string((2 * value.numerator + value.denominator) // (2 * value.denominator))


def nutrition_totals(lines: list[MealLineRecord]) -> NutritionTotals:
    result: dict[str, NutrientTotal] = {}
    for name in NUTRIENTS:
        known = [Fraction(getattr(line, name) * line.quantity, line.basis_quantity)
                 for line in lines if getattr(line, name) is not None]
        result[name] = NutrientTotal(value=rounded(sum(known, Fraction())) if known else None,
                                    known_count=len(known), unknown_count=len(lines) - len(known),
                                    incomplete=len(known) < len(lines))
    return NutritionTotals(**result)


def meal_lines(connection: Connection, meal_id: str) -> list[MealLineRecord]:
    return [MealLineRecord.model_validate(row) for row in connection.execute(
        select(meal_line).where(meal_line.c.meal_id == meal_id).order_by(meal_line.c.position)).mappings()]


def meal_output(record: MealRecord, lines: list[MealLineRecord]) -> MealOutput:
    outputs = []
    for line in lines:
        values = {name: rate_string(getattr(line, name)) if getattr(line, name) is not None else None for name in NUTRIENTS}
        portion = PortionInput(id=line.portion_id, name=line.portion_name, quantity=rate_string(line.portion_quantity)) \
            if line.portion_id is not None and line.portion_name is not None and line.portion_quantity is not None else None
        outputs.append(MealLineOutput(
            id=line.id, kind=line.kind, name=line.name, unit=line.unit, quantity=rate_string(line.quantity),
            basis_quantity=rate_string(line.basis_quantity), product_id=line.product_id,
            product_revision=line.product_revision, portion=portion, **values,
            totals=NutrientValues(**{name: rounded(Fraction(getattr(line, name) * line.quantity, line.basis_quantity))
                                    if getattr(line, name) is not None else None for name in NUTRIENTS}),
        ))
    return MealOutput(id=record.id, occurred_at=timestamp(record.occurred_at), category=record.category,
                      revision=record.revision, created_at=timestamp(record.created_at), updated_at=timestamp(record.updated_at),
                      deleted_at=timestamp(record.deleted_at) if record.deleted_at is not None else None,
                      lines=outputs, totals=nutrition_totals(lines))


def register_meals(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure

    @app.get("/api/meals/{meal_id}", response_model=MealOutput)
    def read_meal(meal_id: UUID) -> MealOutput | JSONResponse:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            row = connection.execute(select(meal).where(meal.c.id == str(meal_id))).mappings().first()
            return meal_output(MealRecord.model_validate(row), meal_lines(connection, str(meal_id))) if row else failure("not_found", "Приём пищи не найден.", 404)

    @app.get("/api/nutrition-day", response_model=NutritionDayOutput)
    def read_day(day: date) -> NutritionDayOutput | JSONResponse:
        try:
            start = milliseconds(datetime.combine(day, time(), MOSCOW))
            end = milliseconds(datetime.combine(day + timedelta(days=1), time(), MOSCOW))
        except (ValueError, OverflowError):
            return failure("validation", "Дата за пределами календаря.", 422, "day")
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            records = [MealRecord.model_validate(row) for row in connection.execute(select(meal).where(
                meal.c.deleted_at.is_(None), meal.c.occurred_at >= start, meal.c.occurred_at < end
            ).order_by(meal.c.occurred_at, meal.c.created_at, meal.c.id)).mappings()]
            lines = [meal_lines(connection, record.id) for record in records]
            return NutritionDayOutput(day=day, meals=[meal_output(record, items) for record, items in zip(records, lines)],
                                      totals=nutrition_totals([line for items in lines for line in items]))

    @app.post("/api/meals", response_model=ReceiptOutput)
    def create_meal(payload: MealInput) -> ReceiptOutput | JSONResponse:
        return change_meal(OperationAction.CREATE_MEAL, payload)

    @app.put("/api/meals/{meal_id}", response_model=ReceiptOutput)
    def edit_meal(meal_id: UUID, payload: EditMealInput) -> ReceiptOutput | JSONResponse:
        return change_meal(OperationAction.EDIT_MEAL, payload, str(meal_id))

    @app.post("/api/meals/{meal_id}/delete", response_model=ReceiptOutput)
    def delete_meal(meal_id: UUID, payload: RevisionInput) -> ReceiptOutput | JSONResponse:
        return change_meal(OperationAction.DELETE_MEAL, payload, str(meal_id))

    @app.post("/api/meals/{meal_id}/restore", response_model=ReceiptOutput)
    def restore_meal(meal_id: UUID, payload: RevisionInput) -> ReceiptOutput | JSONResponse:
        return change_meal(OperationAction.RESTORE_MEAL, payload, str(meal_id))

    def change_meal(action: OperationAction, payload: MealInput | RevisionInput, meal_id: str | None = None) -> ReceiptOutput | JSONResponse:
        normalized = payload.model_dump(exclude={"operation_id"})
        normalized["meal_id"] = meal_id
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
            result_id = meal_id or str(uuid4())
            record = MealRecord(id=result_id, occurred_at=0, category=None, revision=1,
                                created_at=now, updated_at=now, deleted_at=None)
            if isinstance(payload, RevisionInput):
                row = connection.execute(select(meal).where(meal.c.id == result_id)).mappings().first()
                if row is None:
                    return failure("not_found", "Приём пищи не найден.", 404)
                record = MealRecord.model_validate(row)
                if record.revision != payload.expected_revision or (record.deleted_at is not None) != (action == OperationAction.RESTORE_MEAL):
                    return failure("revision_conflict", "Приём пищи изменён на другом устройстве. Загрузите актуальный для сравнения.", 409, "expected_revision")
                if action == OperationAction.RESTORE_MEAL and record.deleted_at is not None and now >= record.deleted_at + 30000:
                    return failure("undo_expired", "30 секунд истекли. Отменить удаление уже нельзя.", 409)
                record.revision += 1
                record.updated_at = now
            if isinstance(payload, MealInput):
                record.occurred_at = milliseconds(datetime.fromisoformat(payload.occurred_at))
                record.category = payload.category
            else:
                record.deleted_at = now if action == OperationAction.DELETE_MEAL else None
            if meal_id:
                connection.execute(update(meal).where(meal.c.id == result_id).values(record.model_dump(exclude={"id"})))
            else:
                connection.execute(insert(meal).values(record.model_dump()))
            if isinstance(payload, MealInput):
                connection.execute(delete(meal_line).where(meal_line.c.meal_id == result_id))
                for position, line in enumerate(payload.lines):
                    values = MealLineRecord(
                        meal_id=result_id, id=line.id, position=position, kind=line.kind, name=line.name, unit=line.unit,
                        quantity=hundredths(line.quantity), basis_quantity=hundredths(line.basis_quantity),
                        **{name: hundredths(getattr(line, name)) if getattr(line, name) is not None else None for name in NUTRIENTS},
                        product_id=line.product_id, product_revision=line.product_revision,
                        portion_id=line.portion.id if line.portion else None, portion_name=line.portion.name if line.portion else None,
                        portion_quantity=hundredths(line.portion.quantity) if line.portion else None,
                    )
                    connection.execute(insert(meal_line).values(values.model_dump()))
            receipt = ReceiptRecord(operation_id=payload.operation_id, action=action, request_hash=request_hash,
                                    result_id=result_id, revision=record.revision, completed_at=now)
            connection.execute(insert(operation_receipt).values(receipt.model_dump()))
            connection.commit()
        return receipt_output(receipt, False)
