from uuid import uuid4

import pytest

from test_entries import diary
from test_meals import line, meal


def one_off(**changes):
    return {'id': str(uuid4()), 'kind': 'one_off', 'name': 'Домашний суп', **changes}


def test_one_off_requires_only_name_and_mixes_with_catalog(diary):
    client, _ = diary
    payload = meal([line(client), one_off(protein='0'), one_off()])
    response = client.post('/api/meals', json=payload)
    assert response.status_code == 200, response.text
    saved = client.get('/api/meals/' + response.json()['result_id']).json()
    assert saved['lines'][1]['quantity'] is None
    assert saved['lines'][1]['basis_quantity'] is None
    assert saved['lines'][1]['totals'] == {'protein': '0.00', 'fat': None, 'carbohydrate': None, 'calories': None}
    assert saved['totals']['protein'] == {'value': '3.00', 'known_count': 2, 'unknown_count': 1, 'incomplete': True}
    assert client.post('/api/meals', json=payload).json()['replayed'] is True
    assert len(client.get('/api/nutrition-day?day=2026-10-19').json()['meals']) == 1


def test_known_basis_survives_repeated_edits_without_rounding_drift(diary):
    client, _ = diary
    payload = meal([one_off(quantity='3', unit='g', carbohydrate='1', calories='0', protein=None)])
    path = '/api/meals/' + client.post('/api/meals', json=payload).json()['result_id']
    saved = client.get(path).json()
    assert saved['lines'][0]['basis_quantity'] == '3.00'
    assert saved['lines'][0]['totals']['carbohydrate'] == '1.00'
    for revision, quantity, expected in [(1, '1', '0.33'), (2, '2', '0.67'), (3, '3', '1.00')]:
        source = {key: value for key, value in saved['lines'][0].items() if key != 'totals'}
        response = client.put(path, json=meal([{**source, 'quantity': quantity}], expected_revision=revision))
        assert response.status_code == 200, response.text
        saved = client.get(path).json()
        assert saved['lines'][0]['totals']['carbohydrate'] == expected
        assert saved['lines'][0]['basis_quantity'] == '3.00'
        assert saved['lines'][0]['carbohydrate'] == '1.00'


def test_new_weight_does_not_invent_an_unknown_original_basis(diary):
    client, _ = diary
    path = '/api/meals/' + client.post('/api/meals', json=meal([one_off(carbohydrate='12')])).json()['result_id']
    saved = client.get(path).json()
    source = {key: value for key, value in saved['lines'][0].items() if key != 'totals'}
    assert client.put(path, json=meal([{**source, 'quantity': '200', 'unit': 'ml'}], expected_revision=1)).status_code == 200
    changed = client.get(path).json()['lines'][0]
    assert changed['basis_quantity'] is None
    assert changed['totals']['carbohydrate'] == '12.00'
    # Explicitly supplying the actual original basis makes scaling possible.
    assert client.put(path, json=meal([{**source, 'quantity': '200', 'unit': 'ml', 'basis_quantity': '100'}], expected_revision=2)).status_code == 200
    assert client.get(path).json()['lines'][0]['totals']['carbohydrate'] == '24.00'


def test_product_preview_is_explicit_rounded_and_independent(diary):
    client, _ = diary
    source = one_off(quantity='3', unit='ml', carbohydrate='1', fat='0')
    path = '/api/meals/' + client.post('/api/meals', json=meal([source])).json()['result_id']
    before = client.get(path).json()
    response = client.post('/api/meal-product-preview', json={'line': source, 'unit': 'ml'})
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview == {'name': 'Домашний суп', 'unit': 'ml', 'protein': None, 'fat': '0.00', 'carbohydrate': '33.33', 'calories': None}
    assert client.get('/api/products').json() == []
    card = {**preview, 'operation_id': str(uuid4()), 'portions': []}
    created = client.post('/api/products', json=card)
    assert created.status_code == 200
    assert client.post('/api/products', json=card).json()['replayed'] is True
    assert client.get(path).json() == before
    assert client.get('/api/products/' + created.json()['result_id']).json()['carbohydrate'] == '33.33'
    unknown = one_off(calories='180')
    assert client.post('/api/meal-product-preview', json={'line': unknown, 'unit': 'g'}).status_code == 422
    known = client.post('/api/meal-product-preview', json={'line': unknown, 'unit': 'g', 'basis_quantity': '120'})
    assert known.json()['calories'] == '150.00'
    assert client.get(path).json() == before
    assert client.post('/api/meal-product-preview', json={'line': source, 'unit': 'g'}).status_code == 422
    assert client.post('/api/meal-product-preview', json={'line': one_off(quantity='0.01', unit='g', calories='21474836.47'), 'unit': 'g'}).status_code == 422


