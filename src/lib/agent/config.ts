// ─── Binary (بيناري) — autonomous agent configuration ────────────────────────
// Binary (@PaymonB_bot) is a general-purpose autonomous agent based in Tiaret,
// Algeria who speaks Modern Standard Arabic. Standalone deployment: own repo,
// own Vercel project, own memory repo and Supabase project.

export const AGENT = {
  id: 'binary',
  name: 'Binary',
  nameAr: 'بيناري',
  username: 'PaymonB_bot',
  numericId: 8918299308,
  // Bot token comes from the environment only (never committed).
  token: process.env.AGENT_BOT_TOKEN || '',
  primaryProvider: 'gemini',
  home: 'Tiaret, Algeria',
  language: 'Modern Standard Arabic (العربية الفصحى)',
};

export const AGENT_CONFIG = {
  // Where the agent's mind lives (GitHub repo, Contents API = free durable DB)
  memoryRepo: process.env.AGENT_MEMORY_REPO || 'bessghiermohamed/binary-agent-memory',
  // Token used at runtime for memory writes, dispatches, gists
  ghToken: process.env.AGENT_GH_TOKEN || '',
  // Guard for the tick endpoint (cron + scheduler hit it from outside)
  tickSecret: process.env.AGENT_TICK_SECRET || '',
  // Scheduler: THIS repo carries its own heartbeat workflow
  // (.github/workflows/agent-tick.yml) — one repo, no separate loop repo.
  // Used for chained fast-follow ticks.
  schedulerRepo: process.env.AGENT_SCHEDULER_REPO || 'bessghiermohamed/binary-agent',
  // Telegram webhook shared secret
  webhookSecret: process.env.AGENT_WEBHOOK_SECRET || '',
  // Owner: pinned automatically on first private DM unless preset here
  ownerChatId: process.env.AGENT_OWNER_CHAT_ID || '',

  // ── budgets (soft caps; the agent reports when it hits them) ──
  LLM_DAILY_CAP: 220, // LLM calls per day across decide/chat/reflect
  TICKS_DAILY_CAP: 400,
  CHAIN_CAP: 12, // max chained fast-follow ticks per work period
  INITIATIVE_GAP_MS: 45 * 60_000, // min pause between self-started initiatives
  CHAT_REPLY_MAX_TOKENS: 380,
  DECIDE_MAX_TOKENS: 900,
  REFLECT_MAX_TOKENS: 320,

  // ── cadence ──
  LOCK_MS: 120_000, // distributed lock TTL (state.json CAS via GitHub)
  WORK_BUDGET_MS: 50_000, // stay under Vercel function limit

  // ── risk gate: actions that ALWAYS require owner approval ──
  ALWAYS_APPROVE_TOOLS: ['http_non_get', 'github_write_outside_memory'],
};

export const TZ_LABEL = 'Africa/Algiers';

// ─── time helpers (owner timezone) ───────────────────────────────────────────
export function nowParts(d = new Date()) {
  const utc = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const alg = new Date(d.getTime() + 60 * 60_000).toISOString().replace('T', ' ').slice(0, 16);
  return { utc, alg: alg + ' owner-local (UTC+1)' };
}

export function dayKey(d = new Date()): string {
  return new Date(d.getTime() + 60 * 60_000).toISOString().slice(0, 10); // owner-local day
}

/** Full local date/time at home (Africa/Algiers), e.g. "Sunday 21 September 2026 at 13:45". */
export function localNow(d = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Algiers',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  } catch {
    return nowParts().alg;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
