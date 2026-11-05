"""Private Web Push subscriptions and durable, per-device star reminders.

The database leases deliveries and invalidates them when a star is rescheduled,
resolved, or deleted. Push endpoints are restricted to browser push providers;
subscription keys and dispatcher credentials never enter logs or public APIs.
Only a device's explicit permission action subscribes it. The worker rechecks
current star state before sending; a push already accepted cannot be recalled.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import secrets
from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

router = APIRouter()
log = logging.getLogger(__name__)
DISPATCH_PATH = "/api/internal/reminders/dispatch"


def _db():
    from .server import _sb
    return _sb()


def configured() -> bool:
    return all(os.getenv(key) for key in ("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "REMINDER_DISPATCH_SECRET"))


def dispatcher_authorized(request: Request) -> bool:
    secret = os.getenv("REMINDER_DISPATCH_SECRET", "")
    return bool(secret) and secrets.compare_digest(request.headers.get("authorization", "").encode(), ("Bearer " + secret).encode())


class Endpoint(BaseModel):
    endpoint: str = Field(min_length=10, max_length=2048)


class Subscription(Endpoint):
    keys: dict[str, str]
    expirationTime: int | None = None


def validate_endpoint(endpoint: str) -> None:
    try:
        url = urlsplit(endpoint)
        host = url.hostname or ""
        allowed = host in {"fcm.googleapis.com", "web.push.apple.com"} or host.endswith(".push.services.mozilla.com") or host.endswith(".notify.windows.com")
        if url.scheme != "https" or not allowed or url.port not in (None, 443) or url.username or url.password or url.fragment:
            raise ValueError()
    except ValueError:
        raise HTTPException(400, "This is not a supported browser push endpoint") from None


def validate_subscription(subscription: dict) -> None:
    validate_endpoint(subscription["endpoint"])
    try:
        for name, size in (("p256dh", 65), ("auth", 16)):
            key = subscription["keys"][name]
            raw = base64.b64decode(key + "=" * (-len(key) % 4), altchars=b"-_", validate=True)
            if len(raw) != size or (name == "p256dh" and raw[0] != 4):
                raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "Invalid push subscription keys") from None


def send_push(subscription: dict, payload: dict) -> None:
    from pywebpush import webpush
    validate_subscription(subscription)
    webpush(subscription_info=subscription, data=json.dumps(payload),
            vapid_private_key=os.environ["VAPID_PRIVATE_KEY"],
            vapid_claims={"sub": os.getenv("VAPID_SUBJECT", "https://stellar-record.vercel.app")},
            ttl=3600, timeout=8, headers={"Urgency": "normal"})


@router.get("/api/notifications/config")
def notification_config(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {"enabled": configured(), "public_key": os.getenv("VAPID_PUBLIC_KEY", ""), "default_hours": 24}


@router.post("/api/notifications/subscribe")
def subscribe(body: Subscription) -> dict:
    if not configured():
        raise HTTPException(503, "Notifications are not configured yet")
    subscription = body.model_dump()
    validate_subscription(subscription)
    rows = _db().rpc("register_stellar_push", {"payload": subscription}).data
    return {"id": rows[0]["id"]}


@router.delete("/api/notifications/subscribe")
def unsubscribe(body: Endpoint) -> dict:
    validate_endpoint(body.endpoint)
    _db().table("push_subscriptions").delete().eq("endpoint", body.endpoint).execute()
    return {"ok": True}


@router.post("/api/notifications/test")
def test_notification(body: Endpoint) -> dict:
    validate_endpoint(body.endpoint)
    rows = _db().table("push_subscriptions").select("subscription").eq("endpoint", body.endpoint).execute().data
    if not rows:
        raise HTTPException(404, "Enable notifications on this device first")
    try:
        send_push(rows[0]["subscription"], {"title": "Stellar", "body": "Your star reminders are ready.", "tag": "stellar-test", "url": "/pool"})
    except Exception:
        log.warning("Test notification delivery failed")
        raise HTTPException(503, "Could not send the test notification. Try enabling notifications again.") from None
    return {"ok": True}


class ReminderTime(BaseModel):
    at: datetime | None = None


@router.post("/api/pool/task/{task_id}/reminder")
def set_reminder(task_id: int, body: ReminderTime) -> dict:
    at = body.at
    if at is not None and (at.tzinfo is None or at <= datetime.now(timezone.utc)):
        raise HTTPException(400, "Choose a future reminder time with a time zone")
    values = {"remind_at": at.astimezone(timezone.utc).isoformat() if at else None,
              "reminder_sent_at": None, "reminder_version": str(uuid4())}
    rows = _db().table("pool_tasks").update(values).eq("id", task_id).is_("resolved_at", "null").execute().data
    if not rows:
        raise HTTPException(404, "This star is no longer open")
    from .server import _pool_patch
    def patch(state):
        for task in state["tasks"]:
            if task["id"] == task_id:
                task.update(values)
    _pool_patch(patch)
    return rows[0]


def dispatch_reminders() -> dict:
    db = _db()
    deliveries = db.rpc("claim_stellar_reminders", {"batch_size": 25}).data
    counts = {"sent": 0, "retry": 0, "failed": 0, "cancelled": 0}
    for delivery in deliveries:
        current = db.table("pool_tasks").select("id,reminder_version,remind_at,resolved_at") \
            .eq("id", delivery["task_id"]).execute().data
        task = current[0] if current else None
        outcome = "failed"
        expired = False
        if not task or task.get("resolved_at") or not task.get("remind_at") or task["reminder_version"] != delivery["reminder_version"]:
            counts["cancelled"] += 1
        else:
            try:
                send_push(delivery["subscription"], {
                    "title": "Stellar · Star reminder", "body": delivery["title"],
                    "tag": f"stellar-star-{delivery['task_id']}-{delivery['reminder_version']}",
                    "url": f"/pool?star={delivery['task_id']}",
                })
                outcome = "sent"
            except Exception as exc:
                response = getattr(exc, "response", None)
                status = getattr(exc, "status_code", None) or (response.status_code if response is not None else None)
                expired = status in (404, 410)
                outcome = "failed" if expired or isinstance(exc, HTTPException) else "retry"
                log.warning("Star reminder delivery %s: %s", delivery["delivery_id"], outcome)
            counts[outcome] += 1
        db.rpc("finish_stellar_reminder", {"delivery_id": delivery["delivery_id"], "token": delivery["claim_token"], "outcome": outcome})
        if expired:
            db.table("push_subscriptions").delete().eq("id", delivery["subscription_id"]).execute()
    return counts


@router.post(DISPATCH_PATH, include_in_schema=False)
def dispatch(request: Request) -> dict:
    if not dispatcher_authorized(request):
        raise HTTPException(401, "Unauthorized")
    if not configured():
        raise HTTPException(503, "Notifications are not configured")
    return dispatch_reminders()
