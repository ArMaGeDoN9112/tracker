import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from sqlalchemy import Engine, event

from diary.app import create_app
from diary.db import database_engine

from test_access import ORIGIN
from test_entries import diary, entry
from test_basal import schedule
from test_temporary_basal import temporary
from test_meals import line, meal
from test_products import product
from test_water import water


def nutrition_history(client):
    source = line(client, protein="0", fat=None)
    response = client.post("/api/meals", json=meal([
        source,
        {"id": str(uuid4()), "kind": "one_off", "name": "Порция", "quantity": "60", "unit": "g", "calories": "180"},
        {"id": str(uuid4()), "kind": "one_off", "name": "Без веса", "fat": "0"},
        {"id": str(uuid4()), "kind": "one_off", "name": "Неизвестно"},
    ]))
    assert response.status_code == 200
    historical = client.get("/api/meals/" + response.json()["result_id"]).json()
    assert client.put("/api/products/" + source["product_id"], json=product(
        expected_revision=1, name="Новая карточка", unit="ml", protein="99", fat="0", calories=None,
        portions=[{"id": str(uuid4()), "name": "Стакан", "quantity": "200"}],
        unit_change_confirmed=True)).status_code == 200
    current = client.get("/api/products/" + source["product_id"]).json()
    edited = {**source, "id": str(uuid4()), "name": current["name"], "unit": current["unit"],
              "protein": current["protein"], "fat": current["fat"], "calories": current["calories"],
              "product_revision": 2, "portion": current["portions"][0]}
    moved = client.post("/api/meals", json=meal([edited])).json()["result_id"]
    assert client.put("/api/meals/" + moved, json=meal([edited], expected_revision=1,
                      occurred_at="2026-10-20T00:00:00+03:00")).status_code == 200
    assert client.post("/api/meals/" + moved + "/delete", json={
        "operation_id": str(uuid4()), "expected_revision": 2}).status_code == 200
    assert client.post("/api/water", json=water(occurred_at="2026-10-19T12:00:00+03:00")).status_code == 200
    moved_water = client.post("/api/water", json=water(occurred_at="2026-10-19T23:59:59+03:00")).json()["result_id"]
    assert client.put("/api/water/" + moved_water, json=water(expected_revision=1, volume_ml=330,
                      occurred_at="2026-10-20T00:00:00+03:00")).status_code == 200
    assert client.post("/api/water/" + moved_water + "/delete", json={
        "operation_id": str(uuid4()), "expected_revision": 2}).status_code == 200
    assert client.put("/api/water-settings", json={"operation_id": str(uuid4()), "expected_revision": 1,
                                                 "volumes_ml": [330, 125]}).status_code == 200
    return historical


def validate_export(document):
    schema = json.loads(Path(f"docs/export/schema-v{document['schema_version']}.json").read_text())
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(document)


def test_empty_export_is_private_download(diary):
    client, _ = diary
    response = client.get("/api/export")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"] == "application/json"
    assert response.headers["content-disposition"].startswith('attachment; filename="diabetes-diary-')
    result = response.json()
    validate_export(result)
    assert result["schema_version"] == 3
    assert result["settings"] == {"timezone": "Europe/Moscow", "theme": "dark",
                                  "water": {"volumes_ml": [200, 250, 500], "revision": 1}}
    assert result["products"] == result["meals"] == result["water"] == []
    assert result["entries"] == result["basal_schedules"] == result["temporary_basals"] == []
    assert set(result["account"]) == {"id", "login", "created_at"}
    assert result["account"]["login"] == "owner"
    client.cookies.clear()
    rejected = client.get("/api/export")
    assert rejected.status_code == 401
    assert "content-disposition" not in rejected.headers


