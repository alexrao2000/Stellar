"""Google and Microsoft adapters preserve native event IDs and versions.

Provider URLs are fixed and pagination links are checked before tokens travel.
Instances, exceptions, all-day events, declined invites and free time retain
provider semantics. Writes touch only the selected occurrence; calendar guests
and unrelated event fields are preserved by partial updates.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException

PROVIDERS = {
    "google": {"label": "Google Calendar", "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
               "token": "https://oauth2.googleapis.com/token", "api": "https://www.googleapis.com/calendar/v3/",
               "read": ["https://www.googleapis.com/auth/calendar.readonly"],
               "write": ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"]},
    "outlook": {"label": "Outlook", "authorize": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
                "token": "https://login.microsoftonline.com/common/oauth2/v2.0/token", "api": "https://graph.microsoft.com/v1.0/",
                "read": ["offline_access", "Calendars.Read"], "write": ["offline_access", "Calendars.ReadWrite"]},
}
META_ID = 'String {6eab02a6-cf59-43d3-896c-bc6fe3c3b0ce} Name StellarTask'


def _http():
    return httpx.Client(timeout=10, follow_redirects=False)


def provider_request(provider, token, method, path, **kwargs):
    base = PROVIDERS[provider]["api"]
    url = path if path.startswith("https://") else base + path
    if not url.startswith(base) or urlsplit(url).username or urlsplit(url).fragment:
        raise HTTPException(502, "The calendar service returned an invalid page link")
    headers = {"Authorization": "Bearer " + token, "Prefer": 'outlook.timezone="UTC", outlook.body-content-type="text"', **kwargs.pop("headers", {})}
    try:
        with _http() as client:
            response = client.request(method, url, headers=headers, **kwargs)
    except httpx.HTTPError:
        raise HTTPException(503, "The calendar service could not be reached. Try again.") from None
    if response.status_code in (409, 412):
        raise HTTPException(409, "This event changed in its calendar. Refresh before editing it.")
    if response.status_code in (401, 403):
        raise HTTPException(403, "Reconnect this calendar to restore its permissions.")
    if response.status_code == 404:
        raise HTTPException(409, "This event was removed or moved. Refresh the calendar.")
    if response.status_code >= 400:
        raise HTTPException(503, "The calendar service could not finish this request. Try again.")
    return response.json() if response.content else {}


def pages(provider, token, path, params=None):
    rows = []
    seen = set()
    for _ in range(20):
        data = provider_request(provider, token, "GET", path, params=params)
        rows.extend(data.get("items" if provider == "google" else "value", []))
        if len(rows) > 2000:
            raise HTTPException(400, "This calendar range is too busy; choose fewer days")
        next_page = data.get("nextPageToken" if provider == "google" else "@odata.nextLink")
        if not next_page:
            return rows
        if next_page in seen:
            break
        seen.add(next_page)
        if provider == "google":
            params = {**(params or {}), "pageToken": next_page}
        else:
            path, params = next_page, None
    raise HTTPException(503, "The calendar service returned too many pages")


def calendars(provider, token):
    rows = pages(provider, token, "users/me/calendarList" if provider == "google" else "me/calendars")
    return [{"id": row["id"], "label": row.get("summaryOverride") or row.get("summary") or row.get("name") or "Calendar",
             "can_write": row.get("accessRole") in ("owner", "writer") if provider == "google" else bool(row.get("canEdit")),
             "primary": bool(row.get("primary") or row.get("isDefaultCalendar")),
             "time_zone": row.get("timeZone") or "UTC"} for row in rows if row.get("id")]


def _moment(value, zone="UTC"):
    if len(value) == 10:
        return datetime.combine(date.fromisoformat(value), time(), ZoneInfo(zone)).astimezone(timezone.utc)
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=ZoneInfo(zone))
    return moment.astimezone(timezone.utc)


def shape_event(provider, row, calendar, connection_id, handle):
    if row.get("status") == "cancelled" or row.get("isCancelled"):
        return None
    start, end = row.get("start", {}), row.get("end", {})
    if not (start.get("dateTime") or start.get("date")) or not (end.get("dateTime") or end.get("date")):
        return None
    try:
        first = _moment(start.get("dateTime") or start["date"], start.get("timeZone") or calendar.get("time_zone", "UTC"))
        last = _moment(end.get("dateTime") or end["date"], end.get("timeZone") or calendar.get("time_zone", "UTC"))
    except (ValueError, KeyError):
        raise HTTPException(502, "A calendar event has an unsupported time zone") from None
    if last <= first:
        return None
    metadata = row.get("extendedProperties", {}).get("private", {}) if provider == "google" else {}
    for prop in row.get("singleValueExtendedProperties", []):
        if prop.get("id") == META_ID:
            try: metadata = json.loads(prop["value"])
            except (ValueError, KeyError): pass
    declined = any(a.get("self") and a.get("responseStatus") == "declined" for a in row.get("attendees", [])) if provider == "google" else row.get("responseStatus", {}).get("response") == "declined"
    busy = row.get("transparency") != "transparent" if provider == "google" else row.get("showAs", "busy") != "free"
    return {"id": handle(connection_id, calendar["id"], row["id"]), "title": row.get("summary") or row.get("subject") or "Busy",
            "notes": (row.get("description") or "") if provider == "google" else row.get("body", {}).get("content", ""),
            "starts_at": first.isoformat(), "ends_at": last.isoformat(), "all_day": bool(start.get("date") or row.get("isAllDay")),
            "kind": metadata.get("stellar_kind", "event") if metadata.get("stellar_kind") in ("run", "task") else "event",
            "client_id": metadata.get("stellar_client_id"), "task_title": metadata.get("stellar_task_title"), "task_series_id": metadata.get("stellar_task_series_id"),
            "updated_at": row.get("etag") or row.get("@odata.etag") or row.get("changeKey"),
            "source": provider, "calendar_label": calendar["label"], "connection_id": connection_id,
            "calendar_id": calendar["id"], "blocks_time": busy and not declined,
            "read_only": not calendar.get("can_write"), "recurring": bool(row.get("recurringEventId") or row.get("seriesMasterId")),
            "has_guests": bool(row.get("attendees"))}


def event_path(provider, calendar_id, event_id=None):
    prefix = "calendars/" if provider == "google" else "me/calendars/"
    path = prefix + quote(calendar_id, safe="") + "/events"
    return path + "/" + quote(event_id, safe="") if event_id else path


def list_events(provider, token, calendar, first, last):
    path = event_path(provider, calendar["id"])
    if provider == "google":
        params = {"timeMin": first, "timeMax": last, "singleEvents": "true", "showDeleted": "false", "maxResults": 250}
    else:
        path = "me/calendars/" + quote(calendar["id"], safe="") + "/calendarView"
        params = {"startDateTime": first, "endDateTime": last, "$top": 250,
                  "$expand": "singleValueExtendedProperties($filter=id eq '" + META_ID + "')"}
    return pages(provider, token, path, params)


def event_body(provider, body):
    first, last = body.starts_at.astimezone(timezone.utc), body.ends_at.astimezone(timezone.utc)
    metadata = {"stellar_client_id": str(body.id), "stellar_kind": body.kind, "stellar_task_title": body.task_title or "",
                "stellar_task_series_id": str(body.task_series_id or "")}
    if body.all_day:
        from .calendar_schedule import calendar_timezone
        tz = ZoneInfo(calendar_timezone())
        first, last = first.astimezone(tz), last.astimezone(tz)
    if provider == "google":
        start = {"date": first.date().isoformat()} if body.all_day else {"dateTime": first.isoformat()}
        end = {"date": last.date().isoformat()} if body.all_day else {"dateTime": last.isoformat()}
        return {"summary": body.title, "description": body.notes, "start": start, "end": end,
                "extendedProperties": {"private": metadata}}
    zone = "UTC"
    if body.all_day:
        from .calendar_schedule import calendar_timezone
        zone = calendar_timezone()
    return {"subject": body.title, "body": {"contentType": "text", "content": body.notes},
            "start": {"dateTime": first.replace(tzinfo=None).isoformat(), "timeZone": zone},
            "end": {"dateTime": last.replace(tzinfo=None).isoformat(), "timeZone": zone}, "isAllDay": body.all_day,
            "singleValueExtendedProperties": [{"id": META_ID, "value": json.dumps(metadata)}]}
