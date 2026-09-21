// ─── Telegram Bot API client ────────────────────────────────────────────────
// Webhook-driven. Approval cards carry Arabic inline buttons whose
// callback_data (appr:<id>:a / appr:<id>:r) routes the owner's decision back
// into the brain. Messages to humans are plain-text MSA — no markdown
// headers, no bullet spam (spec §2).

import { AGENT } from './config';

const BASE = () => `https://api.telegram.org/bot${AGENT.botToken}`;

async function tg(method: string, payload?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json: any = await res.json().catch(() => null);
  if (!json?.ok) {
    const desc = json?.description || `HTTP ${res.status}`;
    if (!/message is not modified|query is too old/i.test(String(desc))) {
      console.error(`[telegram.${method}]`, String(desc).slice(0, 120));
    }
  }
  return json;
}

export async function sendTelegram(chatId: string | number, text: string): Promise<boolean> {
  if (!AGENT.botToken || !chatId) return false;
  const msg = String(text || '').slice(0, 3900);
  const r = await tg('sendMessage', { chat_id: chatId, text: msg, disable_web_page_preview: true });
  return Boolean(r?.ok);
}

export async function sendTyping(chatId: string | number): Promise<void> {
  if (!AGENT.botToken || !chatId) return;
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => null);
}

/** Risk gate: Arabic approval card with inline buttons (spec §2). */
export async function sendApprovalButtons(
  chatId: string | number,
  title: string,
  reason: string,
  approvalId: string,
): Promise<boolean> {
  if (!AGENT.botToken || !chatId) return false;
  const r = await tg('sendMessage', {
    chat_id: chatId,
    text: `⚠️ يحتاج قرارك\n${String(title).slice(0, 300)}\n${String(reason).slice(0, 400)}`,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ اعتماد', callback_data: `appr:${approvalId}:a` },
        { text: '❌ رفض', callback_data: `appr:${approvalId}:r` },
      ]],
    },
  });
  return Boolean(r?.ok);
}

export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await tg('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) }).catch(() => null);
}

export async function setMyCommands(): Promise<void> {
  if (!AGENT.botToken) return;
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'يبدأ المحادثة' },
      { command: 'goals', description: 'يعرض الأهداف' },
      { command: 'status', description: 'حالة الوكيل والمزودات' },
      { command: 'stop', description: 'إيقاف مؤقت' },
      { command: 'resume', description: 'استئناف' },
      { command: 'ping', description: 'فحص الحياة' },
    ],
  });
}

export async function setBranding(): Promise<void> {
  if (!AGENT.botToken) return;
  await Promise.all([
    tg('setMyName', { name: 'بيناري Binary' }).catch(() => null),
    tg('setMyDescription', { description: 'وكيل ذكي مستقل — يتحدث العربية الفصحى ويعمل على أهدافه بين رسائلك.' }).catch(() => null),
  ]);
}

export async function getWebhookInfo(): Promise<any> {
  if (!AGENT.botToken) return null;
  const r = await tg('getWebhookInfo');
  return r?.result || null;
}
