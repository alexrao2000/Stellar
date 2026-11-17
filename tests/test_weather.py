"""Forecast and city reads stay authenticated and constrain upstream requests."""
import httpx
import pytest
from fastapi.testclient import TestClient

from src import server, weather


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    weather._read.cache_clear()
    yield TestClient(server.app, follow_redirects=False)
    weather._read.cache_clear()


def test_weather_queries_are_bounded_and_reused(client, monkeypatch):
    seen = []

    def provider(request):
        seen.append(request)
        if request.url.host == "geocoding-api.open-meteo.com":
            return httpx.Response(200, json={"results": [{"name": "Sample City"}]})
        return httpx.Response(200, json={"timezone": "UTC", "current": {"temperature_2m": 12}})

    with httpx.Client(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        for _ in range(2):
            assert client.get("/api/weather/forecast?latitude=34.05223&longitude=-118.24368").status_code == 200
        result = client.get("/api/weather/cities", params={"name": " Sample City "})
        assert result.json()["results"][0]["name"] == "Sample City"
    assert len(seen) == 2
    params = seen[0].url.params
    assert params["forecast_days"] == "7" and params["timeformat"] == "unixtime"
    assert "sunshine_duration" in params["hourly"]
    assert seen[1].url.params["name"] == "Sample City"
    assert client.get("/api/weather/forecast?latitude=100&longitude=0").status_code == 422
    assert client.get("/api/weather/cities?name=x").status_code == 422


def test_weather_failures_can_be_retried(client, monkeypatch):
    attempts = []

    def provider(request):
        attempts.append(request)
        return httpx.Response(429 if len(attempts) == 1 else 200, json={"results": []})

    with httpx.Client(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        first = client.get("/api/weather/cities?name=Sample")
        assert first.status_code == 503 and first.headers["retry-after"] == "60"
        assert client.get("/api/weather/cities?name=Sample").status_code == 200
    assert len(attempts) == 2


def test_weather_requires_sign_in(client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setenv("AUTH_ALLOWED_EMAIL", "owner@example.com")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "test")
    monkeypatch.setattr(weather, "_http", lambda: pytest.fail("Anonymous provider request"))
    assert client.get("/api/weather/forecast?latitude=34&longitude=-118").status_code == 401
    assert client.get("/api/weather/cities?name=Sample").status_code == 401
