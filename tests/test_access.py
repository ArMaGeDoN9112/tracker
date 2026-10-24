from fastapi.testclient import TestClient

from diary.app import create_app
from diary.db import migrate
from diary.admin import create_account
from diary.admin import reset_password
import pytest

ORIGIN = "https://diary.test"
PASSWORD = "synthetic-password-only"


def login(client, password=PASSWORD, name="owner"):
    csrf = client.get("/api/auth/csrf").json()["csrf_token"]
    return client.post("/api/auth/login", json={"login": name, "password": password},
                       headers={"Origin": ORIGIN, "X-CSRF-Token": csrf})


def test_private_routes_are_closed_by_default(tmp_path):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    app = create_app(database, "https://diary.test")

    @app.get("/api/future-private-route")
    def future_route():
        return {"private": "synthetic"}

    with TestClient(app, base_url="https://diary.test") as client:
        for path in ("/api/auth/session", "/api/future-private-route"):
            response = client.get(path)
            assert response.status_code == 401
            assert response.headers["cache-control"] == "no-store"
        for path in ("/docs", "/openapi.json", "/redoc"):
            assert client.get(path).status_code in (401, 404)


def test_login_persists_after_restart_and_logout_revokes_cookie(tmp_path):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        response = login(client)
        assert response.status_code == 200
        cookie = client.cookies.get("__Host-diary-session")
        assert len(cookie) >= 43
        header = response.headers["set-cookie"]
        for attribute in ("Secure", "HttpOnly", "SameSite=lax", "Max-Age=2592000", "Path=/"):
            assert attribute in header
        assert client.get("/api/auth/session").json() == {"login": "owner"}
    migrate(database)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        client.cookies.set("__Host-diary-session", cookie)
        assert client.get("/api/auth/session").status_code == 200
        csrf = client.get("/api/auth/csrf").json()["csrf_token"]
        assert client.post("/api/auth/logout", headers={"Origin": ORIGIN, "X-CSRF-Token": csrf}).status_code == 204
        client.cookies.set("__Host-diary-session", cookie)
        assert client.get("/api/auth/session").status_code == 401


def test_login_limit_survives_restart_and_expires(tmp_path, monkeypatch):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", PASSWORD)
    clock = 1_800_000_000_000
    monkeypatch.setattr("diary.infrastructure.security.now_ms", lambda: clock)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        for _ in range(5):
            assert login(client, password="incorrect").status_code == 401
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        response = login(client)
        assert response.status_code == 429
        assert int(response.headers["retry-after"]) > 0
        clock += 900_000
        assert login(client).status_code == 200


def test_devices_rotation_reset_and_expiry(tmp_path, monkeypatch):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", PASSWORD)
    clock = 1_800_000_000_000
    monkeypatch.setattr("diary.infrastructure.security.now_ms", lambda: clock)
    app = create_app(database, ORIGIN)
    with TestClient(app, base_url=ORIGIN) as phone, TestClient(app, base_url=ORIGIN) as desktop:
        assert login(phone).status_code == 200
        old = phone.cookies.get("__Host-diary-session")
        assert login(phone).status_code == 200
        rotated = phone.cookies.get("__Host-diary-session")
        assert rotated != old
        with TestClient(app, base_url=ORIGIN) as stale:
            stale.cookies.set("__Host-diary-session", old)
            assert stale.get("/api/auth/session").status_code == 401
        assert login(desktop).status_code == 200
        csrf = phone.get("/api/auth/csrf").json()["csrf_token"]
        assert phone.post("/api/auth/logout", headers={"Origin": ORIGIN, "X-CSRF-Token": csrf}).status_code == 204
        assert desktop.get("/api/auth/session").status_code == 200
        reset_password(database, PASSWORD + "-new")
        assert desktop.get("/api/auth/session").status_code == 401
        assert login(desktop).status_code == 401
        assert login(phone, PASSWORD + "-new").status_code == 200
        clock += 30 * 24 * 60 * 60 * 1000 - 1
        assert phone.get("/api/auth/session").status_code == 200
        clock += 1
        assert phone.get("/api/auth/session").status_code == 401


