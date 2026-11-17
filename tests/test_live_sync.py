"""Revision checks expose only counters and bypass worker caches after a change."""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient
from starlette.requests import Request

from src import server


def test_revision_etag_is_fresh_and_preserves_bigints(monkeypatch):
    rows = [{"scope": scope, "version": 9007199254740993} for scope in ("records", "pool", "definitions")]
    calls = []
    class Query:
        def table(self, name):
            assert name == "stellar_changes"
            calls.append(name)
            return self
        def select(self, columns):
            assert columns == "scope,version"
            return self
        def order(self, key): return self
        def execute(self): return SimpleNamespace(data=rows)
    monkeypatch.setattr(server, "_sb", Query)
    request = lambda headers=(): Request({"type": "http", "headers": headers})
    first = server.api_changes(request())
    assert first.status_code == 200
    assert set(json.loads(first.body).values()) == {"9007199254740993"}
    assert first.headers["cache-control"] == "no-store"
    headers = [(b"if-none-match", first.headers["etag"].encode())]
    assert server.api_changes(request(headers)).status_code == 304
    rows[0]["version"] += 1
    changed = server.api_changes(request(headers))
    assert changed.status_code == 200
    assert changed.headers["etag"] != first.headers["etag"]
    assert len(calls) == 3
    rows.clear()
    with pytest.raises(HTTPException) as error:
        server.api_changes(request())
    assert error.value.status_code == 503


def test_history_change_bypasses_another_workers_cache(monkeypatch):
    monkeypatch.setattr(server, "_cache", {"task_history": (0, ["stale"])})
    monkeypatch.setattr(server, "_refresh_failed", {"task_history": 1})
    def history():
        assert "task_history" not in server._cache
        assert "task_history" not in server._refresh_failed
        return []
    monkeypatch.setattr(server, "_task_history", history)
    monkeypatch.setattr(server, "_definitions", lambda fresh=False: [] if fresh else pytest.fail("Cached definitions"))
    assert server.api_task_history(fresh=True) == []


def test_startup_revision_is_read_before_tasks(monkeypatch):
    calls = []
    revision = {"records": "12", "definitions": "8", "pool": "3"}

    def versions():
        calls.append("versions")
        return revision

    def definitions(**kwargs):
        calls.append("definitions")
        return []

    class EmptyQuery:
        def table(self, name):
            calls.append(name)
            return self

        def __getattr__(self, name):
            return lambda *args: self

        def execute(self):
            return SimpleNamespace(data=[])

    monkeypatch.setattr(server, "_sync_versions", versions)
    monkeypatch.setattr(server, "_definitions", definitions)
    monkeypatch.setattr(server, "_sb", EmptyQuery)
    for read in (
        lambda response: server.api_day("2026-11-16", response, with_revisions=True),
        lambda response: server.api_range("2026-11-15", "2026-11-17", response, with_revisions=True),
    ):
        calls.clear()
        response = Response()
        read(response)
        assert calls == ["versions", "definitions", "task_history"]
        assert json.loads(response.headers["X-Stellar-Revisions"]) == revision


def test_sync_endpoints_require_a_session(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_ALLOWED_EMAIL", "test@example.com")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test")
    monkeypatch.setattr(server, "_sb", lambda: pytest.fail("Unauthenticated database read"))
    client = TestClient(server.app, follow_redirects=False)
    assert client.get('/api/changes').status_code == 401
    assert client.get('/api/task_settings').status_code == 401
