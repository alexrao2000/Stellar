"""Same-origin weather reads keep mobile clients on the app's connection.

Only fixed provider URLs are contacted. Short-lived, bounded caches and a
pooled connection reduce repeated provider calls without storing task data.
Forecast failover uses the provider's compatible archive host only when it
returns fresh current conditions and a populated seven-day forecast horizon.
"""
from __future__ import annotations

from functools import lru_cache
import logging
import math
import time
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Query, Response


router = APIRouter()
logger = logging.getLogger(__name__)
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
FORECAST_FALLBACK = "https://historical-forecast-api.open-meteo.com/v1/forecast"
FIELDS = {
    "current": "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m",
    "hourly": "temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_gusts_10m,sunshine_duration,is_day",
    "daily": "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max",
}


@lru_cache(maxsize=1)
def _http() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(8, connect=4))


def _validate_forecast(data: dict) -> None:
    def finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    current = data.get("current")
    now = time.time()
    if (not isinstance(current, dict) or not finite(current.get("time"))
            or not -900 <= now - current["time"] <= 7200
            or not all(finite(current.get(field)) for field in ("temperature_2m", "weather_code"))
            or not isinstance(data.get("timezone"), str) or not data["timezone"]):
        raise ValueError("Current conditions are missing or stale")
    for section, minimum in (("hourly", 144), ("daily", 7)):
        values = data.get(section)
        times = values.get("time") if isinstance(values, dict) else None
        if (not isinstance(times, list) or len(times) < minimum or not all(map(finite, times))
                or any(end <= start for start, end in zip(times, times[1:]))
                or times[-1] < now + 5 * 86400):
            raise ValueError("Forecast horizon is incomplete")
        for field in FIELDS[section].split(","):
            array = values.get(field)
            if not isinstance(array, list) or len(array) != len(times):
                raise ValueError("Forecast fields are incomplete")
        required = ("temperature_2m", "weather_code") if section == "hourly" else (
            "temperature_2m_max", "temperature_2m_min")
        if not all(finite(values[field][-1]) for field in required):
            raise ValueError("Forecast horizon has no weather data")


@lru_cache(maxsize=128)
def _read(url: str, params: tuple[tuple[str, str], ...], bucket: int) -> dict:
    endpoints = (url, FORECAST_FALLBACK) if url == FORECAST_URL else (url,)
    deadline = time.monotonic() + 10
    for attempt, endpoint in enumerate(endpoints):
        remaining = deadline - time.monotonic()
        if remaining < 1:
            break
        connect = min(2, remaining / 3)
        timeout = httpx.Timeout(min(3 if attempt == 0 else 6, remaining - connect - .4),
                                connect=connect, pool=.2, write=.2)
        if url != FORECAST_URL:
            timeout = httpx.Timeout(8, connect=4)
        try:
            response = _http().get(endpoint, params=params, timeout=timeout)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict) or data.get("error"):
                raise ValueError("Invalid weather response")
            if url == FORECAST_URL:
                _validate_forecast(data)
            if endpoint != url:
                logger.info("Weather forecast failover succeeded host=%s", urlsplit(endpoint).hostname)
            return data
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            logger.warning("Weather upstream failed host=%s error=%s status=%s", urlsplit(endpoint).hostname,
                           type(exc).__name__, status)
            if status == 429:
                raise HTTPException(503, "Weather is busy. Try again shortly.", headers={"Retry-After": "60"}) from None
            if status < 500:
                raise HTTPException(503, "Weather is temporarily unavailable. Try again.") from None
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Weather upstream failed host=%s error=%s", urlsplit(endpoint).hostname, type(exc).__name__)
    raise HTTPException(503, "Could not reach the weather service. Try again.")


@router.get("/api/weather/forecast")
def forecast(response: Response, latitude: float = Query(ge=-90, le=90),
             longitude: float = Query(ge=-180, le=180)) -> dict:
    params = {
        "latitude": str(round(latitude, 4)), "longitude": str(round(longitude, 4)),
        "timezone": "auto", "timeformat": "unixtime", "forecast_days": "7", **FIELDS,
    }
    response.headers["Cache-Control"] = "private, max-age=60"
    return _read(FORECAST_URL, tuple(params.items()), int(time.time() // 300))


@router.get("/api/weather/cities")
def cities(response: Response, name: str = Query(min_length=2, max_length=100)) -> dict:
    name = name.strip()
    if len(name) < 2:
        return {"results": []}
    params = (("name", name), ("count", "6"), ("language", "en"))
    response.headers["Cache-Control"] = "private, max-age=300"
    return _read("https://geocoding-api.open-meteo.com/v1/search", params, int(time.time() // 3600))
