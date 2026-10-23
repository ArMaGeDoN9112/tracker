import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import insert

from diary.app import create_app
from diary.db import database_engine, migrate
from diary.application.operations import OperationAction
from diary.tables import operation_receipt
from test_access import ORIGIN
from test_entries import diary


CASES = json.loads((Path(__file__).parent / 'fixtures/compatibility/operation-receipts.json').read_text(encoding='utf-8'))


def test_legacy_fixture_covers_every_action():
    assert {case['stored_receipt']['action'] for case in CASES} == set(OperationAction)


@pytest.mark.parametrize('elapsed,undo_remaining', [(29999, 1), (30000, 0)])
def test_saved_receipts_replay_after_migration_and_restart_without_writes(diary, monkeypatch, elapsed, undo_remaining):
    client, database = diary
    engine = database_engine(database)
    try:
        with engine.begin() as connection:
            connection.execute(insert(operation_receipt), [case['stored_receipt'] for case in CASES])
    finally:
        engine.dispose()
    migrate(database)
    migrate(database)
    monkeypatch.setattr('diary.entries.now_ms', lambda: 1792400000000 + elapsed)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as restarted:
        restarted.cookies.update(client.cookies)
        restarted.headers.update(client.headers)
        before = restarted.get('/api/export').json()
        before.pop('exported_at')
        for case in CASES:
            response = restarted.request(case['method'], case['path'], json=case['request'])
            expected = {**case['response'], 'replayed': True,
                        'undo_remaining_ms': undo_remaining if case['response']['undo_remaining_ms'] else 0}
            assert response.status_code == 200, case['path']
            assert response.json() == expected
            # Changing revision or content under the saved UUID must never replay.
            changed = {**case['request']}
            if 'expected_revision' in changed:
                changed['expected_revision'] += 1
            elif 'volume_ml' in changed:
                changed['volume_ml'] += 1
            elif 'glucose' in changed:
                changed['glucose'] = '8.0'
            elif 'name' in changed:
                changed['name'] = 'Другой продукт'
            elif 'lines' in changed:
                changed['category'] = 'dinner'
            elif 'percent' in changed:
                changed['percent'] += 1
            else:
                changed['intervals'] = [{'minute': 0, 'rate': '2.00'}]
            conflict = restarted.request(case['method'], case['path'], json=changed)
            assert conflict.status_code == 409
            assert conflict.json() == {'code': 'operation_conflict',
                                       'message': 'UUID уже использован с другими данными.', 'field': 'operation_id'}
        after = restarted.get('/api/export').json()
        after.pop('exported_at')
        assert after == before
