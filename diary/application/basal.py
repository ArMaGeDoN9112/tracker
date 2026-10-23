from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from diary.application.entries import EntryInput
from diary.application.operations import OperationInput, RevisionInput
from diary.domain.precision import hundredths, rate_string
from diary.domain.time import MOSCOW


class IntervalInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    minute: int = Field(ge=0, le=1439, description="Минута от московской полуночи")
    rate: str = Field(max_length=10000, description="От 0 до 21474836.47 ед/ч; сотые, точка или запятая; завершающие нули допустимы")

    @field_validator("rate")
    @classmethod
    def rate_value(cls, value: str) -> str:
        return rate_string(hundredths(value))


class ScheduleInput(OperationInput):
    starts_at: str = Field(json_schema_extra={"format": "date-time"}, description="RFC 3339 со смещением, до миллисекунд")
    intervals: list[IntervalInput] = Field(min_length=1, max_length=1440)

    @field_validator("starts_at")
    @classmethod
    def start_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @field_validator("intervals")
    @classmethod
    def ordered_intervals(cls, value: list[IntervalInput]) -> list[IntervalInput]:
        minutes = [interval.minute for interval in value]
        if minutes[0] != 0 or any(a >= b for a, b in zip(minutes, minutes[1:])):
            raise ValueError("Начните с 00:00; интервалы должны идти строго по возрастанию без повторов.")
        return value


class TemporaryBasalInput(OperationInput):
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    duration_minutes: int = Field(ge=1, le=2147483647)
    percent: int = Field(ge=0, le=2147483647)

    @field_validator("starts_at")
    @classmethod
    def start_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @model_validator(mode="after")
    def representable_end(self) -> "TemporaryBasalInput":
        try:
            end = datetime.fromisoformat(self.starts_at) + timedelta(minutes=self.duration_minutes)
            end.astimezone(MOSCOW)
        except (ValueError, OverflowError) as error:
            raise ValueError("Окончание за пределами календаря.") from error
        return self


class EditTemporaryBasalInput(RevisionInput):
    starts_at: str = Field(json_schema_extra={"format": "date-time"})
    ends_at: str = Field(json_schema_extra={"format": "date-time"})
    percent: int = Field(ge=0, le=2147483647)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def event_time(cls, value: str) -> str:
        return EntryInput.event_time(value)

    @model_validator(mode="after")
    def ordered_period(self) -> "EditTemporaryBasalInput":
        if self.ends_at < self.starts_at:
            raise ValueError("Окончание не может быть раньше начала.")
        return self
