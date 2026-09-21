// ─── Binary's persistent memory (GitHub repo = canonical DB + Supabase mirror) ──
//
// agent-memory/
//   identity.md       — self-concept, rewritten slowly through reflection
//   state.json        — runtime state: lock, budgets, owner, task pointer
//   goals.json        — goals with subtasks and status
//   approvals.json    — risky actions awaiting owner decision
//   episodic.jsonl    — append-only experience log (trimmed to last 400)
//   insights.jsonl    — lessons learned (trimmed to last 200)
//   conversations/<chatId>.jsonl — recent chat history per conversation
//
// All writes go through one lock (state.json CAS) held by a tick.

import { readFile, writeFile, type RawFile } from './github';
import { AGENT_CONFIG, dayKey } from './config';

const R = () => AGENT_CONFIG.memoryRepo;
const T = () => AGENT_CONFIG.ghToken;

// ─── shapes ──────────────────────────────────────────────────────────────────
export interface ScheduledTask {
  id: string;
  what: string;
  dueAt: number;
  createdAt: number;
  goalId?: string;
}

export interface AgentState {
  lock: { id: string; until: number } | null;
  paused: boolean;
  ownerChatId: string;
  ownerName: string;
  currentTask: { goalId: string; note: string; startedAt: number } | null;
  lastAction: { tool: string; summary: string; ok: boolean; ts: number } | null;
  lastInitiativeAt: number;
  nextWakeAt: number;
  chainCount: number;
  scheduled: ScheduledTask[];
  counters: { day: string; llm: number; ticks: number };
  totals: { ticks: number; llm: number; goalsDone: number; startedAt: number };
  meta: { repo: string; built: string };
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'blocked' | 'waiting_approval' | 'done' | 'failed' | 'cancelled';
  subtasks: { id: string; text: string; done: boolean }[];
  origin: string;
  createdAt: number;
  updatedAt: number;
  notes: string[];
  result?: string;
}

export interface Approval {
  id: string;
  tool: string;
  args: any;
  reason: string;
  goalId?: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: number;
  decidedAt?: number;
  message?: { chatId: any; messageId: number };
}

export interface MemoryBundle {
  state: AgentState;
  stateSha: string | null;
  goals: Goal[];
  goalsSha: string | null;
  approvals: Approval[];
  approvalsSha: string | null;
  identity: string;
  identitySha: string | null;
  episodes: string[];
  insights: { ts: number; text: string }[];
  conversations: Record<string, string[]>;
}

// ─── raw file helpers ────────────────────────────────────────────────────────

// ─── Supabase Storage mirror (best-effort add-on; never blocks the agent) ────
// When SUPABASE_URL + SUPABASE_SERVICE_KEY are set, the four "mind" files are
// mirrored into the `agent-memory` storage bucket. GitHub remains canonical.
// 3 consecutive failures disable mirroring for 30 minutes (protects tick budget).
const SB_MIND_FILES = new Set(['state.json', 'goals.json', 'approvals.json', 'identity.md']);
let sbBucketReady = false;
let sbFailures = 0;
let sbDisabledUntil = 0;
export function sbMirrorStatus() {
  return { enabled: Date.now() > sbDisabledUntil && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY, bucketReady: sbBucketReady, failures: sbFailures };
}

async function sbMirror(path: string, content: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !SB_MIND_FILES.has(path)) return;
  if (Date.now() < sbDisabledUntil) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    if (!sbBucketReady) {
      const r = await fetch(`${url}/storage/v1/bucket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'agent-memory', public: false }),
        signal: ctrl.signal,
      });
      if (r.ok || r.status === 400 || r.status === 409) sbBucketReady = true; // 409 = already exists
    }
    const res = await fetch(`${url}/storage/v1/object/agent-memory/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'text/plain;charset=utf-8', 'x-upsert': 'true' },
      body: content,
      signal: ctrl.signal,
    });
    if (res.ok) {
      sbFailures = 0;
    } else {
      throw new Error(`mirror ${res.status}`);
    }
  } catch (e: any) {
    sbFailures++;
    if (sbFailures >= 3) {
      sbDisabledUntil = Date.now() + 30 * 60_000;
      console.error('[agent.memory] supabase mirror disabled for 30min:', e?.message?.slice(0, 80));
    } else {
      console.error('[agent.memory] supabase mirror failed:', path, e?.message?.slice(0, 80));
    }
  } finally {
    clearTimeout(t);
  }
}

