import json
import os
import subprocess
import sys
import fcntl
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4
from pathlib import Path

from fastapi.testclient import TestClient

from diary.app import create_app
from test_access import ORIGIN, login
from test_entries import diary, entry
from test_basal import schedule
from test_temporary_basal import temporary


def points(env):
    return json.loads(subprocess.run(["restic", "snapshots", "--json"], env=env, check=True, capture_output=True, text=True).stdout)


def command(database, *args, env=None, ok=True):
    result = subprocess.run([sys.executable, "-m", "diary.backup", "--database", str(database), *args],
                            env=env, capture_output=True, text=True)
    assert (result.returncode == 0) == ok, result.stdout + result.stderr
    return result


def repository(tmp_path):
    password = tmp_path / "password"
    password.write_text("synthetic-restic-password")
    config = tmp_path / "config.env"
    config.write_text("DIARY_ORIGIN=https://diary.test\n")
    env = {**os.environ, "RESTIC_REPOSITORY": str(tmp_path / "repository"),
           "RESTIC_PASSWORD_FILE": str(password), "DIARY_RECOVERY_CONFIG": str(config),
           "DIARY_RELEASE": "synthetic-release"}
    subprocess.run(["restic", "init"], env=env, check=True, capture_output=True)
    return env


def test_encrypted_point_restores_snapshot_and_revokes_sessions(diary, tmp_path):
    client, database = diary
    client.post("/api/entries", json=entry(comment="Снимок 😀"))
    assert client.post("/api/basal-schedules", json=schedule()).status_code == 200
    assert client.post("/api/temporary-basals", json=temporary()).status_code == 200
    deleted = client.post("/api/entries", json=entry(comment="Удалено", glucose=None)).json()["result_id"]
    client.post(f"/api/entries/{deleted}/delete", json={"operation_id": str(uuid4()), "expected_revision": 1})
    expected = client.get("/api/export").json()
    summary = client.get("/api/glucose-summary?period=week&end=2026-10-19").json()
    day = client.get("/api/day?day=2026-10-19").json()
    env = repository(tmp_path)
    command(database, "backup", env=env)
    client.post("/api/entries", json=entry(comment="Позже"))
    destination = tmp_path / "recovered"
    command(database, "restore", "--snapshot", "latest", "--target", str(destination), env=env)
    with TestClient(create_app(destination / "diary.sqlite3", ORIGIN), base_url=ORIGIN) as restored:
        restored.cookies.update(client.cookies)
        assert restored.get("/api/auth/session").status_code == 401
        restored.cookies.clear()
        login(restored)
        actual = restored.get("/api/export").json()
        actual.pop("exported_at")
        expected.pop("exported_at")
        assert actual == expected
        assert restored.get("/api/glucose-summary?period=week&end=2026-10-19").json() == summary
        assert restored.get("/api/day?day=2026-10-19").json() == day
    assert (destination / "recovery.env").read_text() == "DIARY_ORIGIN=https://diary.test\n"
    manifest = json.loads((destination / "manifest.json").read_text())
    assert manifest["release"] == "synthetic-release"
    assert manifest["schema_version"] == "007_one_off_meals"
    assert "uv.lock" in manifest["files"]
    assert len(client.get("/api/export").json()["entries"]) == 3
    command(database, "verify", env=env)
    status = client.get("/api/backup-status").json()
    assert status["last_external_success"] is None
    assert status["last_local_success"] is not None
    assert status["last_verification"] is not None
    assert status["overdue"] is True
    assert status["error"] is None
    failed = {**env, "RESTIC_REPOSITORY": str(tmp_path / "missing")}
    command(database, "verify", env=failed, ok=False)
    status_after = client.get("/api/backup-status").json()
    assert status_after["last_verification"] == status["last_verification"]
    assert status_after["verification_error"] is not None
    command(database, "restore", "--snapshot", "latest", "--target", str(destination), env=env, ok=False)
    assert len(client.get("/api/export").json()["entries"]) == 3


def test_seven_successful_moscow_days_repeat_gaps_hosts_and_manual(diary, tmp_path):
    _, database = diary
    env = repository(tmp_path)
    command(database, "backup", "--kind", "manual", "--at", "2026-09-01T00:00:00+03:00", env=env)
    for day in [1, 2, 3, 5, 6, 7, 8, 9]:
        command(database, "backup", "--at", f"2026-10-{day:02d}T03:00:00+03:00",
                env={**env, "HOSTNAME": f"host-{day}", "DIARY_RELEASE": f"release-{day}"})
    command(database, "backup", "--at", "2026-10-09T22:30:00Z", env=env)  # October 10 Moscow
    command(database, "backup", "--at", "2026-10-10T02:00:00+03:00", env=env)
    remaining = points(env)
    daily = [point for point in remaining if "daily" in point["tags"]]
    assert len(daily) == 7
    assert {point["hostname"] for point in daily} == {"diary"}
    assert sorted(datetime.fromisoformat(point["time"]).day for point in daily) == [3, 5, 6, 7, 8, 9, 10]
    assert len([point for point in remaining if "manual" in point["tags"]]) == 1


