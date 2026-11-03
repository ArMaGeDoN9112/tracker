from uuid import uuid4

import pytest

from test_entries import diary
from test_meals import meal, legacy_meal


@pytest.mark.parametrize('meal_type', ['breakfast', 'lunch', 'dinner', 'snack'])
def test_meal_type_survives_read_repeat_export_and_old_client_edit(diary, meal_type):
    client, _ = diary
    payload = meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Каша', 'calories': '50'}], meal_type=meal_type)
    response = client.post('/api/meals', json=payload)
    assert response.status_code == 200, response.text
    path = '/api/meals/' + response.json()['result_id']
    assert client.post('/api/meals', json=payload).json()['replayed'] is True
    assert client.post('/api/meals', json={**payload, 'meal_type': None}).status_code == 409
    assert client.get(path).json()['meal_type'] == meal_type
    assert client.get(path + '/repeat-form').json()['meal_type'] == meal_type
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['meals'][0]['meal_type'] == meal_type
    assert client.get('/api/export').json()['meals'][0]['meal_type'] == meal_type
    old_edit = meal(payload['lines'], expected_revision=1)
    assert client.put(path, json=old_edit).status_code == 200
    assert client.get(path).json()['meal_type'] == meal_type
    assert client.put(path, json=old_edit).json()['replayed'] is True
    assert client.put(path, json=meal(payload['lines'], expected_revision=2, meal_type='dinner')).status_code == 200
    assert client.get(path).json()['meal_type'] == 'dinner'
    assert client.put(path, json=meal(payload['lines'], expected_revision=3, meal_type=None)).status_code == 200
    assert client.get(path).json()['meal_type'] is None


@pytest.mark.parametrize('meal_type', ['brunch', '', 4])
def test_invalid_meal_type_is_rejected_without_saving(diary, meal_type):
    client, _ = diary
    payload = meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Каша'}], meal_type=meal_type)
    response = client.post('/api/meals', json=payload)
    assert response.status_code == 422
    assert response.json()['field'] == 'meal_type'
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['meals'] == []


def test_upgrade_adds_an_unset_type_without_changing_existing_meals(tmp_path):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from admin_setup import create_account
    from diary.app import create_app
    from diary.infrastructure.database import database_engine, migrate
    from test_access import ORIGIN, PASSWORD, login
    database = tmp_path / 'previous.sqlite3'
    engine = database_engine(database)
    config = Config()
    config.set_main_option('script_location', str(Path('migrations').resolve()))
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, '011_remove_meal_category')
    engine.dispose()
    create_account(database, 'owner', PASSWORD)
    payload = meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Завтрак по названию', 'protein': '0'}])
    before = legacy_meal(database, payload)
    migrate(database)
    migrate(database)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        assert client.get('/api/meals/' + before['id']).json() == before
        assert before['meal_type'] is None
