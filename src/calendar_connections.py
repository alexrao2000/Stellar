"""Private calendar connections with explicit, revocable write permission.

OAuth uses PKCE and an encrypted, expiring browser state bound to the signed-in
owner and requested mode. Tokens and secret feed URLs are encrypted at rest.
Provider reads are bounded, coalesced and cached in process; local events never
wait for them. Failed external reads explicitly stop scheduling suggestions.
Nothing is copied into task history or silently exported to another calendar.
"""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
import json
import os
import secrets
import threading
import time
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from . import calendar_providers as providers
from .calendar_schedule import CalendarEvent, calendar_timezone
from .postgrest import PostgrestError

router = APIRouter()
COOKIE = 'stellar_calendar_oauth'
COLUMNS = 'id,owner_id,provider,mode,calendars,selected_ids,write_calendar_id,secret,updated_at'
_cache = {}
_lock = threading.RLock()
_refresh_locks = {}


def _db():
    from .server import _sb
    return _sb()


def owner(request):
    user = getattr(request.state, 'auth_user', None)
    if user:
        return user.id
    from .config import load_config
    if not load_config().auth_enabled and not os.getenv('VERCEL'):
        return 'local'
    raise HTTPException(401, 'Sign in to connect calendars')


def _cipher():
    from cryptography.fernet import Fernet
    try:
        return Fernet(os.environ['CALENDAR_TOKEN_KEY'].encode())
    except (KeyError, ValueError):
        raise HTTPException(503, 'Calendar connections need to be configured by the app owner') from None


def seal(value):
    return _cipher().encrypt(json.dumps(value).encode()).decode()


def unseal(value, ttl=None):
    from cryptography.fernet import InvalidToken
    try:
        return json.loads(_cipher().decrypt(value.encode(), ttl=ttl))
    except (InvalidToken, ValueError, TypeError):
        raise HTTPException(400, 'This calendar authorization expired. Start the connection again.') from None


def _origin(request):
    origin = os.getenv('CALENDAR_PUBLIC_URL', '').rstrip('/')
    if not origin and not os.getenv('VERCEL') and request.url.hostname in ('localhost', '127.0.0.1'):
        origin = str(request.base_url).rstrip('/')
    parsed = urlsplit(origin)
    if not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username or (parsed.scheme != 'https' and parsed.hostname not in ('localhost', '127.0.0.1')):
        raise HTTPException(503, 'Calendar connections need a configured callback address')
    return origin


def _credentials(provider):
    if provider not in providers.PROVIDERS:
        raise HTTPException(400, 'Choose Google or Outlook')
    prefix = 'GOOGLE_CALENDAR' if provider == 'google' else 'MICROSOFT_CALENDAR'
    client_id, secret = os.getenv(prefix + '_CLIENT_ID'), os.getenv(prefix + '_CLIENT_SECRET')
    if not client_id or not secret:
        raise HTTPException(503, providers.PROVIDERS[provider]['label'] + ' connection setup is not finished yet')
    return client_id, secret


def _oauth(provider, **kwargs):
    from authlib.integrations.httpx_client import OAuth2Client
    client_id, secret = _credentials(provider)
    return OAuth2Client(client_id, secret, token_endpoint_auth_method='client_secret_post', timeout=12, **kwargs)


def _rows(user):
    try:
        return _db().table('calendar_connections').select(COLUMNS).eq('owner_id', user).order('provider').execute().data or []
    except PostgrestError:
        raise HTTPException(503, 'Calendar connection storage is unavailable') from None


def _connection(user, connection_id):
    row = next((r for r in _rows(user) if r['id'] == str(connection_id)), None)
    if not row:
        raise HTTPException(404, 'Calendar connection not found')
    return row


def _public(row):
    return {key: row.get(key) for key in ('id', 'provider', 'mode', 'calendars', 'selected_ids', 'write_calendar_id', 'updated_at')}


def _invalidate(user):
    with _lock:
        for key in list(_cache):
            if key[0] == user:
                _cache.pop(key, None)


