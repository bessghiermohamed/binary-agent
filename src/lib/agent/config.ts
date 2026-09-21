// ─── Binary — identity, budgets, cadence, time ──────────────────────────────
// Single source of truth for who the agent is. Interpolated everywhere:
// system prompts, Telegram branding, status headers, dashboard. Never
// hard-code identity strings elsewhere.

export const AGENT = {
  id: 'binary',
  name: 'Binary',
  nameAr: 'بيناري',
  username: 'PaymonB_bot',
  numericId: 8918299308,
  botToken: process.env.AGENT_BOT_TOKEN || '',
  home: 'Tiaret, Algeria',
  homeAr: 'تيارت، الجزائر',
  language: 'Modern Standard Arabic (العربية الفصحى)',
  timezone: 'Africa/Algiers', // UTC+1 year-round, no DST
  version: 2,
} as const;

export const REPOS = {
  memory: process.env.AGENT_MEMORY_REPO || 'bessghiermohamed/binary-agent-memory',
  scheduler: process.env.AGENT_SCHEDULER_REPO || 'bessghiermohamed/binary-agent',
};

export const SECRETS = {
  ghToken: process.env.AGENT_GH_TOKEN || '',
  webhookSecret: process.env.AGENT_WEBHOOK_SECRET || '',
  tickSecret: process.env.AGENT_TICK_SECRET || '',
  ownerChatId: process.env.AGENT_OWNER_CHAT_ID || '',
};

// Soft caps — a free deployment must never runaway-spend (spec §6).
export const BUDGETS = {
  llmDaily: 220, // LLM calls per day
  ticksDaily: 400, // ticks per day
  chainCap: 12, // chained ticks per work period
  chainSpacingMs: 30_000, // min gap between chain dispatches (was: none!)
  chainHourly: 20, // hard cap of chain dispatches per rolling hour
  initiativeGapMs: 45 * 60_000, // min gap between self-started initiatives
  workBudgetMs: 50_000, // per-invocation work budget (under Vercel 60s)
  llmHeadroomForChain: 25, // reserve llm calls before allowing a chain
} as const;

// Token ceilings per call type (spec §6).
export const TOKEN_CEIL = { chat: 380, decide: 900, reflect: 320 } as const;

// LLM cortex timing (spec §5).
export const LLM_CFG = {
  callTimeoutMs: 14_000,
  overallBudgetMs: 42_000,
  breakThreshold: 2,
  breakMs: 8 * 60_000,
} as const;

export const MEMORY_CAPS = {
  episodes: 400,
  insights: 200,
  conversationWindow: 24, // lines kept per chat file
  episodesInPrompt: 12,
  insightsInPrompt: 5,
} as const;

// ─── Time helpers — the clock the agent trusts (RULE 03) ───────────────────
// Algeria is UTC+1 with no DST: a fixed offset converts wall-clock to UTC
// exactly. `at_iso` inputs without timezone info are interpreted as Algeria
// local time and converted with this offset — the previous build scheduled
// "07:46" reminders for the wrong instant because it mixed the two frames.

const DZ_OFFSET_MIN = 60;

export function dzNow(): { isoUtc: string; wall: string; wallAr: string; epochMs: number } {
  const now = new Date();
  const wall = new Date(now.getTime() + DZ_OFFSET_MIN * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const wallStr = `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())} ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
  const dayAr = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'][wall.getUTCDay()];
  const wallAr = `${dayAr} ${pad(wall.getUTCDate())}/${pad(wall.getUTCMonth() + 1)}/${wall.getUTCFullYear()} — الساعة ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())} بتوقيت الجزائر`;
  return { isoUtc: now.toISOString(), wall: wallStr, wallAr, epochMs: now.getTime() };
}

/** Interpret a wall-clock string (HH:MM or YYYY-MM-DD HH:MM) as Algeria local
 *  time and return the UTC epoch ms. Returns null when unparseable. */
export function dzWallClockToEpoch(input: string): number | null {
  const m = String(input || '').trim().match(/^(\d{4}-\d{2}-\d{2})?[T ]?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, datePart, hh, mm] = m;
  let y: number, mo: number, d: number;
  if (datePart) {
    [y, mo, d] = datePart.split('-').map(Number);
  } else {
    const w = new Date(Date.now() + DZ_OFFSET_MIN * 60_000);
    y = w.getUTCFullYear(); mo = w.getUTCMonth() + 1; d = w.getUTCDate();
  }
  const utcMs = Date.UTC(y, mo - 1, d, Number(hh), Number(mm)) - DZ_OFFSET_MIN * 60_000;
  // If a bare time already passed today (Algeria), the owner means tomorrow.
  if (!datePart && utcMs <= Date.now() + 60_000) return utcMs + 24 * 3600_000;
  return utcMs;
}

export function epochToWall(epochMs: number): string {
  const w = new Date(epochMs + DZ_OFFSET_MIN * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())} ${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`;
}

export function nextId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function dayKey(ms = Date.now()): string {
  // Algeria-local day key for counter resets
  const w = new Date(ms + DZ_OFFSET_MIN * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}
