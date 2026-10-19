from uuid import uuid4

import pytest

from test_entries import diary, entry
from test_basal import schedule


def temporary(**changes):
    return {"operation_id": str(uuid4()), "starts_at": "2026-10-19T10:00:00+03:00",
            "duration_minutes": 240, "percent": 120, **changes}


def test_replacement_does_not_resume_previous_temporary_basal(diary):
    client, _ = diary
    assert client.post("/api/basal-schedules", json=schedule(intervals=[{"minute": 0, "rate": "0.50"}])).status_code == 200
    first = client.post("/api/temporary-basals", json=temporary())
    assert first.status_code == 200
    assert client.post("/api/temporary-basals", json=temporary(starts_at="2026-10-19T11:00:00+03:00", duration_minutes=60, percent=0)).status_code == 200
    for clock, expected in [("09:59:59.999", "0.50"), ("10:00:00", "0.60"), ("11:00:00", "0.00"), ("12:00:00", "0.50"), ("13:00:00", "0.50")]:
        at = f"2026-10-19T{clock}+03:00"
        assert client.get("/api/basal", params={"at": at}).json() == {"basal": expected}
        receipt = client.post("/api/entries", json=entry(occurred_at=at)).json()
        assert client.get(f'/api/entries/{receipt["result_id"]}').json()["basal"] == expected
    history = client.get("/api/temporary-basals").json()
    assert history[0]["id"] == first.json()["result_id"]
    assert history[0]["ends_at"] == "2026-10-19T11:00:00.000Z"
    assert history[0]["effective_ends_at"] == "2026-10-19T08:00:00.000Z"
    day = client.get("/api/day?day=2026-10-19").json()
    assert [change["basal"] for change in day["basal_changes"]] == ["0.60", "0.00", "0.50"]


def test_historical_insert_changes_both_neighbors_and_preserves_requested_ends(diary):
    client, _ = diary
    for start, duration in [("10:00", 240), ("13:00", 60), ("11:00", 30)]:
        assert client.post("/api/temporary-basals", json=temporary(starts_at=f"2026-10-19T{start}:00+03:00", duration_minutes=duration)).status_code == 200
    history = client.get("/api/temporary-basals").json()
    assert [row["effective_ends_at"] for row in history] == ["2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.000Z", "2026-10-19T11:00:00.000Z"]
    assert history[0]["duration_minutes"] == 240
    assert history[0]["revision"] == 1
    assert history[0]["created_at"] == history[0]["updated_at"]
    assert history[0]["deleted_at"] is None
    assert client.get("/api/day?day=2026-10-19").json()["basal_changes"] == [
        {"occurred_at": instant, "basal": None} for instant in ["2026-10-19T07:00:00.000Z", "2026-10-19T08:00:00.000Z", "2026-10-19T08:30:00.000Z", "2026-10-19T10:00:00.000Z", "2026-10-19T11:00:00.000Z"]]


def test_percent_follows_intervals_versions_midnight_and_unknown_base(diary):
    client, _ = diary
    assert client.post("/api/temporary-basals", json=temporary(starts_at="2026-10-18T23:00:00+03:00", duration_minutes=240, percent=0)).status_code == 200
    assert client.get("/api/basal", params={"at": "2026-10-18T23:30:00+03:00"}).json()["basal"] is None
    assert client.post("/api/basal-schedules", json=schedule(intervals=[{"minute": 0, "rate": "0.50"}, {"minute": 60, "rate": "0.55"}])).status_code == 200
    assert client.post("/api/temporary-basals", json=temporary(starts_at="2026-10-19T00:00:00+03:00", duration_minutes=1500, percent=110)).status_code == 200
    assert client.post("/api/basal-schedules", json=schedule(starts_at="2026-10-19T02:00:00+03:00", intervals=[{"minute": 0, "rate": "0.70"}, {"minute": 60, "rate": "0.80"}])).status_code == 200
    for instant, expected in [("2026-10-19T00:00:00+03:00", "0.55"), ("2026-10-19T01:00:00+03:00", "0.61"),
                              ("2026-10-19T02:00:00+03:00", "0.88"), ("2026-10-20T00:00:00+03:00", "0.77"),
                              ("2026-10-20T01:00:00+03:00", "0.80")]:
        assert client.get("/api/basal", params={"at": instant}).json()["basal"] == expected
    day = client.get("/api/day?day=2026-10-20").json()
    assert day["basal"] == "0.77"
    assert day["temporary_basals"][0]["percent"] == 110
    assert day["temporary_percent"] == 110
    assert client.get("/api/day?day=2026-10-19").json()["temporary_percent"] == 110
    assert day["basal_changes"] == [{"occurred_at": "2026-10-19T22:00:00.000Z", "basal": "0.80"}]


