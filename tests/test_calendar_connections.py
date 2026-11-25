"""Provider permissions, OAuth state and scheduling preferences use demo data.
No test reads a real account, token, calendar subscription or production row.
"""
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from cryptography.fernet import Fernet
from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest

from src import calendar_connections as connections, calendar_feeds, calendar_providers as providers, server, task_planning


class Database:
    def __init__(self): self.rows = {'calendar_connections': [], 'task_planning_rules': []}
    def table(self, name): return Query(self.rows[name])


class Query:
    def __init__(self, rows): self.rows = rows; self.filters = []; self.method = 'GET'
    def select(self, *args, **kwargs): return self
    def order(self, *args, **kwargs): return self
    def eq(self, key, value): self.filters.append((key, value)); return self
    def insert(self, value): self.method = 'POST'; self.body = value; return self
    def update(self, value): self.method = 'PATCH'; self.body = value; return self
    def delete(self): self.method = 'DELETE'; return self
    def execute(self):
        found = [row for row in self.rows if all(row.get(key) == value for key, value in self.filters)]
        if self.method == 'POST':
            row = {**self.body, 'updated_at': '2026-11-24T20:00:00Z', 'write_calendar_id': self.body.get('write_calendar_id')}; self.rows.append(row); found = [row]
        if self.method == 'PATCH':
            for row in found: row.update(self.body)
        if self.method == 'DELETE':
            for row in found: self.rows.remove(row)
        return SimpleNamespace(data=found)


@pytest.fixture
def setup(monkeypatch):
    db = Database()
    monkeypatch.setenv('AUTH_ENABLED', 'false'); monkeypatch.delenv('VERCEL', raising=False)
    monkeypatch.setenv('CALENDAR_TOKEN_KEY', Fernet.generate_key().decode())
    monkeypatch.setenv('CALENDAR_PUBLIC_URL', 'https://app.example')
    for prefix in ('GOOGLE_CALENDAR', 'MICROSOFT_CALENDAR'):
        monkeypatch.setenv(prefix + '_CLIENT_ID', 'test-client'); monkeypatch.setenv(prefix + '_CLIENT_SECRET', 'test-secret')
    monkeypatch.setattr(connections, '_db', lambda: db)
    monkeypatch.setattr(task_planning, '_db', lambda: db)
    connections._cache.clear()
    return TestClient(server.app, base_url="https://app.example"), db


def row(db, mode='read', owner='local'):
    value = {'id': str(uuid4()), 'owner_id': owner, 'provider': 'google', 'mode': mode,
             'calendars': [{'id': 'main', 'label': 'Demo calendar', 'can_write': True}], 'selected_ids': ['main'],
             'write_calendar_id': None, 'secret': connections.seal({'access_token': 'private-access', 'refresh_token': 'private-refresh', 'expires_at': 9999999999}),
             'updated_at': '2026-11-24T20:00:00Z'}
    db.rows['calendar_connections'].append(value); return value


@pytest.mark.parametrize('provider,scope', [('google', 'https://www.googleapis.com/auth/calendar.readonly'), ('outlook', 'Calendars.Read')])
def test_authorization_suggests_read_only_and_uses_bound_pkce(setup, provider, scope):
    client, _ = setup
    result = client.post('/api/calendar/connect/' + provider, json={})
    assert result.status_code == 200
    params = parse_qs(urlsplit(result.json()['url']).query)
    assert scope in params['scope'][0].split()
    assert params['code_challenge_method'] == ['S256'] and len(params['code_challenge'][0]) >= 43
    assert 'httponly' in result.headers['set-cookie'].lower()
    state = connections.unseal(client.cookies.get(connections.COOKIE), ttl=600)
    assert state['owner'] == 'local' and state['mode'] == 'read' and state['provider'] == provider
    assert state['verifier'] not in result.text
    rejected = client.get('/api/calendar/oauth/' + provider + '/callback?state=wrong&code=unused')
    assert rejected.status_code == 400


