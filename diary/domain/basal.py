from datetime import UTC, timedelta

from pydantic import BaseModel

from diary.domain.precision import rate_string
from diary.domain.time import EPOCH, MOSCOW, milliseconds


class BasalInterval(BaseModel):
    minute: int
    rate: int


class BasalSchedule(BaseModel):
    id: str
    starts_at: int
    created_at: int
    intervals: list[BasalInterval]


class TemporaryBasalPeriod(BaseModel):
    id: str
    starts_at: int
    ends_at: int
    effective_ends_at: int
    duration_minutes: int
    percent: int
    created_at: int
    updated_at: int
    revision: int
    deleted_at: int | None


class BasalChange(BaseModel):
    occurred_at: int
    basal: str | None


def effective_periods(periods: list[TemporaryBasalPeriod]) -> list[TemporaryBasalPeriod]:
    return [row.model_copy(update={
        "effective_ends_at": min(row.ends_at, periods[index + 1].starts_at)
        if index + 1 < len(periods) else row.ends_at,
    }) for index, row in enumerate(periods)]


def basal_at(versions: list[BasalSchedule], instant: int, temporary: list[TemporaryBasalPeriod]) -> str | None:
    version = next((version for version in reversed(versions) if version.starts_at <= instant), None)
    if version is None:
        return None
    local = (EPOCH + timedelta(milliseconds=instant)).astimezone(MOSCOW)
    minute = local.hour * 60 + local.minute
    interval = next(interval for interval in reversed(version.intervals) if interval.minute <= minute)
    period = next((row for row in reversed(temporary) if row.starts_at <= instant < row.effective_ends_at), None)
    return rate_string((interval.rate * period.percent + 50) // 100 if period else interval.rate)


def basal_changes(versions: list[BasalSchedule], start: int, end: int, temporary: list[TemporaryBasalPeriod]) -> list[BasalChange]:
    day = (EPOCH + timedelta(milliseconds=start)).astimezone(MOSCOW).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    boundaries = {version.starts_at for version in versions if start < version.starts_at < end}
    temporary_boundaries = {instant for row in temporary for instant in (row.starts_at, row.effective_ends_at) if start < instant < end}
    boundaries.update(temporary_boundaries)
    for version in versions:
        for interval in version.intervals:
            local = day + timedelta(minutes=interval.minute)
            for fold in (0, 1):
                candidate = local.replace(tzinfo=MOSCOW, fold=fold)
                if candidate.astimezone(UTC).astimezone(MOSCOW).replace(tzinfo=None) == local:
                    instant = milliseconds(candidate)
                    if start < instant < end:
                        boundaries.add(instant)
    # A clock rollback can select an earlier interval without crossing its start.
    cursor = start
    while cursor < end:
        next_cursor = min(cursor + 3600000, end)
        offset = (EPOCH + timedelta(milliseconds=cursor)).astimezone(MOSCOW).utcoffset()
        if (EPOCH + timedelta(milliseconds=next_cursor)).astimezone(MOSCOW).utcoffset() != offset:
            low, high = cursor, next_cursor
            while high - low > 1:
                middle = (low + high) // 2
                if (EPOCH + timedelta(milliseconds=middle)).astimezone(MOSCOW).utcoffset() == offset:
                    low = middle
                else:
                    high = middle
            if start < high < end:
                boundaries.add(high)
        cursor = next_cursor
    return [BasalChange(occurred_at=instant, basal=basal_at(versions, instant, temporary)) for instant in sorted(boundaries)
            if instant in temporary_boundaries or basal_at(versions, instant, temporary) != basal_at(versions, instant - 1, temporary)]
