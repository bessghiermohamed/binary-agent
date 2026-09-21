// POST /api/agent/webhook — Telegram updates, secret-guarded (spec §4).
// Header x-telegram-bot-api-secret-token must equal AGENT_WEBHOOK_SECRET.
// Handlers never throw to the client: internal errors are logged and
// returned as {ok:true, error:'internal'} so Telegram does not retry-storm.

import { NextRequest, NextResponse } from 'next/server';
import { SECRETS } from '@/lib/agent/config';
import { handleCallback, handleChatMessage } from '@/lib/agent/brain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({ ok: true, service: 'binary-agent', version: 2, time: new Date().toISOString() });
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!SECRETS.webhookSecret || secret !== SECRETS.webhookSecret) {
    return NextResponse.json({ ok: false, error: 'bad-secret' }, { status: 401 });
  }
  try {
    const update: any = await req.json();

    if (update?.callback_query) {
      const cb = update.callback_query;
      await handleCallback(cb.id, String(cb.message?.chat?.id || ''), String(cb.data || ''));
      return NextResponse.json({ ok: true, handled: 'callback' });
    }

    if (update?.message?.text) {
      const msg = update.message;
      await handleChatMessage(String(msg.chat.id), String(msg.from?.first_name || ''), String(msg.text));
      return NextResponse.json({ ok: true, handled: 'message' });
    }

    return NextResponse.json({ ok: true, handled: 'ignored' });
  } catch (e: any) {
    console.error('[webhook] internal:', String(e?.message || e).slice(0, 200));
    return NextResponse.json({ ok: true, error: 'internal' });
  }
}
