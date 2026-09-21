# Binary Agent — بيناري

An autonomous, general-purpose AI agent behind a single Telegram bot (**@PaymonB_bot**) that speaks Modern Standard Arabic. It pursues goals between messages, uses tools, keeps durable + semantic memory, reflects on its own experience, and loops continuously on a heartbeat without any human triggering it.

**One repo · env-only secrets · free stack end-to-end.**

```
Telegram door                      Heartbeat door
POST /api/agent/webhook            POST /api/agent/tick
x-telegram-bot-api-secret-token    x-agent-secret · cron */5 + chains
                    ┌──────────────────────────┐
                    │  Brain — one tick = one  │
                    │  thought (locked, CAS)   │
                    └──────────────────────────┘
      LLM cortex              Memory                  Tool belt
 11 providers, 3 waves    GitHub mind files      12 tools, risk-gated
 Promise.any racing       + Supabase pgvector     (Arabic approval cards)
```

## The LLM cortex (v3)

Providers never walk sequentially — they **race in parallel waves**; the first acceptable answer wins. A circuit breaker parks any provider that fails twice in a row for 8 minutes.

| Wave | Providers | Notes |
|------|-----------|-------|
| 1 — strong | `gemini`, `openrouter`, `cohere` | gemini is geo-gated from some regions, healthy from Vercel US |
| 2 — backup | `mistral`, `cloudflare`, `pollinations` | pollinations is keyless (GPT4Free-style safety net) |
| 3 — wide net | `pollinations-mistral` (keyless), `grok`, `groq`, `huggingface` | dormant providers stay parked cheaply and revive with zero code changes |

Timing: 14 s per-provider hard cut (AbortController), 42 s overall budget, breaker threshold 2, park 8 min. Per-provider model overrides: `MODEL_<PROVIDER>` env. Health is surfaced in Telegram `/status` and the dashboard (`/?key=AGENT_TICK_SECRET`).

## Memory

- **Layer 1 (canonical)**: plain files in the private [binary-agent-memory](https://github.com/bessghiermohamed/binary-agent-memory) repo via the GitHub Contents API with optimistic concurrency — `state.json` (whose sha doubles as the distributed tick lock), `goals.json`, `approvals.json`, `episodic.jsonl` (cap 400), `insights.jsonl` (cap 200), `conversations/<chatId>.jsonl`, `identity.md`.
- **Layer 2 (semantic)**: Supabase Postgres + pgvector, embeddings by Cloudflare Workers AI `@cf/baai/bge-m3` (1024-dim, multilingual, Arabic-capable). Recall injects up to 7 relevant memory lines into chat prompts. Mirrors are best-effort with a 3-strike fuse — a sick database never eats the tick budget.

## Hard rules (paid for with production incidents)

1. **Never walk providers sequentially** — race in waves; a slow provider loses, it does not block.
2. **A JSON parse miss is not a provider outage** — strict retry at temperature ≤ 0.3, then degrade to `{reply: raw}`.
3. **Garbled Arabic = environment, not model** — inject the local clock (`Africa/Algiers`), temperature 0.6, hard MSA rules in the system prompt.
4. **Cloudflare Workers AI responses need `unwrap: 'result'`.**
5. **Test providers from the deployment region** — geo-gating lies from a dev box.
6. **Chaining is disciplined** — only on a successful tool call, ≥30 s spacing, hourly cap, LLM headroom reserved. (v3: the old build chained every ~15 s on failures and burned the daily budget by noon.)
7. **Goal hygiene** — no goals filed from casual chat; junk titles (`#g_xxxx`) and duplicates are pruned; `currentTask` may only reference a goal that exists.
8. **Algeria wall-clock math** — UTC+1 fixed offset, no DST; `07:46` means 06:46 UTC exactly.
9. **Keepalive or the cron dies silently** — GitHub disables schedules after 60 idle days; the workflow commits `heartbeats/<date>.txt` daily.
10. **Commit as the owner's noreply email** or Vercel's untrusted-author protection blocks the deploy.
11. **Secrets are env-only** — the repo is public; GitHub Push Protection is a backstop, not a control.
12. **Vercel REST API quirks** — deploy via `/v6`; env listing needs `/v9` for account tokens; Marketplace add-ons are dashboard-only.

## Setup

```bash
cp .env.example .env   # fill values — never commit them
bun install            # or npm install
bun run dev            # local dashboard on :3000 (dev-open when AGENT_TICK_SECRET unset)
```

One-time wiring:

```bash
# 1 · register the Telegram webhook (secret must byte-match AGENT_WEBHOOK_SECRET)
curl -s "https://api.telegram.org/bot$AGENT_BOT_TOKEN/setWebhook" \
  -d url="https://binary-agent.vercel.app/api/agent/webhook" \
  -d secret_token="$AGENT_WEBHOOK_SECRET" \
  -d drop_pending_updates=true \
  -d allowed_updates='["message","callback_query"]'

# 2 · bootstrap the Supabase schema (idempotent)
curl -s -X POST "https://binary-agent.vercel.app/api/agent/setup-db" \
  -H "x-agent-secret: $AGENT_TICK_SECRET"

# 3 · verify
curl -s "https://binary-agent.vercel.app/api/agent/webhook"
curl -s "https://api.telegram.org/bot$AGENT_BOT_TOKEN/getWebhookInfo"
```

GitHub repo secrets for the heartbeat workflow: `AGENT_TICK_URL` (the `/api/agent/tick` URL) and `AGENT_TICK_SECRET`.

## Operator probes

```bash
curl -s "$BASE/api/agent/webhook"                                            # service banner
curl -s -X POST "$BASE/api/agent/tick" -H "x-agent-secret: $TICK" \
      -H "content-type: application/json" -d '{"source":"manual"}'           # full tick cycle
curl -s -X POST "$BASE/api/agent/setup-db" -H "x-agent-secret: $TICK"        # idempotent DDL re-check
```

Telegram commands: `/start` · `/goals` · `/status` · `/stop` · `/resume` · `/ping`.
