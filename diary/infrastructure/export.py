from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
import json

from sqlalchemy import Connection, Engine, select
from sqlalchemy.exc import SQLAlchemyError

from diary.application.errors import Unavailable
from diary.application.export import ExportAccountRecord, ExportData
from diary.application.water import WaterSettingsOutput
from diary.application.meals import MealResult
from diary.domain.basal import TemporaryBasalPeriod
from diary.domain.entries import EntryRecord
from diary.domain.nutrition import MealRecord
from diary.domain.water import WaterRecord
from diary.infrastructure.diary import schedules, temporary_basals
from diary.infrastructure.nutrition import SqliteProducts, meal_lines
from diary.tables import account, entry, meal, temporary_basal, water, water_settings


@dataclass
class SqliteExport:
    connection: Connection

    def read(self) -> ExportData:
        owner = self.connection.execute(select(account.c.id, account.c.login, account.c.created_at)).mappings().one()
        settings = self.connection.execute(select(water_settings)).mappings().one()
        active = {row.id: row.effective_ends_at for row in temporary_basals(self.connection)}
        return ExportData(
            account=ExportAccountRecord.model_validate(owner),
            settings=WaterSettingsOutput(volumes_ml=json.loads(settings["volumes_ml"]), revision=settings["revision"]),
            schedules=schedules(self.connection),
            products=SqliteProducts(self.connection).all(),
            meals=[MealResult(record=MealRecord.model_validate(row), lines=meal_lines(self.connection, row["id"]))
                   for row in self.connection.execute(select(meal).order_by(meal.c.occurred_at, meal.c.created_at, meal.c.id)).mappings()],
            entries=[EntryRecord.model_validate(row) for row in self.connection.execute(
                select(entry).order_by(entry.c.occurred_at, entry.c.created_at, entry.c.id)).mappings()],
            temporary=[TemporaryBasalPeriod(**row, effective_ends_at=active.get(row["id"], row["ends_at"]))
                       for row in self.connection.execute(select(temporary_basal).order_by(
                           temporary_basal.c.starts_at, temporary_basal.c.created_at, temporary_basal.c.id)).mappings()],
            water=[WaterRecord.model_validate(row) for row in self.connection.execute(
                select(water).order_by(water.c.occurred_at, water.c.created_at, water.c.id)).mappings()],
        )


@contextmanager
def export_uow(engine: Engine) -> Generator[SqliteExport]:
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            yield SqliteExport(connection)
    except SQLAlchemyError as error:
        raise Unavailable() from error
