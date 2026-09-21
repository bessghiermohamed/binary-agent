// ─── Binary's LLM cortex — 9-provider fallback chain ─────────────────────
// Zero dependencies, OpenAI-compatible endpoints, provider order:
// gemini > openrouter > mistral > huggingface > cohere > cloudflare > pollinations > grok > groq.
// Keys come from Vercel env (never hardcoded). Pollinations is a keyless
// community endpoint (GPT4Free-style) — an always-available safety net.
// Verified 2026-09-21: openrouter (llama-3.3-70b) OK, mistral OK, huggingface OK,
// cohere OK, cloudflare-ai OK, pollinations OK (Arabic); gemini valid but geo-gated
// (works from Vercel US); groq 403 (region); grok key valid but out of credits.

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
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', keyEnv: 'MISTRAL_API_KEY', model: 'ministral-8b-latest' },
  huggingface: {
    url: 'https://router.huggingface.co/v1/chat/completions',
    keyEnv: 'HF_API_KEY',
    model: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  cohere: { url: 'https://api.cohere.ai/compatibility/v1/chat/completions', keyEnv: 'COHERE_API_KEY', model: 'command-r7b-12-2024' },
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
    // Keyless community endpoint (GPT4Free-style). No API key env needed.
    url: 'https://text.pollinations.ai/openai',
    keyEnv: '',
    model: 'openai-fast',
  },
  grok: { url: 'https://api.x.ai/v1/chat/completions', keyEnv: 'GROK_API_KEY', model: 'grok-3-mini' },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile' },
};

const CHAIN = ['gemini', 'openrouter', 'mistral', 'huggingface', 'cohere', 'cloudflare', 'pollinations', 'grok', 'groq'];

export const llmStats = { ok: 0, fail: 0, lastError: '', lastProvider: '' };

function modelFor(name: string): string {
  return process.env[`MODEL_${name.toUpperCase()}`] || PROVIDERS[name].model;
}

async function callOne(name: string, messages: any[], opts: { maxTokens: number; temperature: number }): Promise<string> {
  const cfg = PROVIDERS[name];
  const key = cfg.keyEnv ? process.env[cfg.keyEnv] : 'keyless';
  if (!key) throw new Error('missing API key env: ' + cfg.keyEnv);
  if (!cfg.url) throw new Error('missing config for provider: ' + name);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
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

export async function chat(messages: any[], opts: any = {}): Promise<string> {
  const maxTokens = opts.maxTokens ?? 400;
  const temperature = opts.temperature ?? 0.6;
  const budgetMs = opts.budgetMs ?? 30000;
  const t0 = Date.now();
  let lastErr: any = new Error('no provider configured');
  for (const p of CHAIN) {
    if (!PROVIDERS[p]) continue;
    if (Date.now() - t0 > budgetMs) break;
    try {
      const out = await callOne(p, messages, { maxTokens, temperature });
      llmStats.ok++;
      llmStats.lastProvider = p;
      return out;
    } catch (e: any) {
      llmStats.fail++;
      llmStats.lastError = String(e?.message || '').slice(0, 140);
      console.error(`[agent.llm] ${p} failed:`, llmStats.lastError);
      lastErr = e;
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

export async function chatJson(messages: any[], opts: any = {}): Promise<any | null> {
  const raw = await chat(messages, opts);
  return extractJson(raw);
}
