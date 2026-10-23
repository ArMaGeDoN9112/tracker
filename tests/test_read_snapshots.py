from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import Engine, event

from diary.db import database_engine
from test_basal import schedule
from test_entries import diary, entry
from test_meals import meal
from test_water import water


@pytest.mark.parametrize('route,first_select', [
    ('/api/day?day=2026-10-19', 'SELECT entry.'),
    ('/api/nutrition-day?day=2026-10-19', 'SELECT meal.'),
    ('/api/nutrition-summary?period=custom&start=2026-10-19&end=2026-10-19', 'SELECT water.'),
])
def test_composite_reads_keep_one_snapshot_during_writes(diary, route, first_select):
    client, database = diary
    entry_path = '/api/entries/' + client.post('/api/entries', json=entry()).json()['result_id']
    food = meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Суп', 'protein': '10'}])
    meal_path = '/api/meals/' + client.post('/api/meals', json=food).json()['result_id']
    drink = water(occurred_at='2026-10-19T12:00:00+03:00')
    water_path = '/api/water/' + client.post('/api/water', json=drink).json()['result_id']
    before = client.get(route).json()
    engine = database_engine(database)
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql('PRAGMA journal_mode=WAL')
    finally:
        engine.dispose()
    reading, changed = Event(), Event()

    def pause(connection, cursor, statement, parameters, context, many):
        if statement.startswith(first_select) and not reading.is_set():
            reading.set()
            assert changed.wait(10), 'Concurrent writer did not finish'

    event.listen(Engine, 'after_cursor_execute', pause)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(client.get, route)
            try:
                assert reading.wait(10), 'Composite read did not start'
                assert client.put(entry_path, json=entry(expected_revision=1, glucose='8.0')).status_code == 200
                assert client.post('/api/basal-schedules', json=schedule()).status_code == 200
                assert client.put(meal_path, json={**food, 'operation_id': str(uuid4()), 'expected_revision': 1,
                    'lines': [{**food['lines'][0], 'protein': '20'}]}).status_code == 200
                assert client.put(water_path, json={**drink, 'operation_id': str(uuid4()),
                    'expected_revision': 1, 'volume_ml': 500}).status_code == 200
            finally:
                changed.set()
            response = future.result(timeout=10)
    finally:
        event.remove(Engine, 'after_cursor_execute', pause)
    assert response.status_code == 200
    assert response.json() == before
    assert client.get(route).json() != before
