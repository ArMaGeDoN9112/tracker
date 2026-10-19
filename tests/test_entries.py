from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from diary.admin import create_account
from diary.app import create_app
from diary.db import migrate
from test_access import ORIGIN, PASSWORD, login


@pytest.fixture
def diary(tmp_path):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        client.headers.update({"Origin": ORIGIN, "X-CSRF-Token": client.get("/api/auth/csrf").json()["csrf_token"]})
        yield client, database


def entry(**changes):
    return {"operation_id": str(uuid4()), "occurred_at": "2026-10-19T00:00:00+03:00", "glucose": "5,60", **changes}


def test_create_and_read_moscow_day(diary):
    client, _ = diary
    response = client.post("/api/entries", json=entry())
    assert response.status_code == 200
    receipt = response.json()
    day = client.get("/api/day?day=2026-10-19").json()
    saved = day["entries"][0]
    assert saved["id"] == receipt["result_id"]
    assert saved["glucose"] == "5.6"
    assert saved["bolus"] == "0.0"
    assert saved["basal"] is None
    assert saved["occurred_at"] == "2026-10-18T21:00:00.000Z"
    assert saved["created_at"] != saved["occurred_at"]
    assert client.get("/api/day?day=2026-10-18").json()["entries"] == []


@pytest.mark.parametrize("values,expected", [
    ({"glucose": None, "bolus": "1,20", "reason": "food"}, (None, "1.2", "food")),
    ({"glucose": "", "comment": "<b>Еда 😀</b>"}, (None, "0.0", None)),
    ({"bolus": "0,00", "reason": "correction"}, ("5.6", "0.0", None)),
    ({"glucose": "214748364,7", "bolus": "214748364.70", "reason": "food_and_correction"}, ("214748364.7", "214748364.7", "food_and_correction")),
    ({"bolus": "2", "reason": "correction", "comment": "x" * 10000}, ("5.6", "2.0", "correction")),
])
def test_independent_fields_and_normalization(diary, values, expected):
    client, _ = diary
    assert client.post("/api/entries", json=entry(**values)).status_code == 200
    saved = client.get("/api/day?day=2026-10-19").json()["entries"][0]
    assert (saved["glucose"], saved["bolus"], saved["reason"]) == expected
    assert saved["comment"] == values.get("comment", "")


@pytest.mark.parametrize("values,field", [
    ({"glucose": "0"}, "glucose"), ({"glucose": "NaN"}, "glucose"),
    ({"glucose": "1e9999"}, "glucose"), ({"glucose": "Infinity"}, "glucose"),
    ({"glucose": "5.61"}, "glucose"), ({"glucose": "214748364.8"}, "glucose"),
    ({"glucose": 5.6}, "glucose"), ({"bolus": "-0.1"}, "bolus"),
    ({"bolus": "1.01"}, "bolus"), ({"reason": "unknown"}, "reason"),
    ({"comment": "x" * 10001}, "comment"), ({"operation_id": "bad"}, "operation_id"),
    ({"occurred_at": "2026-10-19T00:00:00"}, "occurred_at"),
    ({"occurred_at": "2026-10-19T00:00:00+03:99"}, "occurred_at"),
    ({"occurred_at": "0001-01-01T00:00:00+23:00"}, "occurred_at"),
])
def test_reject_invalid_fields_without_writing(diary, values, field):
    client, _ = diary
    response = client.post("/api/entries", json=entry(**values))
    assert response.status_code == 422
    assert response.json()["field"] == field
    assert client.get("/api/day?day=2026-10-19").json()["entries"] == []


@pytest.mark.parametrize("values", [{}, {"reason": "food"}, {"comment": " \n\t ", "bolus": "0"}])
def test_empty_entry_is_rejected(diary, values):
    client, _ = diary
    assert client.post("/api/entries", json=entry(glucose=None, **values)).status_code == 422


def test_validation_explains_precision_and_empty_entry(diary):
    client, _ = diary
    error = client.post("/api/entries", json=entry(glucose="5.61")).json()
    assert error["field"] == "glucose"
    assert "один знак после запятой" in error["message"]
    error = client.post("/api/entries", json=entry(glucose=None)).json()
    assert "ненулевую подколку или комментарий" in error["message"]


def test_retries_conflicts_restart_and_migration(diary):
    client, database = diary
    payload = entry(comment="Сохраняется после перезапуска")
    original = client.post("/api/entries", json=payload).json()
    retry = client.post("/api/entries", json={**payload, "glucose": "5.6"}).json()
    assert retry["replayed"] is True
    assert retry["result_id"] == original["result_id"]
    assert retry["completed_at"] == original["completed_at"]
    assert client.post("/api/entries", json={**payload, "comment": "other"}).status_code == 409
    cookie = client.cookies.get("__Host-diary-session")
    migrate(database)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as restarted:
        restarted.cookies.set("__Host-diary-session", cookie)
        day = restarted.get("/api/day?day=2026-10-19").json()
        assert len(day["entries"]) == 1
        assert day["entries"][0]["comment"] == payload["comment"]