// ─── Supabase DB (pgvector semantic memory) + Cloudflare bge-m3 embeddings ────
// The dedicated Supabase agent project stores three queryable tables:
//   agent_episodes — every experience line (with embedding for semantic recall)
//   agent_insights — durable lessons (with embedding)
//   agent_messages — conversation log per chat (with embedding)
// Mirroring is best-effort: 3 consecutive failures disable it for 30 minutes,
// exactly like the Storage mirror. Reads power recallMemories() for the chat path.

const SB_EMBED_MODEL = '@cf/baai/bge-m3'; // 1024-dim multilingual (Arabic-capable), free tier

let sbDbFailures = 0;
let sbDbDisabledUntil = 0;
export function sbDbStatus() {
  return {
    enabled: Date.now() > sbDbDisabledUntil && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY,
    failures: sbDbFailures,
  };
}

function sbDbNoteFail(e: any) {
  sbDbFailures++;
  if (sbDbFailures >= 3) {
    sbDbDisabledUntil = Date.now() + 30 * 60_000;
    console.error('[agent.memory] supabase DB disabled for 30min:', String(e?.message || e).slice(0, 100));
  }
}

async function sbRest(path: string, init: any, timeoutMs = 5000): Promise<any> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        apikey: key,
        'content-type': 'application/json',
        prefer: 'return=minimal',
        ...(init?.headers || {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`sbRest ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return res.status === 204 ? null : res.json().catch(() => null);
  } finally {
    clearTimeout(t);
  }
}

/** Embed text via Cloudflare Workers AI bge-m3 (1024 dims, multilingual). Free. */
export async function embedText(text: string): Promise<number[] | null> {
  const acc = process.env.CF_ACCOUNT_ID;
  const tok = process.env.CF_API_TOKEN;
  if (!acc || !tok) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/ai/run/${SB_EMBED_MODEL}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: [String(text).slice(0, 2000)] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
    const j: any = await res.json();
    const v = j?.result?.data?.[0];
    return Array.isArray(v) && v.length === 1024 ? v : null;
  } catch (e: any) {
    console.error('[agent.memory] embed failed:', e?.message?.slice(0, 80));
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Fire-and-forget mirror of one memory line into the Supabase agent DB. */
async function sbDbMirror(path: string, entry: any): Promise<void> {
  if (Date.now() < sbDbDisabledUntil) return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
  try {
    if (path === 'episodic.jsonl') {
      const e = entry || {};
      const emb = await embedText(e.text || '');
      await sbRest('agent_episodes', {
        method: 'POST',
        body: JSON.stringify({
          ts: new Date(e.ts || Date.now()).toISOString(),
          text: String(e.text || '').slice(0, 1000),
          goal_id: e.goalId ? String(e.goalId) : null,
          tool: e.tool ? String(e.tool) : null,
          ok: typeof e.ok === 'boolean' ? e.ok : null,
          embedding: emb,
          detail: e,
        }),
      });
    } else if (path === 'insights.jsonl') {
      const emb = await embedText(entry?.text || '');
      await sbRest('agent_insights', {
        method: 'POST',
        body: JSON.stringify({
          ts: new Date(entry?.ts || Date.now()).toISOString(),
          text: String(entry?.text || '').slice(0, 1000),
          embedding: emb,
        }),
      });
    } else if (path.startsWith('conversations/')) {
      const chatId = decodeURIComponent(path.slice('conversations/'.length)).replace(/\.jsonl$/, '');
      const emb = await embedText(`${entry?.who || ''}: ${entry?.text || ''}`);
      await sbRest('agent_messages', {
        method: 'POST',
        body: JSON.stringify({
          chat_id: chatId,
          ts: new Date(entry?.ts || Date.now()).toISOString(),
          who: String(entry?.who || '').slice(0, 80),
          text: String(entry?.text || '').slice(0, 1000),
          embedding: emb,
        }),
      });
    } else return;
    sbDbFailures = 0;
  } catch (e: any) {
    sbDbNoteFail(e);
  }
}

/**
 * Semantic recall for the chat path: embed the message, then pgvector cosine
 * search over conversation history + insights. Best-effort — empty string on
 * any failure (the chat never blocks on this).
 */
export async function recallMemories(query: string, chatId: string | null): Promise<string> {
  if (Date.now() < sbDbDisabledUntil) return '';
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return '';
  try {
    const emb = await embedText(query);
    if (!emb) return '';
    const [msgs, ins] = await Promise.all([
      sbRest(
        'rpc/match_agent_messages',
        { method: 'POST', body: JSON.stringify({ query_embedding: emb, match_count: 4, filter_chat: chatId }) },
        8000
      ),
      sbRest(
        'rpc/match_agent_insights',
        { method: 'POST', body: JSON.stringify({ query_embedding: emb, match_count: 3 }) },
        8000
      ),
    ]);
    const lines: string[] = [];
    for (const m of Array.isArray(msgs) ? msgs : []) {
      if (m?.text) lines.push(`- ${(m.who || '?')}: ${String(m.text).slice(0, 180)}`);
    }
    for (const i of Array.isArray(ins) ? ins : []) {
      if (i?.text) lines.push(`- درس سابق: ${String(i.text).slice(0, 180)}`);
    }
    return lines.slice(0, 7).join('\n');
  } catch (e: any) {
    console.error('[agent.memory] recall failed:', String(e?.message || e).slice(0, 100));
    return '';
  }
}

async function readJson<T>(path: string, fallback: T): Promise<{ data: T; sha: string | null }> {
  try {
    const f: RawFile = await readFile(T(), R(), path);
    if (!f.exists) return { data: fallback, sha: null };
    return { data: JSON.parse(f.content) as T, sha: f.sha };
  } catch (e: any) {
    console.error('[agent.memory] readJson failed', path, e?.message);
    return { data: fallback, sha: null };
  }
}

async function writeJson(path: string, data: any, sha: string | null, message: string) {
  const content = JSON.stringify(data, null, 2);
  const r = await writeFile(T(), R(), path, content, message, { sha });
  if (r.ok) void sbMirror(path, content).catch(() => {});
  return r;
}

async function readLines(path: string, cap: number): Promise<any[]> {
  try {
    const f = await readFile(T(), R(), path);
    if (!f.exists) return [];
    const lines = f.content.split('\n').filter((l) => l.trim());
    return lines.slice(-cap).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: 0, text: String(l).slice(0, 200) };
      }
    });
  } catch {
    return [];
  }
}

/** Append one JSON line (read-modify-write; caller holds the lock). */
export async function appendLine(
  path: string,
  entry: any,
  capLines = 400
): Promise<{ ok: boolean; error?: string }> {
  try {
    const f = await readFile(T(), R(), path);
    const lines = f.exists ? f.content.split('\n').filter((l) => l.trim()) : [];
    lines.push(JSON.stringify(entry));
    const trimmed = lines.slice(-capLines);
    const r = await writeFile(
      T(),
      R(),
      path,
      trimmed.join('\n') + '\n',
      `memory: ${path} +1`,
      { sha: f.sha }
    );
    if (r.ok) void sbDbMirror(path, entry).catch(() => {}); // semantic mirror (best-effort)
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e: any) {
    return { ok: false, error: e?.message };
  }
}

// ─── load everything for one tick ────────────────────────────────────────────
export async function loadMemory(): Promise<MemoryBundle> {
  const [state, goals, approvals, identity, episodes, insights] = await Promise.all([
    readJson<AgentState>('state.json', {} as AgentState),
    readJson<{ goals: Goal[] }>('goals.json', { goals: [] }),
    readJson<{ pending: Approval[]; decided: Approval[] }>('approvals.json', { pending: [], decided: [] }),
    readFile(T(), R(), 'identity.md'),
    readLines('episodic.jsonl', 30),
    readLines('insights.jsonl', 20),
  ]);

  const s = state.data as AgentState;
  const freshDay = dayKey();
  const defaults: AgentState = {
    lock: null,
    paused: false,
    ownerChatId: AGENT_CONFIG.ownerChatId,
    ownerName: '',
    currentTask: null,
    lastAction: null,
    lastInitiativeAt: 0,
    nextWakeAt: 0,
    chainCount: 0,
    scheduled: [],
    counters: { day: freshDay, llm: 0, ticks: 0 },
    totals: { ticks: 0, llm: 0, goalsDone: 0, startedAt: Date.now() },
    meta: { repo: R(), built: '2026-09-21' },
  };
  const merged: AgentState = { ...defaults, ...s };
  if (merged.counters?.day !== freshDay) merged.counters = { day: freshDay, llm: 0, ticks: 0 };
  if (!merged.totals) merged.totals = defaults.totals;
  if (!merged.meta) merged.meta = defaults.meta;
  if (!Array.isArray(merged.scheduled)) merged.scheduled = [];
  if (!merged.ownerChatId && AGENT_CONFIG.ownerChatId) merged.ownerChatId = AGENT_CONFIG.ownerChatId;

  return {
    state: merged,
    stateSha: state.sha,
    goals: (goals.data?.goals || []) as Goal[],
    goalsSha: goals.sha,
    approvals: (approvals.data?.pending || []) as Approval[],
    approvalsSha: approvals.sha,
    identity: identity.content || '',
    identitySha: identity.sha,
    episodes: episodes.map((e: any) => (typeof e === 'string' ? e : e.text || JSON.stringify(e))),
    insights: insights.map((i: any) => ({ ts: i.ts || 0, text: i.text || '' })),
    conversations: {},
  };
}

export async function loadConversation(chatId: any, cap = 40): Promise<string[]> {
  return readLines(`conversations/${chatId}.jsonl`, cap).then((arr) =>
    arr.map((e: any) => `${e.who}: ${e.text}`)
  );
}

// ─── save helpers (call while holding the lock) ──────────────────────────────

export async function saveState(b: MemoryBundle): Promise<boolean> {
  const r = await writeJson('state.json', b.state, b.stateSha, 'memory: state');
  b.stateSha = r.sha || b.stateSha;
  return r.ok;
}

export async function saveGoals(b: MemoryBundle): Promise<boolean> {
  const r = await writeJson('goals.json', { goals: b.goals }, b.goalsSha, 'memory: goals');
  b.goalsSha = r.sha || b.goalsSha;
  return r.ok;
}

export async function saveApprovals(b: MemoryBundle): Promise<boolean> {
  const cur = await readJson<{ pending: Approval[]; decided: Approval[] }>('approvals.json', {
    pending: [],
    decided: [],
  });
  const newlyDecided = b.approvals.filter((a) => a.status !== 'pending');
  const stillPending = b.approvals.filter((a) => a.status === 'pending');
  b.approvals = stillPending; // keep the bundle consistent with the file
  const decided = [...(cur.data.decided || []), ...newlyDecided].slice(-40);
  const r = await writeJson('approvals.json', { pending: stillPending, decided }, b.approvalsSha, 'memory: approvals');
  b.approvalsSha = r.sha || b.approvalsSha;
  return r.ok;
}

/**
 * Targeted read-modify-write on state.json (used by the chat path, which does
 * NOT hold the tick lock — avoids clobbering fields a concurrent tick wrote).
 * `fn` may return false to abort the write.
 */
export async function updateStateFields(fn: (s: AgentState) => boolean | void): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const cur = await readJson<AgentState>('state.json', {} as AgentState);
    const s = cur.data as AgentState;
    if (!s.counters) continue; // file not initialized yet — nothing to update
    const verdict = fn(s);
    if (verdict === false) return true;
    const r = await writeJson('state.json', s, cur.sha, 'memory: state (chat update)');
    if (r.ok) return true;
    // sha conflict -> retry with fresh read
  }
  return false;
}

/**
 * Targeted read-modify-write on goals.json (chat path — no tick lock held).
 * `fn` may return false to abort the write.
 */
export async function mutateGoals(fn: (goals: Goal[]) => boolean | void): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    const cur = await readJson<{ goals: Goal[] }>('goals.json', { goals: [] });
    const goals = cur.data?.goals || [];
    const verdict = fn(goals);
    if (verdict === false) return true;
    const r = await writeJson('goals.json', { goals }, cur.sha, 'memory: goals (chat update)');
    if (r.ok) return true;
  }
  return false;
}

export async function saveIdentity(b: MemoryBundle, newIdentity: string): Promise<boolean> {
  const r = await writeFile(T(), R(), 'identity.md', newIdentity.slice(0, 4200), 'identity: self-update', {
    sha: b.identitySha,
  });
  if (r.ok) {
    b.identity = newIdentity.slice(0, 4200);
    b.identitySha = r.sha;
    void sbMirror('identity.md', newIdentity.slice(0, 4200)).catch(() => {});
  }
  return r.ok;
}

// ─── conversation log (outside the lock; last-writer-wins is fine here) ──────
export async function logConversation(chatId: any, who: string, text: string) {
  await appendLine(
    `conversations/${chatId}.jsonl`,
    { ts: Date.now(), who, text: String(text).slice(0, 600) },
    40
  );
}

// ─── distributed lock: state.json CAS ────────────────────────────────────────
// Only ONE tick may think at a time. We mark lock inside state.json; concurrent
// writers conflict on sha and back off. Lock auto-expires (LOCK_MS).

export async function acquireLock(b: MemoryBundle, lockId: string): Promise<boolean> {
  const now = Date.now();
  if (b.state.lock && b.state.lock.until > now && b.state.lock.id !== lockId) return false;
  b.state.lock = { id: lockId, until: now + AGENT_CONFIG.LOCK_MS };
  return saveState(b);
}

export async function releaseLock(b: MemoryBundle, lockId: string): Promise<void> {
  if (b.state.lock?.id === lockId) {
    b.state.lock = null;
    await saveState(b);
  }
}

export function lockStolen(b: MemoryBundle, lockId: string): boolean {
  return !!b.state.lock && b.state.lock.id !== lockId;
}
