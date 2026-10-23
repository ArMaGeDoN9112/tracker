from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from enum import StrEnum
from typing import Callable, ContextManager, Protocol

from pydantic import BaseModel

from diary.application.errors import ApplicationError
from diary.application.entries import DayQuery, InvalidDay
from diary.application.meals import MealResult
from diary.domain.nutrition import (
    MealLineRecord, NutritionAverages, NutritionTotals, nutrition_averages, nutrition_totals,
)
from diary.domain.water import WaterRecord
from diary.domain.glucose import GlucoseTotals
from diary.domain.precision import decimal_string
from diary.domain.time import EPOCH, MOSCOW, milliseconds


class Period(StrEnum):
    WEEK = "week"
    MONTH = "month"
    CUSTOM = "custom"


class SummaryQuery(BaseModel):
    period: Period = Period.WEEK
    start: date | None = None
    end: date | None = None


class InvalidPeriod(ApplicationError):
    code = "validation"

    def __init__(self, message: str, field: str) -> None:
        super().__init__(message)
        self.field = field


class ReadPeriod(BaseModel):
    start: date
    end: date
    lower: int
    upper: int


def summary_period(query: SummaryQuery, clock: Callable[[], int]) -> ReadPeriod:
    end = query.end or (EPOCH + timedelta(milliseconds=clock())).astimezone(MOSCOW).date()
    try:
        start = query.start
        if query.period != Period.CUSTOM:
            start = end - timedelta(days=6 if query.period == Period.WEEK else 29)
        if start is None or start > end:
            raise InvalidPeriod("Укажите начало периода не позже окончания.", "start")
        lower = milliseconds(datetime.combine(start, time(), MOSCOW))
        upper = milliseconds(datetime.combine(end + timedelta(days=1), time(), MOSCOW))
    except (ValueError, OverflowError) as error:
        raise InvalidPeriod("Границы периода за пределами календаря.", "end") from error
    return ReadPeriod(start=start, end=end, lower=lower, upper=upper)


class GlucoseMeasurement(BaseModel):
    occurred_at: int
    glucose: int


class GlucoseReader(Protocol):
    def glucose(self, start: int, end: int) -> list[GlucoseMeasurement]: ...


class GlucoseDayOutput(BaseModel):
    day: date
    count: int
    average: str | None
    minimum: str | None
    maximum: str | None


class GlucoseSummaryOutput(BaseModel):
    start: date
    end: date
    count: int
    average: str | None
    days: list[GlucoseDayOutput]


@dataclass
class GetGlucoseSummary:
    uow: Callable[[], ContextManager[GlucoseReader]]
    clock: Callable[[], int]

    def execute(self, query: SummaryQuery) -> GlucoseSummaryOutput:
        period = summary_period(query, self.clock)
        days = {date.fromordinal(ordinal): GlucoseTotals() for ordinal in range(period.start.toordinal(), period.end.toordinal() + 1)}
        totals = GlucoseTotals()
        with self.uow() as reader:
            rows = reader.glucose(period.lower, period.upper)
            for row in rows:
                day = (EPOCH + timedelta(milliseconds=row.occurred_at)).astimezone(MOSCOW).date()
                days[day].add(row.glucose)
                totals.add(row.glucose)
        return GlucoseSummaryOutput(start=period.start, end=period.end, count=totals.count, average=totals.average(), days=[
            GlucoseDayOutput(day=day, count=values.count, average=values.average(),
                             minimum=decimal_string(values.minimum) if values.minimum is not None else None,
                             maximum=decimal_string(values.maximum) if values.maximum is not None else None)
            for day, values in days.items()
        ])


class NutritionLine(MealLineRecord):
    occurred_at: int


class NutritionSummaryReader(Protocol):
    def water(self, start: int, end: int) -> list[WaterRecord]: ...
    def lines(self, start: int, end: int) -> list[NutritionLine]: ...


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


@dataclass
class GetNutritionSummary:
    uow: Callable[[], ContextManager[NutritionSummaryReader]]
    clock: Callable[[], int]

    def execute(self, query: SummaryQuery) -> NutritionSummaryOutput:
        period = summary_period(query, self.clock)
        days: dict[date, list[MealLineRecord]] = {
            date.fromordinal(ordinal): [] for ordinal in range(period.start.toordinal(), period.end.toordinal() + 1)}
        meals: dict[date, set[str]] = {day: set() for day in days}
        water_totals: dict[date, int] = {}
        with self.uow() as reader:
            for event in reader.water(period.lower, period.upper):
                day = (EPOCH + timedelta(milliseconds=event.occurred_at)).astimezone(MOSCOW).date()
                water_totals[day] = water_totals.get(day, 0) + event.volume_ml
            for line in reader.lines(period.lower, period.upper):
                day = (EPOCH + timedelta(milliseconds=line.occurred_at)).astimezone(MOSCOW).date()
                days[day].append(line)
                meals[day].add(line.meal_id)
        return NutritionSummaryOutput(start=period.start, end=period.end, food_days=sum(bool(ids) for ids in meals.values()),
                                      meal_count=sum(len(ids) for ids in meals.values()), averages=nutrition_averages(list(days.values())),
                                      days=[NutritionSummaryDay(day=day, meal_count=len(meals[day]), totals=nutrition_totals(lines),
                                                                water_total_ml=water_totals.get(day))
                                            for day, lines in days.items()])


class NutritionDayReader(Protocol):
    def meals(self, start: int, end: int) -> list[MealResult]: ...
    def water(self, start: int, end: int) -> list[WaterRecord]: ...


class NutritionDayResult(BaseModel):
    day: date
    meals: list[MealResult]
    water: list[WaterRecord]
    water_total_ml: int | None
    totals: NutritionTotals


@dataclass
class GetNutritionDay:
    uow: Callable[[], ContextManager[NutritionDayReader]]

    def execute(self, query: DayQuery) -> NutritionDayResult:
        try:
            start = milliseconds(datetime.combine(query.day, time(), MOSCOW))
            end = milliseconds(datetime.combine(query.day + timedelta(days=1), time(), MOSCOW))
        except (ValueError, OverflowError) as error:
            raise InvalidDay("Дата за пределами календаря.") from error
        with self.uow() as reader:
            meals = reader.meals(start, end)
            water = reader.water(start, end)
        return NutritionDayResult(
            day=query.day, meals=meals, water=water,
            water_total_ml=sum(event.volume_ml for event in water) if water else None,
            totals=nutrition_totals([line for item in meals for line in item.lines]),
        )
