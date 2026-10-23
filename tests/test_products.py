from uuid import uuid4

import pytest

from test_entries import diary


def product(**changes):
    return {"operation_id": str(uuid4()), "name": "  Творог  ", "unit": "g",
            "protein": "10,00", "fat": "5", "carbohydrate": "0", "calories": None,
            "portions": [{"id": str(uuid4()), "name": "Пачка", "quantity": "180"}], **changes}


def legacy_product(database):
    from sqlalchemy import insert
    from diary.db import database_engine
    from diary.tables import product as product_table, product_portion
    identifier, portion_id = str(uuid4()), str(uuid4())
    engine = database_engine(database)
    try:
        with engine.begin() as connection:
            connection.execute(insert(product_table).values(
                id=identifier, name='Творог', unit='g', protein=1000, fat=500,
                carbohydrate=2000, calories=18000, archived=False, revision=1, created_at=0, updated_at=0))
            connection.execute(insert(product_portion).values(
                product_id=identifier, id=portion_id, position=0, name='Пачка', quantity=18000))
    finally:
        engine.dispose()
    portion = {'id': portion_id, 'name': 'Пачка', 'quantity': '180.00'}
    values = {'name': 'Творог', 'unit': 'g', 'protein': '10.00', 'fat': '5.00', 'carbohydrate': '20.00', 'calories': '180.00'}
    source = {**values, 'id': str(uuid4()), 'kind': 'product', 'quantity': '30', 'basis_quantity': '100',
              'product_id': identifier, 'product_revision': 1, 'portion': portion}
    catalog = [{**values, 'id': identifier, 'photo': None, 'portions': [portion], 'archived': False,
                'revision': 1, 'created_at': '1970-01-01T00:00:00.000Z', 'updated_at': '1970-01-01T00:00:00.000Z'}]
    return source, catalog


def test_catalog_create_read_and_replay(diary):
    client, _ = diary
    assert client.get('/api/products').json() == []
    payload = product()
    response = client.post('/api/products', json=payload)
    assert response.status_code == 200
    receipt = response.json()
    assert client.post('/api/products', json=payload).json()['replayed'] is True
    rows = client.get('/api/products').json()
    assert len(rows) == 1
    saved = rows[0]
    assert saved['id'] == receipt['result_id']
    assert (saved['name'], saved['protein'], saved['fat'], saved['carbohydrate'], saved['calories']) == ('Творог', '10.00', '5.00', '0.00', None)
    assert saved['portions'] == [{**payload['portions'][0], 'quantity': '180.00'}]
    assert client.post('/api/products', json={**payload, 'name': 'Другое'}).status_code == 409


@pytest.mark.parametrize('photo', [
    'https://example.com/food.jpg', 'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/jpeg;base64,not base64', 'data:image/jpeg;base64,aGVsbG8=',
    'data:image/jpeg;base64,' + 'A' * 45000,
])
def test_invalid_photo_does_not_create_product(diary, photo):
    client, _ = diary
    response = client.post('/api/products', json=product(photo=photo))
    assert response.status_code == 422
    assert response.json()['field'] == 'photo'
    assert client.get('/api/products').json() == []


def test_photo_is_preserved_for_older_clients_and_can_be_removed(diary):
    client, database = diary
    photo = 'data:image/jpeg;base64,/9j/2Q=='
    payload = product(photo=photo)
    created = client.post('/api/products', json=payload)
    assert created.status_code == 200
    path = '/api/products/' + created.json()['result_id']
    assert client.get(path).json()['photo'] == photo
    assert client.post('/api/products', json=payload).json()['replayed'] is True
    assert client.put(path, json=product(expected_revision=1)).status_code == 200
    assert client.get(path).json()['photo'] == photo
    from diary.db import migrate
    migrate(database)
    assert client.get('/api/export').json()['products'][0]['photo'] == photo
    assert client.put(path, json=product(expected_revision=2, photo=None)).status_code == 200
    assert client.get(path).json()['photo'] is None


