"""Constellations refresh shared state and update individual star fields."""
import json
import httpx
import pytest
from fastapi.testclient import TestClient

from src import postgrest, server


def test_pool_api_bypasses_stale_worker_cache(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    old = {"tasks": [{"id": 1, "x": .1, "y": .2}], "edges": []}
    fresh = {"tasks": [{"id": 1, "x": .8, "y": .7}], "edges": []}
    monkeypatch.setattr(server, "_pool_all", lambda: old)
    monkeypatch.setattr(server, "_pool_fetch", lambda: fresh)
    response = TestClient(server.app).get("/api/pool?resolved=true")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == fresh


@pytest.mark.parametrize("resolved_at", [None, "2026-11-04T12:00:00Z"])
def test_move_persists_open_and_resolved_stars(monkeypatch, resolved_at):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    row = {"id": 1, "x": .1, "y": .2, "resolved_at": resolved_at}
    requests = []

    def database(request):
        requests.append(request)
        assert request.method == "PATCH"
        assert request.url.params.get("id") == "eq.1"
        assert "resolved_at" not in request.url.params
        return httpx.Response(200, json=[{**row, "x": .98, "y": .02}])

    with httpx.Client(transport=httpx.MockTransport(database)) as http:
        monkeypatch.setattr(postgrest, "_http", lambda: http)
        monkeypatch.setattr(server, "_sb", lambda: postgrest.Client("https://database.invalid", "test"))
        monkeypatch.setattr(server, "_cache", {"pool": (0, {"tasks": [row], "edges": []})})
        response = TestClient(server.app).post("/api/pool/task/1/move?x=1.4&y=-.4")

    assert response.status_code == 200
    assert response.json()["resolved_at"] == resolved_at
    assert row["x"] == .98 and row["y"] == .02
    assert len(requests) == 1


@pytest.mark.parametrize("resolved_at", [None, "2026-11-04T12:00:00Z"])
def test_rename_updates_only_the_title_of_open_and_resolved_stars(monkeypatch, resolved_at):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    row = {"id": 1, "title": "Old name", "x": .1, "y": .2,
           "resolved_at": resolved_at, "remind_at": "2026-12-01T12:00:00Z"}
    writes = []

    def database(request):
        assert request.method == "PATCH"
        assert request.url.params.get("id") == "eq.1"
        body = json.loads(request.content)
        writes.append(body)
        return httpx.Response(200, json=[{**row, **body}])

    with httpx.Client(transport=httpx.MockTransport(database)) as http:
        monkeypatch.setattr(postgrest, "_http", lambda: http)
        monkeypatch.setattr(server, "_sb", lambda: postgrest.Client("https://database.invalid", "test"))
        monkeypatch.setattr(server, "_cache", {"pool": (0, {"tasks": [row], "edges": []})})
        client = TestClient(server.app)
        assert client.post("/api/pool/task/1/rename", json={"title": " "}).status_code == 400
        assert client.post("/api/pool/task/1/rename", json={"title": "x" * 201}).status_code == 400
        response = client.post("/api/pool/task/1/rename", json={"title": "  Order via eBay  "})

    assert response.status_code == 200
    assert response.json() == row
    assert writes == [{"title": "Order via eBay"}]
    assert row["title"] == "Order via eBay"


def test_undo_matches_the_specific_resolution_and_returns_resumed_age(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    original = "2026-11-20T12:00:00+00:00"
    resumed = "2026-08-30T12:00:00+00:00"
    row = {"id": 1, "resolved_at": original, "created_at": "2026-08-24T12:00:00+00:00"}

    def database(request):
        assert request.method == "PATCH"
        assert request.url.params.get("id") == "eq.1"
        if request.url.params.get("resolved_at") != "eq." + original:
            return httpx.Response(200, json=[])
        assert json.loads(request.content)["resolved_at"] is None
        return httpx.Response(200, json=[{**row, "resolved_at": None, "age_started_at": resumed}])

    with httpx.Client(transport=httpx.MockTransport(database)) as http:
        monkeypatch.setattr(postgrest, "_http", lambda: http)
        monkeypatch.setattr(server, "_sb", lambda: postgrest.Client("https://database.invalid", "test"))
        monkeypatch.setattr(server, "_cache", {"pool": (0, {"tasks": [row], "edges": []})})
        client = TestClient(server.app)
        url = "/api/pool/task/1/resolve"
        stale = client.post(url, params={"done": False, "expected_resolved_at": "2026-11-19T12:00:00Z"})
        assert stale.status_code == 409
        assert row["resolved_at"] == original
        undone = client.post(url, params={"done": False, "expected_resolved_at": original})

    assert undone.status_code == 200
    assert undone.json()["age_started_at"] == resumed
    assert row["age_started_at"] == resumed
    assert row["created_at"] == "2026-08-24T12:00:00+00:00"
