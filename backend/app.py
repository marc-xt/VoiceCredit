"""Authenticated VoiceCredit Tracker API."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

from fasiri import Fasiri, FasiriError
from dotenv import load_dotenv
from fastapi import Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")
DATABASE_PATH = Path(os.getenv("DATABASE_PATH") or BASE_DIR / "voicecredit.db")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "lug")
AUTH_SECRET = os.getenv("AUTH_SECRET") or "local-development-secret-change-me"
SESSION_DAYS = int(os.getenv("SESSION_DAYS") or "30")
SUPPORTED_LANGUAGES = {"lug", "swa", "eng"}


class UserPublic(BaseModel):
    id: str
    name: str
    email: str
    created_at: str


class RegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class AuthResponse(BaseModel):
    token: str
    user: UserPublic


class TransactionCreate(BaseModel):
    customer: str = Field(min_length=1, max_length=120)
    item: str = Field(min_length=1, max_length=240)
    amount: float = Field(gt=0)
    transaction_type: str = Field(default="credit", pattern="^(credit|payment|adjustment)$")


class Transaction(BaseModel):
    id: str
    type: str
    customer: str
    item: str
    amount: float
    description: str | None
    timestamp: str
    synced: bool


class TranscriptionResponse(BaseModel):
    transcript: str
    language: str
    provider: str
    model_used: str
    transaction_id: str | None = None


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                type TEXT NOT NULL CHECK (type IN ('credit', 'payment', 'adjustment')),
                customer_id TEXT,
                item TEXT NOT NULL,
                quantity INTEGER,
                amount REAL NOT NULL CHECK (amount > 0),
                description TEXT,
                timestamp TEXT NOT NULL,
                synced INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS audio_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                transaction_id TEXT,
                audio_file_path TEXT,
                transcript TEXT NOT NULL,
                duration INTEGER,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
            );
            """
        )
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(transactions)")}
        if "user_id" not in columns:
            connection.execute("ALTER TABLE transactions ADD COLUMN user_id TEXT")
        audio_columns = {row["name"] for row in connection.execute("PRAGMA table_info(audio_logs)")}
        if "user_id" not in audio_columns:
            connection.execute("ALTER TABLE audio_logs ADD COLUMN user_id TEXT")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_transactions_user_time ON transactions(user_id, timestamp DESC)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_audio_logs_user_time ON audio_logs(user_id, timestamp DESC)")


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def normalize_email(email: str) -> str:
    return email.strip().lower()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return "scrypt${}${}".format(
        base64.urlsafe_b64encode(salt).decode(),
        base64.urlsafe_b64encode(digest).decode(),
    )


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, encoded_salt, encoded_digest = stored_hash.split("$", 2)
        if scheme != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(encoded_salt.encode())
        expected = base64.urlsafe_b64decode(encoded_digest.encode())
        actual = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def hash_token(token: str) -> str:
    return hmac.new(AUTH_SECRET.encode(), token.encode(), hashlib.sha256).hexdigest()


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    created_at = datetime.now(UTC)
    expires_at = created_at + timedelta(days=SESSION_DAYS)
    with get_connection() as connection:
        connection.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (hash_token(token), user_id, created_at.isoformat(), expires_at.isoformat()),
        )
    return token


def user_from_row(row: sqlite3.Row) -> UserPublic:
    return UserPublic(id=row["id"], name=row["name"], email=row["email"], created_at=row["created_at"])


def row_to_transaction(row: sqlite3.Row) -> Transaction:
    return Transaction(
        id=row["id"],
        type=row["type"],
        customer=row["customer_id"] or "Unknown customer",
        item=row["item"],
        amount=row["amount"],
        description=row["description"],
        timestamp=row["timestamp"],
        synced=bool(row["synced"]),
    )


