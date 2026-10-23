from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy import Connection, Engine, delete, insert, select, update
from sqlalchemy.exc import SQLAlchemyError

from diary.application.errors import Unavailable
from diary.application.products import PortionInput, ProductResult, ProductStore
from diary.application.operations import ReceiptStore
from diary.domain.products import ProductRecord
from diary.domain.precision import hundredths, rate_string
from diary.infrastructure.water import SqliteReceipts
from diary.tables import product, product_portion, meal, meal_line
from diary.application.meals import MealResult, MealStore
from diary.domain.nutrition import MealRecord, MealLineRecord


@dataclass
class SqliteProducts:
    connection: Connection

    def get(self, product_id: str) -> ProductResult | None:
        row = self.connection.execute(select(product).where(product.c.id == product_id)).mappings().first()
        return self.result(ProductRecord.model_validate(row)) if row is not None else None

    def result(self, record: ProductRecord) -> ProductResult:
        portions = [PortionInput(id=row.id, name=row.name, quantity=rate_string(row.quantity))
                    for row in self.connection.execute(select(product_portion).where(
                        product_portion.c.product_id == record.id).order_by(product_portion.c.position))]
        return ProductResult(record=record, portions=portions)

    def all(self) -> list[ProductResult]:
        return [self.result(ProductRecord.model_validate(row)) for row in self.connection.execute(
            select(product).order_by(product.c.created_at, product.c.id)).mappings()]

    def save(self, result: ProductResult, *, create: bool) -> None:
        record = result.record
        if create:
            self.connection.execute(insert(product).values(record.model_dump()))
        else:
            self.connection.execute(update(product).where(product.c.id == record.id).values(record.model_dump(exclude={"id"})))
            self.connection.execute(delete(product_portion).where(product_portion.c.product_id == record.id))
        for position, portion in enumerate(result.portions):
            self.connection.execute(insert(product_portion).values(product_id=record.id, id=portion.id,
                position=position, name=portion.name, quantity=hundredths(portion.quantity)))


def meal_lines(connection: Connection, meal_id: str) -> list[MealLineRecord]:
    return [MealLineRecord.model_validate(row) for row in connection.execute(
        select(meal_line).where(meal_line.c.meal_id == meal_id).order_by(meal_line.c.position)).mappings()]


@dataclass
class SqliteMeals:
    connection: Connection

    def get(self, meal_id: str) -> MealResult | None:
        row = self.connection.execute(select(meal).where(meal.c.id == meal_id)).mappings().first()
        return MealResult(record=MealRecord.model_validate(row), lines=meal_lines(self.connection, meal_id)) if row is not None else None

    def save(self, result: MealResult, *, create: bool, replace_lines: bool) -> None:
        record = result.record
        if create:
            self.connection.execute(insert(meal).values(record.model_dump()))
        else:
            self.connection.execute(update(meal).where(meal.c.id == record.id).values(record.model_dump(exclude={"id"})))
        if replace_lines:
            self.connection.execute(delete(meal_line).where(meal_line.c.meal_id == record.id))
            for line in result.lines:
                self.connection.execute(insert(meal_line).values(line.model_dump()))


class SqliteNutritionUow:
    def __init__(self, connection: Connection) -> None:
        self.connection = connection
        self.products: ProductStore = SqliteProducts(connection)
        self.meals: MealStore = SqliteMeals(connection)
        self.receipts: ReceiptStore = SqliteReceipts(connection)

    def commit(self) -> None:
        self.connection.commit()


@contextmanager
def nutrition_uow(engine: Engine, *, write: bool = False) -> Generator[SqliteNutritionUow]:
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
            yield SqliteNutritionUow(connection)
    except SQLAlchemyError as error:
        raise Unavailable() from error
