from uuid import uuid4

import pytest

from test_entries import diary
from test_products import product


def line(client, **changes):
    payload = product(carbohydrate='20', calories='180')
    created = client.post('/api/products', json=payload).json()
    return {'id': str(uuid4()), 'kind': 'product', 'name': 'Творог', 'unit': 'g',
            'quantity': '30', 'basis_quantity': '100', 'protein': '10', 'fat': '5',
            'carbohydrate': '20', 'calories': '180', 'product_id': created['result_id'],
            'product_revision': 1, 'portion': payload['portions'][0], **changes}


def meal(items, **changes):
    return {'operation_id': str(uuid4()), 'occurred_at': '2026-10-19T00:00:00.123+03:00',
            'category': None, 'lines': items, **changes}


def test_catalog_meal_calculates_exact_values_and_day(diary):
    client, _ = diary
    payload = meal([line(client)])
    response = client.post('/api/meals', json=payload)
    assert response.status_code == 200
    saved = client.get('/api/meals/' + response.json()['result_id']).json()
    assert saved['lines'][0]['totals'] == {'protein': '3.00', 'fat': '1.50', 'carbohydrate': '6.00', 'calories': '54.00'}
    assert saved['totals']['calories'] == {'value': '54.00', 'known_count': 1, 'unknown_count': 0, 'incomplete': False}
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    assert day['meals'] == [saved]
    assert day['totals'] == saved['totals']
    assert client.get('/api/nutrition-day?day=2026-10-18').json()['meals'] == []


def test_half_up_is_independent_for_lines_meals_and_day(diary):
    client, _ = diary
    source = line(client, quantity='50', protein=None, fat='0', carbohydrate='0.01', calories=None)
    payload = meal([source, {**source, 'id': str(uuid4())}])
    assert client.post('/api/meals', json=payload).status_code == 200
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    saved = day['meals'][0]
    assert [row['totals']['carbohydrate'] for row in saved['lines']] == ['0.01', '0.01']
    assert saved['totals']['carbohydrate']['value'] == '0.01'
    assert day['totals']['carbohydrate']['value'] == '0.01'
    assert saved['totals']['protein'] == {'value': None, 'known_count': 0, 'unknown_count': 2, 'incomplete': True}
    assert saved['totals']['fat']['value'] == '0.00'
    assert client.post('/api/meals', json=meal([source])).status_code == 200
    # Three exact 0.005 contributions total 0.015, independently rounded to 0.02.
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    assert day['totals']['carbohydrate']['value'] == '0.02'
    assert client.get('/api/nutrition-day?day=2026-10-18').json()['totals']['fat'] == {
        'value': None, 'known_count': 0, 'unknown_count': 0, 'incomplete': False}


def test_snapshots_survive_catalog_changes_and_edit_uses_historical_basis(diary):
    client, _ = diary
    source = line(client)
    path = '/api/products/' + source['product_id']
    first = meal([source])
    created = client.post('/api/meals', json=first).json()
    meal_path = '/api/meals/' + created['result_id']
    before = client.get(meal_path).json()
    other_id = client.post('/api/meals', json=meal([source])).json()['result_id']
    other = client.get('/api/meals/' + other_id).json()
    edit = product(expected_revision=1, name='Новое имя', unit='ml', portions=[], protein='99', unit_change_confirmed=True)
    assert client.put(path, json=edit).status_code == 200
    assert client.get(meal_path).json() == before
    # A draft picked before the card changed must also retain its snapshot.
    draft_id = client.post('/api/meals', json=meal([source])).json()['result_id']
    assert client.get('/api/meals/' + draft_id).json()['lines'] == before['lines']
    update = {**first, 'operation_id': str(uuid4()), 'expected_revision': 1, 'category': 'lunch',
              'lines': [{**source, 'quantity': '90'}]}
    assert client.put(meal_path, json=update).status_code == 200
    changed = client.get(meal_path).json()
    assert changed['occurred_at'] == '2026-10-18T21:00:00.123Z'
    assert changed['lines'][0]['totals'] == {'protein': '9.00', 'fat': '4.50', 'carbohydrate': '18.00', 'calories': '162.00'}
    assert changed['lines'][0]['portion'] == before['lines'][0]['portion']
    assert client.get('/api/meals/' + other_id).json() == other
    assert client.get(path).json()['protein'] == '99.00'
    assert client.post('/api/meals', json=first).json()['replayed'] is True
    assert client.get(meal_path).json() == changed
    assert client.put(meal_path, json={**update, 'operation_id': str(uuid4())}).json()['code'] == 'revision_conflict'


