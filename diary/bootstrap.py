from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

if TYPE_CHECKING:
    from diary.application.backup import RunBackup
    from diary.infrastructure.backup import FileBackupStorage

from fastapi import FastAPI
from sqlalchemy import Engine

from diary.application.water import (
    CreateWater, DeleteWater, EditWater, EditWaterSettings, GetWater,
    GetWaterSettings, RestoreWater, WaterOperations,
)
from diary.infrastructure.water import water_uow
from diary.interfaces.http.water import WaterUseCases, register_water
from diary.security import now_ms
from diary.application.basal import (
    BasalOperations, CreateSchedule, CreateTemporaryBasal, DeleteTemporaryBasal,
    EditTemporaryBasal, GetBasal, GetSchedules, GetTemporaryBasal, GetTemporaryBasals,
    RestoreTemporaryBasal,
)
from diary.application.entries import (
    CreateEntry, DeleteEntry, EditEntry, EntryOperations, GetDay, GetEntry,
    GetEntryForm, GetMoscowTime, RestoreEntry,
)
from diary.infrastructure.diary import diary_uow
from diary.interfaces.http.entries import EntryUseCases, register_entries
from diary.interfaces.http.basal import BasalUseCases, register_basal


def register_water_http(app: FastAPI, engine: Engine) -> None:
    operations = WaterOperations(lambda: water_uow(engine, write=True), lambda: now_ms(), lambda: str(uuid4()))
    cases = WaterUseCases(
        get=GetWater(lambda: water_uow(engine)), settings=GetWaterSettings(lambda: water_uow(engine)),
        create=CreateWater(operations), edit=EditWater(operations), delete=DeleteWater(operations),
        restore=RestoreWater(operations), edit_settings=EditWaterSettings(operations),
    )
    register_water(app, cases, lambda: now_ms())


def register_diary_http(app: FastAPI, engine: Engine) -> None:
    reads = lambda: diary_uow(engine)
    writes = lambda: diary_uow(engine, write=True)
    clock = lambda: now_ms()
    new_id = lambda: str(uuid4())
    entries = EntryOperations(writes, clock, new_id)
    basal = BasalOperations(writes, clock, new_id)
    register_entries(app, EntryUseCases(
        create=CreateEntry(entries), edit=EditEntry(entries), delete=DeleteEntry(entries),
        restore=RestoreEntry(entries), get=GetEntry(reads), day=GetDay(reads),
        form=GetEntryForm(reads, clock), moscow_time=GetMoscowTime(),
    ), clock)
    register_basal(app, BasalUseCases(
        schedules=GetSchedules(reads), basal=GetBasal(reads), temporary=GetTemporaryBasals(reads),
        get_temporary=GetTemporaryBasal(reads), create_schedule=CreateSchedule(basal),
        create_temporary=CreateTemporaryBasal(basal), edit_temporary=EditTemporaryBasal(basal),
        delete_temporary=DeleteTemporaryBasal(basal), restore_temporary=RestoreTemporaryBasal(basal),
    ), clock)


def register_nutrition_http(app: FastAPI, engine: Engine) -> None:
    from diary.application.products import CreateProduct, EditProduct, GetProduct, GetProducts, ProductOperations
    from diary.application.meals import (
        CreateMeal, DeleteMeal, EditMeal, GetMeal, MealOperations, PreviewMealProduct, RepeatMeal, RestoreMeal,
    )
    from diary.infrastructure.nutrition import nutrition_uow
    from diary.interfaces.http.products import ProductUseCases, register_products
    from diary.interfaces.http.meals import MealUseCases, register_meals

    reads = lambda: nutrition_uow(engine)
    writes = lambda: nutrition_uow(engine, write=True)
    clock = lambda: now_ms()
    new_id = lambda: str(uuid4())
    products = ProductOperations(writes, clock, new_id)
    meals = MealOperations(writes, clock, new_id)
    register_products(app, ProductUseCases(
        get=GetProduct(reads), list=GetProducts(reads), create=CreateProduct(products), edit=EditProduct(products),
    ), clock)
    register_meals(app, MealUseCases(
        get=GetMeal(reads), repeat=RepeatMeal(reads, clock, new_id), preview=PreviewMealProduct(),
        create=CreateMeal(meals), edit=EditMeal(meals), delete=DeleteMeal(meals), restore=RestoreMeal(meals),
    ), clock)


def register_reads_http(app: FastAPI, engine: Engine) -> None:
    from diary.application.reads import GetGlucoseSummary, GetNutritionDay, GetNutritionSummary
    from diary.infrastructure.reads import read_uow
    from diary.interfaces.http.reads import ReadUseCases, register_reads

    reads = lambda: read_uow(engine)
    clock = lambda: now_ms()
    register_reads(app, ReadUseCases(
        glucose=GetGlucoseSummary(reads, clock), nutrition=GetNutritionSummary(reads, clock),
        nutrition_day=GetNutritionDay(reads),
    ))


def register_export_http(app: FastAPI, engine: Engine) -> None:
    from diary.application.export import ExportDiary
    from diary.infrastructure.export import export_uow
    from diary.interfaces.http.export import register_export

    clock = lambda: now_ms()
    register_export(app, ExportDiary(lambda: export_uow(engine), clock), clock)


def backup_storage(database: "Path") -> "FileBackupStorage":
    import os
    from diary.application.export import ExportData
    from diary.infrastructure.backup import FileBackupStorage
    from diary.interfaces.export import full_export

    def validate(data: ExportData) -> None:
        full_export(data)

    repository = os.environ.get("RESTIC_REPOSITORY", "")
    return FileBackupStorage(database, validate, repository.startswith(("s3:", "sftp:", "rest:", "rclone:", "azure:", "gs:", "b2:")))


def backup_runner(database: "Path") -> "RunBackup":
    import time
    from datetime import datetime, timezone
    from diary.application.backup import RunBackup

    return RunBackup(backup_storage(database), lambda: datetime.now(timezone.utc), time.monotonic)


def register_backup_status_http(app: FastAPI, database: "Path") -> None:
    from datetime import datetime, timezone
    from diary.application.backup import GetBackupStatus
    from diary.interfaces.http.backup import register_backup_status

    register_backup_status(app, GetBackupStatus(backup_storage(database), lambda: datetime.now(timezone.utc)))