@pytest.mark.parametrize("changes", [{"percent": value} for value in [-1, 2147483648, True, 1.5, "120", None]] +
                         [{"duration_minutes": value} for value in [0, -1, 2147483648, False, 1.5, "60"]] +
                         [{"starts_at": value} for value in ["bad", "2026-10-19T10:00:00", "9999-12-31T23:00:00Z"]])
def test_invalid_temporary_basal_is_not_saved(diary, changes):
    client, _ = diary
    response = client.post("/api/temporary-basals", json=temporary(**changes))
    assert response.status_code == 422
    assert client.get("/api/temporary-basals").json() == []


def test_maximum_values_and_normalized_replay_survive_restart(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from diary.db import migrate
    from test_access import ORIGIN

    client, database = diary
    payload = temporary(duration_minutes=2147483647, percent=2147483647)
    receipt = client.post("/api/temporary-basals", json=payload).json()
    payload["starts_at"] = "2026-10-19T07:00:00Z"
    assert client.post("/api/temporary-basals", json=payload).json() == {**receipt, "replayed": True}
    assert client.post("/api/temporary-basals", json={**payload, "percent": 0}).status_code == 409
    assert client.post("/api/temporary-basals", json=temporary()).status_code == 409
    assert client.post("/api/basal-schedules", json=schedule(intervals=[{"minute": 0, "rate": "21474836.47"}])).status_code == 200
    assert client.get("/api/basal", params={"at": payload["starts_at"]}).json()["basal"] == "461168601413242.06"
    before = client.get("/api/temporary-basals").json()
    migrate(database)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as restarted:
        restarted.cookies.update(client.cookies)
        assert restarted.get("/api/temporary-basals").json() == before
        assert restarted.post("/api/temporary-basals", json=payload, headers=dict(client.headers)).json() == {**receipt, "replayed": True}


@pytest.mark.parametrize("fault", ["commit", "receipt", "period", "locked"])
def test_failed_insert_preserves_neighbors_and_can_retry(diary, fault):
    from sqlalchemy import event
    from sqlalchemy.engine import Engine
    from sqlalchemy.exc import OperationalError

    client, _ = diary
    assert client.post("/api/temporary-basals", json=temporary()).status_code == 200
    before = client.get("/api/temporary-basals").json()
    payload = temporary(starts_at="2026-10-19T11:00:00+03:00")

    def fail_commit(connection):
        raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

    def fail_write(connection, cursor, statement, parameters, context, executemany):
        if ((fault == "receipt" and statement.startswith("INSERT INTO operation_receipt"))
            or (fault == "period" and statement.startswith("INSERT INTO temporary_basal"))
            or (fault == "locked" and statement == "BEGIN IMMEDIATE")):
            raise OperationalError(statement, {}, Exception("database unavailable"))

    hook, listener = ("commit", fail_commit) if fault == "commit" else ("before_cursor_execute", fail_write)
    event.listen(Engine, hook, listener)
    try:
        assert client.post("/api/temporary-basals", json=payload).status_code == 503
    finally:
        event.remove(Engine, hook, listener)
    assert client.get("/api/temporary-basals").json() == before
    assert client.post("/api/temporary-basals", json=payload).json()["replayed"] is False


def test_concurrent_creates_replays_and_conflicts(diary):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN

    client, database = diary
    cookie = client.cookies.get("__Host-diary-session")

    def save(payload):
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as device:
            device.cookies.set("__Host-diary-session", cookie)
            return device.post("/api/temporary-basals", json=payload, headers=dict(client.headers))

    payload = temporary()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, [payload, payload]))
    assert {result.json()["replayed"] for result in responses} == {False, True}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, [temporary(starts_at="2026-10-19T11:00:00+03:00"), temporary(starts_at="2026-10-19T11:00:00+03:00")]))
    assert sorted(result.status_code for result in responses) == [200, 409]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(save, [temporary(starts_at="2026-10-19T10:30:00+03:00"), temporary(starts_at="2026-10-19T10:15:00+03:00")]))
    assert all(result.status_code == 200 for result in responses)
    assert [row["effective_ends_at"] for row in client.get("/api/temporary-basals").json()] == [
        "2026-10-19T07:15:00.000Z", "2026-10-19T07:30:00.000Z", "2026-10-19T08:00:00.000Z", "2026-10-19T12:00:00.000Z"]


