from dataclasses import dataclass
from typing import Callable
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from diary.application.errors import ApplicationError
from diary.application.operations import RevisionInput
from diary.application.water import (
    CreateWater, DeleteWater, EditWater, EditWaterCommand, EditWaterInput, EditWaterSettings,
    GetWater, GetWaterSettings, RestoreWater, WaterInput, WaterQuery,
    WaterRevisionCommand, WaterSettingsInput, WaterSettingsOutput,
)
from diary.domain.water import Volume, WaterRecord
from diary.dto import ErrorOutput
from diary.interfaces.http.outputs import ReceiptOutput, receipt_output, timestamp


class WaterOutput(BaseModel):
    id: str
    volume_ml: Volume
    occurred_at: str
    revision: int
    created_at: str
    updated_at: str
    deleted_at: str | None


def water_output(record: WaterRecord) -> WaterOutput:
    return WaterOutput(**record.model_dump(exclude={"occurred_at", "created_at", "updated_at", "deleted_at"}),
                       occurred_at=timestamp(record.occurred_at), created_at=timestamp(record.created_at),
                       updated_at=timestamp(record.updated_at), deleted_at=timestamp(record.deleted_at) if record.deleted_at is not None else None)


@dataclass
class WaterUseCases:
    get: GetWater
    settings: GetWaterSettings
    create: CreateWater
    edit: EditWater
    delete: DeleteWater
    restore: RestoreWater
    edit_settings: EditWaterSettings


def register_water(app: FastAPI, cases: WaterUseCases, clock: Callable[[], int]) -> None:
    @app.exception_handler(ApplicationError)
    async def application_error(_: Request, error: ApplicationError) -> JSONResponse:
        status = {"not_found": 404, "unavailable": 503}.get(error.code, 409)
        return JSONResponse(ErrorOutput(code=error.code, message=str(error), field=error.field).model_dump(), status_code=status)

    @app.get("/api/water-settings", response_model=WaterSettingsOutput)
    def read_settings() -> WaterSettingsOutput:
        return cases.settings.execute()

    @app.put("/api/water-settings", response_model=ReceiptOutput)
    def edit_settings(payload: WaterSettingsInput) -> ReceiptOutput:
        result = cases.edit_settings.execute(payload)
        return receipt_output(result.receipt, result.replayed, clock())

    @app.get("/api/water/{water_id}", response_model=WaterOutput)
    def read_water(water_id: UUID) -> WaterOutput:
        return water_output(cases.get.execute(WaterQuery(water_id=str(water_id))))

    @app.post("/api/water", response_model=ReceiptOutput)
    def create_water(payload: WaterInput) -> ReceiptOutput:
        result = cases.create.execute(payload)
        return receipt_output(result.receipt, result.replayed, clock())

    @app.put("/api/water/{water_id}", response_model=ReceiptOutput)
    def edit_water(water_id: UUID, payload: EditWaterInput) -> ReceiptOutput:
        result = cases.edit.execute(EditWaterCommand(**payload.model_dump(), water_id=str(water_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/water/{water_id}/delete", response_model=ReceiptOutput)
    def delete_water(water_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.delete.execute(WaterRevisionCommand(**payload.model_dump(), water_id=str(water_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/water/{water_id}/restore", response_model=ReceiptOutput)
    def restore_water(water_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.restore.execute(WaterRevisionCommand(**payload.model_dump(), water_id=str(water_id)))
        return receipt_output(result.receipt, result.replayed, clock())
