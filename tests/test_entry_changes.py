from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from test_entries import diary, entry
from test_access import ORIGIN
from diary.app import create_app
from diary.infrastructure.database import migrate


def test_edit_and_move_preserve_creation_and_untouched_time(diary):
    client, _ = diary
    receipt = client.post('/api/entries', json=entry(occurred_at='2026-10-19T12:34:56.789+03:00')).json()
    path = '/api/entries/' + receipt['result_id']
    original = client.get(path).json()
    payload = entry(occurred_at=original['occurred_at'], glucose='8,1', bolus='1,2', reason='food', comment='Исправлено', expected_revision=1)
    response = client.put(path, json=payload)
    assert response.status_code == 200
    changed = client.get(path).json()
    assert changed['occurred_at'] == '2026-10-19T09:34:56.789Z'
    assert changed['created_at'] == original['created_at']
    assert (changed['revision'], changed['glucose'], changed['bolus'], changed['reason'], changed['comment']) == (2, '8.1', '1.2', 'food', 'Исправлено')
    moved = {**payload, 'operation_id': str(uuid4()), 'expected_revision': 2, 'occurred_at': '2026-10-20T00:00:00+03:00'}
    assert client.put(path, json=moved).json()['revision'] == 3
    assert client.get('/api/day?day=2026-10-19').json()['entries'] == []
    assert client.get('/api/day?day=2026-10-20').json()['entries'][0]['id'] == original['id']


@pytest.mark.parametrize('elapsed,allowed', [(29999, True), (30000, False), (30001, False)])
def test_delete_and_undo_server_deadline(diary, monkeypatch, elapsed, allowed):
    client, _ = diary
    clock = [1800000000000]
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: clock[0])
    payload = entry()
    created = client.post('/api/entries', json=payload).json()
    path = '/api/entries/' + created['result_id']
    deletion = {'operation_id': str(uuid4()), 'expected_revision': 1}
    response = client.post(path + '/delete', json=deletion)
    assert response.status_code == 200
    assert response.json()['revision'] == 2
    assert response.json()['undo_remaining_ms'] == 30000
    assert client.get('/api/day?day=2026-10-19').json()['entries'] == []
    assert client.get(path).json()['deleted_at'] == '2027-01-15T08:00:00.000Z'
    # A late create retry returns its receipt, never resurrecting the entry.
    assert client.post('/api/entries', json=payload).json()['replayed'] is True
    clock[0] += elapsed
    undo = {'operation_id': str(uuid4()), 'expected_revision': 2}
    restored = client.post(path + '/restore', json=undo)
    assert restored.status_code == (200 if allowed else 409)
    assert len(client.get('/api/day?day=2026-10-19').json()['entries']) == int(allowed)
    if allowed:
        assert restored.json()['revision'] == 3
        assert client.get(path).json()['deleted_at'] is None
    else:
        assert restored.json()['code'] == 'undo_expired'
        assert client.get(path).json()['revision'] == 2
    assert client.post(path + '/delete', json=deletion).json()['replayed'] is True


@pytest.mark.parametrize('actions', [('edit', 'edit'), ('edit', 'delete'), ('delete', 'delete'), ('restore', 'restore')])
def test_concurrent_changes_accept_only_one_revision(diary, actions):
    client, database = diary
    created = client.post('/api/entries', json=entry()).json()
    path = '/api/entries/' + created['result_id']
    revision = 1
    if actions[0] == 'restore':
        assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1}).status_code == 200
        revision = 2
    barrier = Barrier(2)
    cookie = client.cookies.get('__Host-diary-session')
    headers = dict(client.headers)

    def change(action):
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as device:
            device.cookies.set('__Host-diary-session', cookie)
            payload = {'operation_id': str(uuid4()), 'expected_revision': revision}
            if action == 'edit':
                payload = entry(**payload, comment='Concurrent change')
            barrier.wait(timeout=10)
            return device.request('PUT' if action == 'edit' else 'POST', path if action == 'edit' else path + '/' + action,
                                  json=payload, headers=headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(change, actions))
    assert sorted(response.status_code for response in responses) == [200, 409]
    assert next(response for response in responses if response.status_code == 409).json()['code'] == 'revision_conflict'
    assert client.get(path).json()['revision'] == revision + 1


