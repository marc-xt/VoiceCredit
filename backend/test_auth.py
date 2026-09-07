from uuid import uuid4

from fastapi.testclient import TestClient

from backend.app import app


def test_register_login_and_current_user() -> None:
    email = f"user-{uuid4()}@example.com"
    with TestClient(app) as client:
        registered = client.post(
            "/api/auth/register",
            json={"name": "Market Owner", "email": email, "password": "correct horse battery"},
        )
        assert registered.status_code == 201
        token = registered.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}

        current = client.get("/api/auth/me", headers=headers)
        assert current.status_code == 200
        assert current.json()["email"] == email

        logged_in = client.post("/api/auth/login", json={"email": email, "password": "correct horse battery"})
        assert logged_in.status_code == 200
        assert logged_in.json()["user"]["name"] == "Market Owner"


def test_transactions_require_auth_and_are_user_scoped() -> None:
    email = f"owner-{uuid4()}@example.com"
    with TestClient(app) as client:
        unauthorized = client.get("/api/transactions")
        assert unauthorized.status_code == 401

        registered = client.post(
            "/api/auth/register",
            json={"name": "Owner", "email": email, "password": "secure password"},
        )
        headers = {"Authorization": f"Bearer {registered.json()['token']}"}
        created = client.post(
            "/api/transactions",
            headers=headers,
            json={"customer": "John", "item": "Bananas", "amount": 15000, "transaction_type": "credit"},
        )
        assert created.status_code == 201
        listed = client.get("/api/transactions", headers=headers)
        assert listed.status_code == 200
        assert listed.json()[0]["customer"] == "John"

        deleted = client.delete(f"/api/transactions/{created.json()['id']}", headers=headers)
        assert deleted.status_code == 204


def test_transcribe_requires_auth_and_key(monkeypatch) -> None:
    monkeypatch.delenv("FASIRI_API_KEY", raising=False)
    email = f"voice-{uuid4()}@example.com"
    with TestClient(app) as client:
        missing_auth = client.post(
            "/api/transcribe",
            files={"audio": ("sample.wav", b"RIFF", "audio/wav")},
            data={"language": "lug"},
        )
        assert missing_auth.status_code == 401

        registered = client.post(
            "/api/auth/register",
            json={"name": "Voice User", "email": email, "password": "voice password"},
        )
        headers = {"Authorization": f"Bearer {registered.json()['token']}"}
        missing_key = client.post(
            "/api/transcribe",
            headers=headers,
            files={"audio": ("sample.wav", b"RIFF", "audio/wav")},
            data={"language": "lug"},
        )
        assert missing_key.status_code == 503
