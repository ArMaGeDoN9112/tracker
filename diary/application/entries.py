import re
from datetime import datetime, timedelta

from pydantic import Field, field_validator, model_validator

from diary.application.operations import OperationInput, RevisionInput
from diary.domain.entries import Reason
from diary.domain.precision import decimal_string, tenths
from diary.domain.time import EPOCH, MOSCOW, milliseconds


class EntryInput(OperationInput):
    occurred_at: str = Field(json_schema_extra={"format": "date-time"}, description="RFC 3339 с явным смещением; точность до миллисекунд")
    glucose: str | None = Field(default=None, max_length=10000, description="Положительное десятичное число, до 214748364.7; точка или запятая, десятые без скрытого округления; завершающие нули допустимы")
    bolus: str = Field(default="0.0", max_length=10000, description="От 0 до 214748364.7, точность до десятых, точка или запятая; пустая строка равна нулю")
    reason: Reason | None = None
    comment: str = Field(default="", max_length=10000)

    @field_validator("occurred_at")
    @classmethod
    def event_time(cls, value: str) -> str:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])", value):
            raise ValueError("Нужна дата RFC 3339 со смещением и точностью до миллисекунд.")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            # Ensure both UTC and the calendar display can represent the instant.
            parsed.astimezone(MOSCOW)
            return (EPOCH + timedelta(milliseconds=milliseconds(parsed))).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except OverflowError as error:
            raise ValueError("Дата за пределами календаря.") from error

    @field_validator("glucose")
    @classmethod
    def glucose_value(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        result = tenths(value)
        if result == 0:
            raise ValueError("Сахар должен быть положительным.")
        return decimal_string(result)

    @field_validator("bolus")
    @classmethod
    def bolus_value(cls, value: str) -> str:
        return decimal_string(tenths(value) if value.strip() else 0)

    @model_validator(mode="after")
    def meaningful(self) -> "EntryInput":
        if self.bolus == "0.0":
            self.reason = None
        if self.glucose is None and self.bolus == "0.0" and not self.comment.strip():
            raise ValueError("Укажите сахар, ненулевую подколку или комментарий.")
        return self


class EditEntryInput(EntryInput, RevisionInput):
    pass
