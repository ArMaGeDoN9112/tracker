from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import Engine, MetaData, Table, event, inspect, select, insert

from admin_setup import create_account
from diary.app import create_app
from diary.infrastructure.database import database_engine, migrate
from diary.tables import meal as meal_table, meal_line, operation_receipt
from diary.application.meals import MealLineInput, line_record
from test_access import ORIGIN, PASSWORD, login
from test_entries import diary
from test_meals import meal


@pytest.mark.parametrize('interrupted', [False, True])
def test_remove_category_preserves_meals_lines_receipts_and_rolls_back(tmp_path, interrupted):
    database = tmp_path / 'meals.sqlite3'
    config = Config()
    config.set_main_option('script_location', str(Path('migrations').resolve()))
    engine = database_engine(database)
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, '010_remove_product_archive')
    create_account(database, 'owner', PASSWORD)
    with engine.begin() as connection:
        previous_meal = Table('meal', MetaData(), autoload_with=connection)
        for index, category in enumerate(['breakfast', 'snack', None]):
            meal_id = str(uuid4())
            connection.execute(insert(previous_meal).values(id=meal_id, occurred_at=1792357200000,
                category=category, revision=2 if index == 1 else 1, created_at=1792357200000,
                updated_at=1792357200000, deleted_at=1792357200000 if index == 1 else None))
            for position, values in enumerate([
                {'name': 'Суп', 'quantity': '150', 'unit': 'g', 'protein': '0'},
                {'name': 'Чай', 'calories': None},
            ]):
                line = MealLineInput(id=str(uuid4()), kind='one_off', **values)
                connection.execute(insert(meal_line).values(line_record(line, meal_id, position).model_dump()))
            connection.execute(insert(operation_receipt).values(operation_id=str(uuid4()), action='create_meal',
                request_hash=f'{index:064x}', result_id=meal_id, revision=1, completed_at=1792357200000))
        before = connection.execute(select(*[c for c in previous_meal.c if c.name != 'category']).order_by(previous_meal.c.id)).mappings().all()
        lines_before = connection.execute(select(meal_line).order_by(meal_line.c.meal_id, meal_line.c.position)).all()
        receipts_before = connection.execute(select(operation_receipt).order_by(operation_receipt.c.operation_id)).all()
    if interrupted:
        def fail_rebuild(connection, cursor, statement, parameters, context, executemany):
            if statement.startswith('ALTER TABLE _alembic_tmp_meal'):
                raise RuntimeError('Interrupted migration')
        event.listen(Engine, 'before_cursor_execute', fail_rebuild)
        try:
            with pytest.raises(RuntimeError, match='Interrupted migration'):
                migrate(database)
        finally:
            event.remove(Engine, 'before_cursor_execute', fail_rebuild)
        with engine.connect() as connection:
            assert 'category' in {column['name'] for column in inspect(connection).get_columns('meal')}
            assert connection.execute(select(meal_line).order_by(meal_line.c.meal_id, meal_line.c.position)).all() == lines_before
    migrate(database)
    migrate(database)
    with engine.connect() as connection:
        assert 'category' not in {column['name'] for column in inspect(connection).get_columns('meal')}
        assert connection.execute(select(*[c for c in meal_table.c if c.name != 'meal_type']).order_by(meal_table.c.id)).mappings().all() == before
        assert connection.execute(select(meal_table.c.meal_type)).scalars().all() == [None, None, None]
        assert connection.execute(select(meal_line).order_by(meal_line.c.meal_id, meal_line.c.position)).all() == lines_before
        assert connection.execute(select(operation_receipt).order_by(operation_receipt.c.operation_id)).all() == receipts_before
        assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        exported = client.get('/api/export').json()['meals']
        assert len(exported) == 3
        assert all(item['meal_type'] is None and len(item['lines']) == 2 for item in exported)
    engine.dispose()


def test_category_is_absent_from_contract_and_ignored_for_old_clients(diary):
    client, _ = diary
    payload = meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Суп', 'calories': '50'}])
    created = client.post('/api/meals', json={**payload, 'category': 'lunch'})
    assert created.status_code == 200
    path = '/api/meals/' + created.json()['result_id']
    assert client.post('/api/meals', json=payload).json()['replayed'] is True
    assert 'category' not in client.get(path).json()
    assert 'category' not in client.get(path + '/repeat-form').json()
    assert 'category' not in client.get('/api/nutrition-day?day=2026-10-19').json()['meals'][0]
    assert 'category' not in client.get('/api/export').json()['meals'][0]
    schemas = client.app.openapi()['components']['schemas']
    for name in ['MealInput', 'EditMealInput', 'MealOutput', 'RepeatMealOutput']:
        assert 'category' not in schemas[name]['properties']
    assert client.post('/api/meals', json={**payload, 'unknown': 'value'}).status_code == 422
