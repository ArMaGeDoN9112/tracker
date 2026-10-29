from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from diary.application.export import ExportData
from diary.application.basal import IntervalInput
from diary.interfaces.http.basal import ScheduleOutput, temporary_output
from diary.domain.entries import Reason
from diary.domain.precision import rate_string
from diary.interfaces.http.entries import entry_output
from diary.interfaces.http.outputs import timestamp
from diary.interfaces.http.meals import MealLineOutput, MealOutput, meal_output
from diary.interfaces.http.products import ProductOutput, product_output
from diary.application.water import WaterSettingsInput, WaterSettingsOutput
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
    schema_version: Literal[4] = 4
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


def full_export(data: ExportData) -> FullExport:
    versions = data.schedules
    return FullExport(
        exported_at=timestamp(data.exported_at),
        settings=ExportSettings(water=ExportWaterSettings.model_validate(data.settings.model_dump())),
        account=ExportAccount(id=data.account.id, login=data.account.login, created_at=timestamp(data.account.created_at)),
        products=[ExportProduct.model_validate(product_output(result).model_dump()) for result in data.products],
        meals=[ExportMeal.model_validate(meal_output(result.record, result.lines).model_dump()) for result in data.meals],
        water=[ExportWater.model_validate(water_output(record).model_dump()) for record in data.water],
        entries=[ExportEntry(**entry_output(record, None).model_dump(exclude={"basal"})) for record in data.entries],
        basal_schedules=[ScheduleOutput(
            id=UUID(version.id), starts_at=timestamp(version.starts_at), created_at=timestamp(version.created_at),
            ends_at=timestamp(versions[index + 1].starts_at) if index + 1 < len(versions) else None,
            intervals=[IntervalInput(minute=interval.minute, rate=rate_string(interval.rate)) for interval in version.intervals],
        ) for index, version in enumerate(versions)],
        temporary_basals=[ExportTemporary(**(temporary_output(record).model_dump() | {
            "effective_ends_at": timestamp(record.effective_ends_at) if record.deleted_at is None else None,
        })) for record in data.temporary],
    )
