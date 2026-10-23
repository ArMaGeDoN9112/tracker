from pydantic import BaseModel


class ErrorOutput(BaseModel):
    code: str
    message: str
    field: str | None = None


class ScheduleConflictOutput(ErrorOutput):
    existing_id: str
    href: str


class CsrfOutput(BaseModel):
    csrf_token: str


class SessionOutput(BaseModel):
    login: str


class LoginOutput(SessionOutput, CsrfOutput):
    pass


class EntryFormOutput(BaseModel):
    local_time: str
    basal: str | None


class MoscowTimeOutput(BaseModel):
    candidates: list[str]
