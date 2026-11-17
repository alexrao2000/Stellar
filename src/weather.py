"""Same-origin weather reads keep mobile clients on the app's connection.

Only fixed provider URLs are contacted. Short-lived, bounded caches and a
pooled connection reduce repeated provider calls without storing task data.
"""
from __future__ import annotations

from functools import lru_cache
import time

import httpx
from fastapi import APIRouter, HTTPException, Query, Response


router = APIRouter()
FIELDS = {
    "current": "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m",
    "hourly": "temperature_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_gusts_10m,sunshine_duration,is_day",
    "daily": "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max",
}


@lru_cache(maxsize=1)
def _http() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(8, connect=4))


@lru_cache(maxsize=128)
def _read(url: str, params: tuple[tuple[str, str], ...], bucket: int) -> dict:
    try:
        response = _http().get(url, params=params)
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict) or data.get("error"):
            raise ValueError("Invalid weather response")
        return data
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 429:
            raise HTTPException(503, "Weather is busy. Try again shortly.", headers={"Retry-After": "60"}) from None
        raise HTTPException(503, "Weather is temporarily unavailable. Try again.") from None
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, "Could not reach the weather service. Try again.") from None


@router.get("/api/weather/forecast")
def forecast(response: Response, latitude: float = Query(ge=-90, le=90),
             longitude: float = Query(ge=-180, le=180)) -> dict:
    params = {
        "latitude": str(round(latitude, 4)), "longitude": str(round(longitude, 4)),
        "timezone": "auto", "timeformat": "unixtime", "forecast_days": "7", **FIELDS,
    }
    response.headers["Cache-Control"] = "private, max-age=60"
    return _read("https://api.open-meteo.com/v1/forecast", tuple(params.items()), int(time.time() // 300))


@router.get("/api/weather/cities")
def cities(response: Response, name: str = Query(min_length=2, max_length=100)) -> dict:
    name = name.strip()
    if len(name) < 2:
        return {"results": []}
    params = (("name", name), ("count", "6"), ("language", "en"))
    response.headers["Cache-Control"] = "private, max-age=300"
    return _read("https://geocoding-api.open-meteo.com/v1/search", params, int(time.time() // 3600))
