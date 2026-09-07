from fastapi.testclient import TestClient

from backend.app import app


def test_health_endpoint() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_create_and_list_transaction() -> None:
    with TestClient(app) as client:
        created = client.post(
            "/api/transactions",
            json={
                "customer": "Test Customer",
                "item": "Test item",
                "amount": 1250,
                "transaction_type": "credit",
            },
        )
        listed = client.get("/api/transactions?limit=1")
    assert created.status_code == 201
    assert created.json()["customer"] == "Test Customer"
    assert created.json()["synced"] is False
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == created.json()["id"]


def test_transcribe_requires_key_without_calling_fasiri(monkeypatch) -> None:
    monkeypatch.delenv("FASIRI_API_KEY", raising=False)
    with TestClient(app) as client:
        response = client.post(
            "/api/transcribe",
            files={"audio": ("sample.wav", b"RIFF", "audio/wav")},
            data={"language": "lug"},
        )
    assert response.status_code == 503
    assert response.json()["detail"] == "FASIRI_API_KEY is not configured"
