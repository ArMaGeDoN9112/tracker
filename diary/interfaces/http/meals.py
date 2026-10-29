from dataclasses import dataclass
from typing import Callable
from uuid import UUID

from fastapi import FastAPI
from pydantic import BaseModel

from diary.application.meals import (
    CreateMeal, DeleteMeal, EditMeal, EditMealCommand, EditMealInput, GetMeal,
    MealInput, MealLineInput, MealProductPreview, MealProductPreviewInput, MealQuery,
    MealRevisionCommand, PreviewMealProduct, RepeatMeal, RestoreMeal, line_input,
)
from diary.application.operations import RevisionInput
from diary.domain.nutrition import (
    MealLineRecord, MealRecord, NUTRIENTS, NutrientValues,
    NutritionTotals, contribution, nutrition_totals, rounded,
)
from diary.interfaces.http.outputs import ReceiptOutput, receipt_output, timestamp


class MealLineOutput(MealLineInput):
    totals: NutrientValues


class RepeatMealOutput(BaseModel):
    occurred_at: str
    lines: list[MealLineInput]


class MealOutput(BaseModel):
    id: str
    occurred_at: str
    revision: int
    created_at: str
    updated_at: str
    deleted_at: str | None
    lines: list[MealLineOutput]
    totals: NutritionTotals


def meal_output(record: MealRecord, lines: list[MealLineRecord]) -> MealOutput:
    outputs = []
    for line in lines:
        outputs.append(MealLineOutput(
            **line_input(line).model_dump(),
            totals=NutrientValues(**{name: rounded(value) if (value := contribution(line, name)) is not None else None for name in NUTRIENTS}),
        ))
    return MealOutput(id=record.id, occurred_at=timestamp(record.occurred_at),
                      revision=record.revision, created_at=timestamp(record.created_at), updated_at=timestamp(record.updated_at),
                      deleted_at=timestamp(record.deleted_at) if record.deleted_at is not None else None,
                      lines=outputs, totals=nutrition_totals(lines))


@dataclass
class MealUseCases:
    get: GetMeal
    repeat: RepeatMeal
    preview: PreviewMealProduct
    create: CreateMeal
    edit: EditMeal
    delete: DeleteMeal
    restore: RestoreMeal


def register_meals(app: FastAPI, cases: MealUseCases, clock: Callable[[], int]) -> None:
    @app.get("/api/meals/{meal_id}/repeat-form", response_model=RepeatMealOutput)
    def repeat_meal(meal_id: UUID) -> RepeatMealOutput:
        result = cases.repeat.execute(MealQuery(meal_id=str(meal_id)))
        return RepeatMealOutput(occurred_at=timestamp(result.occurred_at), lines=result.lines)

    @app.post("/api/meal-product-preview", response_model=MealProductPreview)
    def preview_product(payload: MealProductPreviewInput) -> MealProductPreview:
        return cases.preview.execute(payload)

    @app.get("/api/meals/{meal_id}", response_model=MealOutput)
    def read_meal(meal_id: UUID) -> MealOutput:
        result = cases.get.execute(MealQuery(meal_id=str(meal_id)))
        return meal_output(result.record, result.lines)

    @app.post("/api/meals", response_model=ReceiptOutput)
    def create_meal(payload: MealInput) -> ReceiptOutput:
        result = cases.create.execute(payload)
        return receipt_output(result.receipt, result.replayed, clock())

    @app.put("/api/meals/{meal_id}", response_model=ReceiptOutput)
    def edit_meal(meal_id: UUID, payload: EditMealInput) -> ReceiptOutput:
        result = cases.edit.execute(EditMealCommand(**payload.model_dump(), meal_id=str(meal_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/meals/{meal_id}/delete", response_model=ReceiptOutput)
    def delete_meal(meal_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.delete.execute(MealRevisionCommand(**payload.model_dump(), meal_id=str(meal_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/meals/{meal_id}/restore", response_model=ReceiptOutput)
    def restore_meal(meal_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.restore.execute(MealRevisionCommand(**payload.model_dump(), meal_id=str(meal_id)))
        return receipt_output(result.receipt, result.replayed, clock())