def test_bad_credentials_and_unavailable_repository_preserve_old_points(diary, tmp_path):
    client, database = diary
    env = repository(tmp_path)
    command(database, "backup", env=env)
    before = points(env)
    bad_key = tmp_path / "bad-key"
    bad_key.write_text("wrong-synthetic-password")
    for changes in [{"RESTIC_PASSWORD_FILE": str(bad_key)}, {"RESTIC_REPOSITORY": str(tmp_path / "missing")}]:
        result = command(database, "backup", env={**env, **changes}, ok=False)
        assert "wrong-synthetic" not in result.stdout + result.stderr
        assert points(env) == before
        status = client.get("/api/backup-status").json()
        assert status["error"] is not None
        assert status["last_local_success"] is not None


def test_interrupted_upload_and_no_space_do_not_rotate(diary, tmp_path):
    client, database = diary
    env = repository(tmp_path)
    command(database, "backup", env=env)
    before = points(env)
    bin_path = tmp_path / "bin"
    bin_path.mkdir()
    wrapper = bin_path / "restic"
    real = subprocess.run(["which", "restic"], capture_output=True, text=True, check=True).stdout.strip()
    for code in [1, 130]:
        wrapper.write_text(f'#!/bin/sh\nif [ "$1" = "backup" ]; then\n echo "secret-repository-credential" >&2\n exit {code}\nfi\nexec {real} "$@"\n')
        wrapper.chmod(0o700)
        result = command(database, "backup", env={**env, "PATH": str(bin_path) + ":" + env["PATH"]}, ok=False)
        assert "secret-repository-credential" not in result.stdout + result.stderr
        assert points(env) == before
        assert "secret-repository-credential" not in client.get("/api/backup-status").text


def test_backup_while_writing_restores_a_consistent_point(diary, tmp_path):
    client, database = diary
    env = repository(tmp_path)
    stopped = Event()
    def write():
        count = 0
        while not stopped.is_set():
            assert client.post("/api/entries", json=entry(comment=f"История {count}")).status_code == 200
            count += 1
        return count
    with ThreadPoolExecutor() as pool:
        writing = pool.submit(write)
        try:
            command(database, "backup", env=env)
        finally:
            stopped.set()
        total = writing.result()
    target = tmp_path / "restored"
    command(database, "restore", "--snapshot", "latest", "--target", str(target), env=env)
    with TestClient(create_app(target / "diary.sqlite3", ORIGIN), base_url=ORIGIN) as recovered:
        login(recovered)
        rows = recovered.get("/api/export").json()["entries"]
        assert 0 < len(rows) <= total
        assert {row["comment"] for row in rows} == {f"История {i}" for i in range(len(rows))}


def test_status_is_private_and_marks_external_copy_overdue(diary):
    client, database = diary
    path = database.with_suffix(".backup-status.json")
    path.write_text(json.dumps({"last_external_success": "2000-01-01T00:00:00Z"}))
    assert client.get("/api/backup-status").json()["overdue"] is True
    path.write_text(json.dumps({"last_external_success": datetime.now(timezone.utc).isoformat()}))
    assert client.get("/api/backup-status").json()["overdue"] is False
    client.cookies.clear()
    assert client.get("/api/backup-status").status_code == 401


def test_parallel_command_cannot_overwrite_status_or_points(diary, tmp_path):
    client, database = diary
    env = repository(tmp_path)
    before = client.get("/api/backup-status").json()
    with database.with_suffix(".backup.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        command(database, "backup", env=env, ok=False)
    assert points(env) == []
    assert client.get("/api/backup-status").json() == before


def test_bad_readback_stays_pending_and_never_counts_as_success(diary, tmp_path):
    client, database = diary
    env = repository(tmp_path)
    command(database, "backup", env=env)
    before = points(env)
    original_status = client.get("/api/backup-status").json()
    bin_path = tmp_path / "bin"
    bin_path.mkdir()
    wrapper = bin_path / "restic"
    real = subprocess.run(["which", "restic"], capture_output=True, text=True, check=True).stdout.strip()
    wrapper.write_text(f'#!/bin/sh\n{real} "$@"\nresult=$?\nif [ "$1" = "restore" ] && [ "$result" = 0 ]; then\n printf corrupt > "$4/diary.sqlite3"\nfi\nexit "$result"\n')
    wrapper.chmod(0o700)
    command(database, "backup", env={**env, "PATH": str(bin_path) + ":" + env["PATH"]}, ok=False)
    after = points(env)
    assert all(any(old["id"] == point["id"] for point in after) for old in before)
    assert len([point for point in after if "pending" in point["tags"]]) == 1
    status = client.get("/api/backup-status").json()
    assert status["last_local_success"] == original_status["last_local_success"]
    assert status["error"] is not None
    command(database, "restore", "--snapshot", "latest", "--target", str(tmp_path / "valid"), env=env)