def test_export_preserves_full_history_and_exact_values(diary):
    client, _ = diary
    expected = []
    for index in range(105):
        payload = entry(occurred_at="1970-01-01T00:00:00.123Z", glucose=None,
                        bolus="0.0", comment=f"История 😀 №{index}\n<текст>")
        response = client.post("/api/entries", json=payload)
        assert response.status_code == 200
        saved = client.get("/api/entries/" + response.json()["result_id"]).json()
        expected.append(saved)
    last = expected[-1]
    assert client.put("/api/entries/" + last["id"], json=entry(
        expected_revision=1, glucose="214748364.7", bolus="214748364.7",
        reason="food_and_correction", comment="Изменено 🐈")).status_code == 200
    assert client.post("/api/entries/" + last["id"] + "/delete", json={
        "operation_id": str(uuid4()), "expected_revision": 2}).status_code == 200
    expected[-1] = client.get("/api/entries/" + last["id"]).json()
    for start, rate in [("1970-01-01T00:00:00Z", "0.00"), ("2026-10-19T00:00:00Z", "0.55")]:
        assert client.post("/api/basal-schedules", json=schedule(starts_at=start, intervals=[
            {"minute": 0, "rate": rate}, {"minute": 720, "rate": "21474836.47"}])).status_code == 200
    a = client.post("/api/temporary-basals", json=temporary(
        starts_at="1970-01-01T00:00:00Z", duration_minutes=120, percent=0)).json()["result_id"]
    b = client.post("/api/temporary-basals", json=temporary(
        starts_at="1970-01-01T01:00:00Z", duration_minutes=90, percent=110)).json()["result_id"]
    assert client.put("/api/temporary-basals/" + b, json={
        "operation_id": str(uuid4()), "expected_revision": 1, "percent": 120,
        "starts_at": "1970-01-01T01:00:00Z", "ends_at": "1970-01-01T01:15:00Z"}).status_code == 200
    assert client.post("/api/temporary-basals/" + b + "/delete", json={
        "operation_id": str(uuid4()), "expected_revision": 2}).status_code == 200
    # A deleted period with the same start must not truncate the active one.
    c = client.post("/api/temporary-basals", json=temporary(
        starts_at="1970-01-01T01:00:00Z", duration_minutes=30, percent=2147483647)).json()["result_id"]
    result = client.get("/api/export?day=2026-10-19&limit=1").json()
    validate_export(result)
    assert len(result["entries"]) == 105
    by_id = {row["id"]: row for row in result["entries"]}
    for saved in expected:
        row = by_id[saved["id"]]
        assert set(row) == set(saved) - {"basal"}
        assert row == {key: value for key, value in saved.items() if key != "basal"}
    versions = result["basal_schedules"]
    assert len(versions) == 2
    assert versions[0]["starts_at"] == "1970-01-01T00:00:00.000Z"
    assert versions[0]["ends_at"] == versions[1]["starts_at"]
    assert versions[1]["ends_at"] is None
    assert versions[0]["intervals"] == [{"minute": 0, "rate": "0.00"}, {"minute": 720, "rate": "21474836.47"}]
    assert versions[1]["intervals"][0] == {"minute": 0, "rate": "0.55"}
    periods = {row["id"]: row for row in result["temporary_basals"]}
    assert len(periods) == 3
    assert (periods[a]["ends_at"], periods[a]["effective_ends_at"], periods[a]["percent"]) == ("1970-01-01T02:00:00.000Z", "1970-01-01T01:00:00.000Z", 0)
    assert (periods[b]["duration_minutes"], periods[b]["ends_at"], periods[b]["effective_ends_at"], periods[b]["revision"]) == (90, "1970-01-01T01:15:00.000Z", None, 3)
    assert periods[b]["deleted_at"] is not None
    assert (periods[c]["percent"], periods[c]["effective_ends_at"]) == (2147483647, "1970-01-01T01:30:00.000Z")
    for identifier in (a, b, c):
        saved = client.get("/api/temporary-basals/" + identifier).json()
        if saved["deleted_at"] is not None:
            saved["effective_ends_at"] = None
        assert periods[identifier] == saved
    assert versions == client.get("/api/basal-schedules").json()
    assert set(result) == {"schema_version", "exported_at", "timezone", "units", "settings", "account", "entries", "basal_schedules", "temporary_basals", "products", "meals", "water"}
    assert set(result["account"]) == {"id", "login", "created_at"}


def test_documented_example_matches_schema():
    validate_export(json.loads(Path("docs/export/example-v1.json").read_text()))


