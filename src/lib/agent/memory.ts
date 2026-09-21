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
