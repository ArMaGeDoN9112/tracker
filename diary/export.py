from typing import Annotated, Literal
from uuid import UUID

from fastapi import FastAPI, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Engine, select

from diary.basal import IntervalInput, ScheduleOutput, rate_string, schedules, temporary_basals, temporary_output
from diary.dto import EntryRecord, Reason, TemporaryBasalPeriod
from diary.entries import entry_output, timestamp
from diary.security import now_ms
from diary.tables import account, entry, temporary_basal


Timestamp = Annotated[str, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$", json_schema_extra={"format": "date-time"})]


class ExportAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: int
    login: str
    created_at: Timestamp


class ExportSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timezone: Literal["Europe/Moscow"] = "Europe/Moscow"
    theme: Literal["dark"] = "dark"


class ExportUnits(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timestamps: Literal["RFC 3339 UTC, milliseconds"] = "RFC 3339 UTC, milliseconds"
    glucose: Literal["mmol/L"] = "mmol/L"
    bolus: Literal["U"] = "U"
    rate: Literal["U/h"] = "U/h"
    duration_minutes: Literal["minute"] = "minute"
    percent: Literal["percent"] = "percent"
    minute: Literal["minute of Moscow day"] = "minute of Moscow day"


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
    schema_version: Literal[1] = 1
    exported_at: Timestamp
    timezone: Literal["Europe/Moscow"] = "Europe/Moscow"
    units: ExportUnits = ExportUnits()
    settings: ExportSettings = ExportSettings()
    account: ExportAccount
    entries: list[ExportEntry]
    basal_schedules: list[ScheduleOutput]
    temporary_basals: list[ExportTemporary]


def register_export(app: FastAPI, engine: Engine) -> None:
    @app.get("/api/export", response_class=Response)
    def download() -> Response:
        with engine.connect() as connection:
            # Explicit BEGIN keeps all SELECTs in one SQLite snapshot, including in legacy mode.
            connection.exec_driver_sql("BEGIN")
            owner = connection.execute(select(account.c.id, account.c.login, account.c.created_at)).mappings().one()
            exported_at = now_ms()
            versions = schedules(connection)
            active = {row.id: row.effective_ends_at for row in temporary_basals(connection)}
            result = FullExport(
                exported_at=timestamp(exported_at),
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
        return Response(result.model_dump_json(indent=2), media_type="application/json", headers={
            "Content-Disposition": f'attachment; filename="diabetes-diary-{exported_at}.json"',
        })
