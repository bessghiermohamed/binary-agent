// ─── Binary's tools — what the agent can actually DO ──────────────────────────
// Free/open stack only: direct HTTP, DuckDuckGo search, node:vm sandbox,
// GitHub (gists/files/issues), Telegram, and its own memory.
// Every tool: pure function in, structured result out. Risky ones are gated.

import vm from 'node:vm';
import { createGist, createIssue, writeFile as ghWriteFile, dispatchWorkflow } from './github';
import { AGENT_CONFIG } from './config';

// ─── SSRF guard ──────────────────────────────────────────────────────────────
const BLOCKED_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$)/i;

function guardUrl(u: string): { url: URL | null; error?: string } {
  try {
    const url = new URL(String(u));
    if (!/^https?:$/.test(url.protocol)) return { url: null, error: 'only http/https allowed' };
    if (BLOCKED_HOST.test(url.hostname)) return { url: null, error: 'private network addresses are blocked' };
    return { url };
  } catch {
    return { url: null, error: 'invalid URL' };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function timedFetch(url: string, init: any, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── individual tools ────────────────────────────────────────────────────────

async function toolWebFetch(args: any): Promise<any> {
  const g = guardUrl(args?.url);
  if (!g.url) return { ok: false, error: g.error };
  try {
    const res = await timedFetch(
      g.url.toString(),
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BinaryAgent/1.0)', accept: 'text/html,application/json,text/plain,*/*' } },
      14000
    );
    const ctype = res.headers.get('content-type') || '';
    const raw = await res.text();
    const text = ctype.includes('html') ? stripHtml(raw) : raw;
    const looksBlocked = [403, 429, 503].includes(res.status) || (text.length < 300 && /captcha|verify|robot/i.test(raw));
    if (looksBlocked) throw new Error(`direct fetch blocked (HTTP ${res.status})`);
    return { ok: res.ok, status: res.status, url: g.url.toString(), content: text.slice(0, Number(args?.max_chars) || 7000) };
  } catch (e: any) {
    // fallback: r.jina.ai reader proxy (free tier, returns clean markdown)
    try {
      const res = await timedFetch(
        `https://r.jina.ai/${g.url.toString()}`,
        { headers: { 'user-agent': 'BinaryAgent/1.0' } },
        22000
      );
      if (!res.ok) return { ok: false, error: `direct: ${e?.message}; jina proxy: HTTP ${res.status}` };
      const md = await res.text();
      return { ok: true, url: g.url.toString(), via: 'jina-proxy', content: md.slice(0, Number(args?.max_chars) || 7000) };
    } catch (e2: any) {
      return { ok: false, error: `direct: ${String(e?.message || e).slice(0, 120)}; jina proxy: ${String(e2?.message || e2).slice(0, 120)}` };
    }
  }
}

function decodeDdgHref(href: string): string {
  try {
    if (href.startsWith('//')) href = 'https:' + href;
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.toString();
  } catch {
    return href;
  }
}

// ─── search backends (tried in order, all free, no keys) ────────────────────

async function searchWikipediaLang(lang: string, q: string): Promise<any[]> {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srlimit=6&srsearch=${encodeURIComponent(q)}&format=json&origin=*`;
  const res = await timedFetch(url, { headers: { 'user-agent': 'BinaryAgent/1.0 (autonomous agent; https://github.com/bessghiermohamed/binary-agent)' } }, 10000);
  if (!res.ok) throw new Error(`wiki-${lang} ${res.status}`);
  const j: any = await res.json();
  const hits = j?.query?.search || [];
  if (!hits.length) throw new Error(`wiki-${lang} empty`);
  return hits.map((r: any) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_'))}`,
    snippet: stripHtml(r.snippet || '').slice(0, 220),
  }));
}

/** Google News RSS — reliable, no bot-wall, great for current/Arabic content. */
async function searchGoogleNews(q: string): Promise<any[]> {
  const loc = /[\u0600-\u06FF]/.test(q) ? 'hl=ar&gl=DZ&ceid=DZ:ar' : 'hl=en-US&gl=US&ceid=US:en';
  const res = await timedFetch(`https://news.google.com/rss/search?${loc}&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'BinaryAgent/1.0' } }, 10000);
  if (!res.ok) throw new Error(`gnews ${res.status}`);
  const xml = (await res.text()).replace(/<!\[CDATA\[|\]\]>/g, '');
  const out: any[] = [];
  const re = /<item>\s*<title>([\s\S]*?)<\/title>\s*<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < 8) {
    out.push({ title: stripHtml(m[1]).slice(0, 140), url: m[2].trim(), snippet: stripHtml(m[3]).slice(0, 160) });
  }
  if (!out.length) throw new Error('gnews no items');
  return out;
}

/** DDG lite — POST endpoint, often less bot-walled than html.duckduckgo.com. */
async function searchDdgLite(q: string): Promise<any[]> {
  const res = await timedFetch(
    'https://lite.duckduckgo.com/lite/',
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, body: `q=${encodeURIComponent(q)}` },
    12000
  );
  if (!res.ok) throw new Error(`ddg-lite ${res.status}`);
  const html = await res.text();
  const results: any[] = [];
  const re = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < 8) {
    results.push({ title: stripHtml(m[2]).slice(0, 120), url: decodeDdgHref(m[1]), snippet: '' });
  }
  if (!results.length) throw new Error('ddg-lite no results (likely bot-walled)');
  return results;
}

async function searchDdgInstant(q: string): Promise<any[]> {
  const res = await timedFetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1`, { headers: { 'user-agent': 'BinaryAgent/1.0' } }, 9000);
  if (!res.ok) throw new Error(`ddg-instant ${res.status}`);
  const j: any = await res.json();
  const out: any[] = [];
  if (j?.AbstractText && j?.AbstractURL) out.push({ title: j.Heading || q, url: j.AbstractURL, snippet: String(j.AbstractText).slice(0, 220) });
  for (const rt of (j?.RelatedTopics || []).slice(0, 6)) {
    if (rt?.FirstURL) out.push({ title: String(rt.Text || '').split(' - ')[0].slice(0, 120), url: rt.FirstURL, snippet: String(rt.Text || '').slice(0, 220) });
  }
  if (!out.length) throw new Error('ddg-instant empty');
  return out;
}

async function searchDdgHtml(q: string): Promise<any[]> {
  const res = await timedFetch(
    'https://html.duckduckgo.com/html/',
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, body: `q=${encodeURIComponent(q)}` },
    12000
  );
  if (!res.ok) throw new Error(`ddg-html ${res.status}`);
  const html = await res.text();
  const results: any[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < 8) {
    results.push({ title: stripHtml(m[2]).slice(0, 120), url: decodeDdgHref(m[1]), snippet: m[3] ? stripHtml(m[3]).slice(0, 220) : '' });
  }
  if (!results.length) throw new Error('ddg-html no results (likely bot-walled)');
  return results;
}

async function searchJinaBing(q: string): Promise<any[]> {
  const res = await timedFetch(
    `https://r.jina.ai/https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10`,
    { headers: { 'user-agent': 'BinaryAgent/1.0' } },
    24000
  );
  if (!res.ok) throw new Error(`jina-bing ${res.status}`);
  const md = await res.text();
  const out: any[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]]{4,120})\]\((https?:\/\/[^\)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) && out.length < 8) {
    const url = m[2];
    if (/bing\.com|microsoft\.com\/en-us\/bing|jina\.ai|go\.microsoft/.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: m[1].trim().slice(0, 120), url, snippet: '' });
  }
  if (!out.length) throw new Error('jina-bing no links parsed');
  return out;
}