def access_token(row):
    with _lock:
        guard = _refresh_locks.setdefault(row['id'], threading.Lock())
    with guard:
        latest = _connection(row['owner_id'], row['id'])
        token = unseal(latest['secret'])
        if float(token.get('expires_at', 0)) > time.time() + 60:
            return token['access_token']
        if not token.get('refresh_token'):
            raise HTTPException(403, 'Reconnect this calendar to restore access')
        try:
            with _oauth(row['provider']) as client:
                fresh = dict(client.refresh_token(providers.PROVIDERS[row['provider']]['token'], refresh_token=token['refresh_token']))
        except Exception:
            raise HTTPException(403, 'Reconnect this calendar to restore access') from None
        fresh.setdefault('refresh_token', token['refresh_token'])
        rows = (_db().table('calendar_connections').update({'secret': seal(fresh)})
                .eq('id', row['id']).eq('owner_id', row['owner_id']).eq('updated_at', latest['updated_at']).execute().data or [])
        if not rows:
            current = unseal(_connection(row['owner_id'], row['id'])['secret'])
            if float(current.get('expires_at', 0)) > time.time() + 30:
                return current['access_token']
            raise HTTPException(409, 'This connection changed on another device. Try again.')
        return fresh['access_token']


@router.get('/api/calendar/connections')
def connections(request: Request, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    available = []
    for provider, spec in providers.PROVIDERS.items():
        try:
            _credentials(provider); _cipher(); _origin(request)
            ready = True
        except HTTPException:
            ready = False
        available.append({'id': provider, 'label': spec['label'], 'ready': ready})
    return {'connections': [_public(row) for row in _rows(owner(request))], 'providers': available}


class Authorization(BaseModel):
    allow_writes: bool = False
    connection_id: UUID | None = None


@router.post('/api/calendar/connect/{provider}')
def authorize(provider: str, body: Authorization, request: Request, response: Response):
    user = owner(request)
    existing = _connection(user, body.connection_id) if body.connection_id else None
    if existing and existing['provider'] != provider:
        raise HTTPException(400, 'Choose the same provider for this connection')
    if not existing and len(_rows(user)) >= 8:
        raise HTTPException(400, 'Connect at most eight accounts or subscriptions')
    mode = 'write' if body.allow_writes else 'read'
    scopes = providers.PROVIDERS.get(provider, {}).get(mode)
    _credentials(provider)
    callback = _origin(request) + '/api/calendar/oauth/' + provider + '/callback'
    verifier = secrets.token_urlsafe(48)
    with _oauth(provider, scope=scopes, redirect_uri=callback, code_challenge_method='S256') as client:
        extra = {'access_type': 'offline', 'prompt': 'consent'} if provider == 'google' else {'prompt': 'select_account'}
        url, state = client.create_authorization_url(providers.PROVIDERS[provider]['authorize'], code_verifier=verifier, **extra)
    value = {'owner': user, 'provider': provider, 'mode': mode, 'state': state, 'verifier': verifier,
             'connection_id': str(body.connection_id) if body.connection_id else None, 'redirect': callback}
    response.set_cookie(COOKIE, seal(value), max_age=600, httponly=True, secure=callback.startswith('https:'), samesite='lax', path='/api/calendar/oauth')
    response.headers['Cache-Control'] = 'no-store'
    return {'url': url}


@router.get('/api/calendar/oauth/{provider}/callback')
def callback(provider: str, request: Request):
    state = unseal(request.cookies.get(COOKIE, ''), ttl=600)
    if state.get('owner') != owner(request) or state.get('provider') != provider or not secrets.compare_digest(state.get('state', ''), request.query_params.get('state', '')):
        raise HTTPException(400, 'The calendar authorization did not match. Start again.')
    result = 'cancelled'
    if not request.query_params.get('error'):
        try:
            with _oauth(provider, scope=providers.PROVIDERS[provider][state['mode']], redirect_uri=state['redirect'], state=state['state']) as client:
                token = dict(client.fetch_token(providers.PROVIDERS[provider]['token'], authorization_response=state['redirect'] + '?' + request.url.query,
                                                code_verifier=state['verifier']))
            if not token.get('refresh_token'):
                raise ValueError('No offline permission')
            granted = set(token.get('scope', '').split())
            required = set(providers.PROVIDERS[provider][state['mode']]) - {'offline_access'}
            if not required <= granted:
                raise ValueError('Permission declined')
            listed = providers.calendars(provider, token['access_token'])
            user = owner(request)
            if state['connection_id']:
                old = _connection(user, state['connection_id'])
                row = {'secret': seal(token), 'mode': state['mode'], 'calendars': listed}
                if state['mode'] == 'read': row['write_calendar_id'] = None
                _db().table('calendar_connections').update(row).eq('id', old['id']).eq('owner_id', user).execute()
            else:
                _db().table('calendar_connections').insert({'id': str(uuid4()), 'owner_id': user, 'provider': provider,
                    'mode': state['mode'], 'secret': seal(token), 'calendars': listed, 'selected_ids': []}).execute()
            _invalidate(user)
            result = 'connected'
        except Exception:
            result = 'failed'
    response = RedirectResponse(_origin(request) + '/calendar?connection=' + result, status_code=303, headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
    response.delete_cookie(COOKIE, path='/api/calendar/oauth', secure=state['redirect'].startswith('https:'), httponly=True, samesite='lax')
    return response


class Selection(BaseModel):
    selected_ids: list[str] = Field(max_length=30)
    write_calendar_id: str | None = Field(default=None, max_length=1024)
    allow_writes: bool = False


@router.put('/api/calendar/connections/{connection_id}')
def configure(connection_id: UUID, body: Selection, request: Request):
    user = owner(request); row = _connection(user, connection_id)
    listed = {c['id']: c for c in row['calendars']}
    if len(set(body.selected_ids)) != len(body.selected_ids) or not set(body.selected_ids) <= listed.keys():
        raise HTTPException(400, 'Choose calendars belonging to this connection')
    if body.allow_writes and row['mode'] != 'write':
        raise HTTPException(403, 'Authorize two-way sync before enabling edits')
    if body.write_calendar_id and (not body.allow_writes or body.write_calendar_id not in body.selected_ids or not listed[body.write_calendar_id]['can_write']):
        raise HTTPException(400, 'Choose a selected, writable calendar as the destination')
    values = {'selected_ids': body.selected_ids, 'write_calendar_id': body.write_calendar_id, 'mode': 'write' if body.allow_writes else 'read'}
    rows = _db().table('calendar_connections').update(values).eq('id', str(connection_id)).eq('owner_id', user).execute().data or []
    if not rows: raise HTTPException(409, 'This connection changed. Open it again.')
    _invalidate(user)
    return _public(rows[0])


@router.delete('/api/calendar/connections/{connection_id}')
def disconnect(connection_id: UUID, request: Request):
    user = owner(request)
    _db().table('calendar_connections').delete().eq('id', str(connection_id)).eq('owner_id', user).execute()
    _invalidate(user)
    return {'disconnected': str(connection_id)}


def handle(connection_id, calendar_id, event_id):
    return 'external-' + base64.urlsafe_b64encode(json.dumps([connection_id, calendar_id, event_id], separators=(',', ':')).encode()).decode().rstrip('=')


def parse_handle(value):
    try:
        if not value.startswith('external-') or len(value) > 8192: raise ValueError()
        data = value[9:]; parts = json.loads(base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)))
        if len(parts) != 3 or not all(isinstance(p, str) and p for p in parts): raise ValueError()
        UUID(parts[0])
        return parts
    except (ValueError, TypeError):
        raise HTTPException(400, 'Invalid calendar event') from None