def test_moscow_boundaries_move_composition_and_stable_order(diary, monkeypatch):
    client, _ = diary
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: 1792400000000)
    source = line(client)
    for at in ['2026-10-18T23:59:59.999+03:00', '2026-10-19T00:00:00+03:00',
               '2026-10-19T23:59:59.999+03:00', '2026-10-20T00:00:00+03:00']:
        assert client.post('/api/meals', json=meal([source], occurred_at=at)).status_code == 200
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    assert len(day['meals']) == 2
    assert day['meals'][0]['occurred_at'] == '2026-10-18T21:00:00.000Z'
    first = day['meals'][0]
    edit = meal([{**source, 'id': str(uuid4()), 'name': 'Первая'}, {**source, 'name': 'Вторая', 'quantity': '90'}],
                occurred_at='2026-10-20T00:00:00+03:00', expected_revision=1)
    assert client.put('/api/meals/' + first['id'], json=edit).status_code == 200
    assert len(client.get('/api/nutrition-day?day=2026-10-19').json()['meals']) == 1
    moved = client.get('/api/nutrition-day?day=2026-10-20').json()
    assert [m['id'] for m in moved['meals']] == sorted(m['id'] for m in moved['meals'])
    assert [row['name'] for row in client.get('/api/meals/' + first['id']).json()['lines']] == ['Первая', 'Вторая']
    assert moved['totals']['calories']['value'] == '270.00'


@pytest.mark.parametrize('elapsed,status', [(29999, 200), (30000, 409)])
def test_delete_restore_deadline_and_late_receipts(diary, monkeypatch, elapsed, status):
    client, _ = diary
    clock = 1792400000000
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: clock)
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: clock)
    payload = meal([line(client)])
    path = '/api/meals/' + client.post('/api/meals', json=payload).json()['result_id']
    before = client.get(path).json()
    deletion = {'operation_id': str(uuid4()), 'expected_revision': 1}
    assert client.post(path + '/delete', json=deletion).json()['undo_remaining_ms'] == 30000
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['meals'] == []
    assert client.get(path).json()['lines'] == before['lines']
    clock += elapsed
    assert client.post('/api/meals', json=payload).json()['replayed'] is True
    assert client.get(path).json()['deleted_at'] is not None
    assert client.post(path + '/delete', json=deletion).json()['undo_remaining_ms'] == 30000 - elapsed
    restoration = {'operation_id': str(uuid4()), 'expected_revision': 2}
    assert client.post(path + '/restore', json=restoration).status_code == status
    if status == 200:
        assert client.get(path).json()['lines'] == before['lines']
        assert client.post(path + '/restore', json=restoration).json()['replayed'] is True
        assert client.post(path + '/delete', json=deletion).json()['replayed'] is True
        assert client.get(path).json()['deleted_at'] is None
        assert len(client.get('/api/nutrition-day?day=2026-10-19').json()['meals']) == 1
    else:
        assert client.get(path).json()['revision'] == 2


@pytest.mark.parametrize('field,value', [
    ('name', ' '), ('unit', 'kg'), ('quantity', '0'), ('quantity', '0.001'), ('quantity', 1),
    ('quantity', '21474836.48'), ('protein', True), ('protein', 'NaN'), ('fat', '-1'),
    ('calories', '1e2'), ('basis_quantity', '30'), ('kind', 'other'), ('id', 'bad'),
    ('product_revision', 0), ('product_id', 'bad'), ('carbohydrate', '0.001'),
])
def test_invalid_line_is_identified_without_partial_meal(diary, field, value):
    client, _ = diary
    source = line(client)
    response = client.post('/api/meals', json=meal([source, {**source, 'id': str(uuid4()), field: value}]))
    assert response.status_code == 422
    assert response.json()['field'] == 'lines.1.' + field
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['meals'] == []


