// ─── Binary's LLM cortex v3 — hedged multi-provider racing ──────────────────
// The fix for "suppliers are broken" (RULE 01): providers never walk
// sequentially. They race in parallel waves via Promise.any — first
// acceptable answer wins; a wave loses only when every member fails.
//
//   wave 1 (strong):   gemini · openrouter · cohere
//   wave 2 (backup):   mistral · cloudflare · pollinations(openai)
//   wave 3 (wide net): pollinations-mistral (keyless) · grok · groq · huggingface
//
// v3 hardening (why the previous build answered poorly):
//  · 11 racers instead of 9 — a second keyless pollinations model widens the
//    no-key safety net to a genuinely different failure domain.
//  · per-provider latency + rolling success stats (surfaced in /status and
//    the dashboard so provider problems are visible without logs).
//  · JSON repair escalation: fences stripped → balanced-brace scan →
//    strictRetry at temperature ≤ 0.3 → {reply: raw} wrap. A parse miss can
//    never masquerade as an outage (RULE 02).
//  · overall budget enforced with a deadline that survives wave fan-out.
//
// Keys are env-only (RULE 11). Pollinations is keyless. Dormant providers
// (grok: credits, groq: region, huggingface: CF block) stay in the chain —
// breakers park them cheaply and they revive with zero code changes (RULE 06).

import { LLM_CFG, TOKEN_CEIL } from './config';

