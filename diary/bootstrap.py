from uuid import uuid4

from fastapi import FastAPI
from sqlalchemy import Connection, Engine

from diary.application.water import (
    CreateWater, DeleteWater, EditWater, EditWaterSettings, GetDayWater, GetWater,
    GetWaterSettings, RestoreWater, WaterOperations, WaterPeriod,
)
from diary.infrastructure.water import SqliteWater, water_uow
from diary.interfaces.http.water import WaterUseCases, WaterOutput, register_water, water_output
from diary.security import now_ms


def register_water_http(app: FastAPI, engine: Engine) -> None:
    operations = WaterOperations(lambda: water_uow(engine, write=True), lambda: now_ms(), lambda: str(uuid4()))
    cases = WaterUseCases(
        get=GetWater(lambda: water_uow(engine)), settings=GetWaterSettings(lambda: water_uow(engine)),
        create=CreateWater(operations), edit=EditWater(operations), delete=DeleteWater(operations),
        restore=RestoreWater(operations), edit_settings=EditWaterSettings(operations),
    )
    register_water(app, cases, lambda: now_ms())


def day_water(connection: Connection, start: int, end: int) -> list[WaterOutput]:
    # shortcut: nutrition-day owns the shared snapshot, move its UoW in stage 06.
    records = GetDayWater(SqliteWater(connection)).execute(WaterPeriod(start=start, end=end))
    return [water_output(record) for record in records]
