from uuid import uuid4

from test_entries import diary


def water(**changes):
    return {'operation_id': str(uuid4()), 'volume_ml': 250, **changes}


def test_quick_water_uses_server_time_and_replays_without_duplicates(diary, monkeypatch):
    client, _ = diary
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: 1792400000000)
    payload = water()
    first = client.post('/api/water', json=payload)
    assert first.status_code == 200
    saved = client.get('/api/water/' + first.json()['result_id']).json()
    assert saved['occurred_at'] == saved['created_at'] == '2026-10-19T08:53:20.000Z'
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: 1792486400000)
    assert client.post('/api/water', json=payload).json()['replayed'] is True
    second = client.post('/api/water', json=water(occurred_at=saved['occurred_at'])).json()
    assert second['result_id'] != first.json()['result_id']
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    assert len(day['water']) == 2
    assert day['water_total_ml'] == 500
    assert day['meals'] == []
    assert day['totals']['calories']['value'] is None
    assert client.post('/api/water', json={**payload, 'volume_ml': 500}).status_code == 409
import pytest
from fastapi.testclient import TestClient
from diary.app import create_app
from diary.db import migrate
from test_access import ORIGIN, login


def test_settings_persist_restart_and_replay_does_not_revert_later_edits(diary):
    client, database = diary
    assert client.get('/api/water-settings').json() == {'volumes_ml': [200, 250, 500], 'revision': 1}
    payload = {'operation_id': str(uuid4()), 'expected_revision': 1, 'volumes_ml': [500, 100, 1, 2147483647]}
    assert client.put('/api/water-settings', json=payload).json()['revision'] == 2
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as restarted:
        login(restarted)
        assert restarted.get('/api/water-settings').json() == {'volumes_ml': payload['volumes_ml'], 'revision': 2}
    assert client.put('/api/water-settings', json={**payload, 'operation_id': str(uuid4())}).status_code == 409
    assert client.put('/api/water-settings', json={**payload, 'operation_id': str(uuid4()), 'expected_revision': 2, 'volumes_ml': []}).status_code == 200
    assert client.put('/api/water-settings', json=payload).json()['replayed'] is True
    assert client.get('/api/water-settings').json() == {'volumes_ml': [], 'revision': 3}
    assert client.put('/api/water-settings', json={**payload, 'volumes_ml': [100]}).status_code == 409


@pytest.mark.parametrize('value', [0, -1, 2147483648, 1.5, 1.0, True, '250', None])
def test_volume_ranges_are_strict_in_events_and_settings(diary, value):
    client, _ = diary
    assert client.post('/api/water', json=water(volume_ml=value)).status_code == 422
    response = client.put('/api/water-settings', json={'operation_id': str(uuid4()), 'expected_revision': 1, 'volumes_ml': [value]})
    assert response.status_code == 422
    assert client.get('/api/water-settings').json()['revision'] == 1
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['water_total_ml'] is None


def test_unique_buttons_and_maximum_volume(diary):
    client, _ = diary
    assert client.put('/api/water-settings', json={'operation_id': str(uuid4()), 'expected_revision': 1, 'volumes_ml': [250, 250]}).status_code == 422
    for amount in [1, 2147483647]:
        assert client.post('/api/water', json=water(volume_ml=amount, occurred_at='2026-10-19T12:00:00+03:00')).status_code == 200
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['water_total_ml'] == 2147483648


@pytest.mark.parametrize('elapsed,status', [(29999, 200), (30000, 409)])
def test_move_delete_restore_and_old_receipts(diary, monkeypatch, elapsed, status):
    client, _ = diary
    clock = 1792400000000
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: clock)
    payload = water(occurred_at='2026-10-19T23:59:59.999+03:00')
    path = '/api/water/' + client.post('/api/water', json=payload).json()['result_id']
    edit = water(volume_ml=500, occurred_at='2026-10-20T00:00:00+03:00', expected_revision=1)
    assert client.put(path, json=edit).status_code == 200
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['water_total_ml'] is None
    assert client.get('/api/nutrition-day?day=2026-10-20').json()['water_total_ml'] == 500
    assert client.put(path, json={**edit, 'operation_id': str(uuid4())}).status_code == 409
    deletion = {'operation_id': str(uuid4()), 'expected_revision': 2}
    assert client.post(path + '/delete', json=deletion).json()['undo_remaining_ms'] == 30000
    clock += elapsed
    assert client.post(path + '/delete', json=deletion).json()['undo_remaining_ms'] == 30000 - elapsed
    assert client.post('/api/water', json=payload).json()['replayed'] is True
    assert client.put(path, json=edit).json()['replayed'] is True
    assert client.get('/api/nutrition-day?day=2026-10-20').json()['water'] == []
    response = client.post(path + '/restore', json={'operation_id': str(uuid4()), 'expected_revision': 3})
    assert response.status_code == status
    assert client.get('/api/nutrition-day?day=2026-10-20').json()['water_total_ml'] == (500 if status == 200 else None)