def test_upgrade_previous_schema_preserves_account_and_session(tmp_path):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path
    from diary.db import database_engine

    database = tmp_path / "previous.sqlite3"
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    engine = database_engine(database)
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "001_access")
    engine.dispose()
    create_account(database, "owner", PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        assert login(client).status_code == 200
        migrate(database)
        assert client.get("/api/auth/session").json() == {"login": "owner"}
        csrf = client.get("/api/auth/csrf").json()["csrf_token"]
        assert client.post("/api/entries", json=entry(), headers={"Origin": ORIGIN, "X-CSRF-Token": csrf}).status_code == 200


def test_historical_moscow_times_and_server_clock(diary, monkeypatch):
    client, _ = diary
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    monkeypatch.setattr("diary.entries.now_ms", lambda: 1792357200000)
    assert client.get("/api/entry-form").json()["local_time"] == "2026-10-19T00:00"
    candidates = client.get("/api/moscow-time", params={"local_time": "2014-10-26T01:30"}).json()["candidates"]
    assert candidates == ["2014-10-26T01:30:00+03:00", "2014-10-26T01:30:00+04:00"]
    assert client.get("/api/moscow-time?local_time=2011-03-27T02:30").status_code == 422
    for instant in ["2014-10-25T23:59:59.999+04:00", *candidates, "2014-10-27T00:00:00+03:00"]:
        assert client.post("/api/entries", json=entry(occurred_at=instant)).status_code == 200
    rows = client.get("/api/day?day=2014-10-26").json()["entries"]
    assert [row["occurred_at"] for row in rows] == ["2014-10-25T21:30:00.000Z", "2014-10-25T22:30:00.000Z"]


def test_large_day_and_stable_tie_order(diary, monkeypatch):
    client, _ = diary
    monkeypatch.setattr("diary.entries.now_ms", lambda: 1800000000000)
    for _ in range(105):
        assert client.post("/api/entries", json=entry()).status_code == 200
    rows = client.get("/api/day?day=2026-10-19").json()["entries"]
    assert len(rows) == 105
    assert [row["id"] for row in rows] == sorted(row["id"] for row in rows)


def test_old_moscow_offset_with_seconds_can_be_entered(diary):
    client, _ = diary
    candidates = client.get("/api/moscow-time?local_time=1900-01-01T12:00").json()["candidates"]
    assert candidates == ["1900-01-01T09:29:43.000Z"]
    assert client.post("/api/entries", json=entry(occurred_at=candidates[0])).status_code == 200
    assert len(client.get("/api/day?day=1900-01-01").json()["entries"]) == 1


@pytest.mark.parametrize("fault", ["commit", "full", "locked"])
def test_storage_failure_rolls_back_entry_and_receipt(diary, fault):
    from sqlalchemy import event
    from sqlalchemy.engine import Engine
    from sqlalchemy.exc import OperationalError

    client, _ = diary
    payload = entry()

    def fail_commit(connection):
        raise OperationalError("COMMIT", {}, Exception("disk I/O error"))

    def fail_write(connection, cursor, statement, parameters, context, executemany):
        if (fault == "full" and statement.startswith("INSERT INTO operation_receipt")) or (fault == "locked" and statement == "BEGIN IMMEDIATE"):
            raise OperationalError(statement, {}, Exception("database is " + fault))

    hook, listener = ("commit", fail_commit) if fault == "commit" else ("before_cursor_execute", fail_write)
    event.listen(Engine, hook, listener)
    try:
        response = client.post("/api/entries", json=payload)
        assert response.status_code == 503
        assert response.json()["code"] == "unavailable"
    finally:
        event.remove(Engine, hook, listener)
    assert client.get("/api/day?day=2026-10-19").json()["entries"] == []
    assert client.post("/api/entries", json=payload).json()["replayed"] is False


def test_concurrent_repeat_creates_one_entry(diary):
    from concurrent.futures import ThreadPoolExecutor

    client, database = diary
    payload = entry()
    cookie = client.cookies.get("__Host-diary-session")
    csrf = client.headers["X-CSRF-Token"]

    def save(_):
        with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as device:
            device.cookies.set("__Host-diary-session", cookie)
            return device.post("/api/entries", json=payload, headers={"Origin": ORIGIN, "X-CSRF-Token": csrf}).json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, range(2)))
    assert {result["replayed"] for result in results} == {False, True}
    assert len(client.get("/api/day?day=2026-10-19").json()["entries"]) == 1
