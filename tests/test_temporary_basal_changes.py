from uuid import uuid4

import pytest

from test_entries import diary, entry
from test_basal import schedule
from test_temporary_basal import temporary


def test_historical_edit_recalculates_neighbors_and_event_basal(diary):
    client, _ = diary
    client.post('/api/basal-schedules', json=schedule(intervals=[{'minute': 0, 'rate': '0.50'}]))
    a = client.post('/api/temporary-basals', json=temporary()).json()['result_id']
    b = client.post('/api/temporary-basals', json=temporary(starts_at='2026-10-19T11:00:00+03:00', duration_minutes=60, percent=0)).json()['result_id']
    event = client.post('/api/entries', json=entry(occurred_at='2026-10-19T11:15:00+03:00')).json()['result_id']
    path = '/api/temporary-basals/' + b
    payload = {'operation_id': str(uuid4()), 'expected_revision': 1,
               'starts_at': '2026-10-19T11:30:00+03:00', 'ends_at': '2026-10-19T11:45:00+03:00', 'percent': 150}
    response = client.put(path, json=payload)
    assert response.status_code == 200
    history = client.get('/api/temporary-basals').json()
    assert history[0]['id'] == a
    assert history[0]['ends_at'] == '2026-10-19T11:00:00.000Z'
    assert history[0]['effective_ends_at'] == '2026-10-19T08:30:00.000Z'
    assert history[1]['duration_minutes'] == 60
    assert history[1]['revision'] == 2
    assert client.get('/api/entries/' + event).json()['basal'] == '0.60'
    assert client.get('/api/basal?at=2026-10-19T08:40:00Z').json()['basal'] == '0.75'
    assert client.get('/api/basal?at=2026-10-19T08:45:00Z').json()['basal'] == '0.50'
    assert client.put(path, json=payload).json() == {**response.json(), 'replayed': True}
    assert client.get(path).json() == history[1]


@pytest.mark.parametrize('elapsed,allowed', [(29999, True), (30000, False), (30001, False)])
def test_delete_b_undo_deadline_and_preserved_history(diary, monkeypatch, elapsed, allowed):
    client, database = diary
    clock = [1800000000000]
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: clock[0])
    client.post('/api/temporary-basals', json=temporary())
    original_payload = temporary(starts_at='2026-10-19T11:00:00+03:00', duration_minutes=60, percent=0)
    b = client.post('/api/temporary-basals', json=original_payload).json()['result_id']
    path = '/api/temporary-basals/' + b
    before = client.get('/api/temporary-basals').json()
    deletion = {'operation_id': str(uuid4()), 'expected_revision': 1}
    deleted = client.post(path + '/delete', json=deletion)
    assert deleted.status_code == 200
    assert deleted.json()['undo_remaining_ms'] == 30000
    assert client.get('/api/temporary-basals').json()[0]['effective_ends_at'] == '2026-10-19T11:00:00.000Z'
    assert client.get(path).json()['deleted_at'] == '2027-01-15T08:00:00.000Z'
    assert client.post('/api/temporary-basals', json=original_payload).json()['replayed'] is True
    clock[0] += elapsed
    restore_payload = {'operation_id': str(uuid4()), 'expected_revision': 2}
    restored = client.post(path + '/restore', json=restore_payload)
    assert restored.status_code == (200 if allowed else 409)
    if allowed:
        after = client.get('/api/temporary-basals').json()
        assert after[0] == before[0]
        assert after[1]['revision'] == 3
        assert after[1]['ends_at'] == before[1]['ends_at']
        assert client.post(path + '/restore', json=restore_payload).json()['replayed'] is True
    else:
        assert restored.json()['code'] == 'undo_expired'
        assert client.get(path).json()['revision'] == 2
    assert client.post(path + '/delete', json=deletion).json()['undo_remaining_ms'] == max(0, 30000 - elapsed)
    from diary.infrastructure.database import migrate
    from diary.app import create_app
    from fastapi.testclient import TestClient
    from test_access import ORIGIN
    before_restart = client.get(path).json()
    migrate(database)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as restarted:
        restarted.cookies.update(client.cookies)
        assert restarted.get(path).json() == before_restart
        assert restarted.post(path + '/delete', json=deletion, headers=dict(client.headers)).json()['replayed'] is True


