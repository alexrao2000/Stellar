"""Reminder timing, auth, cancellation, and safe push delivery across devices."""
import base64
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from src import postgrest, reminders, server


def subscription():
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
    return {"endpoint": "https://fcm.googleapis.com/stellar-test", "keys": {"p256dh": encode(b'\x04'+b'x'*64), "auth": encode(b'x'*16)}}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "test-private")
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "test-public")
    monkeypatch.setenv("REMINDER_DISPATCH_SECRET", "test-dispatch")
    monkeypatch.setattr(server, "_cache", {})
    return TestClient(server.app)


@pytest.mark.parametrize("endpoint", ["http://fcm.googleapis.com/a", "https://127.0.0.1/a", "https://fcm.googleapis.com.evil.invalid/a", "https://user:password@fcm.googleapis.com/a", "https://fcm.googleapis.com:444/a"])
def test_subscription_refuses_non_push_endpoints(client, endpoint):
    value = subscription(); value["endpoint"] = endpoint
    assert client.post('/api/notifications/subscribe',json=value).status_code == 400


def test_subscription_checks_keys_and_is_idempotent(client, monkeypatch):
    calls = []
    class DB:
        def rpc(self, name, body):
            calls.append((name,body))
            return SimpleNamespace(data=[{"id":"device-1"}])
    monkeypatch.setattr(reminders,"_db",lambda:DB())
    value = subscription()
    for _ in range(2):
        assert client.post('/api/notifications/subscribe',json=value).json() == {"id":"device-1"}
    assert calls[0][0] == 'register_stellar_push'
    value['keys']['auth']='bad'
    assert client.post('/api/notifications/subscribe',json=value).status_code == 400


def test_reminder_times_require_future_timezone_and_clear_resets_version(client,monkeypatch):
    requests=[]
    def database(request):
        requests.append(request)
        return httpx.Response(200,json=[{"id":1,**json.loads(request.content)}])
    with httpx.Client(transport=httpx.MockTransport(database)) as http:
        monkeypatch.setattr(postgrest,'_http',lambda:http)
        monkeypatch.setattr(reminders,'_db',lambda:postgrest.Client('https://database.invalid','test'))
        for value in ['2020-01-01T12:00:00Z','2099-01-01T12:00:00']:
            assert client.post('/api/pool/task/1/reminder',json={'at':value}).status_code == 400
        at=(datetime.now(timezone.utc)+timedelta(hours=2)).isoformat()
        saved=client.post('/api/pool/task/1/reminder',json={'at':at})
        assert saved.status_code == 200
        assert requests[-1].url.params['resolved_at'] == 'is.null'
        cleared=client.post('/api/pool/task/1/reminder',json={'at':None}).json()
        assert cleared['remind_at'] is None
        assert cleared['reminder_version'] != saved.json()['reminder_version']


def test_new_star_defaults_to_24_hours_and_resolve_cancels(client,monkeypatch):
    bodies=[]
    def database(request):
        body=json.loads(request.content);bodies.append(body)
        return httpx.Response(200,json=[{"id":1,**body}])
    with httpx.Client(transport=httpx.MockTransport(database)) as http:
        monkeypatch.setattr(postgrest,'_http',lambda:http)
        monkeypatch.setattr(server,'_sb',lambda:postgrest.Client('https://database.invalid','test'))
        before=datetime.now(timezone.utc)+timedelta(hours=24)
        added=client.post('/api/pool/task?title=Demo%20star').json()
        assert before <= datetime.fromisoformat(added['remind_at']) <= datetime.now(timezone.utc)+timedelta(hours=24)
        resolved=client.post('/api/pool/task/1/resolve').json()
        assert resolved['remind_at'] is None and resolved['resolved_at']


def test_dispatcher_uses_its_own_auth_without_opening_user_apis(client,monkeypatch):
    monkeypatch.setenv('AUTH_ENABLED','true')
    monkeypatch.setattr(reminders,'dispatch_reminders',lambda:{'sent':0})
    assert client.post(reminders.DISPATCH_PATH).status_code == 401
    assert client.post(reminders.DISPATCH_PATH,headers={'Authorization':'Bearer wrong'}).status_code == 401
    assert client.post(reminders.DISPATCH_PATH,headers={'Authorization':'Bearer test-dispatch'}).json() == {'sent':0}
    assert client.post('/api/notifications/subscribe',json=subscription()).status_code != 200
    assert client.get('/api/notifications/config').status_code != 200


def test_worker_rechecks_resolved_and_rescheduled_stars_and_retries(monkeypatch):
    jobs=[dict(delivery_id=i,claim_token='claim',task_id=i,reminder_version='current',title='Demo',subscription_id='device',subscription=subscription()) for i in range(1,6)]
    finish=[];deleted=[];sent=[]
    class DB:
        def rpc(self,name,body):
            if name=='claim_stellar_reminders':return SimpleNamespace(data=jobs)
            finish.append(body);return SimpleNamespace(data=[])
        def table(self,name):self.name=name;return self
        def select(self,_):return self
        def delete(self):self.deleting=True;return self
        def eq(self,_,value):self.value=value;return self
        def execute(self):
            if self.name=='push_subscriptions':deleted.append(self.value);return SimpleNamespace(data=[])
            return SimpleNamespace(data=[{'id':self.value,'remind_at':'2026-01-01','resolved_at':'done' if self.value==2 else None,'reminder_version':'old' if self.value==3 else 'current'}])
    db=DB();monkeypatch.setattr(reminders,'_db',lambda:db)
    class PushFailure(Exception):
        def __init__(self,status):self.status_code=status
    def send(_,payload):
        sent.append(payload)
        if payload['url'].endswith('4'):raise PushFailure(503)
        if payload['url'].endswith('5'):raise PushFailure(410)
    monkeypatch.setattr(reminders,'send_push',send)
    assert reminders.dispatch_reminders()=={'sent':1,'retry':1,'failed':1,'cancelled':2}
    assert len(sent)==3 and sent[0]['url']=='/pool?star=1'
    assert [f['outcome'] for f in finish]==['sent','failed','failed','retry','failed']
    assert deleted==['device']


def test_config_never_exposes_private_credentials(client):
    result=client.get('/api/notifications/config')
    assert result.headers['cache-control']=='no-store'
    assert result.json()=={'enabled':True,'public_key':'test-public','default_hours':24}
    assert 'test-private' not in result.text and 'test-dispatch' not in result.text


def test_push_payload_is_encrypted_and_can_be_decrypted(monkeypatch):
    import http_ece
    import requests
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
    signing = ec.generate_private_key(ec.SECP256R1())
    receiver = ec.generate_private_key(ec.SECP256R1())
    auth = b'a' * 16
    value = {'endpoint': 'https://fcm.googleapis.com/demo', 'keys': {
        'p256dh': encode(receiver.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
        'auth': encode(auth),
    }}
    private = encode(signing.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    monkeypatch.setenv('VAPID_PRIVATE_KEY', private)
    sent = {}
    def push(endpoint, **kwargs):
        sent.update(endpoint=endpoint, **kwargs)
        return SimpleNamespace(status_code=201, text='', headers={})
    monkeypatch.setattr(requests, 'post', push)
    payload = {'title': 'Stellar', 'body': 'Demo reminder', 'url': '/pool?star=1'}
    reminders.send_push(value, payload)
    plain = http_ece.decrypt(sent['data'], private_key=receiver, auth_secret=auth, version='aes128gcm')
    assert json.loads(plain) == payload
    assert b'Demo reminder' not in sent['data']
    assert sent['timeout'] == 8
