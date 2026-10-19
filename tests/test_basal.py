from uuid import uuid4

import pytest

from test_entries import diary, entry


def schedule(**changes):
    return {"operation_id": str(uuid4()), "starts_at": "2026-10-19T00:00:00+03:00",
            "intervals": [{"minute": 0, "rate": "0,50"}, {"minute": 360, "rate": "0.80"}], **changes}


def test_schedule_drives_existing_events_and_day_boundaries(diary):
    client, _ = diary
    for instant in ["2026-10-19T05:59:59.999+03:00", "2026-10-19T06:00:00+03:00",
                    "2026-10-19T23:59:59.999+03:00", "2026-10-20T00:00:00+03:00"]:
        assert client.post("/api/entries", json=entry(occurred_at=instant)).status_code == 200
    response = client.post("/api/basal-schedules", json=schedule())
    assert response.status_code == 200
    day = client.get("/api/day?day=2026-10-19").json()
    assert day["basal"] == "0.50"
    assert [row["basal"] for row in day["entries"]] == ["0.50", "0.80", "0.80"]
    assert day["basal_changes"] == [{"occurred_at": "2026-10-19T03:00:00.000Z", "basal": "0.80"}]
    tomorrow = client.get("/api/day?day=2026-10-20").json()
    assert tomorrow["basal"] == tomorrow["entries"][0]["basal"] == "0.50"
    saved = client.get(f'/api/entries/{day["entries"][1]["id"]}').json()
    assert saved["basal"] == "0.80"
    history = client.get("/api/basal-schedules").json()
    assert history[0]["id"] == response.json()["result_id"]
    assert history[0]["ends_at"] is None
    assert history[0]["intervals"][0]["rate"] == "0.50"


def test_future_and_inserted_history_only_change_their_period(diary):
    client, _ = diary
    assert client.get("/api/day?day=2026-10-19").json()["basal"] is None
    first = schedule(starts_at="2026-10-19T12:00:00+03:00")
    future = schedule(starts_at="2027-01-01T00:00:00+03:00", intervals=[{"minute": 0, "rate": "2"}])
    for payload in [first, future]:
        assert client.post("/api/basal-schedules", json=payload).status_code == 200
    inserted = schedule(starts_at="2026-10-20T08:00:00+03:00", intervals=[{"minute": 0, "rate": "0"}])
    assert client.post("/api/basal-schedules", json=inserted).status_code == 200
    for instant, expected in [("2026-10-19T11:59:59.999+03:00", None),
                              ("2026-10-19T12:00:00+03:00", "0.80"),
                              ("2026-10-20T07:59:59.999+03:00", "0.80"),
                              ("2026-10-20T08:00:00+03:00", "0.00"),
                              ("2026-12-31T23:59:59.999+03:00", "0.00"),
                              ("2027-01-01T00:00:00+03:00", "2.00")]:
        assert client.get("/api/basal", params={"at": instant}).json() == {"basal": expected}
    history = client.get("/api/basal-schedules").json()
    assert [version["ends_at"] for version in history] == ["2026-10-20T05:00:00.000Z", "2026-12-31T21:00:00.000Z", None]
    day = client.get("/api/day?day=2026-10-19").json()
    assert day["basal"] is None
    assert day["basal_changes"] == [{"occurred_at": "2026-10-19T09:00:00.000Z", "basal": "0.80"}]


@pytest.mark.parametrize("intervals", [[], [{"minute": 1, "rate": "0.5"}],
    [{"minute": 0, "rate": "0.5"}, {"minute": 0, "rate": "1"}],
    [{"minute": 0, "rate": "0"}, {"minute": 60, "rate": "1"}, {"minute": 30, "rate": "2"}],
    [{"minute": -1, "rate": "0"}], [{"minute": 1440, "rate": "0"}],
    [{"minute": True, "rate": "0"}], [{"minute": 0.5, "rate": "0"}],
    *[[{"minute": 0, "rate": rate}] for rate in ["-1", "NaN", "Infinity", "1e2", "0.001", "21474836.48", "", 0.5]],
])
def test_invalid_schedule_is_not_saved(diary, intervals):
    client, _ = diary
    response = client.post("/api/basal-schedules", json=schedule(intervals=intervals))
    assert response.status_code == 422
    assert client.get("/api/basal-schedules").json() == []


def test_normalized_replay_and_conflicts_link_immutable_version(diary):
    client, _ = diary
    payload = schedule(intervals=[{"minute": 0, "rate": "21474836,4700"}])
    receipt = client.post("/api/basal-schedules", json=payload).json()
    payload["intervals"][0]["rate"] = "21474836.47"
    replay = client.post("/api/basal-schedules", json=payload).json()
    assert replay == {**receipt, "replayed": True}
    assert client.post("/api/basal-schedules", json={**payload, "starts_at": "2026-10-19T00:01:00+03:00"}).status_code == 409
    conflict = client.post("/api/basal-schedules", json=schedule()).json()
    assert conflict["existing_id"] == receipt["result_id"]
    assert conflict["href"] == f'#schedule-{receipt["result_id"]}'
    assert len(client.get("/api/basal-schedules").json()) == 1
    for method in [client.put, client.delete]:
        assert method(f'/api/basal-schedules/{receipt["result_id"]}').status_code == 404


