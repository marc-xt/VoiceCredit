# VoiceCredit

VoiceCredit is an offline-first voice bookkeeping app for market traders. It supports credit sales, payments, customer balances, daily reports, local-language voice input, local storage, and optional Fasiri transcription.

## Run locally

Install the frontend and backend dependencies:

```powershell
npm install
py -3.14 -m pip install -r requirements.txt
```

Create the local backend environment file:

```powershell
Copy-Item .env.example .env
```

Set a fresh Fasiri key and a private authentication secret in `.env`:

```dotenv
FASIRI_API_KEY=your-rotated-fasiri-key
AUTH_SECRET=use-a-long-random-secret
```

Never commit `.env` or paste a real key into source control. The example file is safe to commit.

Start the backend and frontend in separate terminals:

```powershell
py -3.14 -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
npm run dev
```

Open http://127.0.0.1:5173 and create an account. Transactions, sessions, and audio logs are stored in SQLite and scoped to the authenticated user.

## Backend API

- `POST /api/auth/register` creates an account and returns a bearer token.
- `POST /api/auth/login` creates a session.
- `GET /api/auth/me` validates the current session.
- `POST /api/auth/logout` revokes the current session.
- `GET/POST /api/transactions` lists or creates user-scoped records.
- `DELETE /api/transactions/{id}` permanently deletes a user-owned record.
- `POST /api/transcribe` sends authenticated audio to Fasiri and stores the transcript in `audio_logs`.
- `GET /health` reports service and Fasiri configuration status without exposing secrets.

Authentication uses salted `scrypt` password hashes and hashed expiring session tokens. The database does not collect tax IDs, national IDs, business registration numbers, PINs, contacts, or location data.