def test_temporary_basal_requires_session_origin_and_csrf(diary):
    from fastapi.testclient import TestClient
    from diary.app import create_app
    from test_access import ORIGIN

    client, database = diary
    for headers in [{"Origin": "https://foreign.test"}, {"X-CSRF-Token": "wrong"}]:
        assert client.post("/api/temporary-basals", json=temporary(), headers=headers).status_code == 403
    assert client.get("/api/temporary-basals").json() == []
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as anonymous:
        assert anonymous.get("/api/temporary-basals").status_code == 401
        assert anonymous.post("/api/temporary-basals", json=temporary()).status_code == 401


def test_adjacent_periods_and_schedule_start_share_one_boundary(diary):
    client, _ = diary
    for start, percent in [("2026-10-18T23:00:00+03:00", 0), ("2026-10-19T00:00:00+03:00", 100)]:
        assert client.post("/api/temporary-basals", json=temporary(starts_at=start, percent=percent, duration_minutes=60)).status_code == 200
    assert client.post("/api/basal-schedules", json=schedule(intervals=[{"minute": 0, "rate": "0.5"}])).status_code == 200
    before = client.get("/api/day?day=2026-10-18").json()
    assert before["basal_changes"] == [{"occurred_at": "2026-10-18T20:00:00.000Z", "basal": None}]
    day = client.get("/api/day?day=2026-10-19").json()
    assert day["basal"] == "0.50"
    assert day["temporary_percent"] == 100
    assert len(day["temporary_basals"]) == 1
    assert day["basal_changes"] == [{"occurred_at": "2026-10-18T22:00:00.000Z", "basal": "0.50"}]


def test_migration_from_schedule_schema_preserves_existing_history(diary):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    from fastapi.testclient import TestClient
    from diary.admin import create_account
    from diary.app import create_app
    from diary.db import database_engine, migrate
    from test_access import ORIGIN, PASSWORD, login

    _, database = diary
    previous = database.parent / "previous.sqlite3"
    engine = database_engine(previous)
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "003_basal_schedules")
    engine.dispose()
    create_account(previous, "owner", PASSWORD)
    with TestClient(create_app(previous, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        client.headers.update({"Origin": ORIGIN, "X-CSRF-Token": client.get("/api/auth/csrf").json()["csrf_token"]})
        payload = schedule()
        receipt = client.post("/api/basal-schedules", json=payload).json()
        before = client.get("/api/basal-schedules").json()
        migrate(previous)
        assert client.get("/api/basal-schedules").json() == before
        assert client.post("/api/basal-schedules", json=payload).json() == {**receipt, "replayed": True}
        assert client.post("/api/temporary-basals", json=temporary()).status_code == 200
