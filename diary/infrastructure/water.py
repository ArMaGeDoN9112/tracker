import json
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy import Connection, Engine, insert, select, update
from sqlalchemy.exc import SQLAlchemyError

from diary.application.errors import Unavailable
from diary.application.operations import ReceiptRecord, ReceiptStore
from diary.application.water import WaterSettingsOutput, WaterStore, WaterUow
from diary.domain.water import WaterRecord
from diary.tables import operation_receipt, water, water_settings


@dataclass
class SqliteReceipts:
    connection: Connection

    def get(self, operation_id: str) -> ReceiptRecord | None:
        row = self.connection.execute(select(operation_receipt).where(
            operation_receipt.c.operation_id == operation_id)).mappings().first()
        return ReceiptRecord.model_validate(row) if row is not None else None

    def add(self, receipt: ReceiptRecord) -> None:
        self.connection.execute(insert(operation_receipt).values(receipt.model_dump()))


@dataclass
class SqliteWater:
    connection: Connection

    def get(self, water_id: str) -> WaterRecord | None:
        row = self.connection.execute(select(water).where(water.c.id == water_id)).mappings().first()
        return WaterRecord.model_validate(row) if row is not None else None

    def day(self, start: int, end: int) -> list[WaterRecord]:
        try:
            return [WaterRecord.model_validate(row) for row in self.connection.execute(select(water).where(
                water.c.deleted_at.is_(None), water.c.occurred_at >= start, water.c.occurred_at < end
            ).order_by(water.c.occurred_at, water.c.created_at, water.c.id)).mappings()]
        except SQLAlchemyError as error:
            raise Unavailable() from error

    def save(self, record: WaterRecord, *, create: bool) -> None:
        if create:
            self.connection.execute(insert(water).values(record.model_dump()))
        else:
            self.connection.execute(update(water).where(water.c.id == record.id).values(record.model_dump(exclude={"id"})))

    def get_settings(self) -> WaterSettingsOutput:
        row = self.connection.execute(select(water_settings)).mappings().one()
        return WaterSettingsOutput(volumes_ml=json.loads(row["volumes_ml"]), revision=row["revision"])

    def save_settings(self, settings: WaterSettingsOutput) -> None:
        self.connection.execute(update(water_settings).values(
            volumes_ml=json.dumps(settings.volumes_ml), revision=settings.revision))


class SqliteWaterUow:
    def __init__(self, connection: Connection) -> None:
        self.connection = connection
        self.water: WaterStore = SqliteWater(connection)
        self.receipts: ReceiptStore = SqliteReceipts(connection)

    def commit(self) -> None:
        self.connection.commit()


@contextmanager
def water_uow(engine: Engine, *, write: bool = False) -> Generator[WaterUow]:
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
            yield SqliteWaterUow(connection)
    except SQLAlchemyError as error:
        raise Unavailable() from error
