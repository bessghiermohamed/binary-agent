// ─── Tool belt — 12 tools, one call per tick, every call risk-classified ────
// Tools marked APPROVAL are intercepted before execution and queued for the
// owner; everything else executes inline within the tick's work budget.
//
// v3 fixes baked in here:
//  · schedule_task — correct Algeria wall-clock math (the "07:46" reminders
//    fired at the wrong instants before) + duplicate suppression.
//  · add_goal / update_goal — goal hygiene: no junk titles, no duplicates,
//    update_goal errors carry the live goal list so the LLM self-corrects.
//  · web_search — 7-backend fail-fast chain, tuned for Arabic queries.
//
// v4 fixes (Sept 2026 audit):
//  · web_search — 8th backend (Bing News RSS) + exported for the chat path,
//    so direct Telegram questions can carry fresh facts too.
//  · schedule_task — anti-obsession guard: refuses meta-reminders (a reminder
//    about a reminder) and refuses a 3rd pending task on the same topic. The
//    v3 agent burned 191/220 daily LLM calls scheduling "adjust the 7:46
//    reminder" reminders — this guard starves that loop at the tool level.

import { runInNewContext } from 'node:vm';
import { dzWallClockToEpoch, epochToWall, nextId } from './config';
import { Goal, Memory, appendInsight, saveGoals, findActiveGoalByTitle, isJunkTitle, normTitle } from './memory';
import { sendApprovalButtons, sendTelegram } from './telegram';
import { dispatchWorkflow, writeFile } from './github';
import { REPOS, SECRETS } from './config';

export type RiskClass = 'AUTO' | 'APPROVAL' | 'APPROVAL_PUBLIC';

export interface ToolDef {
  name: string;
  desc: string; // taught to the LLM
  argsHint: string;
  risk: RiskClass;
}

export const TOOLS: ToolDef[] = [
  { name: 'web_search', desc: 'بحث في الويب عن معلومات وأخبار (يدعم العربية). يعيد عناوين وروابط ومقتطفات.', argsHint: '{"query":"..."}', risk: 'AUTO' },
  { name: 'web_fetch', desc: 'جلب صفحة من رابط وقراءة نصها (يفضَّل بعد web_search).', argsHint: '{"url":"https://...","max_chars":7000}', risk: 'AUTO' },
  { name: 'run_code', desc: 'تنفيذ حسابات JavaScript في صندوق رملي معزول (بلا شبكة).', argsHint: '{"code":"return 2+2"}', risk: 'AUTO' },
  { name: 'http_request', desc: 'طلب HTTP مباشر (GET مباشرة؛ الطرق الأخرى تحتاج اعتماد المالك).', argsHint: '{"method":"GET","url":"https://..."}', risk: 'APPROVAL' },
  { name: 'github_op', desc: 'عمليات GitHub: إنشاء ملاحظة (gist)، أو ملف. الملفات داخل مستودع الذاكرة مباشرة؛ خارجها تحتاج اعتمادًا.', argsHint: '{"op":"gist|write_file","...":"..."}', risk: 'APPROVAL' },
  { name: 'send_message', desc: 'إرسال رسالة إلى المالك (نتائج، تحديثات، أسئلة).', argsHint: '{"text":"..."}', risk: 'AUTO' },
  { name: 'request_approval', desc: 'طلب قرار المالك لأمر خطر أو غير قابل للعكس.', argsHint: '{"title":"...","reason":"..."}', risk: 'AUTO' },
  { name: 'add_goal', desc: 'تبنّي هدف جديد (فقط إذا لم يوجد هدف مماثل نشط).', argsHint: '{"title":"...","description":"...","subtasks":["..."]}', risk: 'AUTO' },
  { name: 'update_goal', desc: 'تحديث هدف قائم: إتمام مهمة فرعية أو تغيير الحالة أو إرفاق نتيجة.', argsHint: '{"goal_id":"g_xxx","subtask_index":0,"status":"done","result":"..."}', risk: 'AUTO' },
  { name: 'remember', desc: 'تدوين درس دائم في الذاكرة طويلة الأمد.', argsHint: '{"text":"..."}', risk: 'AUTO' },
  { name: 'schedule_task', desc: 'جدولة تذكير أو متابعة لاحقة بتوقيت الجزائر.', argsHint: '{"what":"...","in_minutes":30} أو {"what":"...","at":"07:46"}', risk: 'AUTO' },
  { name: 'sleep', desc: 'إنهاء فترة العمل والنوم حتى المهمة المجدولة التالية.', argsHint: '{"minutes":45}', risk: 'AUTO' },
];

