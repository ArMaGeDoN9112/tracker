import pytest
from sqlalchemy import event
from sqlalchemy.exc import OperationalError

from diary.application.errors import Unavailable
from diary.db import database_engine, migrate
from diary.infrastructure.water import SqliteWater


def test_day_reader_translates_storage_failure_with_original_cause(tmp_path):
    database = tmp_path / 'water.sqlite3'
    migrate(database)
    engine = database_engine(database)
    fault = OperationalError('synthetic SQL', {}, Exception('private database details'))

    def fail(connection, cursor, statement, parameters, context, many):
        raise fault

    event.listen(engine, 'before_cursor_execute', fail)
    try:
        with engine.connect() as connection:
            with pytest.raises(Unavailable) as caught:
                SqliteWater(connection).day(0, 1)
        assert caught.value.__cause__ is fault
        assert str(caught.value) == 'Операция не сохранена. Повторите позже.'
    finally:
        engine.dispose()
