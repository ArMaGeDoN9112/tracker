from datetime import date, datetime, time, timedelta

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import Engine, select

from diary.domain.nutrition import MealLineRecord, MealRecord, NutritionAverages, NutritionTotals, nutrition_averages, nutrition_totals
from diary.domain.time import EPOCH, MOSCOW, milliseconds
from diary.glucose import Period
from diary.security import now_ms
from diary.tables import meal, meal_line, water
from diary.interfaces.http.water import WaterOutput
from diary.bootstrap import day_water
from diary.infrastructure.nutrition import meal_lines
from diary.interfaces.http.meals import MealOutput, meal_output


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


# shortcut: composite nutrition reads retain their shared SQL snapshot until stage 06.
def register_nutrition_reads(app: FastAPI, engine: Engine) -> None:
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
