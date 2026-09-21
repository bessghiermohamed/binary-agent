# Binary Agent (بيناري) — dedicated deployment

Standalone autonomous Telegram agent (Modern Standard Arabic). Independent of the Talib/Gu-mo app.

- **Code:** this repo → own Vercel project
- **Memory (canonical):** `bessghiermohamed/binary-agent-memory` (GitHub Contents API)
- **Heartbeat:** `bessghiermohamed/binary-agent-loop` (GitHub Actions, every 5 min + chained ticks)
- **Optional mirror:** own Supabase project (Storage bucket `agent-memory`)

Endpoints: `POST /api/agent/webhook` (Telegram, secret header), `POST /api/agent/tick` (`x-agent-secret`).
See `.env.example` for all environment variables. No secrets are committed.

- 2026-09-21: 9-provider chain (+keyless Pollinations), Supabase pgvector semantic memory, setup-db bootstrap
