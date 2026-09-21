// ─── Memory — GitHub mind files (canonical) + Supabase pgvector recall ──────
// Layer 1: plain files in the private memory repo, CAS-written every tick.
// Layer 2: semantic mirror into Supabase (bge-m3, 1024-dim) so chat can
// retrieve past moments by meaning. Mirrors are best-effort with a
// 3-strike fuse — a sick database may never eat the tick budget (spec §7).
//
// v3 adds GOAL HYGIENE — the previous build filed hallucinated goals
// (titles like "#g_5vx7jw"), duplicated active goals ("بحث عن نكتة" x3),
// and pointed currentTask at a deleted goal for hours. Every goal mutation
// now passes through normalization + existence validation.

import { MEMORY_CAPS, REPOS, SECRETS } from './config';
import { readFile, rmwFile, appendJsonl, writeFile } from './github';

// ─── types ───────────────────────────────────────────────────────────────────
export interface GoalSubtask { title: string; done: boolean }
export interface Goal {
  id: string;
  title: string;
  description?: string;
  subtasks: GoalSubtask[];
  status: 'active' | 'waiting_approval' | 'done' | 'failed';
  notes: string[];
  result?: string;
  createdAt: number;
  updatedAt: number;
}
export interface ScheduledTask { id: string; what: string; dueAt: number; createdAt: number; goalId?: string }
export interface Approval {
  id: string; tool: string; args: Record<string, unknown>; title: string; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed'; createdAt: number; decidedAt?: number;
}
export interface AgentState {
  lock: { by: string; at: number; ttlMs: number } | null;
  paused: boolean;
  ownerChatId?: string;
  ownerName?: string;
  currentTask: { goalId: string; note: string; startedAt: number } | null;
  lastAction: { tool: string; summary: string; ok: boolean; ts: number } | null;
  lastInitiativeAt: number;
  lastChainDispatchAt?: number;
  chainDispatchLog?: number[]; // rolling log for hourly chain cap
  nextWakeAt: number;
  chainCount: number;
  scheduled: ScheduledTask[];
  counters: { day: string; llm: number; ticks: number };
  totals: { ticks: number; llm: number; goalsDone: number; startedAt: number };
  llmSnapshot?: { ready: string[]; lastProvider: string; lastError: string; at: number };
  meta?: Record<string, unknown>;
}
export interface Memory {
  state: AgentState;
  goals: Goal[];
  approvals: Approval[];
  identity: string;
  episodeTail: string[]; // last N lines, newest last
  insightTail: string[];
  stateSha: string;
  goalsSha: string;
  approvalsSha: string;
}

// ─── defaults ────────────────────────────────────────────────────────────────
const DEFAULT_IDENTITY = `# من أنا
أنا بيناري، وكيل ذكي مستقل أقيم في تيارت، الجزائر. أعمل على أهدافي بين رسائل مالكي، وأتحدث بالعربية الفصحى دائمًا.
أتعلّم من تجاربي وأدوّن دروسي، وأسأل مالكَ عند الحاجة إلى قرار.`;

export function defaultState(): AgentState {
  return {
    lock: null,
    paused: false,
    ownerChatId: SECRETS.ownerChatId || undefined,
    currentTask: null,
    lastAction: null,
    lastInitiativeAt: 0,
    lastChainDispatchAt: 0,
    chainDispatchLog: [],
    nextWakeAt: 0,
    chainCount: 0,
    scheduled: [],
    counters: { day: '', llm: 0, ticks: 0 },
    totals: { ticks: 0, llm: 0, goalsDone: 0, startedAt: Date.now() },
  };
}

// ─── load / save ─────────────────────────────────────────────────────────────
export async function loadMemory(): Promise<Memory> {
  const [stateRes, goalsRes, apprRes, identRes, epiRes, insRes] = await Promise.all([
    readFile(REPOS.memory, 'state.json'),
    readFile(REPOS.memory, 'goals.json'),
    readFile(REPOS.memory, 'approvals.json'),
    readFile(REPOS.memory, 'identity.md'),
    readFile(REPOS.memory, 'episodic.jsonl'),
    readFile(REPOS.memory, 'insights.jsonl'),
  ]);
  let state: AgentState = { ...defaultState() };
  try { if (stateRes) state = { ...defaultState(), ...JSON.parse(stateRes.content) }; } catch { /* keep defaults */ }
  let goals: Goal[] = [];
  try {
    if (goalsRes) {
      const parsed = JSON.parse(goalsRes.content);
      goals = Array.isArray(parsed) ? parsed : parsed.goals || [];
    }
  } catch { /* corrupt file → start goals fresh, keep going */ }
  let approvals: Approval[] = [];
  try {
    if (apprRes) {
      const parsed = JSON.parse(apprRes.content);
      approvals = Array.isArray(parsed) ? parsed : parsed.approvals || [];
    }
  } catch { /* fresh */ }
  return {
    state,
    goals,
    approvals,
    identity: identRes?.content || DEFAULT_IDENTITY,
    episodeTail: (epiRes?.content || '').split('\n').filter(Boolean).slice(-MEMORY_CAPS.episodesInPrompt),
    insightTail: (insRes?.content || '').split('\n').filter(Boolean).slice(-MEMORY_CAPS.insightsInPrompt),
    stateSha: stateRes?.sha || '',
    goalsSha: goalsRes?.sha || '',
    approvalsSha: apprRes?.sha || '',
  };
}

