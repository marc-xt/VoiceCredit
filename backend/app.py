"""VoiceCredit Tracker API."""

from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from fasiri import Fasiri, FasiriError

BASE_DIR = Path(__file__).resolve().parent.parent
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", BASE_DIR / "voicecredit.db"))
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "lug")

app = FastAPI(title="VoiceCredit Tracker API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    return connection


def init_db() -> None:
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK (type IN ('credit', 'payment', 'adjustment')),
                customer_id TEXT,
                item TEXT NOT NULL,
                quantity INTEGER,
                amount REAL NOT NULL CHECK (amount > 0),
                description TEXT,
                timestamp TEXT NOT NULL,
                synced INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS audio_logs (
                id TEXT PRIMARY KEY,
                transaction_id TEXT,
                audio_file_path TEXT,
                transcript TEXT NOT NULL,
                duration INTEGER,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (transaction_id) REFERENCES transactions(id)
            );
            """
        )


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


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"status": "ok", "offline_mode": os.getenv("OFFLINE_MODE", "true").lower() == "true"}


@app.get("/api/transactions", response_model=list[Transaction])
def list_transactions(limit: int = 50) -> list[Transaction]:
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=400, detail="limit must be between 1 and 200")
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT * FROM transactions ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()
    return [row_to_transaction(row) for row in rows]


@app.post("/api/transactions", response_model=Transaction, status_code=201)
def create_transaction(payload: TransactionCreate) -> Transaction:
    transaction_id = str(uuid.uuid4())
    timestamp = datetime.now(UTC).isoformat()
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO transactions (id, type, customer_id, item, amount, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (transaction_id, payload.transaction_type, payload.customer, payload.item, payload.amount, timestamp),
        )
        row = connection.execute("SELECT * FROM transactions WHERE id = ?", (transaction_id,)).fetchone()
    return row_to_transaction(row)


@app.delete("/api/transactions/{transaction_id}", status_code=204)
def delete_transaction(transaction_id: str) -> None:
    with get_connection() as connection:
        cursor = connection.execute("DELETE FROM transactions WHERE id = ?", (transaction_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Transaction not found")


@app.post("/api/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio(
    audio: Annotated[UploadFile, File(description="WAV or MP3 recording")],
    language: Annotated[str, Form()] = STT_LANGUAGE,
    transaction_id: Annotated[str | None, Form()] = None,
) -> TranscriptionResponse:
    api_key = os.getenv("FASIRI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="FASIRI_API_KEY is not configured")
    if audio.content_type not in {
        "audio/wav",
        "audio/x-wav",
        "audio/mpeg",
        "audio/mp3",
        "audio/webm",
        "audio/ogg",
        "application/octet-stream",
    }:
        raise HTTPException(status_code=415, detail="Upload a WAV, MP3, WebM, or OGG audio file")

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    try:
        result = Fasiri(api_key=api_key).transcribe(audio_bytes, language)
    except FasiriError as error:
        raise HTTPException(status_code=502, detail=f"Fasiri transcription failed: {error}") from error

    timestamp = datetime.now(UTC).isoformat()
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO audio_logs (id, transaction_id, transcript, timestamp)
            VALUES (?, ?, ?, ?)
            """,
            (str(uuid.uuid4()), transaction_id, result.transcript, timestamp),
        )

    return TranscriptionResponse(
        transcript=result.transcript,
        language=result.language,
        provider=result.provider,
        model_used=result.model_used,
        transaction_id=transaction_id,
    )
