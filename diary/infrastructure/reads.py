from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy import Connection, Engine, select
from sqlalchemy.exc import SQLAlchemyError

from diary.application.errors import Unavailable
from diary.application.meals import MealResult
from diary.application.reads import GlucoseMeasurement, NutritionLine
from diary.domain.nutrition import MealRecord
from diary.domain.water import WaterRecord
from diary.infrastructure.nutrition import meal_lines
from diary.infrastructure.water import SqliteWater
from diary.tables import entry, meal, meal_line


@dataclass
class SqliteReads:
    connection: Connection

    def glucose(self, start: int, end: int) -> list[GlucoseMeasurement]:
        return [GlucoseMeasurement.model_validate(row) for row in self.connection.execute(
            select(entry.c.occurred_at, entry.c.glucose).where(
                entry.c.deleted_at.is_(None), entry.c.glucose.is_not(None),
                entry.c.occurred_at >= start, entry.c.occurred_at < end)).mappings()]

    def water(self, start: int, end: int) -> list[WaterRecord]:
        return SqliteWater(self.connection).day(start, end)

    def lines(self, start: int, end: int) -> list[NutritionLine]:
        return [NutritionLine.model_validate(row) for row in self.connection.execute(
            select(meal_line, meal.c.occurred_at).join(meal, meal_line.c.meal_id == meal.c.id).where(
                meal.c.deleted_at.is_(None), meal.c.occurred_at >= start, meal.c.occurred_at < end)).mappings()]

    def meals(self, start: int, end: int) -> list[MealResult]:
        records = [MealRecord.model_validate(row) for row in self.connection.execute(select(meal).where(
            meal.c.deleted_at.is_(None), meal.c.occurred_at >= start, meal.c.occurred_at < end
        ).order_by(meal.c.occurred_at, meal.c.created_at, meal.c.id)).mappings()]
        return [MealResult(record=record, lines=meal_lines(self.connection, record.id)) for record in records]


@contextmanager
def read_uow(engine: Engine) -> Generator[SqliteReads]:
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            yield SqliteReads(connection)
    except SQLAlchemyError as error:
        raise Unavailable() from error