def _calendar(row, calendar_id, write=False):
    calendar = next((c for c in row['calendars'] if c['id'] == calendar_id and c['id'] in row['selected_ids']), None)
    if not calendar or write and (row['mode'] != 'write' or not calendar['can_write']):
        raise HTTPException(403, 'This calendar is read-only or is no longer selected')
    return {**calendar, 'can_write': row['mode'] == 'write' and calendar['can_write']}


def _read_connection(row, first, last):
    if not set(row['selected_ids']) <= {c['id'] for c in row['calendars']}:
        raise HTTPException(409, 'Choose the calendars for this connection again')
    chosen = [c for c in row['calendars'] if c['id'] in row['selected_ids']]
    if not chosen: return []
    events = []
    if row['provider'] == 'ics':
        from .calendar_feeds import download, read_events
        raw_events = read_events(download(unseal(row['secret'])['url']), first, last, calendar_timezone())
        calendar = chosen[0]
        for raw in raw_events:
            event = providers.shape_event('outlook', raw, calendar, row['id'], handle)
            if event:
                event['source'] = 'ics'; event['read_only'] = True; events.append(event)
        return events
    token = access_token(row)
    for calendar in chosen:
        calendar = _calendar(row, calendar['id'])
        for raw in providers.list_events(row['provider'], token, calendar, first, last):
            event = providers.shape_event(row['provider'], raw, calendar, row['id'], handle)
            if event: events.append(event)
    return events


