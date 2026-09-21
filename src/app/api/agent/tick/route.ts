// POST /api/agent/tick — the heartbeat endpoint (spec §4).
// Header x-agent-secret = AGENT_TICK_SECRET (POST), or ?key= (GET convenience).
// Callers: GitHub Actions cron, self-dispatched chains, manual curls.

import { NextRequest, NextResponse } from 'next/server';
import { SECRETS } from '@/lib/agent/config';
import { runTick } from '@/lib/agent/brain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  if (!SECRETS.tickSecret) return false;
  const header = req.headers.get('x-agent-secret') || '';
  const query = req.nextUrl.searchParams.get('key') || '';
  return header === SECRETS.tickSecret || query === SECRETS.tickSecret;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'bad-secret' }, { status: 401 });
  }
  // ?probe=llm — one-shot provider health audit from production (v4).
  // Burns one tiny call per usable provider; does not touch agent state,
  // budgets, or memory. This is the "supplier problem" observability that
  // was missing when model IDs silently retired (Sept 2026 audit).
  // ?probe=llm&deep=gemini — one deploy, every candidate model tested: the
  // answer to "which Gemini model actually responds TODAY from production".
  const deep = req.nextUrl.searchParams.get('deep');
  if (req.nextUrl.searchParams.get('probe') === 'llm' && deep === 'gemini') {
    const { probeProvider } = await import('@/lib/agent/llm');
    const candidates = [
      'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest',
      'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.8-flash',
    ];
    const results = await Promise.all(candidates.map(async (m) => {
      const r = await probeProvider('gemini', m);
      return { model: m, ok: r.ok, ms: r.ms, error: r.error.slice(0, 90) };
    }));
    const winner = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms)[0] || null;
    return NextResponse.json({ ok: true, probe: 'gemini-deep', at: new Date().toISOString(), results, fastestWorking: winner });
  }
  if (req.nextUrl.searchParams.get('probe') === 'llm') {
    const { PROVIDERS, probeProvider, llmHealth } = await import('@/lib/agent/llm');
    const providers: Record<string, unknown> = {};
    await Promise.all(Object.keys(PROVIDERS).map(async (name) => {
      providers[name] = await probeProvider(name);
    }));
    return NextResponse.json({
      ok: true,
      probe: 'llm',
      at: new Date().toISOString(),
      providers,
      health: llmHealth(),
    });
  }
  // ?probe=models — live model catalogs from production (where regional
  // blocks that hide the sandbox do not apply, e.g. Groq). The ops answer
  // to "which model name is valid TODAY" without guessing.
  if (req.nextUrl.searchParams.get('probe') === 'models') {
    const LISTS: Record<string, { url: string; keyEnv: string; auth?: 'bearer' | 'x-goog' }> = {
      gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=60', keyEnv: 'GEMINI_API_KEY', auth: 'x-goog' },
      groq: { url: 'https://api.groq.com/openai/v1/models', keyEnv: 'GROQ_API_KEY', auth: 'bearer' },
      openrouter: { url: 'https://openrouter.ai/api/v1/models', keyEnv: 'OPENROUTER_API_KEY', auth: 'bearer' },
      cohere: { url: 'https://api.cohere.ai/v1/models?endpoint=chat', keyEnv: 'COHERE_API_KEY', auth: 'bearer' },
      mistral: { url: 'https://api.mistral.ai/v1/models', keyEnv: 'MISTRAL_API_KEY', auth: 'bearer' },
      pollinations: { url: 'https://text.pollinations.ai/models', keyEnv: '' },
    };
    const out: Record<string, unknown> = {};
    await Promise.all(Object.entries(LISTS).map(async ([name, def]) => {
      try {
        const headers: Record<string, string> = {};
        const key = def.keyEnv ? process.env[def.keyEnv] || '' : '';
        if (def.auth === 'x-goog') headers['x-goog-api-key'] = key;
        else if (key) headers.authorization = `Bearer ${key}`;
        const ctl = new AbortController();
        const kill = setTimeout(() => ctl.abort(), 12_000);
        const res = await fetch(def.url, { headers, signal: ctl.signal });
        clearTimeout(kill);
        const json: any = await res.json().catch(() => null);
        let ids: string[] = [];
        if (Array.isArray(json?.data)) ids = json.data.map((m: any) => m.id || m.name).filter(Boolean);
        else if (Array.isArray(json?.models)) ids = json.models.map((m: any) => m.name || m.id).filter(Boolean);
        else if (Array.isArray(json)) ids = json.map((m: any) => m.name || m.id || m.model).filter(Boolean);
        out[name] = { ok: res.ok, status: res.status, count: ids.length, models: ids.slice(0, 60) };
      } catch (e: any) {
        out[name] = { ok: false, error: String(e?.message || e).slice(0, 120) };
      }
    }));
    return NextResponse.json({ ok: true, probe: 'models', at: new Date().toISOString(), lists: out });
  }
  const result = await runTick('manual');
  return NextResponse.json({ ok: true, ...result });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'bad-secret' }, { status: 401 });
  }
  let source: 'cron' | 'chain' | 'manual' = 'cron';
  try {
    const body: any = await req.json().catch(() => ({}));
    if (body?.source === 'chain' || body?.source === 'manual' || body?.source === 'cron') source = body.source;
  } catch { /* default cron */ }
  const result = await runTick(source);
  return NextResponse.json({ ok: true, ...result });
}