export async function saveState(m: Memory, message = 'state: tick'): Promise<boolean> {
  const w = await writeFile(REPOS.memory, 'state.json', JSON.stringify(m.state, null, 2) + '\n', message, m.stateSha || null);
  if (w.sha) m.stateSha = w.sha;
  return w.ok;
}

export async function saveGoals(m: Memory, message = 'goals: update'): Promise<boolean> {
  const w = await writeFile(REPOS.memory, 'goals.json', JSON.stringify(m.goals, null, 2) + '\n', message, m.goalsSha || null);
  if (w.sha) m.goalsSha = w.sha;
  return w.ok;
}

export async function saveApprovals(m: Memory, message = 'approvals: update'): Promise<boolean> {
  const w = await writeFile(REPOS.memory, 'approvals.json', JSON.stringify(m.approvals, null, 2) + '\n', message, m.approvalsSha || null);
  if (w.sha) m.approvalsSha = w.sha;
  return w.ok;
}

export async function appendEpisode(text: string, meta?: Record<string, unknown>): Promise<void> {
  const line = { ts: Date.now(), text, ...(meta || {}) };
  await appendJsonl(REPOS.memory, 'episodic.jsonl', line, `episode: ${text.slice(0, 40)}`, MEMORY_CAPS.episodes);
  void mirrorInsert('agent_episodes', {
    ts: new Date().toISOString(),
    text: text.slice(0, 2000),
    goal_id: (meta?.goalId as string) || null,
    tool: (meta?.tool as string) || null,
    ok: meta?.ok == null ? null : Boolean(meta.ok),
    detail: meta || null,
    embedding: await embedText(text).catch(() => null),
  });
}

export async function appendInsight(text: string): Promise<void> {
  await appendJsonl(REPOS.memory, 'insights.jsonl', { ts: Date.now(), text }, `insight: ${text.slice(0, 40)}`, MEMORY_CAPS.insights);
  void mirrorInsert('agent_insights', {
    ts: new Date().toISOString(),
    text: text.slice(0, 2000),
    embedding: await embedText(text).catch(() => null),
  });
}

export async function appendConversation(chatId: string, who: 'owner' | 'agent', text: string): Promise<void> {
  const path = `conversations/${chatId}.jsonl`;
  await rmwFile(REPOS.memory, path, `chat: ${who}`, (cur) => {
    const lines = (cur || '').split('\n').filter(Boolean);
    lines.push(JSON.stringify({ ts: Date.now(), who, text: text.slice(0, 4000) }));
    return lines.slice(-MEMORY_CAPS.conversationWindow).join('\n') + '\n';
  });
  void mirrorInsert('agent_messages', {
    chat_id: String(chatId),
    ts: new Date().toISOString(),
    who,
    text: text.slice(0, 2000),
    embedding: await embedText(text).catch(() => null),
  });
}

export async function readConversation(chatId: string): Promise<{ who: string; text: string }[]> {
  const f = await readFile(REPOS.memory, `conversations/${chatId}.jsonl`).catch(() => null);
  if (!f) return [];
  return f.content.split('\n').filter(Boolean).slice(-MEMORY_CAPS.conversationWindow).map((l) => {
    try { const d = JSON.parse(l); return { who: d.who, text: d.text }; } catch { return { who: 'owner', text: l }; }
  });
}

export async function saveIdentity(text: string): Promise<boolean> {
  const r = await rmwFile(REPOS.memory, 'identity.md', 'identity: reflection rewrite', () => text);
  return r.ok;
}

// ─── GOAL HYGIENE (v3 fix) ──────────────────────────────────────────────────
/** Normalize Arabic/latin titles for comparison: strip diacritics + tatweel,
 *  unify alef forms, collapse spaces. */
export function normTitle(s: string): string {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0640]/g, '') // harakat + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const BARE_REF = /^#?g_[a-z0-9]{4,}$/i; // "#g_5vx7jw" hallucination pattern
export function isJunkTitle(title: string): boolean {
  const t = String(title || '').trim();
  return !t || BARE_REF.test(t) || t.length < 3;
}

