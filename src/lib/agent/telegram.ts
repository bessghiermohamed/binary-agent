// ─── Telegram helpers for the agent (buttons, callbacks, edits) ──────────────
import { AGENT } from './config';

// All agent messages go out through the agent's own bot (@gu_mo_bot).
const AGENT_TOKEN = () => AGENT.token;

async function tg(token: string, method: string, params: any = {}, timeoutMs = 15000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const j: any = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`tg.${method} -> ${j.error_code || res.status} ${j.description || ''}`);
    return j;
  } finally {
    clearTimeout(t);
  }
}

export async function sendTelegram(chatId: any, text: string, opts: { replyTo?: number } = {}): Promise<any> {
  try {
    const params: any = { chat_id: chatId, text: String(text).slice(0, 3800), disable_web_page_preview: true };
    if (opts.replyTo) params.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    await tg(AGENT_TOKEN(), 'sendMessage', params);
    return { ok: true };
  } catch (e: any) {
    console.error('[agent.tg] sendMessage failed:', e?.message);
    return { ok: false, error: e?.message?.slice(0, 140) };
  }
}

export async function sendTyping(chatId: any): Promise<void> {
  try {
    await tg(AGENT_TOKEN(), 'sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    /* non-critical */
  }
}

export async function sendApprovalButtons(
  chatId: any,
  approvalId: string,
  title: string,
  reason: string
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  try {
    const j = await tg(AGENT_TOKEN(), 'sendMessage', {
      chat_id: chatId,
      text: `⚠️ يحتاج قرارك\n\n${title}\n\nالسبب: ${reason}`.slice(0, 3500),
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ اعتماد', callback_data: `appr:${approvalId}:a` },
            { text: '❌ رفض', callback_data: `appr:${approvalId}:r` },
          ],
        ],
      },
    });
    return { ok: true, messageId: j?.result?.message_id };
  } catch (e: any) {
    return { ok: false, error: e?.message?.slice(0, 140) };
  }
}

export async function answerCallback(callbackId: string, text: string): Promise<void> {
  try {
    await tg(AGENT_TOKEN(), 'answerCallbackQuery', {
      callback_query_id: callbackId,
      text: text.slice(0, 190),
    });
  } catch {
    /* non-critical */
  }
}

export async function editMessage(chatId: any, messageId: number, text: string): Promise<void> {
  try {
    await tg(AGENT_TOKEN(), 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: String(text).slice(0, 3800),
      disable_web_page_preview: true,
    });
  } catch {
    /* non-critical */
  }
}
