"""Forecast and city reads stay authenticated and constrain upstream requests."""
import httpx
import pytest
import time
from fastapi.testclient import TestClient

from src import server, weather


def forecast_data():
    now = int(time.time())
    start = now // 86400 * 86400
    values = {"temperature_2m": 15, "apparent_temperature": 14, "weather_code": 0, "is_day": 1,
              "wind_speed_10m": 10, "precipitation": 0, "precipitation_probability": 10,
              "wind_gusts_10m": 15, "sunshine_duration": 3000, "temperature_2m_max": 20,
              "temperature_2m_min": 10, "sunrise": start + 7 * 3600, "sunset": start + 17 * 3600,
              "precipitation_probability_max": 20}
    data = {"timezone": "UTC", "current": {"time": now, **{field: values[field] for field in weather.FIELDS["current"].split(",")}}}
    for section, count, step in (("hourly", 168, 3600), ("daily", 7, 86400)):
        data[section] = {"time": [start + i * step for i in range(count)]}
        for field in weather.FIELDS[section].split(","):
            data[section][field] = [values[field] + (i * step if field in ("sunrise", "sunset") else 0) for i in range(count)]
    return data


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
        return httpx.Response(200, json=forecast_data())

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


@pytest.mark.parametrize("failure", ["timeout", "unavailable", "invalid"])
def test_forecast_fails_over_and_caches_success(client, monkeypatch, caplog, failure):
    hosts = []

    def provider(request):
        hosts.append(request.url.host)
        if request.url.host == "api.open-meteo.com":
            if failure == "timeout":
                raise httpx.ConnectTimeout("TLS handshake timed out", request=request)
            return httpx.Response(503) if failure == "unavailable" else httpx.Response(200, text="not json")
        return httpx.Response(200, json=forecast_data())

    with httpx.Client(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        for _ in range(2):
            result = client.get("/api/weather/forecast?latitude=34.05&longitude=-118.24")
            assert result.status_code == 200 and len(result.json()["hourly"]["time"]) == 168
    assert hosts == ["api.open-meteo.com", "historical-forecast-api.open-meteo.com"]
    assert any("host=api.open-meteo.com error=" in record.message for record in caplog.records)
    assert not any("latitude" in record.message for record in caplog.records if record.name == weather.__name__)


@pytest.mark.parametrize("bad_data", ["stale", "short", "null_future", "missing_fields"])
def test_archive_host_cannot_supply_stale_or_incomplete_forecasts(client, monkeypatch, bad_data):
    data = forecast_data()
    if bad_data == "stale":
        data["current"]["time"] -= 86400
    elif bad_data == "short":
        data["hourly"]["time"] = data["hourly"]["time"][:24]
    elif bad_data == "null_future":
        data["hourly"]["weather_code"][-1] = None
    else:
        del data["hourly"]["precipitation_probability"]

    def provider(request):
        if request.url.host == "api.open-meteo.com":
            raise httpx.ConnectTimeout("Unavailable", request=request)
        return httpx.Response(200, json=data)

    with httpx.Client(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        assert client.get("/api/weather/forecast?latitude=34&longitude=-118").status_code == 503


def test_forecast_rate_limit_does_not_trigger_another_host(client, monkeypatch):
    hosts = []

    def provider(request):
        hosts.append(request.url.host)
        return httpx.Response(429)

    with httpx.Client(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        result = client.get("/api/weather/forecast?latitude=34&longitude=-118")
    assert result.status_code == 503 and result.headers["retry-after"] == "60"
    assert hosts == ["api.open-meteo.com"]


def test_forecast_accepts_missing_optional_observations_and_polar_sunrise(client, monkeypatch):
    data = forecast_data()
    data["current"]["wind_speed_10m"] = None
    data["daily"]["sunrise"] = [None] * 7
    data["daily"]["sunset"] = [None] * 7
    data["hourly"]["precipitation_probability"][-1] = None
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=data))) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        assert client.get("/api/weather/forecast?latitude=70&longitude=20").status_code == 200


def test_failed_forecast_is_not_cached(client, monkeypatch):
    hosts = []
    offline = True

    def provider(request):
        hosts.append(request.url.host)
        if offline:
            raise httpx.ConnectTimeout("Unavailable", request=request)
        return httpx.Response(200, json=forecast_data())

    with httpx.Client(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        assert client.get("/api/weather/forecast?latitude=34&longitude=-118").status_code == 503
        offline = False
        assert client.get("/api/weather/forecast?latitude=34&longitude=-118").status_code == 200
    assert hosts == ["api.open-meteo.com", "historical-forecast-api.open-meteo.com", "api.open-meteo.com"]


def test_forecast_does_not_start_fallback_after_request_budget(client, monkeypatch):
    clock = [100]
    hosts = []
    monkeypatch.setattr(weather.time, "monotonic", lambda: clock[0])

    def provider(request):
        hosts.append(request.url.host)
        clock[0] += 11
        raise httpx.ReadTimeout("Unavailable", request=request)

    with httpx.Client(transport=httpx.MockTransport(provider)) as upstream:
        monkeypatch.setattr(weather, "_http", lambda: upstream)
        assert client.get("/api/weather/forecast?latitude=34&longitude=-118").status_code == 503
    assert hosts == ["api.open-meteo.com"]
