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


def test_public_assets_do_not_open_the_auth_boundary(client):
    for path in ("/sw.js", "/offline", "/app-assets/app.css", "/app-assets/app.js"):
        assert client.get(path).status_code == 200
    for path in ("/", "/tasks", "/weight", "/pool"):
        assert client.get(path).status_code == 303
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
    for path in ("/", "/tasks", "/weight", "/wake", "/consistency", "/data", "/pool", "/docs"):
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