def test_edit_portions_archive_restore_and_old_receipts(diary):
    client, database = diary
    payload = product(calories='180')
    created = client.post('/api/products', json=payload).json()
    path = '/api/products/' + created['result_id']
    portions = [payload['portions'][0], {'id': str(uuid4()), 'name': 'Ложка', 'quantity': '30'}]
    edit = product(expected_revision=1, portions=list(reversed(portions)), calories='181')
    assert client.put(path, json=edit).json()['revision'] == 2
    saved = client.get(path).json()
    assert [p['id'] for p in saved['portions']] == [p['id'] for p in reversed(portions)]
    assert saved['calories'] == '181.00'
    assert saved['created_at'] <= saved['updated_at']
    assert client.put(path, json={**edit, 'operation_id': str(uuid4())}).json()['code'] == 'revision_conflict'
    archive = {**edit, 'operation_id': str(uuid4()), 'expected_revision': 2, 'archived': True, 'portions': [portions[0]]}
    assert client.put(path, json=archive).json()['revision'] == 3
    assert client.get(path).json()['archived'] is True
    assert client.post('/api/products', json=payload).json()['replayed'] is True
    assert client.put(path, json=edit).json()['replayed'] is True
    assert client.get(path).json()['revision'] == 3
    restore = {**archive, 'operation_id': str(uuid4()), 'expected_revision': 3, 'archived': False}
    assert client.put(path, json=restore).json()['revision'] == 4
    from diary.db import migrate
    migrate(database)
    migrate(database)
    assert client.get(path).json()['archived'] is False
    assert len(client.get('/api/products').json()) == 1


def test_unit_change_requires_explicit_values_confirmation_and_new_portions(diary):
    client, _ = diary
    payload = product()
    path = '/api/products/' + client.post('/api/products', json=payload).json()['result_id']
    edit = {**payload, 'operation_id': str(uuid4()), 'expected_revision': 1, 'unit': 'ml'}
    assert client.put(path, json=edit).json()['code'] == 'unit_change'
    edit['unit_change_confirmed'] = True
    assert client.put(path, json=edit).status_code == 422
    edit['portions'] = []
    missing = {k: v for k, v in edit.items() if k != 'protein'}
    assert client.put(path, json=missing).status_code == 422
    assert client.put(path, json=edit).status_code == 200
    saved = client.get(path).json()
    assert (saved['unit'], saved['portions'], saved['protein']) == ('ml', [], '10.00')


@pytest.mark.parametrize('field,value', [
    ('name', ''), ('name', ' \t '), ('name', 'я' * 201), ('unit', 'kg'),
    ('protein', 1), ('fat', True), ('calories', '1e2'), ('calories', 'NaN'),
    ('protein', '-1'), ('fat', 'Infinity'), ('carbohydrate', '0.001'),
    ('protein', '21474836.48'), ('protein', '9' * 10000), ('archived', 1),
    ('portions', [{'id': str(uuid4()), 'name': 'Порция', 'quantity': '0'}]),
    ('portions', [{'id': str(uuid4()), 'name': 'Порция', 'quantity': 1}]),
    ('portions', [{'id': 'invalid', 'name': 'Порция', 'quantity': '1'}]),
    ('portions', [{'id': str(uuid4()), 'name': ' ', 'quantity': '1'}]),
])
def test_invalid_card_never_partially_saved(diary, field, value):
    client, _ = diary
    response = client.post('/api/products', json=product(**{field: value}))
    assert response.status_code == 422
    assert response.json()['field']
    assert client.get('/api/products').json() == []