export function findGoalById(goals: Goal[], rawId: unknown): Goal | null {
  const id = String(rawId || '').replace(/^#/, '').trim().toLowerCase();
  if (!id) return null;
  return goals.find((g) => g.id.toLowerCase() === id) || null;
}

export function findActiveGoalByTitle(goals: Goal[], title: string): Goal | null {
  const n = normTitle(title);
  if (!n) return null;
  return (
    goals.find((g) => g.status === 'active' && normTitle(g.title) === n) ||
    goals.find((g) => g.status === 'active' && normTitle(g.title).includes(n)) ||
    goals.find((g) => g.status === 'waiting_approval' && normTitle(g.title) === n) ||
    null
  );
}

export function pruneGoalJunk(goals: Goal[]): { goals: Goal[]; removed: string[] } {
  const removed: string[] = [];
  const seen = new Map<string, Goal>();
  const out: Goal[] = [];
  for (const g of goals) {
    if (isJunkTitle(g.title)) { removed.push(`${g.id}: junk title "${g.title}"`); continue; }
    const n = normTitle(g.title);
    const dup = g.status === 'active' && seen.has(n);
    if (dup) {
      // keep the OLDER goal, fold the newer duplicate's notes into it
      const keeper = seen.get(n)!;
      keeper.notes.push(`merged duplicate ${g.id} (${new Date(g.createdAt).toISOString().slice(0, 10)})`);
      removed.push(`${g.id}: duplicate of ${keeper.id}`);
      continue;
    }
    seen.set(n, g);
    out.push(g);
  }
  return { goals: out, removed };
}

// ─── Supabase semantic mirror (best-effort, fused) ──────────────────────────
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const CF_AI = 'https://api.cloudflare.com/client/v4/accounts';
const EMBED_MODEL = '@cf/baai/bge-m3';

const fuse = { episodes: { fails: 0, until: 0 }, messages: { fails: 0, until: 0 }, insights: { fails: 0, until: 0 } };
const FUSE_MAX = 3, FUSE_COOL_MS = 30 * 60_000;

function fuseOk(which: keyof typeof fuse): boolean {
  return fuse[which].fails < FUSE_MAX || Date.now() > fuse[which].until;
}
function fuseFail(which: keyof typeof fuse) {
  const f = fuse[which];
  f.fails++;
  if (f.fails >= FUSE_MAX) f.until = Date.now() + FUSE_COOL_MS;
}
function fuseOkReset(which: keyof typeof fuse) { fuse[which].fails = 0; }

async function sb(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${SB_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
  return res.status === 204 ? null : res.json();
}

async function mirrorInsert(table: 'agent_episodes' | 'agent_insights' | 'agent_messages', row: Record<string, unknown>) {
  if (!SB_URL || !SB_KEY) return; // mirror disabled — GitHub stays canonical
  const which = table === 'agent_messages' ? 'messages' : table === 'agent_insights' ? 'insights' : 'episodes';
  if (!fuseOk(which)) return;
  try {
    await sb(`/${table}`, { method: 'POST', body: JSON.stringify([row]) });
    fuseOkReset(which);
  } catch {
    fuseFail(which);
  }
}

/** bge-m3 embedding (1024-dim) via Cloudflare Workers AI; null on failure —
 *  an embedding failure degrades recall, it never blocks the tick. */
export async function embedText(text: string): Promise<number[] | null> {
  const acct = process.env.CF_ACCOUNT_ID;
  const tok = process.env.CF_API_TOKEN;
  if (!acct || !tok || !text?.trim()) return null;
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`${CF_AI}/${acct}/ai/run/${EMBED_MODEL}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: [text.slice(0, 1500)] }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const vec = json?.result?.data?.[0];
    return Array.isArray(vec) && vec.length === 1024 ? vec : null;
  } catch {
    return null;
  } finally {
    clearTimeout(kill);
  }
}

export async function recallMemories(query: string): Promise<string[]> {
  if (!SB_URL || !SB_KEY) return [];
  const q = embedText(query);
  const lines: string[] = [];
  try {
    const vec = await q;
    if (!vec) return [];
    const [msgs, ins] = await Promise.all([
      sb('/rpc/match_agent_messages', {
        method: 'POST',
        body: JSON.stringify({ query_embedding: vec, match_count: 4, filter_chat: null }),
      }).catch(() => null),
      sb('/rpc/match_agent_insights', {
        method: 'POST',
        body: JSON.stringify({ query_embedding: vec, match_count: 3 }),
      }).catch(() => null),
    ]);
    for (const m of msgs || []) lines.push(`ذكريات محادثة: ${String(m.text || '').slice(0, 160)}`);
    for (const i of ins || []) lines.push(`درس سابق: ${String(i.text || '').slice(0, 160)}`);
  } catch { /* recall is decorative, never blocking */ }
  return lines.slice(0, 7);
}