def edit(row, **changes):
    return {'operation_id': str(uuid4()), 'expected_revision': row['revision'],
            'starts_at': row['starts_at'], 'ends_at': row['ends_at'], 'percent': row['percent'], **changes}


def test_move_across_neighbors_zero_period_and_outside_days_unchanged(diary):
    client, _ = diary
    for time, percent in [('10:00', 120), ('11:00', 0), ('13:00', 150)]:
        assert client.post('/api/temporary-basals', json=temporary(starts_at=f'2026-10-19T{time}:00+03:00', percent=percent)).status_code == 200
    before_days = [client.get('/api/day?day=' + day).json() for day in ['2026-10-18', '2026-10-20']]
    a, b, c = client.get('/api/temporary-basals').json()
    path = '/api/temporary-basals/' + b['id']
    assert client.put(path, json=edit(b, starts_at='2026-10-19T13:30:00+03:00', ends_at='2026-10-19T14:00:00+03:00')).status_code == 200
    after = client.get('/api/temporary-basals').json()
    assert [row['id'] for row in after] == [a['id'], c['id'], b['id']]
    assert [row['effective_ends_at'] for row in after] == ['2026-10-19T10:00:00.000Z', '2026-10-19T10:30:00.000Z', '2026-10-19T11:00:00.000Z']
    assert after[0]['ends_at'] == a['ends_at']
    assert after[1]['ends_at'] == c['ends_at']
    assert client.put(path, json=edit(after[2], ends_at=after[2]['starts_at'])).status_code == 200
    assert client.get('/api/temporary-basals').json()[2]['effective_ends_at'] == after[2]['starts_at']
    assert [client.get('/api/day?day=' + day).json() for day in ['2026-10-18', '2026-10-20']] == before_days


@pytest.mark.parametrize('changes', [
    {'ends_at': '2026-10-19T06:59:59.999Z'}, {'ends_at': '2026-10-19T11:00:00'},
    {'starts_at': 'bad'}, {'percent': -1}, {'percent': True}, {'percent': 2147483648},
    {'expected_revision': 0}, {'operation_id': 'bad'}, {'duration_minutes': 1},
])
def test_invalid_edit_leaves_period_unchanged(diary, changes):
    client, _ = diary
    receipt = client.post('/api/temporary-basals', json=temporary()).json()
    path = '/api/temporary-basals/' + receipt['result_id']
    before = client.get(path).json()
    assert client.put(path, json=edit(before, **changes)).status_code == 422
    assert client.get(path).json() == before


def test_revision_start_and_operation_conflicts_never_overwrite(diary):
    client, _ = diary
    for time in ['10:00', '11:00']:
        client.post('/api/temporary-basals', json=temporary(starts_at=f'2026-10-19T{time}:00+03:00'))
    a, b = client.get('/api/temporary-basals').json()
    path = '/api/temporary-basals/' + b['id']
    assert client.put(path, json=edit(b, starts_at=a['starts_at'])).json()['code'] == 'temporary_conflict'
    change = edit(b, percent=0)
    receipt = client.put(path, json=change).json()
    assert receipt['revision'] == 2
    assert client.put(path, json=edit(b)).json()['code'] == 'revision_conflict'
    assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1}).json()['code'] == 'revision_conflict'
    assert client.put(path, json={**change, 'percent': 50}).json()['code'] == 'operation_conflict'
    assert client.put('/api/temporary-basals/' + a['id'], json=change).json()['code'] == 'operation_conflict'
    deletion = {'operation_id': str(uuid4()), 'expected_revision': 2}
    client.post(path + '/delete', json=deletion)
    replacement = client.post('/api/temporary-basals', json=temporary(starts_at=b['starts_at'])).json()['result_id']
    restore = {'operation_id': str(uuid4()), 'expected_revision': 3}
    assert client.post(path + '/restore', json=restore).json()['code'] == 'temporary_conflict'
    assert client.get(path).json()['revision'] == 3
    assert client.get('/api/temporary-basals/' + replacement).json()['revision'] == 1
    assert client.put(path, json=change).json() == {**receipt, 'replayed': True}
    assert client.get(path).json()['deleted_at'] is not None