def test_old_receipts_do_not_overwrite_later_edits_or_deletions(diary, monkeypatch):
    client, database = diary
    clock = [1800000000000]
    monkeypatch.setattr('diary.bootstrap.now_ms', lambda: clock[0])
    created = client.post('/api/entries', json=entry()).json()
    path = '/api/entries/' + created['result_id']
    edit = entry(expected_revision=1, comment='First edit')
    assert client.put(path, json=edit).json()['revision'] == 2
    deletion = {'operation_id': str(uuid4()), 'expected_revision': 2}
    assert client.post(path + '/delete', json=deletion).json()['revision'] == 3
    restore = {'operation_id': str(uuid4()), 'expected_revision': 3}
    restored = client.post(path + '/restore', json=restore).json()
    assert restored['revision'] == 4
    later = entry(expected_revision=4, comment='Later edit')
    assert client.put(path, json=later).json()['revision'] == 5
    clock[0] += 60000
    for url, payload, method in [(path, edit, 'PUT'), (path + '/delete', deletion, 'POST'), (path + '/restore', restore, 'POST')]:
        replay = client.request(method, url, json=payload)
        assert replay.status_code == 200
        assert replay.json()['replayed'] is True
    assert client.get(path).json()['comment'] == 'Later edit'
    assert client.get(path).json()['revision'] == 5
    assert client.post(path + '/delete', json={**deletion, 'expected_revision': 5}).json()['code'] == 'operation_conflict'
    assert client.post(path + '/restore', json=deletion).json()['code'] == 'operation_conflict'
    second = client.post('/api/entries', json=entry()).json()['result_id']
    assert client.put('/api/entries/' + second, json=edit).json()['code'] == 'operation_conflict'
    assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 5}).json()['revision'] == 6
    migrate(database)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as restarted:
        restarted.cookies.update(client.cookies)
        saved = restarted.get(path).json()
        assert (saved['revision'], saved['comment'], saved['deleted_at']) == (6, 'Later edit', '2027-01-15T08:01:00.000Z')
        assert all(row['id'] != saved['id'] for row in restarted.get('/api/day?day=2026-10-19').json()['entries'])
        assert restarted.post(path + '/restore', json=restore, headers=dict(client.headers)).json()['replayed'] is True
        assert restarted.get(path).json() == saved


@pytest.mark.parametrize('action', ['edit', 'delete', 'restore'])
@pytest.mark.parametrize('fault', ['commit', 'receipt'])
def test_failed_change_has_no_partial_write_or_success_receipt(diary, action, fault):
    from sqlalchemy import event
    from sqlalchemy.engine import Engine
    from sqlalchemy.exc import OperationalError

    client, _ = diary
    path = '/api/entries/' + client.post('/api/entries', json=entry()).json()['result_id']
    if action == 'restore':
        client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1})
    before = client.get(path).json()
    payload = {'operation_id': str(uuid4()), 'expected_revision': before['revision']}
    if action == 'edit':
        payload = entry(**payload, comment='Changed')
    url, method = (path, 'PUT') if action == 'edit' else (path + '/' + action, 'POST')

    def fail_commit(connection):
        raise OperationalError('COMMIT', {}, Exception('I/O error'))

    def fail_receipt(connection, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO operation_receipt'):
            raise OperationalError(statement, {}, Exception('database is full'))

    hook, listener = ('commit', fail_commit) if fault == 'commit' else ('before_cursor_execute', fail_receipt)
    event.listen(Engine, hook, listener)
    try:
        assert client.request(method, url, json=payload).status_code == 503
    finally:
        event.remove(Engine, hook, listener)
    assert client.get(path).json() == before
    result = client.request(method, url, json=payload).json()
    assert result['replayed'] is False
    assert result['revision'] == before['revision'] + 1


@pytest.mark.parametrize('changes,field', [({'glucose': '0'}, 'glucose'), ({'bolus': 'NaN'}, 'bolus'),
    ({'occurred_at': '2026-10-19T12:00:00'}, 'occurred_at'), ({'comment': 'x' * 10001}, 'comment'),
    ({'expected_revision': True}, 'expected_revision'), ({'expected_revision': 0}, 'expected_revision')])
def test_edit_uses_existing_validation_without_changing_entry(diary, changes, field):
    client, _ = diary
    path = '/api/entries/' + client.post('/api/entries', json=entry()).json()['result_id']
    before = client.get(path).json()
    result = client.put(path, json=entry(expected_revision=1, **changes) if 'expected_revision' not in changes else entry(**changes))
    assert result.status_code == 422
    assert result.json()['field'] == field
    assert client.get(path).json() == before


@pytest.mark.parametrize('action', ['edit', 'delete', 'restore'])
def test_changes_require_session_and_csrf(diary, action):
    client, database = diary
    path = '/api/entries/' + client.post('/api/entries', json=entry()).json()['result_id']
    before = client.get(path).json()
    payload = entry(expected_revision=1) if action == 'edit' else {'operation_id': str(uuid4()), 'expected_revision': 1}
    method, url = ('PUT', path) if action == 'edit' else ('POST', path + '/' + action)
    assert client.request(method, url, json=payload, headers={'X-CSRF-Token': 'wrong'}).status_code == 403
    assert client.get(path).json() == before
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        assert anonymous.request(method, url, json=payload, headers={'Origin': ORIGIN}).status_code == 401
        assert anonymous.get(path).status_code == 401


def test_missing_entry_and_deleted_state_conflicts(diary):
    client, _ = diary
    missing = '/api/entries/' + str(uuid4())
    assert client.get(missing).status_code == 404
    assert client.put(missing, json=entry(expected_revision=1)).status_code == 404
    for action in ['delete', 'restore']:
        assert client.post(missing + '/' + action, json={'operation_id': str(uuid4()), 'expected_revision': 1}).status_code == 404
    path = '/api/entries/' + client.post('/api/entries', json=entry()).json()['result_id']
    assert client.post(path + '/restore', json={'operation_id': str(uuid4()), 'expected_revision': 1}).json()['code'] == 'revision_conflict'
    assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 1}).status_code == 200
    assert client.put(path, json=entry(expected_revision=2)).json()['code'] == 'revision_conflict'
    assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 2}).json()['code'] == 'revision_conflict'