def test_export_nutrition_preserves_catalog_and_independent_history(diary):
    client, _ = diary
    historical = nutrition_history(client)
    result = client.get("/api/export?day=1900-01-01&limit=1").json()
    validate_export(result)
    assert result["products"] == client.get("/api/products").json()
    assert len(result["products"]) == 1
    assert "archived" not in result["products"][0]
    assert result["products"][0]["unit"] == "ml"
    assert result["products"][0]["portions"][0]["quantity"] == "200.00"
    assert len(result["meals"]) == len(result["water"]) == 2
    assert result["meals"][0] == historical
    old = result["meals"][0]["lines"]
    assert (old[0]["unit"], old[0]["product_revision"], old[0]["protein"], old[0]["fat"]) == ("g", 1, "0.00", None)
    assert old[0]["portion"]["quantity"] == "180.00"
    assert old[1]["basis_quantity"] == "60.00"
    assert old[2]["basis_quantity"] is old[2]["quantity"] is None
    assert old[3]["totals"] == dict.fromkeys(["protein", "fat", "carbohydrate", "calories"])
    assert result["meals"][1]["revision"] == result["water"][1]["revision"] == 3
    assert result["meals"][1]["deleted_at"] is not None
    assert result["water"][1]["deleted_at"] is not None
    assert result["settings"]["water"] == {"volumes_ml": [330, 125], "revision": 2}
    # Only exported historical facts are needed; the current card has another unit and portion.
    copy = client.post("/api/meals", json=meal([{key: value for key, value in item.items() if key != "totals"} for item in old]))
    assert copy.status_code == 200
    assert client.get("/api/meals/" + copy.json()["result_id"]).json()["totals"] == historical["totals"]


def test_v3_contract_and_example_match_application_dto():
    from diary.interfaces.export import FullExport
    schema = json.loads(Path("docs/export/schema-v3.json").read_text())
    assert schema == FullExport.model_json_schema()
    example = json.loads(Path("docs/export/example-v3.json").read_text())
    validate_export(example)
    assert FullExport.model_validate(example).model_dump(mode="json") == example


