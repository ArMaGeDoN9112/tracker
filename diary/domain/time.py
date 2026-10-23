from datetime import UTC, datetime
from zoneinfo import ZoneInfo


MOSCOW = ZoneInfo("Europe/Moscow")
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def milliseconds(value: datetime) -> int:
    delta = value.astimezone(UTC) - EPOCH
    return delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
