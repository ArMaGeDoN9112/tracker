import json
from typing import Annotated, Literal
from uuid import UUID

from fastapi import FastAPI, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import Connection, Engine, select

from diary.application.basal import IntervalInput
from diary.interfaces.http.basal import ScheduleOutput, temporary_output
from diary.infrastructure.diary import schedules, temporary_basals
from diary.domain.basal import TemporaryBasalPeriod
from diary.domain.entries import EntryRecord, Reason
from diary.domain.nutrition import MealRecord
from diary.domain.precision import rate_string
from diary.domain.products import ProductRecord
from diary.interfaces.http.entries import entry_output
from diary.interfaces.http.outputs import timestamp
from diary.interfaces.http.meals import MealLineOutput, MealOutput, meal_output
from diary.infrastructure.nutrition import SqliteProducts, meal_lines
from diary.interfaces.http.products import ProductOutput, product_output
from diary.security import now_ms
from diary.tables import account, entry, meal, product, temporary_basal, water, water_settings
from diary.application.water import WaterSettingsInput, WaterSettingsOutput
from diary.domain.water import WaterRecord
from diary.interfaces.http.water import WaterOutput, water_output


Timestamp = Annotated[str, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$", json_schema_extra={"format": "date-time"})]
Identifier = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
NutritionValue = Annotated[str, Field(pattern=r"^[0-9]+\.[0-9]{2}$")]


class ExportWaterSettings(WaterSettingsOutput):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)

    @field_validator("volumes_ml")
    @classmethod
    def unique_volumes(cls, value: list[int]) -> list[int]:
        return WaterSettingsInput.unique_volumes(value)


class ExportAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int
    login: str
    created_at: Timestamp


class ExportSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timezone: Literal["Europe/Moscow"] = "Europe/Moscow"
    theme: Literal["dark"] = "dark"
    water: ExportWaterSettings


class ExportUnits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timestamps: Literal["RFC 3339 UTC, milliseconds"] = "RFC 3339 UTC, milliseconds"
    glucose: Literal["mmol/L"] = "mmol/L"
    bolus: Literal["U"] = "U"
    rate: Literal["U/h"] = "U/h"
    duration_minutes: Literal["minute"] = "minute"
    percent: Literal["percent"] = "percent"
    minute: Literal["minute of Moscow day"] = "minute of Moscow day"
    food_quantity: Literal["g or ml; see unit"] = "g or ml; see unit"
    nutrients: Literal["g per basis_quantity"] = "g per basis_quantity"
    calories: Literal["kcal per basis_quantity"] = "kcal per basis_quantity"
    water: Literal["integer ml"] = "integer ml"


class ExportProduct(ProductOutput):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    name: str = Field(min_length=1, max_length=200)
    protein: NutritionValue | None
    fat: NutritionValue | None
    carbohydrate: NutritionValue | None
    calories: NutritionValue | None
    revision: int = Field(ge=1)
    created_at: Timestamp
    updated_at: Timestamp


class ExportMeal(MealOutput):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    occurred_at: Timestamp
    revision: int = Field(ge=1)
    created_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None
    lines: list[MealLineOutput] = Field(min_length=1)


class ExportWater(WaterOutput):
    model_config = ConfigDict(extra="forbid")
    id: Identifier
    occurred_at: Timestamp
    revision: int = Field(ge=1)
    created_at: Timestamp
    updated_at: Timestamp
    deleted_at: Timestamp | None


class ExportEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    occurred_at: Timestamp
    glucose: str | None = Field(pattern=r"^[0-9]+\.[0-9]$")
    bolus: str = Field(pattern=r"^[0-9]+\.[0-9]$")
    reason: Reason | None
    comment: str
    created_at: Timestamp
    updated_at: Timestamp
    revision: int
    deleted_at: Timestamp | None


class ExportTemporary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    starts_at: Timestamp
    ends_at: Timestamp
    effective_ends_at: Timestamp | None
    duration_minutes: int
    percent: int
    created_at: Timestamp
    updated_at: Timestamp
    revision: int
    deleted_at: Timestamp | None


class FullExport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal[3] = 3
    exported_at: Timestamp
    timezone: Literal["Europe/Moscow"] = "Europe/Moscow"
    units: ExportUnits = ExportUnits()
    settings: ExportSettings
    account: ExportAccount
    entries: list[ExportEntry]
    basal_schedules: list[ScheduleOutput]
    temporary_basals: list[ExportTemporary]
    products: list[ExportProduct]
    meals: list[ExportMeal]
    water: list[ExportWater]


def full_export(connection: Connection) -> FullExport:
    owner = connection.execute(select(account.c.id, account.c.login, account.c.created_at)).mappings().one()
    exported_at = now_ms()
    settings = connection.execute(select(water_settings)).mappings().one()
    versions = schedules(connection)
    active = {row.id: row.effective_ends_at for row in temporary_basals(connection)}
    return FullExport(
        exported_at=timestamp(exported_at),
        settings=ExportSettings(water=ExportWaterSettings(
            volumes_ml=json.loads(settings["volumes_ml"]), revision=settings["revision"])),
        products=[ExportProduct.model_validate(product_output(SqliteProducts(connection).result(ProductRecord.model_validate(row))).model_dump())
                  for row in connection.execute(select(product).order_by(product.c.created_at, product.c.id)).mappings()],
        meals=[ExportMeal.model_validate(meal_output(MealRecord.model_validate(row), meal_lines(connection, row["id"])).model_dump())
               for row in connection.execute(select(meal).order_by(meal.c.occurred_at, meal.c.created_at, meal.c.id)).mappings()],
        water=[ExportWater.model_validate(water_output(WaterRecord.model_validate(row)).model_dump())
               for row in connection.execute(select(water).order_by(water.c.occurred_at, water.c.created_at, water.c.id)).mappings()],
        account=ExportAccount(id=owner["id"], login=owner["login"], created_at=timestamp(owner["created_at"])),
        entries=[ExportEntry(**entry_output(EntryRecord.model_validate(row), None).model_dump(exclude={"basal"})) for row in connection.execute(
            select(entry).order_by(entry.c.occurred_at, entry.c.created_at, entry.c.id)).mappings()],
        basal_schedules=[ScheduleOutput(
            id=UUID(version.id), starts_at=timestamp(version.starts_at), created_at=timestamp(version.created_at),
            ends_at=timestamp(versions[index + 1].starts_at) if index + 1 < len(versions) else None,
            intervals=[IntervalInput(minute=interval.minute, rate=rate_string(interval.rate)) for interval in version.intervals],
        ) for index, version in enumerate(versions)],
        temporary_basals=[ExportTemporary(
            **(temporary_output(TemporaryBasalPeriod(**row, effective_ends_at=active.get(row["id"], row["ends_at"]))).model_dump()
               | {"effective_ends_at": timestamp(active[row["id"]]) if row["id"] in active else None}),
        ) for row in connection.execute(select(temporary_basal).order_by(
            temporary_basal.c.starts_at, temporary_basal.c.created_at, temporary_basal.c.id)).mappings()],
    )


def register_export(app: FastAPI, engine: Engine) -> None:
    @app.get("/api/export", response_class=Response)
    def download() -> Response:
        with engine.connect() as connection:
            # Explicit BEGIN keeps all SELECTs in one SQLite snapshot, including in legacy mode.
            connection.exec_driver_sql("BEGIN")
            result = full_export(connection)
        return Response(result.model_dump_json(indent=2), media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="diabetes-diary-{now_ms()}.json"',
        })
