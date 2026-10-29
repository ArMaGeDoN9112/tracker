from pydantic import BaseModel

from diary.application.access import SessionOutput as SessionOutput


class ErrorOutput(BaseModel):
    code: str
    message: str
    field: str | None = None


class ScheduleConflictOutput(ErrorOutput):
    existing_id: str
    href: str


class CsrfOutput(BaseModel):
    csrf_token: str


class LoginOutput(SessionOutput, CsrfOutput):
    pass


class EntryFormOutput(BaseModel):
    latest_glucose_at: str | None
    local_time: str
    basal: str | None


class MoscowTimeOutput(BaseModel):
    candidates: list[str]
