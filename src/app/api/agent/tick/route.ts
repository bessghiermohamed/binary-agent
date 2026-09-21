// Autonomous tick — fired by GitHub Actions (every 5 min), self-dispatched
// chains, or manually. Auth: x-agent-secret header or ?key= param.
import { NextResponse } from 'next/server';
import { AGENT_CONFIG } from '@/lib/agent/config';
import { runTick } from '@/lib/agent/brain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!AGENT_CONFIG.tickSecret || key !== AGENT_CONFIG.tickSecret) {
    return NextResponse.json({ ok: false, error: 'bad-key' }, { status: 401 });
  }
  const result = await runTick(url.searchParams.get('source') || 'cron');
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-agent-secret');
  if (!AGENT_CONFIG.tickSecret || secret !== AGENT_CONFIG.tickSecret) {
    return NextResponse.json({ ok: false, error: 'bad-secret' }, { status: 401 });
  }
  let source = 'cron';
  try {
    const body: any = await req.json();
    if (body?.source) source = String(body.source);
  } catch {
    /* no body is fine */
  }
  const result = await runTick(source);
  return NextResponse.json(result);
}
