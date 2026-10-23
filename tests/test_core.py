from datetime import datetime
from fractions import Fraction

import pytest
from pydantic import ValidationError

from diary.application.entries import EntryInput
from diary.domain.access import validate_login, validate_password
from diary.domain.basal import basal_at, basal_changes
from diary.domain.basal import BasalInterval, BasalSchedule, TemporaryBasalPeriod
from diary.domain.time import milliseconds
from diary.domain.precision import decimal_string, hundredths, rate_string, tenths
from diary.domain.nutrition import MealLineRecord, nutrition_totals, rounded


def test_basal_schedule_and_temporary_percent_without_database():
    start = milliseconds(datetime.fromisoformat("2026-10-23T00:00:00+03:00"))
    versions = [BasalSchedule(id="schedule", starts_at=start, created_at=start, intervals=[
        BasalInterval(minute=0, rate=125), BasalInterval(minute=60, rate=200),
    ])]
    temporary = [TemporaryBasalPeriod(
        id="temporary", starts_at=start + 1800000, ends_at=start + 5400000,
        effective_ends_at=start + 5400000, duration_minutes=60, percent=150,
        created_at=start, updated_at=start, revision=1, deleted_at=None,
    )]
    assert basal_at(versions, start - 1, temporary) is None
    assert basal_at(versions, start, temporary) == "1.25"
    assert [(change.occurred_at, change.basal) for change in basal_changes(
        versions, start, start + 7200000, temporary,
    )] == [(start + 1800000, "1.88"), (start + 3600000, "3.00"), (start + 5400000, "2.00")]


@pytest.mark.parametrize("value,expected", [(" +00012,300 ", 123), ("214748364.7", 2147483647), ("0", 0)])
def test_tenths_normalize_without_rounding(value, expected):
    assert tenths(value) == expected
    assert tenths(decimal_string(expected)) == expected


@pytest.mark.parametrize("parse,value", [
    (tenths, "1.01"), (tenths, "214748364.8"), (hundredths, "0.001"),
    (hundredths, "21474836.48"), (hundredths, "-1"), (tenths, "NaN"),
])
def test_precision_rejects_hidden_rounding_and_overflow(parse, value):
    with pytest.raises(ValueError):
        parse(value)


def test_hundredths_and_half_up_rounding():
    assert hundredths(" +00012,3400 ") == 1234
    assert rate_string(hundredths("21474836.47")) == "21474836.47"
    assert rounded(Fraction(1, 2)) == "0.01"
    assert rounded(Fraction(1, 3)) == "0.00"


def test_command_normalization_preserves_legacy_values():
    command = EntryInput(
        operation_id="{12345678-1234-1234-1234-123456789ABC}",
        occurred_at="2026-10-23T03:00:00.001+03:00", glucose="+005,600", bolus="", reason="food",
    )
    assert command.model_dump() == {
        "operation_id": "12345678-1234-1234-1234-123456789abc",
        "occurred_at": "2026-10-23T00:00:00.001Z", "glucose": "5.6",
        "bolus": "0.0", "reason": None, "comment": "",
    }
    assert milliseconds(datetime.fromisoformat("1969-12-31T23:59:59.999+00:00")) == -1
    with pytest.raises(ValidationError):
        EntryInput(operation_id=command.operation_id, occurred_at="2026-10-23T00:00:00", comment="test")


def test_nutrition_sums_exact_contributions_before_rounding_and_keeps_unknowns():
    line = MealLineRecord(
        meal_id="meal", id="line", position=0, kind="one_off", name="Еда", unit="g",
        quantity=100, basis_quantity=300, protein=1, fat=None, carbohydrate=0, calories=100,
        product_id=None, product_revision=None, portion_id=None, portion_name=None, portion_quantity=None,
    )
    totals = nutrition_totals([line, line])
    assert totals.protein.value == "0.01"
    assert totals.protein.known_count == 2
    assert totals.fat.value is None
    assert totals.fat.unknown_count == 2
    assert totals.fat.incomplete
    assert totals.carbohydrate.value == "0.00"
    assert nutrition_totals([]).protein.value is None


def test_access_validation_without_password_hasher():
    assert validate_login("  пользователь  ") == "пользователь"
    validate_password("x" * 15)
    validate_password("x" * 1024)
    for password in ("x" * 14, "x" * 1025):
        with pytest.raises(ValueError):
            validate_password(password)
    for login in ("  ", "x" * 129):
        with pytest.raises(ValueError):
            validate_login(login)


def test_nutrition_average_counts_only_known_days():
    from diary.domain.nutrition import nutrition_averages

    line = MealLineRecord(
        meal_id="meal", id="line", position=0, kind="one_off", name="Еда", unit=None,
        quantity=None, basis_quantity=None, protein=100, fat=None, carbohydrate=0, calories=100,
        product_id=None, product_revision=None, portion_id=None, portion_name=None, portion_quantity=None,
    )
    unknown = line.model_copy(update={"protein": None})
    totals = nutrition_averages([[line, unknown], [], [line.model_copy(update={"protein": 200})]])
    assert totals.protein.value == "1.50"
    assert totals.protein.known_days == 2
    assert totals.protein.incomplete_days == 1
    assert totals.protein.incomplete
    assert totals.fat.value is None
    assert totals.fat.known_days == 0
    assert totals.fat.incomplete_days == 2
    assert totals.carbohydrate.value == "0.00"
