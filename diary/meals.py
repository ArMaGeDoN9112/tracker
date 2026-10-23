import hashlib
import json
from datetime import date, datetime, time, timedelta
from fractions import Fraction
from typing import Literal
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import Connection, Engine, delete, insert, select, update

from diary.application.meals import EditMealInput, MealInput, MealLineInput, MealProductPreviewInput
from diary.application.operations import OperationAction, ReceiptRecord, RevisionInput
from diary.application.products import PortionInput
from diary.domain.nutrition import (
    Category,
    MealLineRecord,
    MealRecord,
    NUTRIENTS,
    NutrientValues,
    NutritionAverages,
    NutritionTotals,
    contribution,
    nutrition_averages,
    nutrition_totals,
    rounded,
)
from diary.domain.precision import hundredths, rate_string
from diary.domain.time import EPOCH, MOSCOW, milliseconds
from diary.bootstrap import receipt_output
from diary.interfaces.http.outputs import ReceiptOutput, timestamp
from diary.glucose import Period
from diary.security import now_ms
from diary.tables import meal, meal_line, operation_receipt, water
from diary.interfaces.http.water import WaterOutput
from diary.bootstrap import day_water


class MealLineOutput(MealLineInput):
    totals: NutrientValues


class RepeatMealOutput(BaseModel):
    occurred_at: str
    category: Category | None
    lines: list[MealLineInput]


class MealProductPreview(NutrientValues):
    name: str
    unit: Literal["g", "ml"]


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
    water: list[WaterOutput]
    water_total_ml: int | None
    totals: NutritionTotals


class NutritionSummaryDay(BaseModel):
    day: date
    meal_count: int
    totals: NutritionTotals
    water_total_ml: int | None


class NutritionSummaryOutput(BaseModel):
    start: date
    end: date
    food_days: int
    meal_count: int
    averages: NutritionAverages
    days: list[NutritionSummaryDay]


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
            id=line.id, kind=line.kind, name=line.name, unit=line.unit, quantity=rate_string(line.quantity) if line.quantity is not None else None,
            basis_quantity=rate_string(line.basis_quantity) if line.basis_quantity is not None else None, product_id=line.product_id,
            product_revision=line.product_revision, portion=portion, **values,
            totals=NutrientValues(**{name: rounded(value) if (value := contribution(line, name)) is not None else None for name in NUTRIENTS}),
        ))
    return MealOutput(id=record.id, occurred_at=timestamp(record.occurred_at), category=record.category,
                      revision=record.revision, created_at=timestamp(record.created_at), updated_at=timestamp(record.updated_at),
                      deleted_at=timestamp(record.deleted_at) if record.deleted_at is not None else None,
                      lines=outputs, totals=nutrition_totals(lines))


def register_meals(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure

    @app.get("/api/nutrition-summary", response_model=NutritionSummaryOutput)
    def read_summary(period: Period = Period.WEEK, start: date | None = None,
                     end: date | None = None) -> NutritionSummaryOutput | JSONResponse:
        end = end or (EPOCH + timedelta(milliseconds=now_ms())).astimezone(MOSCOW).date()
        try:
            if period != Period.CUSTOM:
                start = end - timedelta(days=6 if period == Period.WEEK else 29)
            if start is None or start > end:
                return failure("validation", "Укажите начало периода не позже окончания.", 422, "start")
            lower = milliseconds(datetime.combine(start, time(), MOSCOW))
            upper = milliseconds(datetime.combine(end + timedelta(days=1), time(), MOSCOW))
        except (ValueError, OverflowError):
            return failure("validation", "Границы периода за пределами календаря.", 422, "end")
        days: dict[date, list[MealLineRecord]] = {
            date.fromordinal(ordinal): [] for ordinal in range(start.toordinal(), end.toordinal() + 1)}
        meals: dict[date, set[str]] = {day: set() for day in days}
        water_totals: dict[date, int] = {}
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            for event in connection.execute(select(water.c.occurred_at, water.c.volume_ml).where(
                water.c.deleted_at.is_(None), water.c.occurred_at >= lower, water.c.occurred_at < upper)):
                day = (EPOCH + timedelta(milliseconds=event.occurred_at)).astimezone(MOSCOW).date()
                water_totals[day] = water_totals.get(day, 0) + event.volume_ml
            rows = connection.execute(select(meal_line, meal.c.occurred_at).join(meal, meal_line.c.meal_id == meal.c.id).where(
                meal.c.deleted_at.is_(None), meal.c.occurred_at >= lower, meal.c.occurred_at < upper)).mappings()
            for row in rows:
                day = (EPOCH + timedelta(milliseconds=row.occurred_at)).astimezone(MOSCOW).date()
                line = MealLineRecord.model_validate(row)
                days[day].append(line)
                meals[day].add(line.meal_id)
        return NutritionSummaryOutput(start=start, end=end, food_days=sum(bool(ids) for ids in meals.values()),
                                      meal_count=sum(len(ids) for ids in meals.values()), averages=nutrition_averages(list(days.values())),
                                      days=[NutritionSummaryDay(day=day, meal_count=len(meals[day]), totals=nutrition_totals(lines),
                                                                water_total_ml=water_totals.get(day))
                                            for day, lines in days.items()])

    @app.get("/api/meals/{meal_id}/repeat-form", response_model=RepeatMealOutput)
    def repeat_meal(meal_id: UUID) -> RepeatMealOutput | JSONResponse:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            row = connection.execute(select(meal).where(meal.c.id == str(meal_id), meal.c.deleted_at.is_(None))).mappings().first()
            if row is None:
                return failure("not_found", "Неудалённый приём пищи не найден.", 404)
            source = meal_output(MealRecord.model_validate(row), meal_lines(connection, str(meal_id)))
            return RepeatMealOutput(occurred_at=timestamp(now_ms()), category=source.category,
                                    lines=[MealLineInput(**line.model_dump(exclude={"totals", "id"}), id=str(uuid4())) for line in source.lines])

    @app.post("/api/meal-product-preview", response_model=MealProductPreview)
    def preview_product(payload: MealProductPreviewInput) -> MealProductPreview | JSONResponse:
        line = payload.line
        basis = line.basis_quantity or payload.basis_quantity
        if line.kind != "one_off":
            return failure("validation", "Выберите разовую еду.", 422, "line.kind")
        if basis is None:
            return failure("validation", "Введите фактическое количество исходной порции или заполните новую карточку независимо.", 422, "basis_quantity")
        if line.basis_quantity is not None and payload.unit != line.unit:
            return failure("validation", "Единица должна совпадать с исходной основой.", 422, "unit")
        values = {name: rounded(Fraction(hundredths(getattr(line, name)) * 10000, hundredths(basis)))
                  if getattr(line, name) is not None else None for name in NUTRIENTS}
        if any(Fraction(value) > Fraction(2147483647, 100) for value in values.values() if value is not None):
            return failure("validation", "Значение на 100 превышает предел карточки. Заполните её независимо.", 422, "basis_quantity")
        return MealProductPreview(name=line.name, unit=payload.unit, **values)

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
            events = day_water(connection, start, end)
            return NutritionDayOutput(day=day, water=events, water_total_ml=sum(event.volume_ml for event in events) if events else None, meals=[meal_output(record, items) for record, items in zip(records, lines)],
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
                        quantity=hundredths(line.quantity) if line.quantity is not None else None,
                        basis_quantity=hundredths(line.basis_quantity) if line.basis_quantity is not None else None,
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