@pytest.mark.parametrize('actions', [('edit', 'edit'), ('edit', 'delete'), ('delete', 'delete'), ('restore', 'restore')])
def test_concurrent_changes_serialize_revision(diary, actions):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN

    client, database = diary
    period = client.post('/api/temporary-basals', json=temporary()).json()['result_id']
    path = '/api/temporary-basals/' + period
    if actions[0] == 'restore':
        client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1})
    row = client.get(path).json()
    barrier = Barrier(2)

    def change(action):
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as device:
            device.cookies.update(client.cookies)
            payload = edit(row, percent=50) if action == 'edit' else {'operation_id': str(uuid4()), 'expected_revision': row['revision']}
            barrier.wait(timeout=10)
            return device.request('PUT' if action == 'edit' else 'POST', path if action == 'edit' else path + '/' + action, json=payload, headers=dict(client.headers))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(change, actions))
    assert sorted(result.status_code for result in results) == [200, 409]
    assert client.get(path).json()['revision'] == row['revision'] + 1


@pytest.mark.parametrize('action', ['edit', 'delete', 'restore'])
@pytest.mark.parametrize('fault', ['commit', 'receipt', 'period'])
def test_failed_change_has_no_partial_state_or_receipt(diary, action, fault):
    from sqlalchemy import event
    from sqlalchemy.engine import Engine
    from sqlalchemy.exc import OperationalError

    client, _ = diary
    path = '/api/temporary-basals/' + client.post('/api/temporary-basals', json=temporary()).json()['result_id']
    if action == 'restore':
        client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1})
    before = client.get(path).json()
    payload = edit(before, percent=50) if action == 'edit' else {'operation_id': str(uuid4()), 'expected_revision': before['revision']}
    target = path if action == 'edit' else path + '/' + action
    method = 'PUT' if action == 'edit' else 'POST'

    def fail_commit(connection):
        raise OperationalError('COMMIT', {}, Exception('disk error'))

    def fail_write(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO operation_receipt' if fault == 'receipt' else 'UPDATE temporary_basal'):
            raise OperationalError(statement, {}, Exception('disk error'))

    hook, listener = ('commit', fail_commit) if fault == 'commit' else ('before_cursor_execute', fail_write)
    event.listen(Engine, hook, listener)
    try:
        assert client.request(method, target, json=payload).status_code == 503
    finally:
        event.remove(Engine, hook, listener)
    assert client.get(path).json() == before
    assert client.request(method, target, json=payload).json()['replayed'] is False
    assert client.request(method, target, json=payload).json()['replayed'] is True


def test_restore_races_with_new_period_at_same_start(diary):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN

    client, database = diary
    original = temporary()
    path = '/api/temporary-basals/' + client.post('/api/temporary-basals', json=original).json()['result_id']
    client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1})

    def save(restore):
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as device:
            device.cookies.update(client.cookies)
            payload = {'operation_id': str(uuid4()), 'expected_revision': 2} if restore else temporary()
            return device.post(path + '/restore' if restore else '/api/temporary-basals', json=payload, headers=dict(client.headers))

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, [True, False]))
    assert sorted(result.status_code for result in results) == [200, 409]
    assert len(client.get('/api/temporary-basals').json()) == 1


@pytest.mark.parametrize('action', ['edit', 'delete', 'restore'])
def test_changes_require_session_origin_and_csrf(diary, action):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN

    client, database = diary
    path = '/api/temporary-basals/' + client.post('/api/temporary-basals', json=temporary()).json()['result_id']
    row = client.get(path).json()
    method, target = ('PUT', path) if action == 'edit' else ('POST', path + '/' + action)
    payload = edit(row) if action == 'edit' else {'operation_id': str(uuid4()), 'expected_revision': 1}
    for headers in [{'Origin': 'https://foreign.test'}, {'X-CSRF-Token': 'wrong'}]:
        assert client.request(method, target, json=payload, headers=headers).status_code == 403
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        assert anonymous.request(method, target, json=payload).status_code == 401
        assert anonymous.get(path).status_code == 401
    assert client.get(path).json() == row
