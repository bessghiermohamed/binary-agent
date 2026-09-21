// Telegram door: messages (chat/commands/goals) + approval buttons.
import { NextResponse } from 'next/server';
import { AGENT_CONFIG } from '@/lib/agent/config';
import { handleChatMessage, handleCallback } from '@/lib/agent/brain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ ok: true, service: 'binary-agent', version: 1, time: new Date().toISOString() });
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!AGENT_CONFIG.webhookSecret || secret !== AGENT_CONFIG.webhookSecret) {
    return NextResponse.json({ ok: false, error: 'bad-secret' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    if (body?.callback_query) {
      const r = await handleCallback(body.callback_query);
      return NextResponse.json({ ok: true, ...r });
    }
    if (body?.message) {
      const r = await handleChatMessage(body.message);
      return NextResponse.json({ ok: true, ...r });
    }
    return NextResponse.json({ ok: true, skipped: 'unhandled-update' });
  } catch (e: any) {
    console.error('[agent.webhook] error:', e?.message);
    return NextResponse.json({ ok: true, error: 'internal' });
  }
}
