from datetime import UTC, datetime
from uuid import uuid4

import pytest

from test_entries import diary, entry


def test_daily_and_weighted_period_summary(diary):
    client, _ = diary
    for at, glucose in [("2026-10-01T00:00:00+03:00", "4.0"),
                        ("2026-10-01T23:59:59.999+03:00", "8.0"),
                        ("2026-10-02T00:00:00+03:00", "12.0")]:
        assert client.post("/api/entries", json=entry(occurred_at=at, glucose=glucose)).status_code == 200
    for fields in [{"bolus": "2.0"}, {"comment": "Без измерения"}]:
        assert client.post("/api/entries", json=entry(occurred_at="2026-10-03T12:00:00+03:00", glucose=None, **fields)).status_code == 200
    response = client.get("/api/glucose-summary?period=custom&start=2026-10-01&end=2026-10-03")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "start": "2026-10-01", "end": "2026-10-03", "count": 3, "average": "8.0",
        "days": [
            {"day": "2026-10-01", "count": 2, "average": "6.0", "minimum": "4.0", "maximum": "8.0"},
            {"day": "2026-10-02", "count": 1, "average": "12.0", "minimum": "12.0", "maximum": "12.0"},
            {"day": "2026-10-03", "count": 0, "average": None, "minimum": None, "maximum": None},
        ],
    }


def test_rounding_uses_all_measurements_without_rounding_days(diary):
    client, _ = diary
    for at, glucose in [("2026-10-01T12:00:00+03:00", "4.0"),
                        ("2026-10-01T13:00:00+03:00", "4.1"),
                        ("2026-10-02T12:00:00+03:00", "4.0")]:
        assert client.post("/api/entries", json=entry(occurred_at=at, glucose=glucose)).status_code == 200
    result = client.get("/api/glucose-summary?period=custom&start=2026-10-01&end=2026-10-02").json()
    assert result["days"][0]["average"] == "4.1"
    assert result["average"] == "4.0"


@pytest.mark.parametrize("period,start,length", [("week", "2026-09-29", 7), ("month", "2026-09-06", 30)])
def test_presets_include_end_and_default_to_moscow_today(diary, monkeypatch, period, start, length):
    client, _ = diary
    monkeypatch.setattr("diary.glucose.now_ms", lambda: int(datetime(2026, 10, 4, 21, 30, tzinfo=UTC).timestamp() * 1000))
    for suffix in ["", "&end=2026-10-05"]:
        response = client.get(f"/api/glucose-summary?period={period}{suffix}")
        assert response.status_code == 200
        result = response.json()
        assert (result["start"], result["end"], len(result["days"])) == (start, "2026-10-05", length)
        assert result["count"] == 0 and result["average"] is None
        assert all(day["count"] == 0 and day["average"] is None and day["minimum"] is None and day["maximum"] is None for day in result["days"])


@pytest.mark.parametrize("query", ["period=unknown", "period=custom", "period=custom&start=2026-10-03&end=2026-10-01",
                                  "end=bad", "end=9999-12-31", "end=0001-01-01"])
def test_invalid_period_is_a_validation_error(diary, query):
    client, _ = diary
    response = client.get(f"/api/glucose-summary?{query}")
    assert response.status_code == 422
    assert response.json()["code"] == "validation"


def test_moscow_boundaries_and_long_unpaginated_history(diary):
    client, _ = diary
    # In 2010 Moscow was UTC+4 in summer: a fixed +3 gives the wrong day.
    for at, glucose in [("2010-06-01T19:59:59.999Z", "99.0"),
                        ("2010-06-01T20:00:00Z", "4.0"),
                        ("2010-06-02T19:59:59.999Z", "8.0"),
                        ("2010-06-02T20:00:00Z", "99.0")]:
        assert client.post("/api/entries", json=entry(occurred_at=at, glucose=glucose)).status_code == 200
    result = client.get("/api/glucose-summary?period=custom&start=2010-06-02&end=2010-06-02").json()
    assert result["count"] == 2 and result["average"] == "6.0"
    for index in range(105):
        assert client.post("/api/entries", json=entry(occurred_at="2010-07-01T00:00:00+04:00", glucose="5.0")).status_code == 200
    assert client.post("/api/entries", json=entry(occurred_at="2026-10-19T00:00:00+03:00", glucose="10.0")).status_code == 200
    result = client.get("/api/glucose-summary?period=custom&start=2010-07-01&end=2026-10-19").json()
    assert result["count"] == 106 and result["average"] == "5.0"
    assert result["days"][0]["count"] == 105 and result["days"][-1]["count"] == 1
    assert len(result["days"]) == 5955


def test_move_change_delete_restore_refresh_both_days_and_period(diary):
    client, _ = diary
    saved = client.post("/api/entries", json=entry(occurred_at="2026-10-01T12:00:00+03:00", glucose="4.0")).json()
    path = f'/api/entries/{saved["result_id"]}'
    url = "/api/glucose-summary?period=custom&start=2026-10-01&end=2026-10-02"
    assert client.put(path, json=entry(occurred_at="2026-10-02T12:00:00+03:00", glucose="8.0", expected_revision=1)).status_code == 200
    result = client.get(url).json()
    assert result["average"] == "8.0" and [day["count"] for day in result["days"]] == [0, 1]
    assert result["days"][0]["average"] is None and result["days"][1]["average"] == "8.0"
    assert client.post(f"{path}/delete", json={"operation_id": str(uuid4()), "expected_revision": 2}).status_code == 200
    result = client.get(url).json()
    assert result["count"] == 0 and result["average"] is None
    assert client.post(f"{path}/restore", json={"operation_id": str(uuid4()), "expected_revision": 3}).status_code == 200
    result = client.get(url).json()
    assert result["average"] == "8.0" and [day["count"] for day in result["days"]] == [0, 1]
    assert client.put(path, json=entry(occurred_at="2026-10-02T12:00:00+03:00", glucose=None, comment="Без сахара", expected_revision=4)).status_code == 200
    assert client.get(url).json()["count"] == 0


def test_summary_requires_a_session(diary):
    client, _ = diary
    client.cookies.clear()
    response = client.get("/api/glucose-summary")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