def test_moscow_clock_rollback_changes_rate_at_transition(diary):
    client, _ = diary
    payload = schedule(starts_at="2014-10-25T00:00:00+04:00", intervals=[
        {"minute": 0, "rate": "0.5"}, {"minute": 90, "rate": "1"}])
    assert client.post("/api/basal-schedules", json=payload).status_code == 200
    day = client.get("/api/day?day=2014-10-26").json()
    assert day["basal_changes"] == [
        {"occurred_at": "2014-10-25T21:30:00.000Z", "basal": "1.00"},
        {"occurred_at": "2014-10-25T22:00:00.000Z", "basal": "0.50"},
        {"occurred_at": "2014-10-25T22:30:00.000Z", "basal": "1.00"}]


@pytest.mark.parametrize("fault", ["commit", "receipt", "interval", "locked"])
def test_failed_save_has_no_partial_version_or_receipt(diary, fault):
    from sqlalchemy import event
    from sqlalchemy.engine import Engine
    from sqlalchemy.exc import OperationalError

    client, _ = diary
    payload = schedule()

    def fail_commit(connection):
        raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

    def fail_write(connection, cursor, statement, parameters, context, executemany):
        if ((fault == "receipt" and statement.startswith("INSERT INTO operation_receipt"))
            or (fault == "interval" and statement.startswith("INSERT INTO basal_interval"))
            or (fault == "locked" and statement == "BEGIN IMMEDIATE")):
            raise OperationalError(statement, {}, Exception("database unavailable"))

    hook, listener = ("commit", fail_commit) if fault == "commit" else ("before_cursor_execute", fail_write)
    event.listen(Engine, hook, listener)
    try:
        assert client.post("/api/basal-schedules", json=payload).status_code == 503
    finally:
        event.remove(Engine, hook, listener)
    assert client.get("/api/basal-schedules").json() == []
    assert client.post("/api/basal-schedules", json=payload).json()["replayed"] is False


def test_schedule_access_requires_session_origin_and_csrf(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN

    client, database = diary
    for headers in [{"X-CSRF-Token": "wrong"}, {"Origin": "https://foreign.test"}]:
        assert client.post("/api/basal-schedules", json=schedule(), headers=headers).status_code == 403
    assert client.get("/api/basal-schedules").json() == []
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        for path in ["/api/basal-schedules", "/api/basal?at=2026-10-19T00:00:00Z"]:
            assert anonymous.get(path).status_code == 401
        assert anonymous.post("/api/basal-schedules", json=schedule()).status_code == 401


def test_concurrent_versions_with_occupied_start_are_serialized(diary):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN

    client, database = diary
    cookie = client.cookies.get("__Host-diary-session")

    def save(payload):
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as device:
            device.cookies.set("__Host-diary-session", cookie)
            return device.post("/api/basal-schedules", json=payload, headers=dict(client.headers))

    payload = schedule()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, [payload, payload]))
    assert {result.json()["replayed"] for result in responses} == {False, True}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, [schedule(starts_at="2026-10-20T00:00:00Z"), schedule(starts_at="2026-10-20T00:00:00Z")]))
    assert sorted(result.status_code for result in responses) == [200, 409]
    assert len(client.get("/api/basal-schedules").json()) == 2


def test_history_and_replays_survive_migration_and_restart(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from diary.db import migrate
    from test_access import ORIGIN

    client, database = diary
    payload = schedule()
    receipt = client.post("/api/basal-schedules", json=payload).json()
    before = client.get("/api/basal-schedules").json()
    migrate(database)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as restarted:
        restarted.cookies.update(client.cookies)
        assert restarted.get("/api/basal-schedules").json() == before
        assert restarted.post("/api/basal-schedules", json=payload, headers=dict(client.headers)).json() == {**receipt, "replayed": True}


def test_migration_from_previous_schema_keeps_entries_and_session(tmp_path):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    from fastapi.testclient import TestClient
    from diary.admin import create_account
    from diary.app import create_app
    from diary.db import database_engine, migrate
    from test_access import ORIGIN, PASSWORD, login

    database = tmp_path / "previous.sqlite3"
    engine = database_engine(database)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "002_entries")
    engine.dispose()
    create_account(database, "owner", PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        headers = {"Origin": ORIGIN, "X-CSRF-Token": client.get("/api/auth/csrf").json()["csrf_token"]}
        payload = entry()
        receipt = client.post("/api/entries", json=payload, headers=headers).json()
        migrate(database)
        saved = client.get(f'/api/entries/{receipt["result_id"]}').json()
        assert saved["glucose"] == "5.6"
        assert saved["basal"] is None
        assert client.post("/api/entries", json=payload, headers=headers).json()["replayed"] is True
        assert client.post("/api/basal-schedules", json=schedule(), headers=headers).status_code == 200


@pytest.mark.parametrize("start", ["2026-10-19T00:00:00", "bad", "2026-02-30T00:00:00Z", "0001-01-01T00:00:00+23:00"])
def test_schedule_rejects_invalid_absolute_time(diary, start):
    client, _ = diary
    response = client.post("/api/basal-schedules", json=schedule(starts_at=start))
    assert response.status_code == 422
    assert response.json()["field"] == "starts_at"
    assert client.get("/api/basal", params={"at": start}).status_code == 422


def test_day_with_nonexistent_midnight_keeps_local_interval_minutes(diary):
    client, _ = diary
    assert client.post("/api/basal-schedules", json=schedule(starts_at="1930-06-20T00:00:00+02:00", intervals=[
        {"minute": 0, "rate": "0.5"}, {"minute": 120, "rate": "1"}])).status_code == 200
    day = client.get("/api/day?day=1930-06-21").json()
    assert day["basal"] == "0.50"
    assert day["basal_changes"] == [{"occurred_at": "1930-06-20T23:00:00.000Z", "basal": "1.00"}]
