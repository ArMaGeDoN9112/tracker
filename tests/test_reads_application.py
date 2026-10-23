from contextlib import nullcontext
from datetime import date, datetime
from uuid import uuid4

import pytest

from diary.application.entries import DayQuery, InvalidDay
from diary.application.meals import MealLineInput, MealResult, line_record
from diary.application.reads import (
    GetGlucoseSummary, GetNutritionDay, GetNutritionSummary, GlucoseMeasurement,
    InvalidPeriod, NutritionLine, Period, SummaryQuery,
)
from diary.domain.nutrition import MealRecord
from diary.domain.time import milliseconds
from diary.domain.water import WaterRecord


class MemoryReads:
    def glucose(self, start, end):
        records = [GlucoseMeasurement(occurred_at=milliseconds(datetime.fromisoformat(at)), glucose=value)
                   for at, value in [('2010-06-01T19:59:59.999+00:00', 990),
                                     ('2010-06-01T20:00:00+00:00', 40),
                                     ('2010-06-02T19:00:00+00:00', 41),
                                     ('2010-06-02T20:00:00+00:00', 40),
                                     ('2010-06-03T20:00:00+00:00', 990)]]
        return [row for row in records if start <= row.occurred_at < end]


def test_glucose_summary_keeps_historical_days_and_unrounded_period_average():
    result = GetGlucoseSummary(lambda: nullcontext(MemoryReads()), lambda: 0).execute(
        SummaryQuery(period=Period.CUSTOM, start=date(2010, 6, 2), end=date(2010, 6, 3)))
    assert result.count == 3 and result.average == '4.0'
    assert [(day.day, day.count, day.average, day.minimum, day.maximum) for day in result.days] == [
        (date(2010, 6, 2), 2, '4.1', '4.0', '4.1'),
        (date(2010, 6, 3), 1, '4.0', '4.0', '4.0')]


class MemoryNutrition:
    def meals(self, start, end):
        lines = self.lines(start, end)
        if not lines:
            return []
        at = lines[0].occurred_at
        return [MealResult(record=MealRecord(id='meal', occurred_at=at, category=None, revision=1,
                           created_at=at, updated_at=at, deleted_at=None), lines=lines)]

    def lines(self, start, end):
        at = milliseconds(datetime.fromisoformat('2010-06-01T20:00:00+00:00'))
        return [NutritionLine(**line_record(MealLineInput(id=str(uuid4()), kind='one_off', name='Суп',
                              protein=value), 'meal', position).model_dump(), occurred_at=at)
                for position, value in enumerate(['0', None]) if start <= at < end]

    def water(self, start, end):
        at = milliseconds(datetime.fromisoformat('2010-06-02T20:00:00+00:00'))
        return [WaterRecord(id='water', volume_ml=250, occurred_at=at, created_at=at, updated_at=at,
                            deleted_at=None, revision=1)] if start <= at < end else []


def test_nutrition_summary_counts_meals_and_retains_zero_unknown_and_water_only_days():
    result = GetNutritionSummary(lambda: nullcontext(MemoryNutrition()), lambda: 0).execute(
        SummaryQuery(period=Period.CUSTOM, start=date(2010, 6, 2), end=date(2010, 6, 4)))
    assert (result.food_days, result.meal_count) == (1, 1)
    assert [day.water_total_ml for day in result.days] == [None, 250, None]
    assert result.averages.protein.model_dump() == {
        'value': '0.00', 'known_days': 1, 'incomplete_days': 1, 'incomplete': True}
    assert result.days[0].totals.fat.model_dump() == {
        'value': None, 'known_count': 0, 'unknown_count': 2, 'incomplete': True}


def test_nutrition_day_returns_records_and_totals_without_http_or_database():
    result = GetNutritionDay(lambda: nullcontext(MemoryNutrition())).execute(DayQuery(day=date(2010, 6, 2)))
    assert result.day == date(2010, 6, 2)
    assert [item.record.id for item in result.meals] == ['meal']
    assert result.water == []
    assert result.water_total_ml is None
    assert result.totals.protein.model_dump() == {
        'value': '0.00', 'known_count': 1, 'unknown_count': 1, 'incomplete': True}


@pytest.mark.parametrize('day,water_total', [(date(2010, 6, 3), 250), (date(2010, 6, 4), None)])
def test_nutrition_day_without_food_preserves_unknown_totals(day, water_total):
    result = GetNutritionDay(lambda: nullcontext(MemoryNutrition())).execute(DayQuery(day=day))
    assert result.meals == []
    assert result.water_total_ml == water_total
    assert result.totals.protein.model_dump() == {
        'value': None, 'known_count': 0, 'unknown_count': 0, 'incomplete': False}


@pytest.mark.parametrize('case,reader', [
    (GetGlucoseSummary, MemoryReads), (GetNutritionSummary, MemoryNutrition),
])
@pytest.mark.parametrize('query,field', [
    (SummaryQuery(period=Period.CUSTOM), 'start'),
    (SummaryQuery(period=Period.CUSTOM, start=date(2026, 10, 21), end=date(2026, 10, 20)), 'start'),
    (SummaryQuery(end=date.min), 'end'), (SummaryQuery(end=date.max), 'end'),
])
def test_summary_rejects_invalid_calendar_periods(case, reader, query, field):
    with pytest.raises(InvalidPeriod) as caught:
        case(lambda: nullcontext(reader()), lambda: 0).execute(query)
    assert caught.value.field == field


def test_nutrition_day_rejects_calendar_overflow():
    with pytest.raises(InvalidDay):
        GetNutritionDay(lambda: nullcontext(MemoryNutrition())).execute(DayQuery(day=date.max))
