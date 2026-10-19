from datetime import date, datetime, time, timedelta
from enum import StrEnum

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import Engine, select

from diary.entries import EPOCH, MOSCOW, decimal_string, milliseconds
from diary.security import now_ms
from diary.tables import entry


class Period(StrEnum):
    WEEK = "week"
    MONTH = "month"
    CUSTOM = "custom"


class GlucoseDayOutput(BaseModel):
    day: date
    count: int
    average: str | None
    minimum: str | None
    maximum: str | None


class GlucoseSummaryOutput(BaseModel):
    start: date
    end: date
    count: int
    average: str | None
    days: list[GlucoseDayOutput]


class GlucoseTotals(BaseModel):
    total: int = 0
    count: int = 0
    minimum: int | None = None
    maximum: int | None = None

    def add(self, glucose: int) -> None:
        self.total += glucose
        self.count += 1
        self.minimum = glucose if self.minimum is None else min(self.minimum, glucose)
        self.maximum = glucose if self.maximum is None else max(self.maximum, glucose)

    def average(self) -> str | None:
        # Integer half-up in stored tenths, with no intermediate rounding.
        return decimal_string((2 * self.total + self.count) // (2 * self.count)) if self.count else None


def register_glucose(app: FastAPI, engine: Engine) -> None:
    from diary.app import failure

    @app.get("/api/glucose-summary", response_model=GlucoseSummaryOutput)
    def glucose_summary(period: Period = Period.WEEK, start: date | None = None,
                        end: date | None = None) -> GlucoseSummaryOutput | JSONResponse:
        end = end or (EPOCH + timedelta(milliseconds=now_ms())).astimezone(MOSCOW).date()
        try:
            if period != Period.CUSTOM:
                start = end - timedelta(days=6 if period == Period.WEEK else 29)
            if start is None or start > end:
                return failure("validation", "Укажите начало периода не позже окончания.", 422, "start")
            lower = milliseconds(datetime.combine(start, time(), MOSCOW))
            upper = milliseconds(datetime.combine(end + timedelta(days=1), time(), MOSCOW))
        except (ValueError, OverflowError):
            return failure("validation", "Границы периода за пределами календаря.", 422, "end")

        days = {date.fromordinal(ordinal): GlucoseTotals() for ordinal in range(start.toordinal(), end.toordinal() + 1)}
        totals = GlucoseTotals()
        with engine.connect() as connection:
            rows = connection.execute(select(entry.c.occurred_at, entry.c.glucose).where(
                entry.c.deleted_at.is_(None), entry.c.glucose.is_not(None),
                entry.c.occurred_at >= lower, entry.c.occurred_at < upper))
            for row in rows:
                day = (EPOCH + timedelta(milliseconds=row.occurred_at)).astimezone(MOSCOW).date()
                days[day].add(row.glucose)
                totals.add(row.glucose)
        return GlucoseSummaryOutput(start=start, end=end, count=totals.count, average=totals.average(), days=[
            GlucoseDayOutput(day=day, count=values.count, average=values.average(),
                             minimum=decimal_string(values.minimum) if values.minimum is not None else None,
                             maximum=decimal_string(values.maximum) if values.maximum is not None else None)
            for day, values in days.items()
        ])
