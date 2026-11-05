"""Pool refreshes read shared state; every visible star can retain its position."""
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