export const TOOL_MAP: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

export interface ToolResult { ok: boolean; summary: string; data?: unknown; queued?: ApprovalRequest }

export interface ApprovalRequest { tool: string; args: Record<string, unknown>; title: string; reason: string }

// ─── helpers ────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function fetchT(url: string, init?: RequestInit, ms = 10_000): Promise<Response> {
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: ctl.signal,
      headers: { 'user-agent': UA, 'accept-language': 'ar,en;q=0.8', ...(init?.headers || {}) },
    });
  } finally { clearTimeout(kill); }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function ssrfGuard(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return 'protocol must be http/https';
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
      /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) || host === '0.0.0.0' || host === 'metadata.google.internal' ||
      /^ fd/.test(host) || host.includes('::1') || host.startsWith('fe80:')
    ) return 'private/loopback hosts are blocked';
    if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return 'port blocked';
    return null;
  } catch {
    return 'invalid URL';
  }
}

// ─── web_search: 8-backend fail-fast chain ───────────────────────────────────
export interface Hit { title: string; url: string; snippet: string }

async function searchWikipedia(query: string): Promise<Hit[]> {
  try {
    const u = `https://ar.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5&origin=*`;
    const r = await fetchT(u, {}, 9_000);
    const j: any = await r.json();
    return (j?.query?.search || []).map((s: any) => ({
      title: String(s.title || ''),
      url: `https://ar.wikipedia.org/wiki/${encodeURIComponent(String(s.title || '').replace(/ /g, '_'))}`,
      snippet: stripHtml(String(s.snippet || '')).slice(0, 220),
    }));
  } catch { return []; }
}

async function searchDdgInstant(query: string): Promise<Hit[]> {
  try {
    const r = await fetchT(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {}, 9_000);
    const j: any = await r.json();
    const hits: Hit[] = [];
    if (j?.AbstractText) hits.push({ title: j.Heading || query, url: j.AbstractURL || '', snippet: String(j.AbstractText).slice(0, 300) });
    if (j?.Answer && !j.AbstractText) hits.push({ title: query, url: '', snippet: `الإجابة السريعة: ${String(j.Answer).slice(0, 300)}` });
    for (const t of (j?.RelatedTopics || []).slice(0, 4)) {
      if (t?.Text) hits.push({ title: String(t.Text).slice(0, 80), url: t?.FirstURL || '', snippet: String(t.Text).slice(0, 220) });
    }
    return hits;
  } catch { return []; }
}

function ddgUddg(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.toString();
  } catch { return href; }
}

async function searchDdgHtml(query: string): Promise<Hit[]> {
  try {
    const r = await fetchT(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {}, 10_000);
    const html = await r.text();
    const hits: Hit[] = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && hits.length < 6) {
      hits.push({ title: stripHtml(m[2]).slice(0, 120), url: ddgUddg(m[1]), snippet: '' });
    }
    return hits;
  } catch { return []; }
}

async function searchDdgLite(query: string): Promise<Hit[]> {
  try {
    // POST form — often less bot-walled (spec §8)
    const r = await fetchT('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(query)}`,
    }, 10_000);
    const html = await r.text();
    const hits: Hit[] = [];
    const re = /<a[^>]+href="([^"]+)"[^>]*class=.result-link.[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && hits.length < 6) {
      const url = ddgUddg(m[1]);
      if (url.startsWith('http')) hits.push({ title: stripHtml(m[2]).slice(0, 120), url, snippet: '' });
    }
    return hits;
  } catch { return []; }
}