def test_independent_numbers_limits_duplicate_names_and_portion_ids(diary):
    client, _ = diary
    payload = product(protein='21474836,47000', fat='', carbohydrate=None, calories='0.000')
    assert client.post('/api/products', json=payload).status_code == 200
    assert client.post('/api/products', json={**payload, 'operation_id': str(uuid4())}).status_code == 200
    saved = client.get('/api/products').json()
    assert len(saved) == 2
    assert (saved[0]['protein'], saved[0]['fat'], saved[0]['carbohydrate'], saved[0]['calories']) == ('21474836.47', None, None, '0.00')
    assert client.post('/api/products', json=product(portions=payload['portions'] * 2)).status_code == 422


@pytest.mark.parametrize('fault', ['portion', 'receipt', 'commit'])
@pytest.mark.parametrize('editing', [False, True])
def test_atomic_rollback_and_retry(diary, fault, editing):
    from sqlalchemy import Engine, event
    from sqlalchemy.exc import OperationalError
    client, _ = diary
    path = '/api/products'
    if editing:
        path += '/' + client.post(path, json=product()).json()['result_id']
    before = client.get('/api/products').json()
    payload = product(**({'expected_revision': 1} if editing else {}))

    def fail_commit(connection):
        raise OperationalError('COMMIT', {}, Exception('synthetic failure'))

    def fail_write(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO ' + ('product_portion' if fault == 'portion' else 'operation_receipt')):
            raise OperationalError(statement, {}, Exception('synthetic failure'))

    hook, listener = ('commit', fail_commit) if fault == 'commit' else ('before_cursor_execute', fail_write)
    event.listen(Engine, hook, listener)
    try:
        assert client.request('PUT' if editing else 'POST', path, json=payload).status_code == 503
    finally:
        event.remove(Engine, hook, listener)
    assert client.get('/api/products').json() == before
    assert client.request('PUT' if editing else 'POST', path, json=payload).json()['replayed'] is False


def test_access_csrf_body_limit_and_operation_scope(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN
    client, database = diary
    payload = product()
    receipt = client.post('/api/products', json=payload).json()
    path = '/api/products/' + receipt['result_id']
    assert client.get(path).headers['cache-control'] == 'no-store'
    assert client.post('/api/products', json=payload, headers={'Origin': 'https://other.test'}).status_code == 403
    assert client.post('/api/products', json=payload, headers={'X-CSRF-Token': 'wrong'}).status_code == 403
    assert client.post('/api/products', content=b' ' * 65537).status_code == 413
    assert client.put(path, json={**payload, 'expected_revision': 1}).json()['code'] == 'operation_conflict'
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        for route in ['/api/products', path]:
            assert anonymous.get(route).status_code == 401
        assert anonymous.post('/api/products', json=product()).status_code == 401
    assert len(client.get('/api/products').json()) == 1


def test_concurrent_revisions_and_same_operation(diary):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN
    client, database = diary
    payload = product()

    def send(request):
        method, path, body = request
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as peer:
            peer.cookies.update(client.cookies)
            return peer.request(method, path, json=body, headers=dict(client.headers))

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(send, [('POST', '/api/products', payload)] * 2))
    assert all(r.status_code == 200 for r in responses)
    assert sorted(r.json()['replayed'] for r in responses) == [False, True]
    path = '/api/products/' + responses[0].json()['result_id']
    requests = [('PUT', path, product(expected_revision=1, archived=archived)) for archived in (True, False)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(send, requests))
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert client.get(path).json()['revision'] == 2


def test_upgrade_existing_diary_preserves_history_and_session(tmp_path):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
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
        command.upgrade(config, '004_temporary_basal')
    engine.dispose()
    create_account(database, 'owner', PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        headers = {'Origin': ORIGIN, 'X-CSRF-Token': client.get('/api/auth/csrf').json()['csrf_token']}
        assert client.post('/api/entries', json=entry(comment='Прежняя история'), headers=headers).status_code == 200
        before = client.get('/api/day?day=2026-10-19').json()
        migrate(database)
        migrate(database)
        assert client.get('/api/day?day=2026-10-19').json() == before
        assert client.get('/api/products').json() == []
        assert client.post('/api/products', json=product(), headers=headers).status_code == 200
