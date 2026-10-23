from uuid import uuid4

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