def test_repeat_freezes_history_and_server_time_without_writing(diary, monkeypatch):
    client, _ = diary
    source = line(client)
    path = '/api/meals/' + client.post('/api/meals', json=meal([source, one_off(carbohydrate='12')], category='lunch')).json()['result_id']
    original = client.get(path).json()
    from test_products import product
    assert client.put('/api/products/' + source['product_id'], json=product(expected_revision=1, name='Изменён', carbohydrate='99', archived=True)).status_code == 200
    monkeypatch.setattr('diary.meals.now_ms', lambda: 1792500000123)
    response = client.get(path + '/repeat-form')
    assert response.status_code == 200
    draft = response.json()
    assert draft['occurred_at'] == '2026-10-20T12:40:00.123Z'
    assert draft['category'] == 'lunch'
    assert [row['id'] for row in draft['lines']] != [row['id'] for row in original['lines']]
    assert len(set(row['id'] for row in draft['lines'])) == 2
    assert draft['lines'][0]['carbohydrate'] == '20.00'
    assert draft['lines'][1]['quantity'] is None
    assert len(client.get('/api/nutrition-day?day=2026-10-19').json()['meals']) == 1
    assert client.get('/api/nutrition-day?day=2026-10-20').json()['meals'] == []
    assert client.put(path, json=meal([source], expected_revision=1, category='dinner')).status_code == 200
    draft['lines'][0]['quantity'] = '90'
    payload = {'operation_id': str(uuid4()), **draft}
    created = client.post('/api/meals', json=payload)
    assert created.status_code == 200, created.text
    assert created.json()['result_id'] != original['id']
    assert client.post('/api/meals', json=payload).json()['replayed'] is True
    repeated = client.get('/api/meals/' + created.json()['result_id']).json()
    assert len(repeated['lines']) == 2
    assert repeated['totals']['carbohydrate']['value'] == '30.00'
    assert repeated['occurred_at'] == draft['occurred_at']
    assert client.get(path).json()['category'] == 'dinner'
    assert len(client.get(path).json()['lines']) == 1
    assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 2}).status_code == 200
    assert client.get(path + '/repeat-form').status_code == 404
    assert client.get('/api/meals/' + created.json()['result_id']).json() == repeated


@pytest.mark.parametrize('changes', [
    {'name': ' '}, {'quantity': '10'}, {'basis_quantity': '3'}, {'quantity': '0', 'unit': 'g'},
    {'quantity': 1, 'unit': 'g'}, {'quantity': '0.001', 'unit': 'ml'}, {'fat': '-1'},
    {'calories': 'NaN'}, {'protein': True}, {'unit': 'kg'}, {'product_id': str(uuid4())},
])
def test_invalid_one_off_is_atomic(diary, changes):
    client, _ = diary
    response = client.post('/api/meals', json=meal([line(client), one_off(**changes)]))
    assert response.status_code == 422
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['meals'] == []


@pytest.mark.parametrize('changes,field', [
    ({'quantity': '10'}, 'unit'),
    ({'basis_quantity': '3', 'unit': 'g'}, 'quantity'),
    ({'product_id': str(uuid4())}, 'product_id'),
])
def test_one_off_errors_identify_the_control(diary, changes, field):
    client, _ = diary
    response = client.post('/api/meals', json=meal([one_off(**changes)]))
    assert response.status_code == 422
    assert response.json()['field'] == 'lines.0.' + field


def test_repeat_and_preview_require_session_and_protect_private_data(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN
    client, database = diary
    source = one_off(quantity='120', unit='g', calories='180')
    path = '/api/meals/' + client.post('/api/meals', json=meal([source])).json()['result_id'] + '/repeat-form'
    payload = {'line': source, 'unit': 'g'}
    assert client.get(path).headers['cache-control'] == 'no-store'
    assert client.post('/api/meal-product-preview', json=payload).headers['cache-control'] == 'no-store'
    for headers in [{'Origin': 'https://other.test'}, {'X-CSRF-Token': 'wrong'}]:
        assert client.post('/api/meal-product-preview', json=payload, headers=headers).status_code == 403
    assert client.post('/api/meal-product-preview', content=b' ' * 65537).status_code == 413
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        assert anonymous.get(path).status_code == 401
        assert anonymous.post('/api/meal-product-preview', json=payload).status_code == 401


def test_upgrade_preserves_catalog_meals_deletions_receipts_and_session(tmp_path):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from diary.admin import create_account
    from diary.app import create_app
    from diary.db import database_engine, migrate
    from test_access import ORIGIN, PASSWORD, login
    from test_entries import entry
    database = tmp_path / 'previous.sqlite3'
    config = Config()
    config.set_main_option('script_location', str(Path(__file__).resolve().parents[1] / 'migrations'))
    engine = database_engine(database)
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, '006_meals')
    engine.dispose()
    create_account(database, 'owner', PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        client.headers.update({'Origin': ORIGIN, 'X-CSRF-Token': client.get('/api/auth/csrf').json()['csrf_token']})
        assert client.post('/api/entries', json=entry(comment='Прежний дневник')).status_code == 200
        source = line(client)
        payload = meal([source])
        receipt = client.post('/api/meals', json=payload).json()
        path = '/api/meals/' + receipt['result_id']
        deleted_path = '/api/meals/' + client.post('/api/meals', json=meal([source])).json()['result_id']
        assert client.post(deleted_path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1}).status_code == 200
        routes = [path, deleted_path, '/api/day?day=2026-10-19', '/api/products']
        before = [client.get(route).json() for route in routes]
        migrate(database)
        migrate(database)
        assert [client.get(route).json() for route in routes] == before
        day = client.get('/api/nutrition-day?day=2026-10-19').json()
        assert day['meals'] == [before[0]]
        assert day['water'] == []
        assert day['water_total_ml'] is None
        assert client.post('/api/meals', json=payload).json()['replayed'] is True
        assert client.post('/api/meals', json=meal([source, one_off()])).status_code == 200
