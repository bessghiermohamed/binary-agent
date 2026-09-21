// ─── Binary's LLM cortex v2 — hedged multi-provider racing ─────────────────
// Instead of walking the chain one-by-one (a single slow/hanging provider ate
// the whole time budget and every later provider starved — the cause of the
// "مزودات الذكاء اصطدمت بعقبة" failures), providers now race in parallel
// waves: first acceptable answer wins.
//
//   wave 1 (strong):  gemini > openrouter > cohere
//   wave 2 (backup):  mistral > cloudflare > pollinations
//   wave 3 (dormant): grok > groq > huggingface   (parked: no credits / 403)
//
// A circuit breaker parks any provider that fails twice in a row for 8 minutes
// so rate-limited or geo-blocked endpoints never burn the budget again.
// Keys come from env only. Pollinations is keyless (GPT4Free-style safety net).
// Verified 2026-09-21 (sandbox): openrouter OK 2.9s, cohere OK 0.4s,
// mistral OK 1.7s, cloudflare OK 0.8s, pollinations openai OK 2.6s (Arabic OK);
// huggingface 403 (CF block), grok 403 (no credits), groq 403 (region);
// gemini valid, geo-gated from sandbox, healthy from Vercel US.

const PROVIDERS: Record<string, any> = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    keyEnv: 'GEMINI_API_KEY',
    model: 'gemini-flash-latest',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
    model: 'meta-llama/llama-3.3-70b-instruct',
    extraHeaders: { 'HTTP-Referer': 'https://github.com/bessghiermohamed/binary-agent', 'X-Title': 'Binary Agent' },
  },
  cohere: { url: 'https://api.cohere.ai/compatibility/v1/chat/completions', keyEnv: 'COHERE_API_KEY', model: 'command-r7b-12-2024' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', keyEnv: 'MISTRAL_API_KEY', model: 'ministral-8b-latest' },
  cloudflare: {
    // Workers AI — free daily neuron allowance, account id comes from env.
    url: (
      process.env.CF_ACCOUNT_ID
        ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`
        : ''
    ),
    keyEnv: 'CF_API_TOKEN',
    model: '@cf/meta/llama-3.1-8b-instruct',
    unwrap: 'result', // response shape: { success, result: { choices: [...] } }
  },
  pollinations: {
    // Keyless community endpoint (GPT4Free-style). 'openai' (gpt-4o-mini class)
    // answers faster AND writes cleaner Arabic than 'openai-fast'.
    url: 'https://text.pollinations.ai/openai',
    keyEnv: '',
    model: 'openai',
  },
  grok: { url: 'https://api.x.ai/v1/chat/completions', keyEnv: 'GROK_API_KEY', model: 'grok-3-mini' },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile' },
  huggingface: {
    url: 'https://router.huggingface.co/v1/chat/completions',
    keyEnv: 'HF_API_KEY',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
  },
};

const WAVES: string[][] = [
  ['gemini', 'openrouter', 'cohere'],
  ['mistral', 'cloudflare', 'pollinations'],
  ['grok', 'groq', 'huggingface'],
];

const CALL_TIMEOUT_MS = 14_000; // per provider (was 25s — a hang ate the budget)
const BREAK_THRESHOLD = 2; // consecutive failures before parking
const BREAK_MS = 8 * 60_000; // park duration

export const llmStats = {
  ok: 0,
  fail: 0,
  lastError: '',
  lastProvider: '',
  perProvider: {} as Record<string, { ok: number; fail: number; lastError: string }>,
};

const breaker: Record<string, { fails: number; until: number }> = {};

function noteFail(p: string, msg: string) {
  const b = (breaker[p] ||= { fails: 0, until: 0 });
  b.fails++;
  const st = (llmStats.perProvider[p] ||= { ok: 0, fail: 0, lastError: '' });
  st.fail++;
  st.lastError = msg;
  if (b.fails >= BREAK_THRESHOLD) {
    b.until = Date.now() + BREAK_MS;
    b.fails = 0;
    console.error(`[agent.llm] breaker: ${p} parked ${BREAK_MS / 60000}min (${msg.slice(0, 80)})`);
  }
}

function noteOk(p: string) {
  breaker[p] = { fails: 0, until: 0 };
  const st = (llmStats.perProvider[p] ||= { ok: 0, fail: 0, lastError: '' });
  st.ok++;
}

/** Public snapshot for /status — owner-visible provider health. */
export function llmHealth(): { ready: string[]; parked: string[]; lastProvider: string; lastError: string } {
  const now = Date.now();
  const all = WAVES.flat();
  const hasKey = (p: string) => {
    const env = PROVIDERS[p]?.keyEnv;
    return !env || !!process.env[env];
  };
  return {
    ready: all.filter((p) => hasKey(p) && (breaker[p]?.until ?? 0) < now),
    parked: all.filter((p) => hasKey(p) && (breaker[p]?.until ?? 0) >= now),
    lastProvider: llmStats.lastProvider,
    lastError: llmStats.lastError,
  };
}

function modelFor(name: string): string {
  return process.env[`MODEL_${name.toUpperCase()}`] || PROVIDERS[name].model;
}

async function callOne(name: string, messages: any[], opts: { maxTokens: number; temperature: number }): Promise<string> {
  const cfg = PROVIDERS[name];
  const key = cfg.keyEnv ? process.env[cfg.keyEnv] : 'keyless';
  if (!key) throw new Error('missing API key env: ' + cfg.keyEnv);
  if (!cfg.url) throw new Error('missing config for provider: ' + name);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.keyEnv ? { authorization: `Bearer ${key}` } : {}),
        ...(cfg.extraHeaders || {}),
      },
      body: JSON.stringify({ model: modelFor(name), messages, max_tokens: opts.maxTokens, temperature: opts.temperature }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 140)}`);
    let j: any = await res.json();
    if (cfg.unwrap && j[cfg.unwrap]) j = j[cfg.unwrap]; // cloudflare { result: { choices } }
    const txt = j.choices?.[0]?.message?.content;
    if (!txt) throw new Error('empty completion');
    return txt;
  } finally {
    clearTimeout(t);
  }
}