export interface ProviderDef {
  url: string;
  keyEnv: string;
  model: string;
  wave: 1 | 2 | 3;
  extraHeaders?: Record<string, string>;
  unwrap?: 'result';
  keyless?: boolean;
  note?: string;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyEnv: 'GEMINI_API_KEY',
    model: 'gemini-flash-latest',
    wave: 1,
    note: 'geo-gated from some regions; healthy from Vercel US',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
    model: 'meta-llama/llama-3.3-70b-instruct',
    wave: 1,
    extraHeaders: { 'HTTP-Referer': 'https://github.com/bessghiermohamed/binary-agent', 'X-Title': 'Binary Agent' },
  },
  cohere: {
    url: 'https://api.cohere.ai/compatibility/v1/chat/completions',
    keyEnv: 'COHERE_API_KEY',
    model: 'command-r7b-12-2024',
    wave: 1,
    note: 'fastest verified (0.4s)',
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    keyEnv: 'MISTRAL_API_KEY',
    model: 'ministral-8b-latest',
    wave: 2,
  },
  cloudflare: {
    url: process.env.CF_ACCOUNT_ID
      ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`
      : '',
    keyEnv: 'CF_API_TOKEN',
    model: '@cf/meta/llama-3.1-8b-instruct',
    wave: 2,
    unwrap: 'result',
    note: 'Workers AI — response needs unwrap:result (RULE 04)',
  },
  pollinations: {
    url: 'https://text.pollinations.ai/openai',
    keyEnv: '',
    model: 'openai',
    wave: 2,
    keyless: true,
    note: "keyless GPT4Free-style net — 'openai' writes cleaner Arabic than 'openai-fast'",
  },
  'pollinations-mistral': {
    url: 'https://text.pollinations.ai/openai',
    keyEnv: '',
    model: 'mistral',
    wave: 3,
    keyless: true,
    note: 'second keyless racer on a different upstream model',
  },
  grok: {
    url: 'https://api.x.ai/v1/chat/completions',
    keyEnv: 'GROK_API_KEY',
    model: 'grok-3-mini',
    wave: 3,
    note: 'dormant: no credits',
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    keyEnv: 'GROQ_API_KEY',
    model: 'llama-3.3-70b-versatile',
    wave: 3,
    note: 'dormant: region-blocked',
  },
  huggingface: {
    url: 'https://router.huggingface.co/v1/chat/completions',
    keyEnv: 'HF_API_KEY',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
    wave: 3,
    note: 'dormant: intermittent CF block',
  },
};

const WAVES: string[][] = [
  ['gemini', 'openrouter', 'cohere'],
  ['mistral', 'cloudflare', 'pollinations'],
  ['pollinations-mistral', 'grok', 'groq', 'huggingface'],
];

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }

// ─── stats + circuit breaker (module-scope, per warm lambda) ────────────────
interface PStats { ok: number; fail: number; lastError: string; lastMs: number; avgMs: number }
export const llmStats = {
  ok: 0,
  fail: 0,
  lastError: '',
  lastProvider: '',
  lastMs: 0,
  perProvider: {} as Record<string, PStats>,
};
const breaker: Record<string, { fails: number; until: number }> = {};

function pStats(p: string): PStats {
  return (llmStats.perProvider[p] ||= { ok: 0, fail: 0, lastError: '', lastMs: 0, avgMs: 0 });
}

function noteOk(p: string, ms: number) {
  const s = pStats(p);
  s.ok++; s.lastMs = ms; s.avgMs = s.avgMs ? Math.round(s.avgMs * 0.7 + ms * 0.3) : ms;
  llmStats.ok++; llmStats.lastProvider = p; llmStats.lastMs = ms;
  const b = breaker[p]; if (b) b.fails = 0;
}

function noteFail(p: string, msg: string) {
  const s = pStats(p);
  s.fail++; s.lastError = String(msg).slice(0, 140);
  llmStats.fail++; llmStats.lastError = s.lastError;
  const b = (breaker[p] ||= { fails: 0, until: 0 });
  b.fails++;
  if (b.fails >= LLM_CFG.breakThreshold) b.until = Date.now() + LLM_CFG.breakMs;
}

export function llmHealth() {
  const ready: string[] = [];
  const parked: { provider: string; untilWall: string; lastError: string }[] = [];
  const now = Date.now();
  for (const name of Object.keys(PROVIDERS)) {
    if (!usable(name)) continue;
    const b = breaker[name];
    if (b && b.until > now) {
      parked.push({ provider: name, untilWall: new Date(b.until).toISOString(), lastError: pStats(name).lastError });
    } else {
      ready.push(name);
    }
  }
  return {
    ready,
    readyCount: ready.length,
    parked,
    lastProvider: llmStats.lastProvider,
    lastError: llmStats.lastError,
    lastMs: llmStats.lastMs,
    totals: { ok: llmStats.ok, fail: llmStats.fail },
    perProvider: llmStats.perProvider,
    waves: WAVES,
  };
}

function usable(name: string): boolean {
  const p = PROVIDERS[name];
  if (!p) return false;
  if (!p.url) return false; // cloudflare without account id
  if (p.keyEnv && !process.env[p.keyEnv]) return false; // key missing
  return true;
}

function modelOf(name: string): string {
  const p = PROVIDERS[name];
  const overrideEnv = `MODEL_${name.toUpperCase().replace(/-/g, '_')}`;
  return process.env[overrideEnv] || p.model;
}

// ─── single provider call ────────────────────────────────────────────────────
async function callOne(
  name: string,
  messages: ChatMsg[],
  opts: { temperature?: number; maxTokens?: number },
): Promise<{ provider: string; text: string; ms: number }> {
  const p = PROVIDERS[name];
  const model = modelOf(name);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (p.keyEnv && process.env[p.keyEnv]) headers.authorization = `Bearer ${process.env[p.keyEnv]}`;
  if (p.extraHeaders) Object.assign(headers, p.extraHeaders);

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? TOKEN_CEIL.chat,
  };
  if (name === 'pollinations' || name === 'pollinations-mistral') {
    body.private = true; // keep community-proxy traffic off public feeds
  }

  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), LLM_CFG.callTimeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(p.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 160);
      noteFail(name, `HTTP ${res.status} ${errText}`);
      throw new Error(`${name}: HTTP ${res.status}`);
    }
    const json: any = await res.json();
    let payload = json;
    if (p.unwrap === 'result') payload = json?.result ?? json; // RULE 04
    let text: string = '';
    if (payload?.choices?.[0]?.message?.content != null) {
      text = String(payload.choices[0].message.content);
    } else if (payload?.choices?.[0]?.text != null) {
      text = String(payload.choices[0].text);
    } else if (typeof payload?.content === 'string') { // pollinations variants
      text = payload.content;
    } else if (payload?.response?.content?.[0]?.text) { // some anthropic-style shims
      text = String(payload.response.content[0].text);
    }
    text = (text || '').trim();
    if (text.length < 2) {
      noteFail(name, 'empty content');
      throw new Error(`${name}: empty content`);
    }
    noteOk(name, ms);
    return { provider: name, text, ms };
  } catch (e: any) {
    if (!`${e?.message || ''}`.startsWith(name)) noteFail(name, e?.message || 'network');
    throw e;
  } finally {
    clearTimeout(kill);
  }
}

// ─── public: chat() — race waves, first acceptable answer wins ──────────────
export async function chat(
  messages: ChatMsg[],
  opts: { temperature?: number; maxTokens?: number; budgetMs?: number } = {},
): Promise<{ text: string; provider: string; ms: number; wave: number } | null> {
  const deadline = Date.now() + (opts.budgetMs ?? LLM_CFG.overallBudgetMs);
  const errors: string[] = [];
  for (let w = 0; w < WAVES.length; w++) {
    if (Date.now() >= deadline) { errors.push('deadline'); break; }
    const members = WAVES[w].filter(usable);
    if (!members.length) continue;
    const racers = members.map((name) =>
      callOne(name, messages, opts).catch((e) => {
        errors.push(String(e?.message || e));
        return null;
      }),
    );
    const budgetLeft = deadline - Date.now();
    const winner = await Promise.race([
      Promise.any(racers as Promise<{ provider: string; text: string; ms: number }>[]).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), Math.max(budgetLeft, 1))),
    ]);
    if (winner) return { ...winner, wave: w + 1 };
  }
  llmStats.lastError = errors.slice(-3).join(' | ').slice(0, 200) || 'all providers failed';
  return null;
}

// ─── JSON mode — decision traffic (RULE 02: parse miss ≠ outage) ────────────
export function extractJson(raw: string): any | null {
  let s = String(raw || '').trim();
  s = s.replace(/```(?:json)?/gi, ''); // strip code fences
  const start = s.indexOf('{');
  if (start === -1) return null;
  // balanced-brace scan from the first '{'
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

