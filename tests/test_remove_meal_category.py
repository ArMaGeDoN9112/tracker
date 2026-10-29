from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import Engine, MetaData, Table, event, inspect, select, update

from admin_setup import create_account
from diary.app import create_app
from diary.infrastructure.database import database_engine, migrate
from diary.tables import meal_line, operation_receipt
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
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        client.headers.update({'Origin': ORIGIN, 'X-CSRF-Token': client.get('/api/auth/csrf').json()['csrf_token']})
        for index, category in enumerate(['breakfast', 'snack', None]):
            response = client.post('/api/meals', json=meal([
                {'id': str(uuid4()), 'kind': 'one_off', 'name': 'Суп', 'quantity': '150', 'unit': 'g', 'protein': '0'},
                {'id': str(uuid4()), 'kind': 'one_off', 'name': 'Чай', 'calories': None},
            ]))
            assert response.status_code == 200
            path = '/api/meals/' + response.json()['result_id']
            with engine.begin() as connection:
                previous_meal = Table('meal', MetaData(), autoload_with=connection)
                connection.execute(update(previous_meal).where(previous_meal.c.id == response.json()['result_id']).values(category=category))
            if index == 1:
                assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1}).status_code == 200
        before = client.get('/api/export').json()
        before.pop('exported_at')
        with engine.connect() as connection:
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
        after = client.get('/api/export').json()
        after.pop('exported_at')
        assert after == before
        with engine.connect() as connection:
            assert 'category' not in {column['name'] for column in inspect(connection).get_columns('meal')}
            assert connection.execute(select(meal_line).order_by(meal_line.c.meal_id, meal_line.c.position)).all() == lines_before
            assert connection.execute(select(operation_receipt).order_by(operation_receipt.c.operation_id)).all() == receipts_before
            assert connection.exec_driver_sql('PRAGMA foreign_key_check').all() == []
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