async function searchMojeek(q: string): Promise<any[]> {
  const res = await timedFetch(`https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BinaryAgent/1.0)' } }, 10000);
  if (!res.ok) throw new Error(`mojeek ${res.status}`);
  const html = await res.text();
  const out: any[] = [];
  const re = /<a[^>]+class="title[^"]*"[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 8) {
    out.push({ title: stripHtml(m[2]).slice(0, 120), url: m[1], snippet: '' });
  }
  if (!out.length) throw new Error('mojeek no results parsed');
  return out;
}

async function toolWebSearch(args: any): Promise<any> {
  const q = String(args?.query || '').slice(0, 300);
  if (!q) return { ok: false, error: 'query required' };
  const attempts: string[] = [];
  const hasArabic = /[\u0600-\u06FF]/.test(q);
  const backends: [string, (query: string) => Promise<any[]>][] = [];
  if (hasArabic) backends.push(['wikipedia-ar', (x) => searchWikipediaLang('ar', x)]);
  backends.push(
    ['wikipedia-en', (x) => searchWikipediaLang('en', x)],
    ['gnews', searchGoogleNews],
    ['ddg-lite', searchDdgLite],
    ['ddg-instant', searchDdgInstant],
    ['ddg-html', searchDdgHtml],
    ['jina-bing', searchJinaBing],
    ['mojeek', searchMojeek]
  );
  for (const [name, fn] of backends) {
    try {
      const results = await fn(q);
      if (results.length) return { ok: true, backend: name, query: q, results };
      attempts.push(`${name}: empty`);
    } catch (e: any) {
      attempts.push(`${name}: ${String(e?.message || e).slice(0, 60)}`);
    }
  }
  return { ok: false, error: `all search backends failed — ${attempts.join(' | ')}` };
}

async function toolRunCode(args: any): Promise<any> {
  const code = String(args?.code || '');
  if (!code.trim()) return { ok: false, error: 'code required' };
  if (code.length > 8000) return { ok: false, error: 'code too long (max 8000 chars)' };
  const timeoutMs = Math.min(Number(args?.timeout_ms) || 6000, 6000);
  const logs: string[] = [];
  const sandbox: any = {
    console: {
      log: (...a: any[]) => logs.push(a.map((x) => safeStr(x)).join(' ').slice(0, 400)),
    },
    Math,
    JSON,
    Date,
    RegExp,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Intl,
  };
  try {
    const result = vm.runInNewContext(code, sandbox, { timeout: timeoutMs, displayErrors: true });
    return { ok: true, result: safeStr(result).slice(0, 3000), logs: logs.slice(0, 20) };
  } catch (e: any) {
    return { ok: false, error: `${String(e?.message || e).slice(0, 300)}`, logs: logs.slice(0, 20) };
  }
}

function safeStr(x: any): string {
  try {
    if (typeof x === 'string') return x.slice(0, 500);
    if (x === undefined) return 'undefined';
    return JSON.stringify(x)?.slice(0, 500) ?? String(x);
  } catch {
    return String(x).slice(0, 200);
  }
}

async function toolHttpRequest(args: any): Promise<any> {
  const g = guardUrl(args?.url);
  if (!g.url) return { ok: false, error: g.error };
  const method = String(args?.method || 'GET').toUpperCase();
  try {
    const res = await timedFetch(
      g.url.toString(),
      {
        method,
        headers: { 'user-agent': 'BinaryAgent/1.0', ...(args?.headers || {}) },
        body: args?.body != null ? (typeof args.body === 'string' ? args.body : JSON.stringify(args.body)) : undefined,
      },
      14000
    );
    const text = await res.text();
    return { ok: res.ok, status: res.status, content: text.slice(0, 6000) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function toolGithubOp(args: any): Promise<any> {
  const token = AGENT_CONFIG.ghToken;
  if (!token) return { ok: false, error: 'no AGENT_GH_TOKEN configured' };
  const op = String(args?.op || '');
  const memRepo = AGENT_CONFIG.memoryRepo;
  if (op === 'gist') {
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries(args?.files || {})) files[String(name).slice(0, 60)] = String(content).slice(0, 40000);
    if (!Object.keys(files).length) return { ok: false, error: 'files required' };
    const r = await createGist(token, files, String(args?.description || 'from Binary'), !!args?.public);
    return r.ok ? { ok: true, url: r.url } : { ok: false, error: r.error };
  }
  if (op === 'write_file') {
    const repo = String(args?.repo || memRepo);
    if (!/\//.test(repo)) return { ok: false, error: 'repo must be owner/name' };
    return ghWriteFile(token, repo, String(args?.path || ''), String(args?.content || ''), `murad-agent: ${String(args?.message || 'write')}`);
  }
  if (op === 'issue') {
    const repo = String(args?.repo || AGENT_CONFIG.schedulerRepo);
    if (!/\//.test(repo)) return { ok: false, error: 'repo must be owner/name' };
    return createIssue(token, repo, String(args?.title || 'note'), String(args?.body || ''));
  }
  return { ok: false, error: `unknown github op: ${op} (use gist | write_file | issue)` };
}

async function toolDispatchTick(args: any): Promise<any> {
  const token = AGENT_CONFIG.ghToken;
  if (!token) return { ok: false, error: 'no AGENT_GH_TOKEN configured' };
  const r = await dispatchWorkflow(token, AGENT_CONFIG.schedulerRepo, 'agent-tick.yml', {
    source: String(args?.source || 'chain'),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// ─── registry ────────────────────────────────────────────────────────────────
// `local` tools mutate memory and are executed by brain.ts (they need the
// memory bundle). Here: pure/external tools only.

export interface ToolCtx {
  ownerChatId: string;
  goalId?: string;
}

export interface ToolDef {
  name: string;
  desc: string;
  args: string; // compact schema hint for the prompt
  risky?: (args: any) => true | string; // true = always approve; string = reason
}

export const TOOLS: ToolDef[] = [
  { name: 'web_search', desc: 'Search the web (DuckDuckGo) and get titles/URLs/snippets.', args: '{query}' },
  { name: 'web_fetch', desc: 'Fetch a URL and get readable text (HTML stripped, JSON as-is).', args: '{url, max_chars?}' },
  {
    name: 'run_code',
    desc: 'Run pure JavaScript (node vm sandbox, no network/timers/fs) for math, parsing, text processing. Last expression is the result.',
    args: '{code, timeout_ms?}',
  },
  {
    name: 'http_request',
    desc: 'Raw HTTP request to any public API (GET is free to use; any other method needs owner approval).',
    args: '{method, url, headers?, body?}',
    risky: (a) => String(a?.method || 'GET').toUpperCase() !== 'GET' && 'non-GET request changes things on an external service',
  },
  {
    name: 'github_op',
    desc: 'GitHub actions: create a gist (share code/files), write a file into a repo (own memory repo by default; other repos need approval), open an issue.',
    args: "{op: 'gist'|'write_file'|'issue', files?|repo?+path?+content?, title?, body?}",
    risky: (a) =>
      (a?.op === 'write_file' && a?.repo && a.repo !== AGENT_CONFIG.memoryRepo && 'writing into a repo other than my memory') ||
      (a?.op === 'issue' && a?.repo && a.repo !== AGENT_CONFIG.schedulerRepo && 'opening an issue on an external repo') ||
      (a?.op === 'gist' && a?.public && 'making content public on the internet'),
  },
  { name: 'send_message', desc: 'Send a Telegram message to the owner. Use for updates, questions, results, or just talking.', args: '{text}' },
  {
    name: 'request_approval',
    desc: 'Ask the owner to approve an action you consider risky or expensive. Work pauses until they decide.',
    args: '{tool, args(object), reason}',
  },
  { name: 'add_goal', desc: 'Adopt a new goal (from owner requests or your own initiative).', args: '{title, description?, subtasks?(string[])}' },
  {
    name: 'update_goal',
    desc: 'Update a goal: mark progress, tick a subtask done, add a note, or finish/fail/block it.',
    args: '{goal_id, status?(!active|!blocked|!waiting_approval|!done|!failed|!cancelled), check_subtask?(id), add_subtasks?(string[]), add_note?, result?}',
  },
  { name: 'remember', desc: 'Save a durable lesson or fact to long-term memory (survives restarts, shapes future behavior).', args: '{text}' },
  { name: 'schedule_task', desc: 'Schedule a future check (reminder, follow-up, monitoring). Fires on a later tick.', args: '{what, in_minutes?, at_iso?}' },
  { name: 'sleep', desc: 'Go idle for N minutes (end work period, wait for next scheduled wake).', args: '{minutes?}' },
];

export const TOOL_MAP: Record<string, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Execute an external/pure tool. Local (memory-touching) ones return marker. */
export async function execTool(name: string, args: any, ctx: ToolCtx): Promise<any> {
  switch (name) {
    case 'web_search':
      return toolWebSearch(args);
    case 'web_fetch':
      return toolWebFetch(args);
    case 'run_code':
      return toolRunCode(args);
    case 'http_request':
      return toolHttpRequest(args);
    case 'github_op':
      return toolGithubOp(args);
    case 'dispatch_tick':
      return toolDispatchTick(args);
    case 'send_message': {
      const { sendTelegram } = await import('./telegram');
      const chatId = args?.chat_id || ctx.ownerChatId;
      if (!chatId) return { ok: false, error: 'no known chat to message (owner not pinned yet)' };
      const r = await sendTelegram(chatId, String(args?.text || '').slice(0, 3800));
      return r;
    }
    default:
      return { __local__: true }; // add_goal, update_goal, remember, schedule_task, sleep, request_approval
  }
}

/** Human-readable summary of tool args for logs/episodes. */
export function describeArgs(args: any): string {
  try {
    const s = JSON.stringify(args);
    return (s || '').length > 160 ? s.slice(0, 157) + '…' : s || '{}';
  } catch {
    return '{}';
  }
}