def test_write_scope_requires_the_explicit_toggle(setup):
    client, db = setup
    result = client.post('/api/calendar/connect/google', json={'allow_writes': True})
    assert 'https://www.googleapis.com/auth/calendar.events' in parse_qs(urlsplit(result.json()['url']).query)['scope'][0]
    value = row(db)
    result = client.put('/api/calendar/connections/' + value['id'], json={'selected_ids': ['main'], 'allow_writes': True, 'write_calendar_id': 'main'})
    assert result.status_code == 403 and value['mode'] == 'read'


def test_read_only_and_unselected_calendars_never_reach_provider_writes(setup, monkeypatch):
    client, db = setup; value = row(db)
    monkeypatch.setattr(providers, 'provider_request', lambda *args, **kwargs: pytest.fail('Read-only connection attempted a provider write'))
    body = {'connection_id': value['id'], 'calendar_id': 'main', 'title': 'Demo event', 'starts_at': '2026-11-24T20:00:00Z', 'ends_at': '2026-11-24T21:00:00Z'}
    assert client.post('/api/calendar/external-events', json=body).status_code == 403
    handle = connections.handle(value['id'], 'main', 'event1')
    assert client.delete('/api/calendar/external-events/' + handle + '?version=one').status_code == 403
    value['mode'] = 'write'; value['selected_ids'] = []
    assert client.post('/api/calendar/external-events', json=body).status_code == 403


def test_connections_never_expose_credentials_and_cannot_cross_owners(setup):
    client, db = setup; mine = row(db, 'write'); other = row(db, 'write', 'another-owner')
    response = client.get('/api/calendar/connections')
    assert len(response.json()['connections']) == 1
    for text in ('secret', 'private-access', 'private-refresh', other['id']): assert text not in response.text
    assert client.put('/api/calendar/connections/' + other['id'], json={'selected_ids': []}).status_code == 404
    assert client.put('/api/calendar/connections/' + mine['id'], json={'selected_ids': ['unowned']}).status_code == 400
    result = client.put('/api/calendar/connections/' + mine['id'], json={'selected_ids': ['main'], 'allow_writes': False})
    assert result.status_code == 200 and mine['mode'] == 'read' and mine['write_calendar_id'] is None
    assert client.delete('/api/calendar/connections/' + mine['id']).status_code == 200
    assert db.rows['calendar_connections'] == [other]