@lru_cache(maxsize=64)
def _read_guard(key):
    return threading.Lock()


@router.get('/api/calendar/external-events')
def external_events(request: Request, response: Response, start: date, end: date, fresh: bool = False):
    if end < start or (end - start).days > 41:
        raise HTTPException(400, 'Choose at most 42 days')
    response.headers['Cache-Control'] = 'no-store'
    user = owner(request); rows = _rows(user)
    revision = '|'.join(row['id'] + ':' + row['updated_at'] for row in rows)
    key = (user, start.isoformat(), end.isoformat(), revision)
    with _lock:
        entry = _cache.get(key)
        if not fresh and entry and time.monotonic() - entry[0] < 60:
            return entry[1]
    with _read_guard(key):
        with _lock:
            entry = _cache.get(key)
            if not fresh and entry and time.monotonic() - entry[0] < 60:
                return entry[1]
        tz = ZoneInfo(calendar_timezone())
        first = datetime.combine(start, datetime.min.time(), tz).isoformat()
        last = datetime.combine(end + timedelta(days=1), datetime.min.time(), tz).isoformat()
        events, failures = [], []
        with ThreadPoolExecutor(max_workers=4) as executor:
            jobs = [(row, executor.submit(_read_connection, row, first, last)) for row in rows]
            for row, job in jobs:
                try: events.extend(job.result())
                except Exception: failures.append({'id': row['id'], 'provider': row['provider'], 'message': 'This calendar could not sync. Reconnect it or try refreshing.'})
        result = {'events': events, 'complete': not failures, 'errors': failures, 'connections': [_public(row) for row in rows]}
        with _lock:
            if len(_cache) >= 64: _cache.pop(next(iter(_cache)))
            if not failures: _cache[key] = (time.monotonic(), result)
        return result


class ExternalEvent(CalendarEvent):
    connection_id: UUID
    calendar_id: str = Field(min_length=1, max_length=1024)
    remote_version: str | None = Field(default=None, max_length=1000)


@router.post('/api/calendar/external-events')
def create_external(body: ExternalEvent, request: Request):
    user = owner(request); row = _connection(user, body.connection_id); calendar = _calendar(row, body.calendar_id, write=True)
    data = providers.event_body(row['provider'], body)
    if row['provider'] == 'google': data['id'] = body.id.hex
    else: data['transactionId'] = str(body.id)
    token = access_token(row)
    if body.kind in ('run', 'task'): check_slot(request, body)
    try:
        raw = providers.provider_request(row['provider'], token, 'POST', providers.event_path(row['provider'], calendar['id']), json=data)
    except HTTPException as error:
        if row['provider'] != 'google' or error.status_code != 409: raise
        raw = providers.provider_request('google', token, 'GET', providers.event_path('google', calendar['id'], body.id.hex))
        expected = providers.event_body('google', body)
        if any(raw.get(key) != expected[key] for key in ('summary', 'description', 'start', 'end')):
            raise HTTPException(409, 'This event changed. Refresh before saving again.') from None
    _invalidate(user)
    return providers.shape_event(row['provider'], raw, calendar, row['id'], handle)


