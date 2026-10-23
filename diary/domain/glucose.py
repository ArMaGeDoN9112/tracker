from pydantic import BaseModel

from diary.domain.precision import decimal_string


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
