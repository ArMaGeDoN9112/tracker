from fractions import Fraction
from typing import Literal

from pydantic import BaseModel

from diary.domain.precision import rate_string


NUTRIENTS = ("protein", "fat", "carbohydrate", "calories")


class MealRecord(BaseModel):
    id: str
    occurred_at: int
    revision: int
    created_at: int
    updated_at: int
    deleted_at: int | None


class MealLineRecord(BaseModel):
    meal_id: str
    id: str
    position: int
    kind: Literal["product", "one_off"]
    name: str
    unit: Literal["g", "ml"] | None
    quantity: int | None
    basis_quantity: int | None
    protein: int | None
    fat: int | None
    carbohydrate: int | None
    calories: int | None
    product_id: str | None
    product_revision: int | None
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


class NutrientAverage(BaseModel):
    value: str | None
    known_days: int
    incomplete_days: int
    incomplete: bool


class NutritionAverages(BaseModel):
    protein: NutrientAverage
    fat: NutrientAverage
    carbohydrate: NutrientAverage
    calories: NutrientAverage


def rounded(value: Fraction) -> str:
    # Values are nonnegative hundredths; round half-up without a Decimal context limit.
    return rate_string((2 * value.numerator + value.denominator) // (2 * value.denominator))


def contribution(line: MealLineRecord, name: str) -> Fraction | None:
    value = getattr(line, name)
    if value is None:
        return None
    return Fraction(value * line.quantity, line.basis_quantity) if line.basis_quantity is not None and line.quantity is not None else Fraction(value)


def nutrition_totals(lines: list[MealLineRecord]) -> NutritionTotals:
    result: dict[str, NutrientTotal] = {}
    for name in NUTRIENTS:
        known = [value for line in lines if (value := contribution(line, name)) is not None]
        result[name] = NutrientTotal(value=rounded(sum(known, Fraction())) if known else None,
                                    known_count=len(known), unknown_count=len(lines) - len(known),
                                    incomplete=len(known) < len(lines))
    return NutritionTotals(**result)


def nutrition_averages(days: list[list[MealLineRecord]]) -> NutritionAverages:
    averages: dict[str, NutrientAverage] = {}
    for name in NUTRIENTS:
        total = Fraction()
        known_days = incomplete_days = 0
        for lines in days:
            known = [value for line in lines if (value := contribution(line, name)) is not None]
            total += sum(known, Fraction())
            known_days += bool(known)
            incomplete_days += len(known) < len(lines)
        averages[name] = NutrientAverage(value=rounded(total / known_days) if known_days else None,
                                         known_days=known_days, incomplete_days=incomplete_days,
                                         incomplete=incomplete_days > 0)
    return NutritionAverages(**averages)