@router.put('/api/calendar/external-events/{event_handle}')
def update_external(event_handle: str, body: ExternalEvent, request: Request):
    user = owner(request); cid, calendar_id, eid = parse_handle(event_handle)
    if cid != str(body.connection_id) or calendar_id != body.calendar_id or not body.remote_version:
        raise HTTPException(400, 'Refresh this event before editing it')
    row = _connection(user, cid); calendar = _calendar(row, calendar_id, write=True)
    if body.kind in ('run', 'task'): check_slot(request, body, event_handle)
    raw = providers.provider_request(row['provider'], access_token(row), 'PATCH', providers.event_path(row['provider'], calendar_id, eid),
                                     headers={'If-Match': body.remote_version}, json=providers.event_body(row['provider'], body))
    _invalidate(user)
    return providers.shape_event(row['provider'], raw, calendar, cid, handle)


@router.delete('/api/calendar/external-events/{event_handle}')
def delete_external(event_handle: str, request: Request, version: str = Query(min_length=1, max_length=1000)):
    user = owner(request); cid, calendar_id, eid = parse_handle(event_handle)
    row = _connection(user, cid); _calendar(row, calendar_id, write=True)
    providers.provider_request(row['provider'], access_token(row), 'DELETE', providers.event_path(row['provider'], calendar_id, eid), headers={'If-Match': version})
    _invalidate(user)
    return {'deleted': event_handle}


class Feed(BaseModel):
    label: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=10, max_length=4096)


@router.post('/api/calendar/feeds')
def subscribe(body: Feed, request: Request):
    from .calendar_feeds import download, read_events
    user = owner(request)
    _cipher()
    if len(_rows(user)) >= 8: raise HTTPException(400, 'Connect at most eight calendars')
    try:
        data = download(body.url)
        now = datetime.now(timezone.utc)
        read_events(data, now.isoformat(), (now + timedelta(days=7)).isoformat(), calendar_timezone())
    except HTTPException: raise
    except Exception: raise HTTPException(503, 'The calendar subscription could not be reached') from None
    row = {'id': str(uuid4()), 'owner_id': user, 'provider': 'ics', 'mode': 'read', 'secret': seal({'url': body.url}),
           'calendars': [{'id': 'feed', 'label': body.label.strip(), 'can_write': False, 'time_zone': calendar_timezone()}], 'selected_ids': ['feed']}
    rows = _db().table('calendar_connections').insert(row).execute().data or []
    _invalidate(user)
    return _public(rows[0])


def check_slot(request, body, exclude=None):
    user = owner(request)
    tz = ZoneInfo(calendar_timezone())
    first, last = body.starts_at.astimezone(tz).date(), body.ends_at.astimezone(tz).date()
    result = external_events(request, Response(), first, last, fresh=True)
    if not result['complete']:
        raise HTTPException(503, 'All connected calendars must sync before reserving this task')
    rows = (_db().table('calendar_events').select('id,starts_at,ends_at,kind,task_title,task_series_id')
            .filter('starts_at', 'lt', datetime.combine(last + timedelta(days=1), datetime.min.time(), tz).isoformat())
            .filter('ends_at', 'gt', datetime.combine(first, datetime.min.time(), tz).isoformat()).execute().data or [])
    for event in [*rows, *result['events']]:
        if event['id'] == exclude or event.get('blocks_time') is False: continue
        if isinstance(body, ExternalEvent) and event.get('client_id') == str(body.id) and event.get('connection_id') == str(body.connection_id) and event.get('calendar_id') == body.calendar_id: continue
        start = datetime.fromisoformat(event['starts_at'].replace('Z', '+00:00'))
        end = datetime.fromisoformat(event['ends_at'].replace('Z', '+00:00'))
        if start < body.ends_at and end > body.starts_at:
            raise HTTPException(409, 'This slot is now occupied in a calendar. Choose another suggestion.')
        same_task = bool(body.task_series_id and str(event.get('task_series_id')) == str(body.task_series_id)) or bool(body.task_title and event.get('task_title') == body.task_title)
        if event.get('kind') in ('run', 'task') and same_task and start.astimezone(tz).date() == first:
            raise HTTPException(409, 'This task is already scheduled for that day')
