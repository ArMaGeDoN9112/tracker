from uuid import uuid4

import pytest

from test_entries import diary
from test_meals import line, meal


def food(**values):
    return {'id': str(uuid4()), 'kind': 'one_off', 'name': 'Еда', **values}


def test_summary_water_uses_moscow_days_and_excludes_deleted_events(diary):
    client, _ = diary
    ids = []
    for at, volume in [('2026-02-01T20:59:59.999Z', 200), ('2026-02-01T21:00:00Z', 250),
                       ('2026-02-02T20:59:59.999Z', 500), ('2026-02-02T21:00:00Z', 100)]:
        response = client.post('/api/water', json={'operation_id': str(uuid4()), 'volume_ml': volume, 'occurred_at': at})
        assert response.status_code == 200
        ids.append(response.json()['result_id'])
    path = '/api/nutrition-summary?period=custom&start=2026-02-01&end=2026-02-28'
    summary = client.get(path).json()
    assert len(summary['days']) == 28
    assert [day['water_total_ml'] for day in summary['days'][:4]] == [200, 750, 100, None]
    assert summary['food_days'] == 0
    assert client.post(f'/api/water/{ids[1]}/delete', json={
        'operation_id': str(uuid4()), 'expected_revision': 1}).status_code == 200
    assert client.get(path).json()['days'][1]['water_total_ml'] == 500


def test_summary_known_days_incomplete_days_and_zero(diary):
    client, _ = diary
    for day, lines in [('2026-10-17', [food(carbohydrate='10', protein='0'), food()]),
                       ('2026-10-18', [food()])]:
        assert client.post('/api/meals', json=meal(lines, occurred_at=day + 'T12:00:00+03:00')).status_code == 200
    assert client.post('/api/water', json={'operation_id': str(uuid4()), 'volume_ml': 200,
                                         'occurred_at': '2026-10-19T12:00:00+03:00'}).status_code == 200
    path = '/api/nutrition-summary?period=custom&start=2026-10-17&end=2026-10-19'
    response = client.get(path)
    assert response.status_code == 200
    summary = response.json()
    assert summary['food_days'] == 2
    assert summary['meal_count'] == 2
    assert [day['meal_count'] for day in summary['days']] == [1, 1, 0]
    assert summary['averages']['carbohydrate'] == {
        'value': '10.00', 'known_days': 1, 'incomplete_days': 2, 'incomplete': True}
    assert summary['averages']['protein']['value'] == '0.00'
    assert summary['averages']['calories'] == {
        'value': None, 'known_days': 0, 'incomplete_days': 2, 'incomplete': True}
    assert summary['days'][0]['totals']['carbohydrate']['value'] == '10.00'
    assert summary['days'][2]['totals']['carbohydrate'] == {
        'value': None, 'known_count': 0, 'unknown_count': 0, 'incomplete': False}
    assert client.post('/api/meals', json=meal([food(carbohydrate='0')],
                       occurred_at='2026-10-19T12:00:00+03:00')).status_code == 200
    summary = client.get(path).json()
    assert summary['food_days'] == 3
    assert summary['averages']['carbohydrate'] == {
        'value': '5.00', 'known_days': 2, 'incomplete_days': 2, 'incomplete': True}


def test_summary_rounds_exact_contributions_independently_of_days(diary):
    client, _ = diary
    for day, quantity in [('17', '50'), ('18', '150')]:
        assert client.post('/api/meals', json=meal([line(client, quantity=quantity, carbohydrate='0.01')],
                           occurred_at=f'2026-10-{day}T12:00:00+03:00')).status_code == 200
    summary = client.get('/api/nutrition-summary?end=2026-10-19').json()
    assert [day['totals']['carbohydrate']['value'] for day in summary['days'][-3:]] == ['0.01', '0.02', None]
    assert summary['averages']['carbohydrate'] == {
        'value': '0.01', 'known_days': 2, 'incomplete_days': 0, 'incomplete': False}