def test_unknown_partial_huge_results_normalization_and_invalid_header(diary):
    client, _ = diary
    source = line(client, protein='21474836.47', quantity='21474836.47', fat='0', calories=None)
    payload = meal([source])
    assert client.post('/api/meals', json=payload).status_code == 200
    saved = client.get('/api/nutrition-day?day=2026-10-19').json()['meals'][0]
    assert saved['lines'][0]['totals']['protein'] == '4611686014132.42'
    assert client.post('/api/meals', json={**payload, 'lines': [{**source, 'protein': '21474836,4700', 'fat': '0.000'}]}).json()['replayed'] is True
    second = {**source, 'id': str(uuid4()), 'protein': None, 'fat': '', 'carbohydrate': None}
    assert client.post('/api/meals', json=meal([second])).status_code == 200
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    assert day['totals']['protein'] == {'value': '4611686014132.42', 'known_count': 1, 'unknown_count': 1, 'incomplete': True}
    for changes in [{'lines': []}, {'lines': [source, source]}, {'category': 'other'}, {'occurred_at': '2026-10-19T12:00:00'}, {'operation_id': 'bad'}]:
        assert client.post('/api/meals', json=meal([source], **changes)).status_code == 422


@pytest.mark.parametrize('fault', ['line', 'receipt', 'commit'])
@pytest.mark.parametrize('editing', [False, True])
@pytest.mark.parametrize('mixed', [False, True])
def test_atomic_meal_rollback_and_retry(diary, fault, editing, mixed):
    from sqlalchemy import Engine, event
    from sqlalchemy.exc import OperationalError
    client, _ = diary
    source = line(client)
    path = '/api/meals'
    if editing:
        path += '/' + client.post(path, json=meal([source])).json()['result_id']
    before = client.get('/api/nutrition-day?day=2026-10-19').json()
    second = {'id': str(uuid4()), 'kind': 'one_off', 'name': 'Разовая еда', 'fat': '0'} if mixed else {**source, 'id': str(uuid4())}
    payload = meal([source, second], **({'expected_revision': 1} if editing else {}))

    def fail_commit(connection):
        raise OperationalError('COMMIT', {}, Exception('synthetic failure'))

    def fail_write(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO ' + ('meal_line' if fault == 'line' else 'operation_receipt')):
            if fault != 'line' or parameters[2] == 1:
                raise OperationalError(statement, {}, Exception('synthetic failure'))

    hook, listener = ('commit', fail_commit) if fault == 'commit' else ('before_cursor_execute', fail_write)
    event.listen(Engine, hook, listener)
    try:
        assert client.request('PUT' if editing else 'POST', path, json=payload).status_code == 503
    finally:
        event.remove(Engine, hook, listener)
    assert client.get('/api/nutrition-day?day=2026-10-19').json() == before
    assert client.request('PUT' if editing else 'POST', path, json=payload).json()['replayed'] is False


def test_access_body_limit_and_conflicting_operation(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN
    client, database = diary
    payload = meal([line(client)])
    receipt = client.post('/api/meals', json=payload).json()
    path = '/api/meals/' + receipt['result_id']
    for route in [path, '/api/nutrition-day?day=2026-10-19']:
        assert client.get(route).headers['cache-control'] == 'no-store'
    assert client.post('/api/meals', json=payload, headers={'Origin': 'https://other.test'}).status_code == 403
    assert client.put(path, json={**payload, 'expected_revision': 1}, headers={'X-CSRF-Token': 'wrong'}).status_code == 403
    assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1}, headers={'X-CSRF-Token': 'wrong'}).status_code == 403
    assert client.post('/api/meals', json={**payload, 'category': 'lunch'}).json()['code'] == 'operation_conflict'
    assert client.put(path, json={**payload, 'expected_revision': 1}).json()['code'] == 'operation_conflict'
    assert client.post('/api/meals', content=b' ' * 65537).status_code == 413
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        for route in [path, '/api/nutrition-day?day=2026-10-19']:
            assert anonymous.get(route).status_code == 401
        assert anonymous.post('/api/meals', json=payload).status_code == 401
    assert len(client.get('/api/nutrition-day?day=2026-10-19').json()['meals']) == 1