export async function chatJson(
  messages: ChatMsg[],
  opts: { maxTokens?: number; budgetMs?: number } = {},
): Promise<{ json: any; provider: string; ms: number; retried: boolean } | null> {
  // attempt 1 — normal temperature
  const first = await chat(messages, { ...opts, temperature: 0.6 });
  if (first) {
    const json = extractJson(first.text);
    if (json && typeof json === 'object') return { json, provider: first.provider, ms: first.ms, retried: false };
  }
  // attempt 2 — strict retry, low temperature, explicit instruction
  const strictMsgs: ChatMsg[] = [
    ...messages,
    { role: 'user', content: 'IMPORTANT: output ONLY one valid JSON object. No prose, no markdown fences, no commentary — JSON only.' },
  ];
  const second = await chat(strictMsgs, { ...opts, temperature: 0.2, budgetMs: 20_000 });
  if (second) {
    const json = extractJson(second.text);
    if (json && typeof json === 'object') return { json, provider: second.provider, ms: second.ms, retried: true };
    // RULE 02 final degradation — model spoke, but not JSON. Never fake an outage.
    return { json: { reply: second.text }, provider: second.provider, ms: second.ms, retried: true };
  }
  if (first) return { json: { reply: first.text }, provider: first.provider, ms: first.ms, retried: true };
  return null; // genuine outage — every racer in every wave failed
}

// ─── provider probe (setup/verification, burns no budget silently) ─────────
export async function probeProvider(name: string): Promise<{ ok: boolean; ms: number; error: string }> {
  if (!usable(name)) return { ok: false, ms: 0, error: 'not usable (missing key or url)' };
  try {
    const r = await callOne(name, [
      { role: 'system', content: 'You are a probe. Reply with the single word: OK' },
      { role: 'user', content: 'ping' },
    ], { temperature: 0, maxTokens: 8 });
    return { ok: true, ms: r.ms, error: '' };
  } catch (e: any) {
    return { ok: false, ms: 0, error: String(e?.message || e).slice(0, 120) };
  }
}
