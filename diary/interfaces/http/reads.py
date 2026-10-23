from dataclasses import dataclass
from datetime import date

from fastapi import FastAPI
from pydantic import BaseModel

from diary.application.entries import DayQuery
from diary.application.reads import (
    GetGlucoseSummary, GetNutritionDay, GetNutritionSummary, GlucoseSummaryOutput,
    NutritionSummaryOutput, Period, SummaryQuery,
)
from diary.domain.nutrition import NutritionTotals
from diary.interfaces.http.meals import MealOutput, meal_output
from diary.interfaces.http.water import WaterOutput, water_output


class NutritionDayOutput(BaseModel):
    day: date
    meals: list[MealOutput]
    water: list[WaterOutput]
    water_total_ml: int | None
    totals: NutritionTotals


@dataclass
class ReadUseCases:
    glucose: GetGlucoseSummary
    nutrition: GetNutritionSummary
    nutrition_day: GetNutritionDay


def register_reads(app: FastAPI, cases: ReadUseCases) -> None:
    @app.get("/api/glucose-summary", response_model=GlucoseSummaryOutput)
    def glucose_summary(period: Period = Period.WEEK, start: date | None = None,
                        end: date | None = None) -> GlucoseSummaryOutput:
        return cases.glucose.execute(SummaryQuery(period=period, start=start, end=end))

    @app.get("/api/nutrition-summary", response_model=NutritionSummaryOutput)
    def nutrition_summary(period: Period = Period.WEEK, start: date | None = None,
                          end: date | None = None) -> NutritionSummaryOutput:
        return cases.nutrition.execute(SummaryQuery(period=period, start=start, end=end))

    @app.get("/api/nutrition-day", response_model=NutritionDayOutput)
    def nutrition_day(day: date) -> NutritionDayOutput:
        result = cases.nutrition_day.execute(DayQuery(day=day))
        return NutritionDayOutput(
            day=result.day, meals=[meal_output(item.record, item.lines) for item in result.meals],
            water=[water_output(record) for record in result.water],
            water_total_ml=result.water_total_ml, totals=result.totals,
        )