def test_concurrent_creation_and_competing_edit_delete(diary):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN
    client, database = diary
    payload = meal([line(client)])

    def send(request):
        method, path, body = request
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as peer:
            peer.cookies.update(client.cookies)
            return peer.request(method, path, json=body, headers=dict(client.headers))

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(send, [('POST', '/api/meals', payload)] * 2))
    assert sorted(r.json()['replayed'] for r in responses) == [False, True]
    path = '/api/meals/' + responses[0].json()['result_id']
    edit = {**payload, 'operation_id': str(uuid4()), 'expected_revision': 1, 'category': 'snack'}
    deletion = {'operation_id': str(uuid4()), 'expected_revision': 1}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(send, [('PUT', path, edit), ('POST', path + '/delete', deletion)]))
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert client.get(path).json()['revision'] == 2


def test_upgrade_catalog_and_diary_preserves_history_and_session(tmp_path):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient
    from diary.admin import create_account
    from diary.app import create_app
    from diary.db import database_engine, migrate
    from test_access import ORIGIN, PASSWORD, login
    from test_entries import entry
    from test_products import legacy_product
    database = tmp_path / 'catalog.sqlite3'
    config = Config()
    config.set_main_option('script_location', str(Path(__file__).resolve().parents[1] / 'migrations'))
    engine = database_engine(database)
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, '005_products')
    engine.dispose()
    create_account(database, 'owner', PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        client.headers.update({'Origin': ORIGIN, 'X-CSRF-Token': client.get('/api/auth/csrf').json()['csrf_token']})
        assert client.post('/api/entries', json=entry(comment='Прежняя история')).status_code == 200
        source, catalog = legacy_product(database)
        before = client.get('/api/day?day=2026-10-19').json()
        migrate(database)
        migrate(database)
        assert client.get('/api/day?day=2026-10-19').json() == before
        assert client.get('/api/products').json() == catalog
        assert client.get('/api/nutrition-day?day=2026-10-19').json()['meals'] == []
        assert client.post('/api/meals', json=meal([source])).status_code == 200


def test_ml_unknown_values_and_full_day_without_pagination(diary, monkeypatch):
    client, _ = diary
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: 1792400000000)
    source = line(client, unit='ml', quantity='30', protein=None, fat='0', carbohydrate='20', calories=None, portion=None)
    payload = meal([source])
    for _ in range(105):
        assert client.post('/api/meals', json={**payload, 'operation_id': str(uuid4())}).status_code == 200
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    assert len(day['meals']) == 105
    assert [row['id'] for row in day['meals']] == sorted(row['id'] for row in day['meals'])
    assert day['totals']['carbohydrate']['value'] == '630.00'
    assert day['totals']['protein']['value'] is None
    assert day['meals'][0]['lines'][0]['unit'] == 'ml'


@pytest.mark.parametrize('kind', ['delete', 'restore'])
@pytest.mark.parametrize('fault', ['receipt', 'commit'])
def test_delete_restore_rollback_is_atomic(diary, kind, fault):
    from sqlalchemy import Engine, event
    from sqlalchemy.exc import OperationalError
    client, _ = diary
    path = '/api/meals/' + client.post('/api/meals', json=meal([line(client)])).json()['result_id']
    if kind == 'restore':
        assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1}).status_code == 200
    before = client.get(path).json()
    payload = {'operation_id': str(uuid4()), 'expected_revision': before['revision']}

    def fail_commit(connection):
        raise OperationalError('COMMIT', {}, Exception('synthetic failure'))

    def fail_receipt(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO operation_receipt'):
            raise OperationalError(statement, {}, Exception('synthetic failure'))

    hook, listener = ('commit', fail_commit) if fault == 'commit' else ('before_cursor_execute', fail_receipt)
    event.listen(Engine, hook, listener)
    try:
        assert client.post(path + '/' + kind, json=payload).status_code == 503
    finally:
        event.remove(Engine, hook, listener)
    assert client.get(path).json() == before
    assert client.post(path + '/' + kind, json=payload).json()['replayed'] is False