async function searchGoogleNewsDz(query: string): Promise<Hit[]> {
  try {
    // pinned to Algeria / Arabic — the key fix for Arabic current-events (spec §8)
    const r = await fetchT(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ar&gl=DZ&ceid=DZ:ar`, {}, 10_000);
    const xml = await r.text();
    const hits: Hit[] = [];
    const re = /<item><title>([\s\S]*?)<\/title><link>([\s\S]*?)<\/link>(?:<description>([\s\S]*?)<\/description>)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) && hits.length < 6) {
      hits.push({ title: stripHtml(m[1]).slice(0, 140), url: m[2].trim(), snippet: m[3] ? stripHtml(m[3]).slice(0, 220) : '' });
    }
    return hits;
  } catch { return []; }
}

async function searchBingViaJina(query: string): Promise<Hit[]> {
  try {
    const r = await fetchT(`https://r.jina.ai/https://www.bing.com/search?q=${encodeURIComponent(query)}`, {}, 12_000);
    const text = await r.text();
    const hits: Hit[] = [];
    const re = /\[([^\]]{6,120})\]\((https?:\/\/[^)]+bing[^)]*|https?:\/\/[^)]{10,})\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && hits.length < 6) {
      const url = m[2];
      if (/bing\.com|microsoft\.com\/bing/.test(url)) continue;
      hits.push({ title: m[1].slice(0, 120), url, snippet: '' });
    }
    return hits;
  } catch { return []; }
}

