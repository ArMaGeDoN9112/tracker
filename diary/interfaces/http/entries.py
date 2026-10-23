from dataclasses import dataclass
from datetime import date
from typing import Callable
from uuid import UUID

from fastapi import FastAPI
from pydantic import BaseModel, Field

from diary.application.entries import (
    CreateEntry, DayQuery, DeleteEntry, EditEntry, EditEntryCommand, EditEntryInput,
    EntryInput, EntryQuery, EntryRevisionCommand, GetDay, GetEntry,
    GetEntryForm, GetMoscowTime, MoscowTimeQuery, RestoreEntry,
)
from diary.application.operations import RevisionInput
from diary.domain.entries import EntryRecord, Reason
from diary.domain.precision import decimal_string
from diary.domain.time import milliseconds
from diary.dto import EntryFormOutput, MoscowTimeOutput
from diary.interfaces.http.outputs import ReceiptOutput, receipt_output, timestamp


class EntryOutput(BaseModel):
    id: UUID
    occurred_at: str = Field(json_schema_extra={"format": "date-time"})
    glucose: str | None = Field(pattern=r"^[0-9]+\.[0-9]$")
    bolus: str = Field(pattern=r"^[0-9]+\.[0-9]$")
    reason: Reason | None
    comment: str
    created_at: str = Field(json_schema_extra={"format": "date-time"})
    updated_at: str = Field(json_schema_extra={"format": "date-time"})
    revision: int
    deleted_at: str | None
    basal: str | None


class DayOutput(BaseModel):
    day: date
    basal: str | None
    entries: list[EntryOutput]
    basal_changes: list["BasalChangeOutput"]
    temporary_basals: list["TemporaryBasalOutput"]
    temporary_percent: int | None


class TemporaryBasalOutput(BaseModel):
    id: UUID
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    ends_at: str = Field(json_schema_extra={"format": "date-time"})
    effective_ends_at: str = Field(json_schema_extra={"format": "date-time"})
    duration_minutes: int
    percent: int
    created_at: str = Field(json_schema_extra={"format": "date-time"})
    updated_at: str = Field(json_schema_extra={"format": "date-time"})
    revision: int
    deleted_at: str | None


class BasalChangeOutput(BaseModel):
    occurred_at: str = Field(json_schema_extra={"format": "date-time"})
    basal: str | None


def entry_output(row: EntryRecord, basal: str | None) -> EntryOutput:
    return EntryOutput(
        id=UUID(row.id), glucose=decimal_string(row.glucose) if row.glucose is not None else None,
        bolus=decimal_string(row.bolus), reason=row.reason, comment=row.comment,
        occurred_at=timestamp(row.occurred_at), created_at=timestamp(row.created_at),
        updated_at=timestamp(row.updated_at), revision=row.revision,
        deleted_at=timestamp(row.deleted_at) if row.deleted_at is not None else None, basal=basal,
    )


@dataclass
class EntryUseCases:
    create: CreateEntry
    edit: EditEntry
    delete: DeleteEntry
    restore: RestoreEntry
    get: GetEntry
    day: GetDay
    form: GetEntryForm
    moscow_time: GetMoscowTime


def register_entries(app: FastAPI, cases: EntryUseCases, clock: Callable[[], int]) -> None:
    from diary.interfaces.http.basal import temporary_output

    @app.get("/api/entry-form")
    def entry_form() -> EntryFormOutput:
        result = cases.form.execute()
        return EntryFormOutput(local_time=result.local_time.isoformat(timespec="minutes")[:16], basal=result.basal)

    @app.get("/api/moscow-time", response_model=MoscowTimeOutput)
    def moscow_time(local_time: str) -> MoscowTimeOutput:
        result = cases.moscow_time.execute(MoscowTimeQuery(local_time=local_time))
        # Pre-1919 offsets include seconds, which RFC 3339 cannot express.
        return MoscowTimeOutput(candidates=sorted({
            timestamp(milliseconds(instant)) if len(instant.isoformat()) > 25 else instant.isoformat()
            for instant in result.candidates
        }))

    @app.post("/api/entries", response_model=ReceiptOutput)
    def create_entry(payload: EntryInput) -> ReceiptOutput:
        result = cases.create.execute(payload)
        return receipt_output(result.receipt, result.replayed, clock())

    @app.put("/api/entries/{entry_id}", response_model=ReceiptOutput)
    def edit_entry(entry_id: UUID, payload: EditEntryInput) -> ReceiptOutput:
        result = cases.edit.execute(EditEntryCommand(**payload.model_dump(), entry_id=str(entry_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/entries/{entry_id}/delete", response_model=ReceiptOutput)
    def delete_entry(entry_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.delete.execute(EntryRevisionCommand(**payload.model_dump(), entry_id=str(entry_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.post("/api/entries/{entry_id}/restore", response_model=ReceiptOutput)
    def restore_entry(entry_id: UUID, payload: RevisionInput) -> ReceiptOutput:
        result = cases.restore.execute(EntryRevisionCommand(**payload.model_dump(), entry_id=str(entry_id)))
        return receipt_output(result.receipt, result.replayed, clock())

    @app.get("/api/entries/{entry_id}", response_model=EntryOutput)
    def read_entry(entry_id: UUID) -> EntryOutput:
        result = cases.get.execute(EntryQuery(entry_id=str(entry_id)))
        return entry_output(result.record, result.basal)

    @app.get("/api/day", response_model=DayOutput)
    def read_day(day: date) -> DayOutput:
        result = cases.day.execute(DayQuery(day=day))
        return DayOutput(
            day=result.day, basal=result.basal,
            entries=[entry_output(row.record, row.basal) for row in result.entries],
            basal_changes=[BasalChangeOutput(occurred_at=timestamp(row.occurred_at), basal=row.basal)
                           for row in result.basal_changes],
            temporary_basals=[temporary_output(row) for row in result.temporary_basals],
            temporary_percent=result.temporary_percent,
        )


