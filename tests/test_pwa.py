"""Installation assets stay public without exposing authenticated app data."""
import struct
from html.parser import HTMLParser

import pytest
from fastapi.testclient import TestClient

from src import server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_ALLOWED_EMAIL", "owner@example.com")
    monkeypatch.setenv("SUPABASE_URL", "https://project.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test")
    return TestClient(server.app, follow_redirects=False)


def test_manifest_and_icons_are_available_before_sign_in(client):
    response = client.get("/manifest.webmanifest")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/manifest+json")
    manifest = response.json()
    assert manifest["name"] == "Stellar"
    assert manifest["short_name"] == "Stellar"
    assert manifest["id"] == "/"
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "/"
    assert manifest["scope"] == "/"
    for icon in manifest["icons"]:
        png = client.get(icon["src"])
        assert png.status_code == 200
        assert png.headers["content-type"] == "image/png"
        assert png.content[:8] == b"\x89PNG\r\n\x1a\n"
        width, height = struct.unpack(">II", png.content[16:24])
        assert f"{width}x{height}" == icon["sizes"]
    assert client.get("/app-assets/apple-touch-icon.png").status_code == 200
    assert client.get("/app-assets/icon-192.png").content == client.get(manifest["icons"][0]["src"]).content
    assert client.get("/app-assets/apple-touch-icon.png").content == client.get("/app-assets/stellar-apple-touch-icon.png").content
    assert client.get("/favicon.svg").content == client.get("/app-assets/stellar.svg").content


def test_public_assets_do_not_open_the_auth_boundary(client):
    for path in ("/sw.js", "/offline", "/app-assets/app.css", "/app-assets/stellar.css", "/app-assets/app.js",
                 "/app-assets/workspace.css", "/app-assets/workspace.js", "/app-assets/navigation.js",
                 "/app-assets/navigation.css", "/app-assets/metrics.js",
                 "/app-assets/sections.js", "/app-assets/sections.css",
                 "/app-assets/ranges.js", "/app-assets/ranges.css",
                 "/app-assets/reports.js", "/app-assets/reports.css"):
        assert client.get(path).status_code == 200
    for path in ("/", "/tasks", "/weight", "/pool", "/pool?embedded=true", "/metrics?tab_frame=true", "/data?tab_frame=true", "/tasks?tab_frame=true"):
        assert client.get(path).status_code == 303
    assert client.post("/api/day/2026-11-04/report", headers={"Origin": "http://testserver"}, json={"title": "Run", "state": "incomplete"}).status_code == 401
    assert client.get("/api/task_history").status_code == 401
    assert client.post("/api/day/2026-11-04/weight?lbs=150",
                       headers={"Origin": "http://testserver"}).status_code == 401
    assert client.get("/app-assets/credentials.json").status_code != 200


def test_service_worker_is_revalidated_and_has_root_scope(client):
    response = client.get("/sw.js")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["service-worker-allowed"] == "/"
    assert response.headers["content-type"].startswith("text/javascript")


class Head(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_head = False
        self.viewport = []
        self.manifests = []

    def handle_starttag(self, tag, attrs):
        if tag == "head":
            self.in_head = True
        attrs = dict(attrs)
        if self.in_head and tag == "meta" and attrs.get("name") == "viewport":
            self.viewport.append(attrs["content"])
        if self.in_head and tag == "link" and attrs.get("rel") == "manifest":
            self.manifests.append(attrs["href"])

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False


def test_all_views_and_login_have_a_real_mobile_document(client, monkeypatch):
    monkeypatch.setattr(server, "_definitions", lambda **kwargs: [])
    monkeypatch.setattr(server, "_pool_state", lambda **kwargs: {"tasks": [], "edges": []})
    pages = [client.get("/login").text]
    monkeypatch.setenv("AUTH_ENABLED", "false")
    for path in ("/", "/tasks", "/metrics", "/weight", "/wake", "/consistency", "/data", "/pool", "/docs"):
        response = client.get(path)
        assert response.status_code == 200
        pages.append(response.text)
    for page in pages:
        assert page.lstrip().lower().startswith("<!doctype html>")
        head = Head()
        head.feed(page)
        assert head.viewport == ["width=device-width,initial-scale=1,viewport-fit=cover"]
        assert head.manifests == ["/manifest.webmanifest"]
        assert 'id="install-dialog"' in page
        assert 'data-install hidden' in page
        assert "Stellar" in page
        assert "Task Tracker" not in page


def test_pool_paints_its_shell_before_reading_data(client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    calls = []

    def pool_state(**kwargs):
        calls.append(kwargs)
        return {"tasks": [{"id": "7", "title": "Plan the week"}], "edges": []}
    monkeypatch.setattr(server, "_pool_state", pool_state)
    response = client.get("/pool?embedded=true")
    assert response.status_code == 200
    assert 'data-page="pool" data-embedded="true"' in response.text
    assert 'class="sidenav"' not in response.text
    assert 'id="pool-add"' in response.text
    assert 'id="pool-map"' in response.text
    assert not calls
    assert 'id="pool-loading"' in response.text
    standalone = client.get("/pool")
    assert 'class="sidenav"' in standalone.text
    assert 'data-embedded="true"' not in standalone.text
    assert not calls
    data = client.get("/api/pool?resolved=true")
    assert data.json()["tasks"][0]["title"] == "Plan the week"
    assert len(calls) == 1


def test_tasks_page_does_not_read_pool_until_the_browser_opens_it(client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    def unexpected_pool_read(**kwargs):
        raise AssertionError("Pool must load only when its pane is opened")
    monkeypatch.setattr(server, "_pool_state", unexpected_pool_read)
    response = client.get("/?view=week")
    assert response.status_code == 200
    assert 'aria-controls="pool-pane"' in response.text
    assert '<iframe id="pool-frame" title="Undated task pool"></iframe>' in response.text


def test_cached_sections_share_only_the_outer_sidebar(client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(server, "_definitions", lambda **kwargs: [])
    for path in ("/", "/metrics", "/data", "/tasks", "/pool", "/docs"):
        page = client.get(path + "?tab_frame=true")
        assert page.status_code == 200
        assert '<nav class="sidenav"' not in page.text
        assert '/app-assets/sections.js?v=1' in page.text
        assert 'data-embedded="true"' not in page.text
        assert '<nav class="sidenav"' in client.get(path).text


def test_range_assets_load_only_for_the_selected_layout(client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    for view in ("day", "month", "3days", "week", "custom"):
        html = client.get("/?view=" + view).text
        selected = view in {"3days", "week", "custom"}
        assert ('<link rel="preload" as="script" href="/app-assets/ranges.js?v=7">' in html) == selected
        assert ('<link rel="preload" as="style" href="/app-assets/ranges.css?v=8">' in html) == selected
        assert "__RANGE_ASSETS__" not in html