def test_summary_periods_moscow_midnight_and_old_history(diary, monkeypatch):
    from datetime import datetime
    from diary.entries import milliseconds
    client, _ = diary
    monkeypatch.setattr('diary.meals.now_ms', lambda: milliseconds(datetime.fromisoformat('2026-10-19T21:00:00+00:00')))
    for at in ['2026-10-19T20:59:59.999Z', '2026-10-19T21:00:00Z', '2026-10-20T20:59:59.999Z', '2026-10-20T21:00:00Z']:
        assert client.post('/api/meals', json=meal([food(protein='2')], occurred_at=at)).status_code == 200
    week = client.get('/api/nutrition-summary').json()
    assert (week['start'], week['end'], len(week['days'])) == ('2026-10-14', '2026-10-20', 7)
    assert week['meal_count'] == 3
    assert week['days'][-1]['meal_count'] == 2
    month = client.get('/api/nutrition-summary?period=month&end=1901-02-02').json()
    assert (month['start'], month['end'], len(month['days'])) == ('1901-01-04', '1901-02-02', 30)
    assert month['food_days'] == month['meal_count'] == 0
    assert month['averages']['protein'] == {
        'value': None, 'known_days': 0, 'incomplete_days': 0, 'incomplete': False}
    old = client.get('/api/nutrition-summary?period=custom&start=1900-01-01&end=1900-03-01').json()
    assert len(old['days']) == 60
    single = client.get('/api/nutrition-summary?period=custom&start=2026-10-20&end=2026-10-20').json()
    assert single['meal_count'] == 2
    assert single['averages']['protein']['value'] == '4.00'


def test_summary_uses_snapshots_and_updates_after_edit_move_delete_restore(diary):
    from test_products import product
    client, _ = diary
    source = line(client, quantity='100')
    payload = meal([source, food(protein='5')])
    path = '/api/meals/' + client.post('/api/meals', json=payload).json()['result_id']
    summary_path = '/api/nutrition-summary?period=custom&start=2026-10-19&end=2026-10-20'
    before = client.get(summary_path).json()
    assert before['averages']['protein']['value'] == '15.00'
    assert client.put('/api/products/' + source['product_id'], json=product(
        expected_revision=1, name='Изменённый', unit='ml', portions=[], protein='99',
        unit_change_confirmed=True)).status_code == 200
    assert client.get(summary_path).json() == before
    edit = {**payload, 'operation_id': str(uuid4()), 'expected_revision': 1,
            'occurred_at': '2026-10-20T00:00:00+03:00', 'lines': [{**source, 'quantity': '200'}]}
    assert client.put(path, json=edit).status_code == 200
    moved = client.get(summary_path).json()
    assert [day['meal_count'] for day in moved['days']] == [0, 1]
    assert moved['averages']['protein']['value'] == '20.00'
    assert client.post(path + '/delete', json={'operation_id': str(uuid4()), 'expected_revision': 2}).status_code == 200
    assert client.get(summary_path).json()['food_days'] == 0
    assert client.post(path + '/restore', json={'operation_id': str(uuid4()), 'expected_revision': 3}).status_code == 200
    assert client.get(summary_path).json() == moved
    assert client.put(path, json={**edit, 'operation_id': str(uuid4()), 'expected_revision': 4,
                                 'occurred_at': '2026-10-21T00:00:00+03:00'}).status_code == 200
    assert client.get(summary_path).json()['meal_count'] == 0


@pytest.mark.parametrize('query,field', [
    ('period=custom&end=2026-10-20', 'start'),
    ('period=custom&start=2026-10-21&end=2026-10-20', 'start'),
    ('period=other', 'period'), ('end=bad', 'end'), ('end=0001-01-01', 'end'),
    ('end=9999-12-31', 'end'),
])
def test_summary_rejects_invalid_periods(diary, query, field):
    client, _ = diary
    response = client.get('/api/nutrition-summary?' + query)
    assert response.status_code == 422
    assert response.json()['field'] == field


def test_summary_is_private_and_not_cached(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN
    client, database = diary
    assert client.get('/api/nutrition-summary').headers['cache-control'] == 'no-store'
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        assert anonymous.get('/api/nutrition-summary').status_code == 401