def test_provider_pagination_refuses_a_foreign_host_before_sending_tokens(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        providers.provider_request('outlook', 'not-for-a-foreign-host', 'GET', 'https://attacker.invalid/v1.0/events')
    assert exc.value.status_code == 502


def test_google_instances_free_time_all_day_and_cancellations_keep_their_meaning():
    calendar = {'id': 'demo', 'label': 'Demo', 'time_zone': 'America/Los_Angeles', 'can_write': False}
    raw = {'id': 'event', 'summary': 'Holiday', 'start': {'date': '2026-03-08'}, 'end': {'date': '2026-03-09'}, 'etag': 'version1', 'transparency': 'transparent'}
    event = providers.shape_event('google', raw, calendar, 'connection', connections.handle)
    assert event['all_day'] and event['read_only'] and not event['blocks_time']
    assert datetime.fromisoformat(event['ends_at']).timestamp() - datetime.fromisoformat(event['starts_at']).timestamp() == 23 * 3600
    assert providers.shape_event('google', {**raw, 'status': 'cancelled'}, calendar, 'connection', connections.handle) is None
    raw['transparency'] = 'opaque'; raw['attendees'] = [{'self': True, 'responseStatus': 'declined'}]
    assert not providers.shape_event('google', raw, calendar, 'connection', connections.handle)['blocks_time']


def test_external_failures_explicitly_stop_suggestions_but_keep_other_calendars(setup, monkeypatch):
    client, db = setup; first = row(db); second = row(db)
    def read(value, *args):
        if value['id'] == first['id']: raise HTTPException(503, 'upstream down')
        return [{'id': 'demo', 'title': 'Read-only meeting'}]
    monkeypatch.setattr(connections, '_read_connection', read)
    response = client.get('/api/calendar/external-events?start=2026-11-24&end=2026-11-25')
    assert response.status_code == 200
    assert response.json()['complete'] is False and len(response.json()['events']) == 1 and len(response.json()['errors']) == 1
    assert first['secret'] not in response.text


def test_provider_edits_include_the_exact_remote_version(setup, monkeypatch):
    client, db = setup; value = row(db, 'write'); calls = []
    monkeypatch.setattr(connections, 'access_token', lambda row: 'test-token')
    def write(*args, **kwargs):
        calls.append((args, kwargs)); raise HTTPException(409, 'Event changed')
    monkeypatch.setattr(providers, 'provider_request', write)
    handle = connections.handle(value['id'], 'main', 'event1')
    body = {'connection_id': value['id'], 'calendar_id': 'main', 'title': 'Edited event', 'starts_at': '2026-11-24T20:00:00Z', 'ends_at': '2026-11-24T21:00:00Z', 'remote_version': '"etag-1"'}
    response = client.put('/api/calendar/external-events/' + handle, json=body)
    assert response.status_code == 409 and calls[0][1]['headers']['If-Match'] == '"etag-1"'
    assert calls[0][0][2] == 'PATCH'
    body.pop('remote_version')
    assert client.put('/api/calendar/external-events/' + handle, json=body).status_code == 400
    assert len(calls) == 1


def test_private_feed_destinations_are_rejected_before_connecting(monkeypatch):
    monkeypatch.setattr(calendar_feeds.socket, 'getaddrinfo', lambda *args, **kwargs: [(2, 1, 6, '', ('127.0.0.1', 443))])
    for url in ['https://private.invalid/calendar.ics', 'http://public.invalid/a.ics', 'https://user:pass@public.invalid/a.ics']:
        with pytest.raises(HTTPException): calendar_feeds.download(url)


def test_subscription_instances_respect_cancellations_and_free_events():
    data = b'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:demo\r\nDTSTART:20261124T180000Z\r\nDTEND:20261124T183000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Demo\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    events = calendar_feeds.read_events(data, '2026-11-24T00:00:00+00:00', '2026-11-27T00:00:00+00:00', 'UTC')
    assert len(events) == 3 and all(event['showAs'] == 'free' for event in events)
    with pytest.raises(HTTPException): calendar_feeds.read_events(data.replace(b'FREQ=DAILY', b'FREQ=SECONDLY'), '2026-11-24T00:00:00+00:00', '2026-11-27T00:00:00+00:00', 'UTC')


def test_planning_rules_validate_overnight_windows_and_persist_by_series(setup, monkeypatch):
    client, db = setup
    monkeypatch.setattr(server, '_definitions', lambda **kwargs: [{'id': 7, 'series_id': 7, 'title': 'Read', 'active': True}])
    result = client.put('/api/calendar/task-planning/7', json={'enabled': True, 'duration_minutes': 60, 'earliest': 1320, 'latest': 60, 'icon': 'capsule'})
    assert result.status_code == 200 and db.rows['task_planning_rules'][0]['series_id'] == 7
    assert db.rows['task_planning_rules'][0]['owner_id'] == 'local'
    assert result.json()['rule']['icon'] == 'capsule'
    previous_client = client.put('/api/calendar/task-planning/7', json={'duration_minutes': 20})
    assert previous_client.json()['rule']['icon'] == 'capsule'
    assert client.put('/api/calendar/task-planning/7', json={'icon': None}).json()['rule']['icon'] is None
    assert client.put('/api/calendar/task-planning/8', json={}).status_code == 404
    assert client.put('/api/calendar/task-planning/7', json={'duration_minutes': 100, 'earliest': 540, 'latest': 570}).status_code == 422

def test_oauth_callback_saves_only_the_chosen_mode_and_encrypts_tokens(setup, monkeypatch):
    client, db = setup
    prepared = client.post('/api/calendar/connect/google', json={'allow_writes': False})
    state = parse_qs(urlsplit(prepared.json()['url']).query)['state'][0]
    class OAuth:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def fetch_token(self, *args, **kwargs):
            assert kwargs['code_verifier']
            return {'access_token': 'private-callback-access', 'refresh_token': 'private-callback-refresh', 'expires_at': 9999999999,
                    'scope': 'https://www.googleapis.com/auth/calendar.readonly'}
    monkeypatch.setattr(connections, '_oauth', lambda *args, **kwargs: OAuth())
    monkeypatch.setattr(providers, 'calendars', lambda *args: [{'id': 'main', 'label': 'Demo', 'can_write': True}])
    result = client.get('/api/calendar/oauth/google/callback?code=one-time-code&state=' + state, follow_redirects=False)
    assert result.status_code == 303 and 'connection=connected' in result.headers['location']
    stored = db.rows['calendar_connections'][0]
    assert stored['mode'] == 'read' and stored['selected_ids'] == []
    assert 'private-callback-access' not in stored['secret']
    assert connections.unseal(stored['secret'])['refresh_token'] == 'private-callback-refresh'


def test_declining_a_write_scope_does_not_create_a_write_connection(setup, monkeypatch):
    client, db = setup
    prepared = client.post('/api/calendar/connect/google', json={'allow_writes': True})
    state = parse_qs(urlsplit(prepared.json()['url']).query)['state'][0]
    class OAuth:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def fetch_token(self, *args, **kwargs): return {'access_token': 'denied-write', 'refresh_token': 'demo-refresh', 'scope': 'https://www.googleapis.com/auth/calendar.readonly'}
    monkeypatch.setattr(connections, '_oauth', lambda *args, **kwargs: OAuth())
    result = client.get('/api/calendar/oauth/google/callback?code=one-time-code&state=' + state, follow_redirects=False)
    assert result.status_code == 303 and 'connection=failed' in result.headers['location']
    assert not db.rows['calendar_connections']


def test_last_moment_conflict_prevents_booking_before_any_write(setup, monkeypatch):
    client, db = setup; value = row(db, 'write')
    monkeypatch.setattr(connections, 'access_token', lambda row: 'test-token')
    monkeypatch.setattr(connections, 'external_events', lambda *args, **kwargs: {'complete': False, 'events': []})
    monkeypatch.setattr(providers, 'provider_request', lambda *args, **kwargs: pytest.fail('Incomplete calendar coverage must prevent booking'))
    body = {'connection_id': value['id'], 'calendar_id': 'main', 'title': 'Read', 'starts_at': '2026-11-24T20:00:00Z', 'ends_at': '2026-11-24T20:30:00Z', 'kind': 'task', 'task_title': 'Read', 'task_series_id': 1}
    assert client.post('/api/calendar/external-events', json=body).status_code == 503

def test_task_planning_read_joins_current_series_rules_without_exposing_owner(setup, monkeypatch):
    client, db = setup
    monkeypatch.setattr(server, '_definitions', lambda **kwargs: [{'id': 7, 'series_id': 7, 'title': 'Read', 'active': True, 'sort_order': 1, 'starts_on': '2026-01-01'}])
    initial = client.get('/api/calendar/task-planning').json()
    assert initial['tasks'][0]['rule'] == initial['defaults']
    assert initial['defaults']['enabled'] is True
    assert initial['tasks'][0]['updated_at'] is None
    db.rows['task_planning_rules'].append({'owner_id': 'local', 'series_id': 7, 'rule': {'enabled': False, 'duration_minutes': 45}, 'updated_at': '2026-11-24T20:00:00Z'})
    result = client.get('/api/calendar/task-planning')
    assert result.status_code == 200
    task = result.json()['tasks'][0]
    assert task['series_id'] == 7 and task['rule']['duration_minutes'] == 45 and task['titles'] == ['Read']
    assert task['rule']['enabled'] is False
    assert 'owner_id' not in result.text