def test_upgrade_stage_one_to_nutrition_and_repeated_migrations_preserve_old_data(tmp_path):
    from alembic import command
    from alembic.config import Config
    from diary.admin import create_account
    from diary.db import migrate
    from test_access import PASSWORD, login
    database = tmp_path / "stage-one.sqlite3"
    engine = database_engine(database)
    config = Config()
    config.set_main_option("script_location", str(Path("migrations").resolve()))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "004_temporary_basal")
    engine.dispose()
    create_account(database, "owner", PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        login(client)
        client.headers.update({"Origin": ORIGIN, "X-CSRF-Token": client.get("/api/auth/csrf").json()["csrf_token"]})
        saved = client.post("/api/entries", json=entry(comment="История до питания")).json()["result_id"]
        assert client.post("/api/entries/" + saved + "/delete", json={"operation_id": str(uuid4()), "expected_revision": 1}).status_code == 200
        assert client.post("/api/basal-schedules", json=schedule()).status_code == 200
        period = client.post("/api/temporary-basals", json=temporary()).json()["result_id"]
        routes = ["/api/entries/" + saved, "/api/basal-schedules", "/api/temporary-basals/" + period, "/api/day?day=2026-10-19"]
        before = [client.get(route).json() for route in routes]
        migrate(database)
        migrate(database)
        assert [client.get(route).json() for route in routes] == before
        result = client.get("/api/export").json()
        validate_export(result)
        assert result["entries"][0]["deleted_at"] is not None
        assert result["basal_schedules"] == before[1]
        assert result["temporary_basals"] == [before[2]]
        assert result["products"] == result["meals"] == result["water"] == []
        assert result["settings"]["water"] == {"volumes_ml": [200, 250, 500], "revision": 1}


@pytest.mark.parametrize("revocation", ["expired", "logout", "reset"])
def test_export_rejects_expired_and_revoked_sessions(diary, monkeypatch, revocation):
    from diary.admin import reset_password
    from diary.security import SESSION_SECONDS, now_ms
    from test_access import PASSWORD

    client, database = diary
    cookies = dict(client.cookies)
    if revocation == "expired":
        future = now_ms() + SESSION_SECONDS * 1000 + 1
        monkeypatch.setattr("diary.app.now_ms", lambda: future)
    elif revocation == "logout":
        assert client.post("/api/auth/logout").status_code == 204
    else:
        reset_password(database, PASSWORD + "-new")
    client.cookies.update(cookies)
    response = client.get("/api/export")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    assert "content-disposition" not in response.headers


def test_export_uses_one_snapshot_during_concurrent_changes(diary):
    client, database = diary
    identifier = client.post("/api/entries", json=entry(comment="До изменения")).json()["result_id"]
    engine = database_engine(database)
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
    engine.dispose()
    reading, changed = Event(), Event()

    def pause_read(connection, cursor, statement, parameters, context, many):
        if statement.startswith("SELECT entry.") and not reading.is_set():
            reading.set()
            assert changed.wait(10), "Concurrent writer did not finish"

    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as reader:
        reader.cookies.update(client.cookies)
        event.listen(Engine, "before_cursor_execute", pause_read)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(reader.get, "/api/export")
                try:
                    assert reading.wait(10), "Export did not start"
                    assert client.put("/api/entries/" + identifier, json=entry(
                        expected_revision=1, comment="После изменения")).status_code == 200
                    assert client.post("/api/basal-schedules", json=schedule()).status_code == 200
                    assert client.post("/api/temporary-basals", json=temporary()).status_code == 200
                finally:
                    changed.set()
                response = future.result(timeout=10)
        finally:
            event.remove(Engine, "before_cursor_execute", pause_read)
    assert response.status_code == 200
    result = response.json()
    validate_export(result)
    assert result["entries"][0]["comment"] == "До изменения"
    assert result["entries"][0]["revision"] == 1
    assert result["basal_schedules"] == result["temporary_basals"] == []
    current = client.get("/api/export").json()
    assert current["entries"][0]["comment"] == "После изменения"
    assert current["entries"][0]["revision"] == 2
    assert len(current["basal_schedules"]) == len(current["temporary_basals"]) == 1


@pytest.mark.parametrize("paused_select", ["SELECT product_portion.", "SELECT meal_line."])
def test_export_nutrition_snapshot_keeps_card_portions_and_composition_together(diary, paused_select):
    client, database = diary
    historical = nutrition_history(client)
    before = client.get("/api/export").json()
    engine = database_engine(database)
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA journal_mode=WAL")
    engine.dispose()
    reading, changed = Event(), Event()

    def pause(connection, cursor, statement, parameters, context, many):
        if statement.startswith(paused_select) and not reading.is_set():
            reading.set()
            assert changed.wait(10), "Concurrent writer did not finish"

    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as reader:
        reader.cookies.update(client.cookies)
        event.listen(Engine, "before_cursor_execute", pause)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(reader.get, "/api/export")
                try:
                    assert reading.wait(10), "Export did not start"
                    assert client.put("/api/products/" + before["products"][0]["id"], json=product(
                        expected_revision=2, unit="ml", portions=[], name="После снимка")).status_code == 200
                    assert client.put("/api/meals/" + historical["id"], json=meal([
                        {"id": str(uuid4()), "kind": "one_off", "name": "Новый состав", "carbohydrate": "17"}],
                        expected_revision=1)).status_code == 200
                    assert client.post("/api/meals", json=meal([
                        {"id": str(uuid4()), "kind": "one_off", "name": f"Новая строка {i}"} for i in range(3)])).status_code == 200
                    assert client.put("/api/water-settings", json={"operation_id": str(uuid4()), "expected_revision": 2,
                                                                 "volumes_ml": []}).status_code == 200
                finally:
                    changed.set()
                result = future.result(timeout=10).json()
        finally:
            event.remove(Engine, "before_cursor_execute", pause)
    validate_export(result)
    result.pop("exported_at")
    before.pop("exported_at")
    assert result == before
    current = client.get("/api/export").json()
    assert current["products"][0]["revision"] == 3
    assert current["products"][0]["portions"] == []
    assert len(current["meals"]) == 3
    assert current["settings"]["water"] == {"volumes_ml": [], "revision": 3}
