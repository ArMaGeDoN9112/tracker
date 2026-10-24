from dataclasses import dataclass
from datetime import datetime
from typing import Callable
from uuid import UUID

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from diary.application.basal import (
    BasalQuery, CreateSchedule, CreateTemporaryBasal, DeleteTemporaryBasal,
    EditTemporaryBasal, EditTemporaryBasalInput, EditTemporaryCommand, GetBasal,
    GetSchedules, GetTemporaryBasal, GetTemporaryBasals, IntervalInput,
    RestoreTemporaryBasal, ScheduleConflict, ScheduleInput, TemporaryBasalInput,
    TemporaryQuery, TemporaryRevisionCommand,
)
from diary.application.entries import EntryInput
from diary.application.operations import RevisionInput
from diary.domain.basal import BasalSchedule, TemporaryBasalPeriod
from diary.domain.precision import rate_string
from diary.domain.time import milliseconds
from diary.interfaces.http.dto import ErrorOutput, ScheduleConflictOutput
from diary.interfaces.http.entries import TemporaryBasalOutput
from diary.interfaces.http.outputs import ReceiptOutput, receipt_output, timestamp


class ScheduleOutput(BaseModel):
    id: UUID
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    ends_at: str | None = Field(json_schema_extra={"format": "date-time"})
    created_at: str = Field(json_schema_extra={"format": "date-time"})
    intervals: list[IntervalInput]


class BasalOutput(BaseModel):
    basal: str | None = Field(pattern=r"^[0-9]+\.[0-9]{2}$", description="Скорость по расписанию в ед/ч, сотые; null до первой версии")


def temporary_output(row: TemporaryBasalPeriod) -> TemporaryBasalOutput:
    return TemporaryBasalOutput(
        id=UUID(row.id), starts_at=timestamp(row.starts_at), ends_at=timestamp(row.ends_at),
        effective_ends_at=timestamp(row.effective_ends_at), duration_minutes=row.duration_minutes, percent=row.percent,
        created_at=timestamp(row.created_at), updated_at=timestamp(row.updated_at), revision=row.revision,
        deleted_at=timestamp(row.deleted_at) if row.deleted_at is not None else None,
    )


def schedule_outputs(versions: list[BasalSchedule]) -> list[ScheduleOutput]:
    return [ScheduleOutput(
        id=UUID(version.id), starts_at=timestamp(version.starts_at), created_at=timestamp(version.created_at),
        ends_at=timestamp(versions[index + 1].starts_at) if index + 1 < len(versions) else None,
        intervals=[IntervalInput(minute=row.minute, rate=rate_string(row.rate)) for row in version.intervals],
    ) for index, version in enumerate(versions)]


@dataclass
class BasalUseCases:
    schedules: GetSchedules
    basal: GetBasal
    temporary: GetTemporaryBasals
    get_temporary: GetTemporaryBasal
    create_schedule: CreateSchedule
    create_temporary: CreateTemporaryBasal
    edit_temporary: EditTemporaryBasal
    delete_temporary: DeleteTemporaryBasal
    restore_temporary: RestoreTemporaryBasal


def register_basal(app: FastAPI, cases: BasalUseCases, clock: Callable[[], int]) -> None:
    @app.get("/api/basal-schedules", response_model=list[ScheduleOutput])
    def history() -> list[ScheduleOutput]:
        return schedule_outputs(cases.schedules.execute())

    @app.get("/api/basal", response_model=BasalOutput)
    def read_basal(at: str = Query(description="RFC 3339 с явным смещением, точность до миллисекунд", json_schema_extra={"format": "date-time"})) -> BasalOutput | JSONResponse:
        try:
            instant = milliseconds(datetime.fromisoformat(EntryInput.event_time(at)))
        except ValueError:
            return JSONResponse(ErrorOutput(code="validation", message="Укажите дату RFC 3339 с явным смещением.", field="at").model_dump(), status_code=422)
        return BasalOutput(basal=cases.basal.execute(BasalQuery(instant=instant)))

    @app.get("/api/temporary-basals", response_model=list[TemporaryBasalOutput])
    def temporary_history() -> list[TemporaryBasalOutput]:
        return [temporary_output(row) for row in cases.temporary.execute()]

    @app.get("/api/temporary-basals/{period_id}", response_model=TemporaryBasalOutput)
    def read_temporary(period_id: UUID) -> TemporaryBasalOutput:
        return temporary_output(cases.get_temporary.execute(TemporaryQuery(period_id=str(period_id))))

    @app.put("/api/temporary-basals/{period_id}", response_model=ReceiptOutput)
    def edit_temporary(period_id: UUID, payload: EditTemporaryBasalInput) -> ReceiptOutput:
        result = cases.edit_temporary.execute(EditTemporaryCommand(**payload.model_dump(), period_id=str(period_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/temporary-basals/{period_id}/delete", response_model=ReceiptOutput)
    def delete_temporary(period_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.delete_temporary.execute(TemporaryRevisionCommand(**payload.model_dump(), period_id=str(period_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/temporary-basals/{period_id}/restore", response_model=ReceiptOutput)
    def restore_temporary(period_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.restore_temporary.execute(TemporaryRevisionCommand(**payload.model_dump(), period_id=str(period_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/temporary-basals", response_model=ReceiptOutput)
    def create_temporary(payload: TemporaryBasalInput) -> ReceiptOutput:
        result = cases.create_temporary.execute(payload)
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/basal-schedules", response_model=ReceiptOutput)
    def create_schedule(payload: ScheduleInput) -> ReceiptOutput | JSONResponse:
        try:
            result = cases.create_schedule.execute(payload)
        except ScheduleConflict as error:
            return JSONResponse(ScheduleConflictOutput(
                code=error.code, message=str(error), field=error.field,
                existing_id=error.existing_id, href=f"#schedule-{error.existing_id}",
            ).model_dump(mode="json"), status_code=409)
        return receipt_output(result.receipt, result.replayed, clock())


