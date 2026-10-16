import os, sqlite3, subprocess, sys, time
from pathlib import Path
import httpx

ROOT=Path(__file__).resolve().parents[1]

def test_server_smoke(tmp_path):
    env=os.environ.copy(); env.update({'APP_PIN':'test-pin','DATA_DIR':str(tmp_path),'CORS_ORIGINS':'https://localhost','RATE_LIMIT_PER_MINUTE':'60','AI_PROVIDER':'gonka','GONKA_BASE_URL':'https://api.gonkarouter.io/v1','GONKA_MODEL':'MiniMaxAI/MiniMax-M2.7','SECRET_ENCRYPTION_KEY':'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='})
    p=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8765'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                if httpx.get('http://127.0.0.1:8765/api/health').status_code==200: break
            except Exception: time.sleep(.1)
        assert httpx.get('http://127.0.0.1:8765/api/health').json()['ok'] is True
        assert httpx.get('http://127.0.0.1:8765/api/settings').status_code==401
        headers={'X-Victor-Pin':'test-pin'}
        s=httpx.get('http://127.0.0.1:8765/api/settings',headers=headers)
        assert s.status_code==200 and s.json()['server']['appPinSet'] is True
        assert s.json()['providers']['primary']=='gonka'
        assert s.json()['providers']['gonka']['baseUrl']=='https://api.gonkarouter.io/v1'
        assert s.json()['providers']['gonka']['model']=='MiniMaxAI/MiniMax-M2.7'
        saved=httpx.put('http://127.0.0.1:8765/api/secrets/gonka.apiKey',headers=headers,json={'value':'test-provider-key'})
        assert saved.status_code==200 and saved.json()['status']['set'] is True and saved.json()['status']['masked'].startswith('test')
        reread=httpx.get('http://127.0.0.1:8765/api/settings',headers=headers).json()
        assert reread['secrets']['gonka.apiKey']['set'] is True and reread['secrets']['gonka.apiKey']['decryptable'] is True
        invalid=httpx.post('http://127.0.0.1:8765/api/chat',headers=headers,json={'message':''})
        assert invalid.status_code==422
        r=httpx.post('http://127.0.0.1:8765/api/chat',headers=headers,json={'message':'hello'})
        assert r.status_code==503 and 'failed' in r.text.lower()
        assert (tmp_path/'victor.sqlite3').exists()
    finally: p.terminate(); p.wait(timeout=10)

def test_rate_limit(tmp_path):
    env=os.environ.copy(); env.update({'APP_PIN':'test-pin','DATA_DIR':str(tmp_path),'RATE_LIMIT_PER_MINUTE':'3'})
    p=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8766'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                if httpx.get('http://127.0.0.1:8766/api/health').status_code in (200,429): break
            except Exception: time.sleep(.1)
        first=httpx.get('http://127.0.0.1:8766/api/health')
        second=httpx.get('http://127.0.0.1:8766/api/health')
        third=httpx.get('http://127.0.0.1:8766/api/health')
        assert first.status_code==200 and second.status_code==200 and third.status_code==429
    finally: p.terminate(); p.wait(timeout=10)

def test_gonka_mock_and_diagnostics(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    os.environ['APP_PIN'] = 'test-pin'
    os.environ['GONKA_API_KEY'] = 'test-gonka-live-key'
    os.environ['AI_PROVIDER'] = 'gonka'
    os.environ['GONKA_BASE_URL'] = 'https://api.gonkarouter.io/v1'
    os.environ['GONKA_MODEL'] = 'MiniMaxAI/MiniMax-M2.7'
    os.environ['DATA_DIR'] = str(tmp_path)

    from app.main import app

    class MockResp:
        status_code = 200
        def json(self):
            return {'choices': [{'message': {'content': 'VICTOR TEST OK'}}]}
        def raise_for_status(self): pass

    async def mock_post(self, url, *args, **kwargs):
        assert 'https://api.gonkarouter.io/v1/chat/completions' in url
        return MockResp()

    monkeypatch.setattr(httpx.AsyncClient, 'post', mock_post)

    client = TestClient(app)
    # Check diagnostics
    diag = client.get('/api/diagnostics', headers={'X-Victor-Pin': 'test-pin'})
    assert diag.status_code == 200
    assert diag.json()['ready']['aiText'] is True

    # Check /api/test/gonka
    t_res = client.post('/api/test/gonka', headers={'X-Victor-Pin': 'test-pin'})
    assert t_res.status_code == 200
    assert t_res.json()['ok'] is True
    assert t_res.json()['detail'] == 'VICTOR TEST OK'

    # Check /api/chat
    c_res = client.post('/api/chat', headers={'X-Victor-Pin': 'test-pin'}, json={'message': 'test prompt'})
    assert c_res.status_code == 200
    assert c_res.json()['text'] == 'VICTOR TEST OK'