/** Race a set of providers in parallel; first success wins. */
function race(names: string[], messages: any[], opts: { maxTokens: number; temperature: number }): Promise<string> {
  const runners = names.map(async (p) => {
    try {
      const out = await callOne(p, messages, opts);
      noteOk(p);
      llmStats.ok++;
      llmStats.lastProvider = p;
      return out;
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 140);
      noteFail(p, msg);
      llmStats.fail++;
      llmStats.lastError = msg;
      console.error(`[agent.llm] ${p} failed:`, msg);
      throw e;
    }
  });
  return Promise.any(runners); // Node 18+/20: resolves on first fulfilled
}

/** Is this provider actually usable right now (key present, url built)? */
function usable(p: string): boolean {
  const cfg = PROVIDERS[p];
  if (!cfg) return false;
  if (cfg.keyEnv && !process.env[cfg.keyEnv]) return false;
  if (!cfg.url) return false;
  return true;
}

export async function chat(messages: any[], opts: any = {}): Promise<string> {
  const maxTokens = opts.maxTokens ?? 400;
  const temperature = opts.temperature ?? 0.6;
  const budgetMs = opts.budgetMs ?? 42_000;
  const t0 = Date.now();
  let lastErr: any = new Error('no provider configured');
  for (const wave of WAVES) {
    if (Date.now() - t0 > budgetMs) break;
    const now = Date.now();
    const candidates = wave.filter((p) => usable(p) && (breaker[p]?.until ?? 0) < now);
    if (!candidates.length) continue; // whole wave parked/unusable -> next wave
    try {
      return await race(candidates, messages, { maxTokens, temperature });
    } catch (e: any) {
      lastErr = e; // wave lost completely -> next wave
    }
  }
  throw lastErr;
}

/** Tolerant JSON extraction: models sometimes wrap JSON in prose or ```fences. */
export function extractJson(text: string): any | null {
  if (!text) return null;
  let t = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const direct = (() => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  })();
  if (direct && typeof direct === 'object') return direct;
  // first balanced {...} block
  let start = t.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(t.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
    start = t.indexOf('{', start + 1);
  }
  return null;
}

/**
 * JSON-mode chat. With strictRetry (chat path), one bad parse costs a retried
 * call and, as a last resort, the raw text is wrapped as { reply } so the bot
 * answers with model output instead of the "providers hit an obstacle" notice.
 */
export async function chatJson(messages: any[], opts: any = {}): Promise<any | null> {
  const raw = await chat(messages, opts);
  const first = extractJson(raw);
  if (first && typeof first === 'object') return first;
  if (!opts.strictRetry) return null;
  const raw2 = await chat(
    [
      ...messages,
      { role: 'user', content: 'Your previous answer was not valid JSON. Output ONLY valid JSON now — no prose, no code fences, no mixed languages.' },
    ],
    { ...opts, temperature: Math.min(opts.temperature ?? 0.6, 0.3), budgetMs: 20_000 }
  );
  const second = extractJson(raw2);
  if (second && typeof second === 'object') return second;
  return { reply: String(raw).replace(/\s+/g, ' ').slice(0, 600) };
}
