# Binary Agent (بيناري) — ONE repo, fully independent

A single, standalone, general-purpose **autonomous Telegram agent** speaking
Modern Standard Arabic, based in Tiaret, Algeria. This repository is the whole
agent: engine, heartbeat/scheduler, docs — nothing else required.

**LIVE:** `@PaymonB_bot` → `https://binary-agent.vercel.app/api/agent/webhook`

## Architecture (one repo)

```
binary-agent/                      ← you are here (public)
├── src/lib/agent/                 ← the mind: brain, LLM, memory, tools, telegram
├── src/app/api/agent/
│   ├── webhook/route.ts           ← Telegram updates (secret-guarded)
│   ├── tick/route.ts              ← heartbeat endpoint (secret-guarded)
│   └── setup-db/route.ts          ← one-click Supabase schema bootstrap
└── .github/workflows/
    └── agent-tick.yml             ← the heartbeat: every 5 min + self-dispatch chains
```

- **Hosting:** Vercel (own project, `binary-agent.vercel.app`) — auto-deploys on push.
- **Memory:**
  - Semantic memory: **Supabase Postgres + pgvector** (`bge-m3` embeddings via
    Cloudflare Workers AI) — recall injected into chat.
  - Durable mind files (identity/state/goals/approvals): GitHub Contents API on a
    **private** data repo (`binary-agent-memory`) — kept private because it holds
    real conversation data. It is data infrastructure, not part of the agent code.
- **Secrets:** environment variables only (`.env.example` documents all of them).
  Nothing is committed.

## LLM cortex v2 — hedged provider racing

Providers no longer walk a sequential chain (a single hang ate the whole time
budget and starved the rest — the old failure mode). Providers now **race in
parallel waves**, first acceptable answer wins:

| Wave | Providers | Role |
|------|-----------|------|
| 1 | gemini → openrouter → cohere | strong, fast |
| 2 | mistral → cloudflare → pollinations | backup (+ keyless safety net) |
| 3 | grok → groq → huggingface | dormant (parked: no credits / 403) |

- Circuit breaker: 2 consecutive failures park a provider for 8 minutes.
- 14s per-provider timeout, 42s overall budget.
- `/status` in Telegram shows live provider health (ready / parked / last error).

## Heartbeat

`.github/workflows/agent-tick.yml` (this repo) POSTs `/api/agent/tick` every
5 minutes with `AGENT_TICK_URL` + `AGENT_TICK_SECRET` repo secrets. The agent
self-dispatches the same workflow for fast-follow ticks while working (chain
cap 12). A daily keepalive commit prevents the 60-day schedule auto-disable.

## Endpoints

- `POST /api/agent/webhook` — Telegram (header `x-telegram-bot-api-secret-token`)
- `POST /api/agent/tick` — scheduler (header `x-agent-secret`)
- `POST /api/agent/setup-db` — idempotent Supabase DDL (header `x-agent-secret`)

## Human-in-the-loop

Risky actions (non-GET HTTP, writes outside the memory repo, public gists)
queue for owner approval with inline Approve/Reject buttons in Telegram
(`اعتماد` / `رفض`). Never executed without the owner's decision.

## Setup (fresh deploy)

1. Push → import to Vercel (or use the existing project).
2. Copy `.env.example` → set env vars in Vercel.
3. `POST /api/agent/setup-db` once to create the pgvector schema.
4. Register the Telegram webhook with the same secret you set.
5. Add `AGENT_TICK_URL` + `AGENT_TICK_SECRET` as repo secrets → enable the workflow.
