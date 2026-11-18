"""Private calendar endpoints validate times, preserve versions and isolate writes."""
import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from src import calendar_schedule, postgrest, server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(calendar_schedule, "calendar_timezone", lambda: "America/Los_Angeles")
    return TestClient(server.app, follow_redirects=False)


def payload(**values):
    return {"id": str(uuid4()), "title": "Planning", "starts_at": "2026-11-18T17:00:00Z",
            "ends_at": "2026-11-18T18:00:00Z", "notes": "", "kind": "event", "all_day": False, **values}


def database(monkeypatch, handler):
    upstream = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(postgrest, "_http", lambda: upstream)
    monkeypatch.setattr(server, "_sb", lambda: postgrest.Client("https://database.invalid", "test"))
    return upstream


def test_events_read_real_overlaps_and_use_etags(client, monkeypatch):
    calls = []
    row = {**payload(), "updated_at": "2026-11-18T16:00:00Z"}

    def handler(request):
        calls.append(request)
        assert request.url.path == "/rest/v1/calendar_events"
        assert request.url.params.get("starts_at") == "lt.2026-11-23T00:00:00-08:00"
        assert request.url.params.get("ends_at") == "gt.2026-11-16T00:00:00-08:00"
        return httpx.Response(200, json=[row])

    with database(monkeypatch, handler):
        result = client.get("/api/calendar/events?start=2026-11-16&end=2026-11-22")
        assert result.status_code == 200 and result.json()["events"][0]["title"] == "Planning"
        assert result.headers["cache-control"] == "no-store"
        cached = client.get("/api/calendar/events?start=2026-11-16&end=2026-11-22", headers={"If-None-Match": result.headers["etag"]})
        assert cached.status_code == 304
    assert len(calls) == 2
    assert client.get("/api/calendar/events?start=2026-11-16&end=2027-01-01").status_code == 400


def test_event_create_and_retried_save_preserve_identity(client, monkeypatch):
    rows = []
    calls = []
    body = payload()

    def handler(request):
        calls.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=rows)
        row = {**json.loads(request.content), "updated_at": "2026-11-18T16:00:00Z"}
        rows.append(row)
        return httpx.Response(201, json=[row])

    with database(monkeypatch, handler):
        first = client.post("/api/calendar/events", json=body)
        second = client.post("/api/calendar/events", json=body)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert [request.method for request in calls] == ["GET", "POST", "GET"]
    assert rows[0]["time_zone"] == "America/Los_Angeles"


def test_a_simultaneous_retried_create_returns_the_saved_event(client, monkeypatch):
    body = payload()
    reads = 0

    def handler(request):
        nonlocal reads
        if request.method == "POST":
            return httpx.Response(409, json={"code": "23505"})
        reads += 1
        return httpx.Response(200, json=[] if reads == 1 else [{**body, "updated_at": "2026-11-18T16:00:00Z"}])

    with database(monkeypatch, handler):
        result = client.post("/api/calendar/events", json=body)
    assert result.status_code == 200 and result.json()["id"] == body["id"]
    assert reads == 2


@pytest.mark.parametrize("changes", [
    {"title": "  "}, {"starts_at": "2026-11-18T09:00:00"}, {"ends_at": "2026-11-18T16:00:00Z"},
    {"ends_at": "2027-01-01T18:00:00Z"}, {"kind": "run", "all_day": True}, {"title": "a" * 161},
])
def test_invalid_event_never_reaches_database(client, monkeypatch, changes):
    monkeypatch.setattr(server, "_sb", lambda: pytest.fail("Invalid event reached storage"))
    assert client.post("/api/calendar/events", json=payload(**changes)).status_code == 422


def test_updates_and_deletes_require_the_version_seen_by_the_editor(client, monkeypatch):
    body = payload(version="2026-11-18T16:00:00Z")
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.params["updated_at"] == "eq.2026-11-18T16:00:00+00:00"
        return httpx.Response(200, json=[])

    with database(monkeypatch, handler):
        assert client.put("/api/calendar/events/" + body["id"], json=body).status_code == 409
        assert client.delete("/api/calendar/events/" + body["id"], params={"version": body["version"]}).status_code == 409
    assert [request.method for request in calls] == ["PATCH", "DELETE"]


def test_run_conflicts_are_actionable_and_do_not_change_task_records(client, monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        assert request.url.path == "/rest/v1/calendar_events"
        return httpx.Response(200, json=[]) if request.method == "GET" else httpx.Response(400, json={"code": "23P01", "message": "calendar_run_conflict"})

    with database(monkeypatch, handler):
        result = client.post("/api/calendar/events", json=payload(kind="run", task_title="Run", ends_at="2026-11-18T17:10:00Z"))
    assert result.status_code == 409 and "occupied" in result.json()["detail"]
    assert len(calls) == 2


def test_calendar_is_private_and_mutations_require_same_origin(client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_ALLOWED_EMAIL", "owner@example.com")
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test")
    monkeypatch.setattr(server, "_sb", lambda: pytest.fail("Anonymous calendar storage access"))
    assert client.post("/api/calendar/events", headers={"Origin": "https://elsewhere.invalid"}, json=payload()).status_code == 403
    assert client.get("/calendar").status_code == 303
    assert client.get("/api/calendar/events?start=2026-11-16&end=2026-11-22").status_code == 401
    assert client.post("/api/calendar/events", headers={"Origin": "http://testserver"}, json=payload()).status_code == 401