def test_origin_csrf_rotation_and_default_protection(tmp_path):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", PASSWORD)
    app = create_app(database, ORIGIN)

    @app.post("/api/future-write")
    def future_write():
        return {"saved": True}

    with TestClient(app, base_url=ORIGIN) as client:
        pre = client.get("/api/auth/csrf").json()["csrf_token"]
        payload = {"login": "owner", "password": PASSWORD}
        for headers in ({}, {"Origin": ORIGIN}, {"Origin": "https://foreign.test", "X-CSRF-Token": pre},
                        {"Origin": "null", "X-CSRF-Token": pre}, {"X-CSRF-Token": pre}):
            assert client.post("/api/auth/login", json=payload, headers=headers).status_code == 403
        assert login(client).status_code == 200
        current = client.get("/api/auth/csrf").json()["csrf_token"]
        assert current != pre
        for path in ("/api/auth/logout", "/api/future-write"):
            assert client.post(path, headers={"Origin": ORIGIN, "X-CSRF-Token": pre}).status_code == 403
            assert client.post(path, headers={"X-CSRF-Token": current}).status_code == 403
        assert client.post("/api/future-write", headers={"Origin": ORIGIN, "X-CSRF-Token": current}).status_code == 200
        response = client.options("/api/auth/login", headers={"Origin": "https://foreign.test", "Access-Control-Request-Method": "POST"})
        assert "access-control-allow-origin" not in response.headers
        assert client.get("/api/auth/session", headers={"Host": "foreign.test"}).status_code == 400


@pytest.mark.parametrize("length", [14, 1025])
def test_admin_rejects_invalid_password_without_changing_access(tmp_path, length):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    with pytest.raises(ValueError):
        create_account(database, "owner", "x" * length)
    create_account(database, "owner", PASSWORD)
    with pytest.raises(ValueError):
        reset_password(database, "x" * length)
    with pytest.raises(ValueError):
        create_account(database, "second", PASSWORD)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        assert login(client).status_code == 200


def test_limits_are_independent_by_source_and_login_and_ignore_forwarded_headers(tmp_path):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", PASSWORD)
    app = create_app(database, ORIGIN)
    for index in range(5):
        with TestClient(app, base_url=ORIGIN, client=(f"192.0.2.{index}", 1234)) as client:
            assert login(client, "bad-password").status_code == 401
    with TestClient(app, base_url=ORIGIN, client=("192.0.2.100", 1234)) as client:
        assert login(client).status_code == 429
        for index in range(5):
            assert login(client, "bad-password", f"unknown-{index}").status_code == 401
        client.headers["X-Forwarded-For"] = "192.0.2.200"
        assert login(client, "bad-password", "another-unknown").status_code == 429


def test_pre_csrf_expiry_and_validation_dont_disclose_secrets(tmp_path, monkeypatch):
    database = tmp_path / "diary.sqlite3"
    migrate(database)
    clock = 1_800_000_000_000
    monkeypatch.setattr("diary.infrastructure.security.now_ms", lambda: clock)
    with TestClient(create_app(database, ORIGIN), base_url=ORIGIN) as client:
        csrf = client.get("/api/auth/csrf").json()["csrf_token"]
        headers = {"Origin": ORIGIN, "X-CSRF-Token": csrf}
        payload = {"login": "owner", "password": PASSWORD}
        first = client.post("/api/auth/login", json=payload, headers=headers)
        assert first.status_code == 401
        assert client.post("/api/auth/login", json={**payload, "login": "unknown"}, headers=headers).json() == first.json()
        response = client.post("/api/auth/login", json={**payload, "password": PASSWORD * 100}, headers=headers)
        assert response.status_code == 422
        assert PASSWORD not in response.text
        response = client.post("/api/auth/login", content=b"x" * 65_537, headers=headers)
        assert response.status_code == 413
        clock += 900_000
        assert client.post("/api/auth/login", json=payload, headers=headers).status_code == 403


def test_concurrent_failed_logins_do_not_exceed_limit(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    database = tmp_path / "diary.sqlite3"
    migrate(database)
    create_account(database, "owner", PASSWORD)
    app = create_app(database, ORIGIN)

    def attempt(_):
        with TestClient(app, base_url=ORIGIN) as client:
            return login(client, "incorrect").status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        statuses = list(pool.map(attempt, range(6)))
    assert statuses.count(401) == 5
    assert statuses.count(429) == 1
