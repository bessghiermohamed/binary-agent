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