def test_moscow_boundaries_and_stable_order_and_no_implicit_water(diary, monkeypatch):
    from test_meals import meal
    client, _ = diary
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: 1792400000000)
    for at in ['2026-10-18T23:59:59.999+03:00', '2026-10-19T00:00:00+03:00', '2026-10-19T00:00:00+03:00', '2026-10-20T00:00:00+03:00']:
        assert client.post('/api/water', json=water(occurred_at=at)).status_code == 200
    day = client.get('/api/nutrition-day?day=2026-10-19').json()
    assert len(day['water']) == 2
    assert [w['id'] for w in day['water']] == sorted(w['id'] for w in day['water'])
    assert day['water_total_ml'] == 500
    assert client.post('/api/meals', json=meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Вода', 'quantity': '500', 'unit': 'ml'}])).status_code == 200
    assert client.get('/api/nutrition-day?day=2026-10-19').json()['water'] == day['water']


@pytest.mark.parametrize('settings', [False, True])
@pytest.mark.parametrize('fault', ['receipt', 'commit'])
def test_rollback_and_retry(diary, settings, fault):
    from sqlalchemy import Engine, event
    from sqlalchemy.exc import OperationalError
    client, _ = diary
    path = '/api/water-settings' if settings else '/api/water'
    payload = {'operation_id': str(uuid4()), 'expected_revision': 1, 'volumes_ml': []} if settings else water(occurred_at='2026-10-19T12:00:00+03:00')
    method = 'PUT' if settings else 'POST'
    before = client.get('/api/water-settings').json() if settings else client.get('/api/nutrition-day?day=2026-10-19').json()
    def fail_commit(connection):
        raise OperationalError('COMMIT', {}, Exception('synthetic'))
    def fail_write(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO operation_receipt'):
            raise OperationalError(statement, {}, Exception('synthetic'))
    hook, listener = ('commit', fail_commit) if fault == 'commit' else ('before_cursor_execute', fail_write)
    event.listen(Engine, hook, listener)
    try:
        response = client.request(method, path, json=payload)
        assert response.status_code == 503
        assert response.json() == {'code': 'unavailable', 'message': 'Операция не сохранена. Повторите позже.', 'field': None}
    finally:
        event.remove(Engine, hook, listener)
    after = client.get('/api/water-settings').json() if settings else client.get('/api/nutrition-day?day=2026-10-19').json()
    assert after == before
    assert client.request(method, path, json=payload).json()['replayed'] is False


@pytest.mark.parametrize('settings', [False, True])
def test_concurrent_replay_and_competing_changes(diary, settings):
    from concurrent.futures import ThreadPoolExecutor
    client, database = diary
    def send(request):
        method, path, payload = request
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as peer:
            peer.cookies.update(client.cookies)
            return peer.request(method, path, json=payload, headers=dict(client.headers))
    payload = {'operation_id': str(uuid4()), 'expected_revision': 1, 'volumes_ml': []} if settings else water()
    path, method = ('/api/water-settings', 'PUT') if settings else ('/api/water', 'POST')
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(send, [(method, path, payload)] * 2))
    assert sorted(r.json()['replayed'] for r in results) == [False, True]
    path = '/api/water-settings' if settings else '/api/water/' + results[0].json()['result_id']
    edit = {'operation_id': str(uuid4()), 'expected_revision': 2, 'volumes_ml': [100]} if settings else water(expected_revision=1, occurred_at='2026-10-19T12:00:00+03:00')
    rival = {**edit, 'operation_id': str(uuid4()), 'volumes_ml': [500]} if settings else {'operation_id': str(uuid4()), 'expected_revision': 1}
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(send, [('PUT', path, edit), ('PUT' if settings else 'POST', path if settings else path + '/delete', rival)]))
    assert sorted(r.status_code for r in results) == [200, 409]


def test_access_validation_and_body_limit(diary):
    client, database = diary
    payload = water()
    for path in ['/api/water', '/api/water-settings']:
        method = 'PUT' if path.endswith('settings') else 'POST'
        assert client.request(method, path, json=payload, headers={'Origin': 'https://other.test'}).status_code == 403
        assert client.request(method, path, json=payload, headers={'X-CSRF-Token': 'wrong'}).status_code == 403
        assert client.request(method, path, content=b' ' * 65537).status_code == 413
    path = '/api/water/' + client.post('/api/water', json=payload).json()['result_id']
    for route in [path, '/api/water-settings', '/api/nutrition-day?day=2026-10-19']:
        assert client.get(route).headers['cache-control'] == 'no-store'
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
            assert anonymous.get(route).status_code == 401
    for value in ['bad', '2026-10-19T12:00:00', '2026-10-19T12:00:00.0001Z']:
        response = client.post('/api/water', json=water(occurred_at=value))
        assert response.status_code == 422
        assert response.json()['field'] == 'occurred_at'


def test_upgrade_previous_schema_preserves_diary_and_meals(tmp_path):
    from pathlib import Path
    from alembic import command
    from alembic.config import Config
    from diary.db import database_engine
    from diary.admin import create_account
    from test_access import PASSWORD
    from test_entries import entry
    from test_meals import meal
    database = tmp_path / 'previous.sqlite3'
    config = Config()
    config.set_main_option('script_location', str(Path(__file__).resolve().parents[1] / 'migrations'))
    engine = database_engine(database)
    with engine.begin() as connection:
        config.attributes['connection'] = connection
        command.upgrade(config, '007_one_off_meals')
    engine.dispose()
    create_account(database, 'owner', PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        client.headers.update({'Origin': ORIGIN, 'X-CSRF-Token': client.get('/api/auth/csrf').json()['csrf_token']})
        assert client.post('/api/entries', json=entry()).status_code == 200
        record = client.post('/api/meals', json=meal([{'id': str(uuid4()), 'kind': 'one_off', 'name': 'Еда'}])).json()
        old_entry = client.get('/api/day?day=2026-10-19').json()
        old_meal = client.get('/api/meals/' + record['result_id']).json()
        migrate(database)
        migrate(database)
        assert client.get('/api/day?day=2026-10-19').json() == old_entry
        assert client.get('/api/meals/' + record['result_id']).json() == old_meal
        assert client.get('/api/water-settings').json() == {'volumes_ml': [200, 250, 500], 'revision': 1}
        assert client.get('/api/nutrition-day?day=2026-10-19').json()['water_total_ml'] is None