def current_user(authorization: Annotated[str | None, Header()] = None) -> UserPublic:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT users.* FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """,
            (hash_token(token), now_iso()),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="Session expired or invalid")
    return user_from_row(row)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="VoiceCredit Tracker API", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "offline_mode": os.getenv("OFFLINE_MODE", "true").lower() == "true",
        "fasiri_configured": bool(os.getenv("FASIRI_API_KEY")),
    }


@app.post("/api/auth/register", response_model=AuthResponse, status_code=201)
def register(payload: RegisterRequest) -> AuthResponse:
    email = normalize_email(payload.email)
    user_id = str(uuid.uuid4())
    created_at = now_iso()
    try:
        with get_connection() as connection:
            connection.execute(
                "INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (user_id, payload.name.strip(), email, hash_password(payload.password), created_at),
            )
            row = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="An account with that email already exists") from error
    return AuthResponse(token=create_session(user_id), user=user_from_row(row))


@app.post("/api/auth/login", response_model=AuthResponse)
def login(payload: LoginRequest) -> AuthResponse:
    with get_connection() as connection:
        row = connection.execute("SELECT * FROM users WHERE email = ?", (normalize_email(payload.email),)).fetchone()
    if row is None or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Email or password is incorrect")
    return AuthResponse(token=create_session(row["id"]), user=user_from_row(row))


@app.get("/api/auth/me", response_model=UserPublic)
def me(user: Annotated[UserPublic, Depends(current_user)]) -> UserPublic:
    return user


@app.post("/api/auth/logout", status_code=204)
def logout(authorization: Annotated[str | None, Header()] = None) -> None:
    if authorization and authorization.lower().startswith("bearer "):
        with get_connection() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(authorization.split(" ", 1)[1].strip()),))


@app.get("/api/transactions", response_model=list[Transaction])
def list_transactions(user: Annotated[UserPublic, Depends(current_user)], limit: int = 50) -> list[Transaction]:
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT * FROM transactions WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?", (user.id, limit)
        ).fetchall()
    return [row_to_transaction(row) for row in rows]


@app.post("/api/transactions", response_model=Transaction, status_code=201)
def create_transaction(payload: TransactionCreate, user: Annotated[UserPublic, Depends(current_user)]) -> Transaction:
    transaction_id = str(uuid.uuid4())
    timestamp = now_iso()
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO transactions (id, user_id, type, customer_id, item, amount, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (transaction_id, user.id, payload.transaction_type, payload.customer, payload.item, payload.amount, timestamp),
        )
        row = connection.execute("SELECT * FROM transactions WHERE id = ? AND user_id = ?", (transaction_id, user.id)).fetchone()
    return row_to_transaction(row)


@app.delete("/api/transactions/{transaction_id}", status_code=204)
def delete_transaction(transaction_id: str, user: Annotated[UserPublic, Depends(current_user)]) -> None:
    with get_connection() as connection:
        cursor = connection.execute("DELETE FROM transactions WHERE id = ? AND user_id = ?", (transaction_id, user.id))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Transaction not found")


@app.post("/api/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio(
    audio: Annotated[UploadFile, File(description="WAV, MP3, WebM, or OGG recording")],
    user: Annotated[UserPublic, Depends(current_user)],
    language: Annotated[str, Form()] = STT_LANGUAGE,
    transaction_id: Annotated[str | None, Form()] = None,
) -> TranscriptionResponse:
    api_key = os.getenv("FASIRI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="FASIRI_API_KEY is not configured")
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(status_code=400, detail="Unsupported language")
    if audio.content_type not in {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/webm", "audio/ogg", "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="Upload a WAV, MP3, WebM, or OGG audio file")
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        result = Fasiri(api_key=api_key).transcribe(audio_bytes, language)
    except FasiriError as error:
        raise HTTPException(status_code=502, detail=f"Fasiri transcription failed: {error}") from error
    timestamp = now_iso()
    with get_connection() as connection:
        connection.execute(
            "INSERT INTO audio_logs (id, user_id, transaction_id, transcript, timestamp) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), user.id, transaction_id, result.transcript, timestamp),
        )
    return TranscriptionResponse(
        transcript=result.transcript,
        language=result.language,
        provider=result.provider,
        model_used=result.model_used,
        transaction_id=transaction_id,
    )
