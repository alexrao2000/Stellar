"""Metric modules follow recorded tasks and retain identity across renames."""
from fastapi.testclient import TestClient

from src import server


def test_metric_modules_require_records_and_group_renamed_tasks(monkeypatch):
    definitions = [
        {"id": 10, "series_id": 10, "title": "Read", "starts_on": "2026-01-01", "ends_on": "2026-10-31", "deleted_at": None},
        {"id": 11, "series_id": 10, "title": "Read daily", "starts_on": "2026-11-01", "ends_on": None, "deleted_at": None},
        {"id": 12, "series_id": 12, "title": "No records yet", "starts_on": "2026-11-01", "deleted_at": None},
    ]
    rows = [
        {"day": "2026-11-04", "list_title": "Daily", "title": "Weigh yourself", "weight_lbs": 150},
        {"day": "2026-11-04", "list_title": "Daily", "title": "Wake Up", "notes": "Wake-up Time: 7:30 am"},
        {"day": "2026-10-31", "list_title": "Daily", "title": "Read", "is_completed": True},
        {"day": "2026-11-04", "list_title": "Daily", "title": "Read daily", "is_completed": False},
        {"day": "2026-12-01", "list_title": "Daily", "title": "Future task"},
    ]
    monkeypatch.setattr(server, "_today", lambda: "2026-11-04")
    monkeypatch.setattr(server, "_definitions", lambda: definitions)
    monkeypatch.setattr(server, "_task_projection", lambda columns: rows)
    result = server.api_metrics()
    assert [m["id"] for m in result["modules"]] == ["overview", "weight", "wake", "task-10"]
    assert result["modules"][-1]["label"] == "Read daily"
    assert result["modules"][-1]["titles"] == ["Read", "Read daily"]
    before = result["revision"]
    rows[-2]["is_completed"] = True
    after = server.api_metrics()["revision"]
    assert after != before
    definitions[-1]["optional"] = True
    assert server.api_metrics()["revision"] != after


def test_empty_records_only_offer_overview(monkeypatch):
    monkeypatch.setattr(server, "_definitions", lambda: [])
    monkeypatch.setattr(server, "_task_projection", lambda columns: [])
    assert server.api_metrics()["modules"] == [{"id": "overview", "label": "Overview", "kind": "overview"}]


def test_metrics_shell_is_lazy_and_embedded_task_names_are_safe(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(server, "_task_projection", lambda columns: (_ for _ in ()).throw(AssertionError("eager metrics read")))
    client = TestClient(server.app)
    html = client.get("/metrics").text
    assert 'id="metric-tabs"' in html
    assert 'id="metric-frame"' in html
    html = client.get("/consistency", params={"embedded": "true", "task": "</script><script>alert(1)</script>"}).text
    assert '"task":"</script>' not in html
    assert 'data-embedded="true"' in html
    assert 'class="sidenav"' not in html


def test_metrics_and_embedded_modules_require_authentication(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_ALLOWED_EMAIL", "owner@example.com")
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    client = TestClient(server.app, follow_redirects=False)
    assert client.get("/api/metrics").status_code == 401
    for path in ("/metrics", "/weight?embedded=true", "/wake?embedded=true", "/consistency?embedded=true"):
        assert client.get(path).status_code == 303


def test_report_changes_invalidate_metrics_even_when_completion_is_unchanged(monkeypatch):
    rows = [{"day": "2026-11-04", "list_title": "Daily", "title": "Run", "is_completed": False, "status": "incomplete"}]
    monkeypatch.setattr(server, "_definitions", lambda: [])
    monkeypatch.setattr(server, "_task_projection", lambda columns: rows)
    before = server.api_metrics()["revision"]
    rows[0]["status"] = "unreported"
    assert server.api_metrics()["revision"] != before
