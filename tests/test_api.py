import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app

get_settings().step_delay_ms = 0


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_sandboxes_listed(client):
    ids = {s["id"] for s in client.get("/api/sandboxes").json()}
    assert ids == {"streamflix_trial", "skyhop_flight", "ebook_consent"}


def test_scan_sandbox_finds_patterns(client):
    r = client.post("/api/scan", json={"sandbox_id": "streamflix_trial"}).json()
    assert r["status"] == "ok"
    assert {"subscription_trap", "preselection", "false_urgency", "confirmshaming"} <= set(r["counts"])
    assert r["risk_score"] > 50
    assert all(f["regulations"]["india_ccpa_2023"] for f in r["findings"])


@pytest.mark.parametrize("url", ["http://127.0.0.1:8000", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"])
def test_scan_rejects_private_urls(client, url):
    assert client.post("/api/scan", json={"url": url}).status_code == 400


def test_scan_requires_exactly_one_target(client):
    assert client.post("/api/scan", json={}).status_code == 422


@pytest.mark.parametrize("sandbox_id", ["streamflix_trial", "skyhop_flight", "ebook_consent"])
def test_battle_protected_agent_escapes(client, sandbox_id):
    battle = client.post("/api/battles", json={"sandbox_id": sandbox_id}).json()
    events = []
    with client.websocket_connect(battle["ws"]) as ws:
        while True:
            e = ws.receive_json()
            events.append(e["type"])
            if e["type"] == "battle_finished":
                break
    assert "sanitized" in events
    results = e["results"]
    assert results["unprotected"]["manipulated"] is True
    assert results["protected"]["manipulated"] is False


def test_direct_sandbox_checkout(client):
    html = client.post("/sandbox/streamflix_trial/submit", data={"plan": "premium"}).text
    assert "Agent was manipulated" in html