async function searchBingNewsRss(query: string): Promise<Hit[]> {
  try {
    // second news RSS — different index than Google News, Arabic/DZ market
    const r = await fetchT(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&mkt=ar-DZ`, {}, 10_000);
    const xml = await r.text();
    const hits: Hit[] = [];
    const re = /<item><title>([\s\S]*?)<\/title><link>([\s\S]*?)<\/link>(?:<description>([\s\S]*?)<\/description>)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) && hits.length < 6) {
      hits.push({ title: stripHtml(m[1]).slice(0, 140), url: m[2].trim(), snippet: m[3] ? stripHtml(m[3]).slice(0, 220) : '' });
    }
    return hits;
  } catch { return []; }
}

async function searchMojeek(query: string): Promise<Hit[]> {
  try {
    const r = await fetchT(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, {}, 10_000);
    const html = await r.text();
    const hits: Hit[] = [];
    const re = /<a[^>]+class="title"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && hits.length < 6) {
      hits.push({ title: stripHtml(m[2]).slice(0, 120), url: m[1], snippet: '' });
    }
    return hits;
  } catch { return []; }
}

export async function webSearch(query: string): Promise<Hit[]> {
  const isArabic = /[\u0600-\u06FF]/.test(query);
  const backends = [
    ...(isArabic ? [searchWikipedia] : []),
    searchDdgInstant,
    searchDdgHtml,
    searchDdgLite,
    searchGoogleNewsDz,
    searchBingNewsRss,
    searchBingViaJina,
    searchMojeek,
  ];
  for (const backend of backends) {
    const hits = await backend(query);
    if (hits.length >= 2) return hits.slice(0, 6);
  }
  return [];
}

// ─── the executor ────────────────────────────────────────────────────────────
// brain.ts intercepts APPROVAL-risk calls before execTool; execTool itself
// executes AUTO-class tools only.
export async function execTool(m: Memory, tool: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const args = rawArgs || {};
  try {
    switch (tool) {
      case 'web_search': {
        const query = String(args.query || '').trim();
        if (!query) return { ok: false, summary: 'web_search: query مطلوب' };
        const hits = await webSearch(query);
        if (!hits.length) return { ok: false, summary: 'web_search: تعذّر البحث (كل المصادر محجوبة) — جرّب صياغة أخرى' };
        return {
          ok: true,
          summary: hits.map((h) => `• ${h.title} — ${h.url}${h.snippet ? ` — ${h.snippet}` : ''}`).join('\n').slice(0, 2200),
          data: hits,
        };
      }
      case 'web_fetch': {
        const url = String(args.url || '');
        const guard = ssrfGuard(url);
        if (guard) return { ok: false, summary: `web_fetch: ${guard}` };
        const maxChars = Math.min(Number(args.max_chars) || 7000, 12000);
        try {
          const r = await fetchT(url, {}, 12_000);
          const ct = r.headers.get('content-type') || '';
          const body = await r.text();
          if (ct.includes('json')) return { ok: true, summary: body.slice(0, maxChars) };
          const text = stripHtml(body);
          if (text.length < 80) throw new Error('thin content');
          return { ok: true, summary: text.slice(0, maxChars) };
        } catch {
          // r.jina.ai reader fallback (spec §8)
          try {
            const r2 = await fetchT(`https://r.jina.ai/${url}`, {}, 14_000);
            const t2 = (await r2.text()).slice(0, maxChars);
            if (t2.trim().length > 40) return { ok: true, summary: t2 };
            return { ok: false, summary: 'web_fetch: تعذّر قراءة الصفحة' };
          } catch {
            return { ok: false, summary: 'web_fetch: فشل الجلب' };
          }
        }
      }
      case 'run_code': {
        const code = String(args.code || '');
        if (!code.trim()) return { ok: false, summary: 'run_code: code مطلوب' };
        if (/\brequire\s*\(|\bprocess\b|\bimport\s*\(|fetch\s*\(|net\s*\./i.test(code)) {
          return { ok: false, summary: 'run_code: العمليات الشبكية أو النظامية ممنوعة — الحسابات فقط' };
        }
        try {
          const sandbox: Record<string, unknown> = { console: { log: () => {} }, Math, JSON, Date, Number, String, Array, Object };
          const result = runInNewContext(`(function(){ ${code} })()`, sandbox, { timeout: 2000 });
          return { ok: true, summary: `run_code → ${JSON.stringify(result ?? null).slice(0, 1500)}` };
        } catch (e: any) {
          return { ok: false, summary: `run_code خطأ: ${String(e?.message || e).slice(0, 300)}` };
        }
      }
      case 'http_request': {
        const url = String(args.url || '');
        const guard = ssrfGuard(url);
        if (guard) return { ok: false, summary: `http_request: ${guard}` };
        const r = await fetchT(url, { method: 'GET' }, 12_000);
        const body = (await r.text()).slice(0, 1500);
        return { ok: r.ok, summary: `HTTP ${r.status} — ${body.slice(0, 1200)}` };
      }
      case 'github_op': {
        const op = String(args.op || '');
        if (op === 'gist') {
          // public gists are approval-gated by the brain; reaching here means approved
          const content = String(args.content || '');
          const r = await fetch('https://api.github.com/gists', {
            method: 'POST',
            headers: { authorization: `Bearer ${SECRETS.ghToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ description: String(args.description || 'Binary Agent note'), public: false, files: { note: { content } } }),
          });
          const j: any = await r.json().catch(() => null);
          if (!r.ok) return { ok: false, summary: `gist: HTTP ${r.status}` };
          return { ok: true, summary: `gist created (secret): ${j?.id || ''}` };
        }
        if (op === 'write_file') {
          const path = String(args.path || '');
          const content = String(args.content || '');
          if (!path) return { ok: false, summary: 'write_file: path مطلوب' };
          const w = await writeFile(REPOS.memory, path, content, `agent note: ${path}`);
          return w.ok ? { ok: true, summary: `كُتب ${path} في مستودع الذاكرة` } : { ok: false, summary: `write_file فشل: ${w.error}` };
        }
        if (op === 'issue') {
          const r = await fetch(`https://api.github.com/repos/${REPOS.scheduler}/issues`, {
            method: 'POST',
            headers: { authorization: `Bearer ${SECRETS.ghToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ title: String(args.title || 'Agent issue'), body: String(args.body || '').slice(0, 4000) }),
          });
          const j: any = await r.json().catch(() => null);
          return r.ok ? { ok: true, summary: `issue #${j?.number} created` } : { ok: false, summary: `issue: HTTP ${r.status}` };
        }
        return { ok: false, summary: 'github_op: op غير معروف' };
      }
      case 'send_message': {
        const text = String(args.text || '').trim();
        const chatId = m.state.ownerChatId;
        if (!chatId) return { ok: false, summary: 'send_message: لا يوجد مالك مثبّت بعد' };
        const sent = await sendTelegram(chatId, text);
        return sent ? { ok: true, summary: `أُرسلت رسالة إلى المالك (${text.length} حرفًا)` } : { ok: false, summary: 'send_message: فشل الإرسال' };
      }
      case 'request_approval': {
        const chatId = m.state.ownerChatId;
        const id = nextId('appr');
        const req: ApprovalRequest = { tool: 'manual', args: {}, title: String(args.title || 'طلب اعتماد'), reason: String(args.reason || '') };
        if (!chatId) return { ok: false, summary: 'request_approval: لا يوجد مالك — رُفض الإجراء' };
        await sendApprovalButtons(chatId, req.title, req.reason, id);
        return { ok: true, summary: `أُرسل طلب اعتماد ${id} إلى المالك`, queued: { ...req, tool: 'noop', args: { note: req.reason } } };
      }
      case 'add_goal': {
        const title = String(args.title || '').trim();
        if (isJunkTitle(title)) return { ok: false, summary: 'add_goal: العنوان غير صالح — اكتب عنوانًا واضحًا بالعربية' };
        const dup = findActiveGoalByTitle(m.goals, title);
        if (dup) {
          return { ok: true, summary: `الهدف موجود أصلًا: ${dup.id} "${dup.title}" (الحالة: ${dup.status}) — لا حاجة لهدف جديد`, data: { goalId: dup.id } };
        }
        const activeCount = m.goals.filter((g) => g.status === 'active').length;
        if (activeCount >= 12) return { ok: false, summary: `add_goal: بلغنا الحد الأقصى (12 هدفًا نشطًا) — أكمل أو أغلق هدفًا أولًا` };
        const goal: Goal = {
          id: nextId('g'),
          title,
          description: String(args.description || '').slice(0, 500) || undefined,
          subtasks: (Array.isArray(args.subtasks) ? args.subtasks : []).slice(0, 12).map((s: unknown) => ({ title: String(s).slice(0, 200), done: false })),
          status: 'active',
          notes: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        m.goals.push(goal);
        const saved = await saveGoals(m, `goal added: ${title.slice(0, 40)}`);
        return saved
          ? { ok: true, summary: `أُضيف هدف ${goal.id} "${title}" (${goal.subtasks.length} مهمة فرعية)`, data: { goalId: goal.id } }
          : { ok: false, summary: 'add_goal: فشل الحفظ في GitHub' };
      }
      case 'update_goal': {
        const goal = m.goals.find((g) => g.id.toLowerCase() === String(args.goal_id || '').replace(/^#/, '').toLowerCase());
        if (!goal) {
          const live = m.goals.filter((g) => g.status === 'active').map((g) => `${g.id} "${g.title}"`).join(' | ') || 'لا أهداف نشطة';
          return { ok: false, summary: `update_goal: لا هدف بهذا المعرف. الأهداف النشطة الآن: ${live.slice(0, 700)}` };
        }
        if (args.subtask_index != null) {
          const idx = Number(args.subtask_index);
          if (!goal.subtasks[idx]) return { ok: false, summary: `update_goal: لا مهمة فرعية رقم ${idx} (الموجود: 0..${goal.subtasks.length - 1})` };
          goal.subtasks[idx].done = args.subtask_done === false ? false : true;
        }
        if (args.add_subtasks) {
          for (const s of (Array.isArray(args.add_subtasks) ? args.add_subtasks : []).slice(0, 6)) {
            if (goal.subtasks.length < 12) goal.subtasks.push({ title: String(s).slice(0, 200), done: false });
          }
        }
        if (args.status && ['active', 'waiting_approval', 'done', 'failed'].includes(String(args.status))) {
          goal.status = args.status as Goal['status'];
          if (args.status === 'done' || args.status === 'failed') {
            goal.result = String(args.result || goal.result || '').slice(0, 2000) || undefined;
            m.state.totals.goalsDone += args.status === 'done' ? 1 : 0;
            if (m.state.currentTask?.goalId === goal.id) m.state.currentTask = null;
          }
        } else if (args.result) {
          goal.result = String(args.result).slice(0, 2000);
        }
        if (args.note) goal.notes.push(String(args.note).slice(0, 300));
        goal.updatedAt = Date.now();
        const saved = await saveGoals(m, `goal updated: ${goal.id}`);
        const doneCount = goal.subtasks.filter((s) => s.done).length;
        return saved
          ? { ok: true, summary: `goal ${goal.id} "${goal.title}" → ${goal.status} (${doneCount}/${goal.subtasks.length} مهام)` }
          : { ok: false, summary: 'update_goal: فشل الحفظ' };
      }
      case 'remember': {
        const text = String(args.text || '').trim();
        if (!text) return { ok: false, summary: 'remember: text مطلوب' };
        await appendInsight(text.slice(0, 500));
        return { ok: true, summary: `دُوّن درس: ${text.slice(0, 120)}` };
      }
      case 'schedule_task': {
        const what = String(args.what || '').trim();
        if (!what) return { ok: false, summary: 'schedule_task: what مطلوب' };
        let dueAt = 0;
        if (args.at) {
          dueAt = dzWallClockToEpoch(String(args.at)) ?? 0;
          if (!dueAt) return { ok: false, summary: 'schedule_task: صيغة الوقت غير مفهومة — استخدم HH:MM أو YYYY-MM-DD HH:MM بتوقيت الجزائر' };
        } else if (args.in_minutes != null || args.in_minutes_or_seconds != null) {
          const n = Number(args.in_minutes ?? args.in_minutes_or_seconds ?? 30);
          // guard against the LLM emitting seconds by mistake
          const minutes = n > 0 && n < 90 ? n : Math.max(1, Math.round(n / 60));
          dueAt = Date.now() + minutes * 60_000;
        } else if (args.at_iso) {
          const t = Date.parse(String(args.at_iso));
          if (!Number.isFinite(t)) return { ok: false, summary: 'schedule_task: at_iso غير صالح' };
          dueAt = t;
        } else {
          dueAt = Date.now() + 30 * 60_000;
        }
        // duplicate suppression — same normalized what within 2-minute window
        const dup = m.state.scheduled.find((t) => Math.abs(t.dueAt - dueAt) < 120_000 && t.what.trim() === what);
        if (dup) return { ok: true, summary: `المهمة مجدولة أصلًا (${dup.id} عند ${epochToWall(dup.dueAt)})` };
        // v4 anti-obsession guards (Sept 2026 audit):
        // 1) never schedule a task whose purpose is managing another task —
        //    that is the exact shape of the 07:46 reminder loop.
        if (/تعديل\s*تذكير|ضبط\s*تذكير|تذكير[^.]{0,24}تذكير|تنبيه[^.]{0,24}تنبيه|متابعة\s*التذكير/.test(what)) {
          return { ok: false, summary: 'schedule_task: لا تُجدول مهمة لإدارة مهمة مجدولة — نفّذ التعديل فورًا أو انتظر موعدها' };
        }
        // 2) refuse a 3rd pending task on the same topic (word-overlap twin).
        const topicTwin = (a: string, b: string): boolean => {
          const na = normTitle(a), nb = normTitle(b);
          if (!na || !nb) return false;
          if (na.includes(nb) || nb.includes(na)) return true;
          const wa = new Set(na.split(/\s+/).filter((w) => w.length > 3));
          const wb = nb.split(/\s+/).filter((w) => w.length > 3);
          const shared = [...wa].filter((w) => wb.includes(w)).length;
          return wa.size > 0 && wb.length > 0 && shared / Math.min(wa.size, wb.length) >= 0.5;
        };
        const sameTopic = m.state.scheduled.filter((t) => topicTwin(t.what, what));
        if (sameTopic.length >= 2) {
          return { ok: false, summary: `schedule_task: أتابع هذا الموضوع بمهامّ مجدولة أصلًا (${sameTopic.map((t) => t.id).join('، ')}) — لن أضيف تتبعًا ثالثًا له` };
        }
        const task = { id: nextId('t'), what, dueAt, createdAt: Date.now(), goalId: m.state.currentTask?.goalId };
        m.state.scheduled.push(task);
        return { ok: true, summary: `جُدولت "${what}" عند ${epochToWall(dueAt)} بتوقيت الجزائر (${task.id})` };
      }
      case 'sleep': {
        const minutes = Math.max(5, Math.min(Number(args.minutes) || 45, 480));
        m.state.nextWakeAt = Date.now() + minutes * 60_000;
        m.state.chainCount = 0;
        return { ok: true, summary: `سأنام ${minutes} دقيقة حتى المهمة التالية` };
      }
      default:
        return { ok: false, summary: `أداة غير معروفة: ${tool}` };
    }
  } catch (e: any) {
    return { ok: false, summary: `${tool} خطأ: ${String(e?.message || e).slice(0, 250)}` };
  }
}

/** Chain fast-follow: dispatch the tick workflow (used by brain). */
export async function dispatchTick(source: 'chain' | 'manual' | 'cron'): Promise<{ ok: boolean; error?: string }> {
  if (!SECRETS.ghToken) return { ok: false, error: 'no gh token' };
  return dispatchWorkflow(REPOS.scheduler, 'agent-tick.yml', { source });
}
