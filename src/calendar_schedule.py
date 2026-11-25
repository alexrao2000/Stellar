"""Stellar's private timed calendar, separate from task completion records.

Events use absolute timestamps and the app timezone. Runs reserve time without
marking tasks done. Database guards serialize run bookings; optimistic versions
prevent an older device from overwriting or deleting a newer edit.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Literal
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import AwareDatetime, BaseModel, Field, model_validator

from .config import load_config
from .postgrest import PostgrestError
from .timezones import resolve_timezone

router = APIRouter()
COLUMNS = "id,title,notes,starts_at,ends_at,all_day,kind,task_title,task_series_id,run_day,time_zone,updated_at"


def _db():
    from .server import _sb
    return _sb()


def calendar_timezone() -> str:
    return resolve_timezone(load_config(), allow_google=False)


class CalendarEvent(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    title: str = Field(min_length=1, max_length=160)
    notes: str = Field(default="", max_length=2000)
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    all_day: bool = False
    kind: Literal["event", "run", "task"] = "event"
    task_title: str | None = Field(default=None, max_length=200)
    task_series_id: int | None = Field(default=None, gt=0)
    version: AwareDatetime | None = None

    @model_validator(mode="after")
    def valid_interval(self):
        self.title = self.title.strip()
        if not self.title or self.ends_at <= self.starts_at:
            raise ValueError("Enter a title and an end time after the start")
        if self.ends_at - self.starts_at > timedelta(days=31):
            raise ValueError("An event can span at most 31 days")
        if self.kind in {"run", "task"} and (self.all_day or not timedelta(seconds=1) <= self.ends_at - self.starts_at <= timedelta(hours=8)):
            raise ValueError("A scheduled task needs a timed slot of 1 second to 8 hours")
        return self

    def row(self) -> dict:
        tz_name = calendar_timezone()
        start = self.starts_at.astimezone(timezone.utc)
        return {"id": str(self.id), "title": self.title, "notes": self.notes,
                "starts_at": start.isoformat(), "ends_at": self.ends_at.astimezone(timezone.utc).isoformat(),
                "all_day": self.all_day, "kind": self.kind, "time_zone": tz_name,
                "task_title": self.task_title if self.kind in {"run", "task"} else None,
                "task_series_id": self.task_series_id if self.kind in {"run", "task"} else None,
                "run_day": start.astimezone(ZoneInfo(tz_name)).date().isoformat() if self.kind in {"run", "task"} else None}


def _shape(row: dict) -> dict:
    return {column: row.get(column) for column in COLUMNS.split(",")}


def _same_event(row: dict, body: CalendarEvent) -> bool:
    expected = body.row()
    return (all(row.get(key) == expected.get(key) for key in ("title", "notes", "all_day", "kind", "task_title", "task_series_id"))
            and all(datetime.fromisoformat(row[key].replace("Z", "+00:00")) == getattr(body, key)
                    for key in ("starts_at", "ends_at")))


def _write_error(exc: PostgrestError):
    if "23P01" in str(exc) or "calendar_run_conflict" in str(exc):
        raise HTTPException(409, "That task slot is now occupied. Choose another suggestion.") from None
    if "23505" in str(exc):
        raise HTTPException(409, "This task is already scheduled for that day. Move or remove it first.") from None
    raise exc


@router.get("/api/calendar/events")
def events(request: Request, start: date, end: date) -> Response:
    if end < start or (end - start).days > 41:
        raise HTTPException(400, "Choose a calendar range of at most 42 days")
    tz = ZoneInfo(calendar_timezone())
    first = datetime.combine(start, datetime.min.time(), tz).isoformat()
    last = datetime.combine(end + timedelta(days=1), datetime.min.time(), tz).isoformat()
    rows = (_db().table("calendar_events").select(COLUMNS).filter("starts_at", "lt", last)
            .filter("ends_at", "gt", first).order("starts_at,id").limit(1001).execute().data or [])
    if len(rows) > 1000:
        raise HTTPException(400, "This range contains too many events; choose fewer days")
    body = json.dumps({"events": [_shape(row) for row in rows]}, separators=(",", ":"), sort_keys=True)
    etag = '"' + sha256(body.encode()).hexdigest() + '"'
    headers = {"Cache-Control": "no-store", "ETag": etag, "Vary": "Cookie"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


@router.post("/api/calendar/events")
def create_event(body: CalendarEvent, request: Request) -> dict:
    row = body.row()
    existing = _db().table("calendar_events").select(COLUMNS).eq("id", row["id"]).execute().data or []
    if existing:
        if _same_event(existing[0], body):
            return _shape(existing[0])
        raise HTTPException(409, "This event changed on another device. Refresh before editing it.")
    if body.kind == "task":
        from .calendar_connections import check_slot
        check_slot(request, body)
    try:
        rows = _db().table("calendar_events").insert(row).execute().data or []
    except PostgrestError as exc:
        if "23505" in str(exc):
            existing = _db().table("calendar_events").select(COLUMNS).eq("id", row["id"]).execute().data or []
            if existing and _same_event(existing[0], body):
                return _shape(existing[0])
        _write_error(exc)
    if not rows:
        raise HTTPException(503, "The event could not be saved. Try again.")
    return _shape(rows[0])


@router.put("/api/calendar/events/{event_id}")
def update_event(event_id: UUID, body: CalendarEvent, request: Request) -> dict:
    if body.version is None:
        raise HTTPException(400, "Refresh this event before editing it")
    row = body.row()
    row.pop("id")
    if body.kind == "task":
        from .calendar_connections import check_slot
        check_slot(request, body, str(event_id))
    try:
        rows = (_db().table("calendar_events").update(row).eq("id", str(event_id))
                .eq("updated_at", body.version.isoformat()).execute().data or [])
    except PostgrestError as exc:
        _write_error(exc)
    if not rows:
        raise HTTPException(409, "This event changed on another device. Refresh before editing it.")
    return _shape(rows[0])


@router.delete("/api/calendar/events/{event_id}")
def delete_event(event_id: UUID, version: AwareDatetime = Query()) -> dict:
    rows = (_db().table("calendar_events").delete().eq("id", str(event_id))
            .eq("updated_at", version.isoformat()).execute().data or [])
    if not rows:
        raise HTTPException(409, "This event changed on another device. Refresh before removing it.")
    return {"deleted": str(event_id)}
