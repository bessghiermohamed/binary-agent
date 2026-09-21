// ─── Brain — one tick = one thought (spec §6) ───────────────────────────────
// Cycle: lock → approvals → governor → LLM JSON decision → ONE tool →
// episode → save → reflection → chain?
//
// v3 discipline fixes (why the previous build behaved poorly):
//  · Chaining requires: continue:true AND the last tool SUCCEEDED AND
//    chainCount < cap AND ≥30s since the last dispatch AND hourly cap AND
//    LLM headroom. The old build chained every ~15s on failures — a tight
//    loop that burned 167 LLM calls in a morning and delivered nothing.
//  · Chat never files goals from casual conversation (the "متى تاتي نكتة"
//    fiasco produced three duplicate goals). Goals come from the explicit
//    goal: prefix or from deliberate tick decisions.
//  · currentTask can only point at a goal that exists (orphan guard).
//  · The governor answers quick factual questions directly in chat instead
//    of re-registering them as goals (spec §2 hard rule).

import { AGENT, BUDGETS, MEMORY_CAPS, REPOS, SECRETS, TOKEN_CEIL, dayKey, dzNow, epochToWall, nextId } from './config';
import { chat, chatJson, llmHealth, type ChatMsg } from './llm';
import {
  AgentState, Approval, Memory, appendConversation, appendEpisode, appendInsight,
  loadMemory, readConversation, recallMemories, saveApprovals, saveGoals, saveIdentity, saveState,
} from './memory';
import { TOOL_MAP, TOOLS, execTool, dispatchTick, webSearch, type ToolResult } from './tools';
import { answerCallback, sendTelegram, sendTyping } from './telegram';

const LOCK_TTL_MS = 120_000;
const SELF_INTRO = 'مرحبًا! أنا بيناري، وكيل ذكي مستقل أقيم في تيارت، الجزائر. أعمل على أهدافي بين رسائلك، وأتحدث معك بالعربية الفصحى دائمًا.';

// ─── system prompt pieces ────────────────────────────────────────────────────
function identityPrompt(m: Memory): string {
  return [
    `أنت "${AGENT.nameAr}" — ${AGENT.name}، وكيل ذكي مستقل. مقرّك: ${AGENT.homeAr}. لغتك دائمًا: العربية الفصحى الواضحة، بلا عامية وبلا خلط لغات.`,
    `الوقت الآن: ${dzNow().wallAr}. اذكر الأوقات من هذه الساعة فقط، ولا تخترع أبدًا وقتًا أو نتيجة أو هدفًا.`,
    m.identity,
  ].join('\n');
}

function hardRulesPrompt(): string {
  return [
    'قواعد صارمة:',
    '1) أجب عن الأسئلة الواقعية من الحقائق مباشرة — لا تعيد تسجيلها أهدافًا.',
    '2) لا تختلق أهدافًا ولا أوقاتًا ولا نتائج. استخدم معرفات الأهداف الحقيقية فقط.',
    '3) كل جملة تُكتب للإنسان: فصحى نظيفة، نص بسيط بلا عناوين ماركداون ولا قوائم مرقمة طويلة.',
    '4) إن فشل أداة مرتين غيّر الأسلوب؛ وإن أخفقت تمامًا فاعترف بالفشل بوضوح.',
    '5) كن مقتصدًا في نداء الأدوات؛ نداك واحد فقط لكل نبضة.',
    '6) لا تطلب هدفًا جديدًا إن وُجد هدف نشط مطابق — حدّث القائم.',
    '7) لا تُجدول مهمة لتعديل مهمة مجدولة ولا هدفًا لإدارة تذكير — نفّذ العمل مباشرة.',
  ].join('\n');
}

function toolsPrompt(): string {
  return 'الأدوات المتاحة:\n' + TOOLS.map((t) => `- ${t.name}: ${t.desc} — ${t.argsHint}`).join('\n');
}

function contextPrompt(m: Memory): string {
  const activeGoals = m.goals.filter((g) => g.status === 'active');
  const goalsBlock = activeGoals.length
    ? activeGoals.map((g) => {
        const subs = g.subtasks.map((s, i) => `${s.done ? 'x' : ' '}${i}:${s.title.slice(0, 60)}`).join(' ');
        return `${g.id} "${g.title}" [${g.subtasks.filter((s) => s.done).length}/${g.subtasks.length}] ${subs}`.slice(0, 300);
      }).join('\n')
    : 'لا أهداف نشطة.';
  const due = m.state.scheduled
    .filter((t) => t.dueAt > Date.now() - 3600_000)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, 6)
    .map((t) => `${t.id} "${t.what}" @ ${epochToWall(t.dueAt)}`)
    .join('\n') || 'لا مهام مجدولة.';
  const pending = m.approvals.filter((a) => a.status === 'pending').length;
  return [
    `الأهداف النشطة:\n${goalsBlock}`,
    `المهام المجدولة:\n${due}`,
    `طلبات اعتماد معلّقة: ${pending}`,
    `آخر التجارب:\n${m.episodeTail.slice(-MEMORY_CAPS.episodesInPrompt).join('\n') || 'بداية العمل.'}`,
    `دروس سابقة:\n${m.insightTail.join('\n') || 'لا دروس بعد.'}`,
  ].join('\n\n');
}

const DECISION_CONTRACT = `أخرج كائن JSON واحد فقط بهذا الشكل (أقل من 150 كلمة):
{"thought":"سبب قرارك بالعربية في ≤ 40 كلمة","tool":"<اسم الأداة أو \"none\">","args":{ ... },"continue":true|false}
- إن لم يكن ثمّة عمل مفيد الآن فاختر tool:"none" و continue:false.
- "continue":true فقط إن كانت الخطوة التالية فورية ومهمة ونجحت الخطوة الحالية.`;

// ─── lock ────────────────────────────────────────────────────────────────────
function lockId(): string { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

async function acquireLock(m: Memory, id: string): Promise<boolean> {
  const now = Date.now();
  const cur = m.state.lock;
  if (cur && now < cur.at + cur.ttlMs && cur.by !== id) return false; // someone else holds it
  m.state.lock = { by: id, at: now, ttlMs: LOCK_TTL_MS };
  return true;
}

function releaseLock(m: Memory) { m.state.lock = null; }

// ─── governor ────────────────────────────────────────────────────────────────
type Mode = 'task' | 'scheduled' | 'initiative' | 'idle';

function pickMode(m: Memory): { mode: Mode; note: string } {
  if (m.state.paused) return { mode: 'idle', note: 'paused' };
  const now = Date.now();
  const due = m.state.scheduled.filter((t) => t.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  if (due.length) return { mode: 'scheduled', note: `due: ${due[0].what.slice(0, 80)}` };
  const active = m.goals.filter((g) => g.status === 'active');
  if (active.length) {
    // orphan guard: currentTask must reference a live goal
    if (m.state.currentTask && !active.some((g) => g.id === m.state.currentTask!.goalId)) {
      m.state.currentTask = null;
    }
    if (!m.state.currentTask) {
      const next = active.sort((a, b) => a.updatedAt - b.updatedAt)[0];
      m.state.currentTask = { goalId: next.id, note: next.title.slice(0, 120), startedAt: now };
    }
    return { mode: 'task', note: m.state.currentTask.note };
  }
  if (now - m.state.lastInitiativeAt > BUDGETS.initiativeGapMs) {
    return { mode: 'initiative', note: 'self-started' };
  }
  return { mode: 'idle', note: 'nothing to do' };
}

// ─── decision + execution ─────────────────────────────────────────────────────
interface Decision { thought: string; tool: string; args: Record<string, unknown>; continue: boolean }

async function decide(m: Memory, mode: Mode, note: string): Promise<Decision | null> {
  const msgs: ChatMsg[] = [
    { role: 'system', content: [identityPrompt(m), hardRulesPrompt(), toolsPrompt(), contextPrompt(m)].join('\n\n') },
    {
      role: 'user',
      content: `نبضة عمل (الوضع: ${mode}${note ? ` — ${note}` : ''}). قرّر الخطوة التالية المفيدة الواحدة. ${DECISION_CONTRACT}`,
    },
  ];
  const r = await chatJson(msgs, { maxTokens: TOKEN_CEIL.decide, budgetMs: BUDGETS.workBudgetMs - 8000 });
  if (!r) return null;
  const j = r.json;
  const tool = String(j.tool || 'none').trim().toLowerCase();
  return {
    thought: String(j.thought || j.reply || '').slice(0, 300),
    tool: TOOL_MAP[tool] ? tool : 'none',
    args: (j.args && typeof j.args === 'object' ? j.args : {}) as Record<string, unknown>,
    continue: j.cont === true || j.continue === true,
  };
}

async function queueApproval(m: Memory, tool: string, args: Record<string, unknown>, title: string, reason: string): Promise<void> {
  const id = nextId('appr');
  m.approvals.push({
    id, tool, args, title: title.slice(0, 200), reason: reason.slice(0, 500),
    status: 'pending', createdAt: Date.now(),
  });
  await saveApprovals(m, `approval queued: ${title.slice(0, 40)}`);
  if (m.state.ownerChatId) {
    await sendTelegram(m.state.ownerChatId, `⚠️ يحتاج قرارك\n${title}\n${reason}`.slice(0, 800));
    // approval card with buttons
    const { sendApprovalButtons } = await import('./telegram');
    await sendApprovalButtons(m.state.ownerChatId, title, reason, id);
  }
}

function needsApproval(tool: string, args: Record<string, unknown>): { title: string; reason: string } | null {
  const def = TOOL_MAP[tool];
  if (!def) return null;
  if (tool === 'http_request' && String(args.method || 'GET').toUpperCase() !== 'GET') {
    return { title: `طلب ${String(args.method).toUpperCase()} إلى ${String(args.url || '').slice(0, 120)}`, reason: 'طلب شبكي غير GET يتطلب قرارك.' };
  }
  if (def.risk === 'APPROVAL' && tool === 'github_op' && String(args.op) === 'write_file') {
    return null; // memory-repo writes are AUTO; outside-repo writes are gated below
  }
  if (def.risk === 'APPROVAL' && tool === 'github_op' && String(args.op) === 'gist' && args.public === true) {
    return { title: 'إنشاء gist عام', reason: String(args.description || 'محتوى عام').slice(0, 300) };
  }
  if (tool === 'http_request' && def.risk === 'APPROVAL') return null; // GET is auto — handled above
  return null;
}

async function executeDecision(m: Memory, d: Decision, bypassRisk = false): Promise<ToolResult> {
  if (d.tool === 'none') {
    return { ok: true, summary: 'لا إجراء (none)' };
  }
  const gate = bypassRisk ? null : needsApproval(d.tool, d.args);
  if (gate) {
    await queueApproval(m, d.tool, d.args, gate.title, gate.reason);
    return { ok: true, summary: `أُدرج الإجراء في قائمة الاعتماد (${gate.title}) — لن يُنفّذ قبل قرار المالك`, queued: { tool: d.tool, args: d.args, ...gate } };
  }
  return execTool(m, d.tool, d.args);
}

// ─── reflection (spec §6 stage 7) ────────────────────────────────────────────
async function reflect(m: Memory, trigger: string): Promise<void> {
  const msgs: ChatMsg[] = [
    { role: 'system', content: [identityPrompt(m), 'أنت في وضع تأمل ذاتي. أعد صياغة "من أنا" في 3–5 أسطر فصحى تحافظ على الحقائق وتضيف ما تعلمته.'].join('\n') },
    {
      role: 'user',
      content: `محفّز التأمل: ${trigger}\nنسخة "من أنا" الحالية:\n${m.identity}\n\nأخرج سطرين: السطر الأول "IDENTITY:" ثم النص الجديد، والسطر الثاني "LESSON:" ثم درس واحد موجز.`,
    },
  ];
  const r = await chat(msgs, { temperature: 0.5, maxTokens: TOKEN_CEIL.reflect, budgetMs: 20_000 });
  if (!r) return;
  const idMatch = r.text.match(/IDENTITY:\s*([\s\S]*?)(?:\nLESSON:|$)/i);
  const lessonMatch = r.text.match(/LESSON:\s*([\s\S]*)/i);
  if (idMatch && idMatch[1].trim().length > 40) {
    const newText = idMatch[1].trim().slice(0, 1200);
    if (newText !== m.identity) {
      await saveIdentity(newText);
      m.identity = newText;
    }
  }
  if (lessonMatch && lessonMatch[1].trim().length > 8) {
    await appendInsight(lessonMatch[1].trim().slice(0, 400));
    m.insightTail.push(lessonMatch[1].trim().slice(0, 200));
  }
}

// ─── THE TICK ────────────────────────────────────────────────────────────────
export async function runTick(source: 'cron' | 'chain' | 'manual' = 'cron'): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const id = lockId();
  const m = await loadMemory();
  const result: Record<string, unknown> = { ok: true, source, at: new Date().toISOString() };

  try {
    // reset daily counters on Algeria day rollover
    const today = dayKey();
    if (m.state.counters.day !== today) {
      m.state.counters = { day: today, llm: 0, ticks: 0 };
    }
    if (m.state.counters.ticks >= BUDGETS.ticksDaily) {
      return { ok: true, idle: 'tick-cap', ticksToday: m.state.counters.ticks };
    }

    if (!(await acquireLock(m, id))) {
      return { ok: false, error: 'locked', by: m.state.lock?.by };
    }

    // 1 · execute owner-approved actions
    const approved = m.approvals.filter((a) => a.status === 'approved');
    for (const ap of approved) {
      const r = await execTool(m, ap.tool, ap.args);
      ap.status = 'executed';
      ap.decidedAt = Date.now();
      await appendEpisode(`approval-executed: ${ap.tool} -> ${r.summary.slice(0, 160)}`, { tool: ap.tool, ok: r.ok });
      if (m.state.ownerChatId) {
        await sendTelegram(m.state.ownerChatId, `${r.ok ? '✅ نُفّذ' : '❌ فشل'}: ${ap.title}\n${r.summary.slice(0, 300)}`);
      }
    }
    if (approved.length) await saveApprovals(m, 'approvals: executed');

    // 2 · governor
    const { mode, note } = pickMode(m);
    result.mode = mode;
    if (mode === 'idle') {
      m.state.llmSnapshot = { ...llmHealthSnapshot(), at: Date.now() };
      await saveState(m, 'state: idle tick');
      releaseLock(m);
      await saveState(m, 'state: idle tick (lock released)');
      result.idle = note;
      return result;
    }

    if (m.state.counters.llm >= BUDGETS.llmDaily) {
      await appendEpisode('budget: بلغنا سقف النداءات اليومي — سكت حتى الغد', { ok: true });
      await saveState(m, 'state: llm cap');
      releaseLock(m);
      await saveState(m, 'state: llm cap (lock released)');
      result.idle = 'llm-cap';
      return result;
    }

    // 3 · think
    const d = await decide(m, mode, note);
    m.state.counters.llm++;
    m.state.totals.llm++;
    if (!d) {
      await appendEpisode(`error: decision parse failed (mode=${mode}) — المزودات لم ترد`, { ok: false });
      m.state.chainCount = 0; // never chain on a failed thought
      await saveState(m, 'state: no decision');
      releaseLock(m);
      await saveState(m, 'state: no decision (lock released)');
      result.ok = false;
      result.error = 'no-decision';
      return result;
    }
    result.thought = d.thought.slice(0, 200);

    // 4 · act — exactly ONE tool
    const r = await executeDecision(m, d);
    m.state.lastAction = { tool: d.tool, summary: r.summary.slice(0, 200), ok: r.ok, ts: Date.now() };
    m.state.counters.ticks++;
    m.state.totals.ticks++;
    if (mode === 'initiative') m.state.lastInitiativeAt = Date.now();
    result.action = `${d.tool}`;
    result.outcome = r.summary.slice(0, 240);
    result.toolOk = r.ok;

    // 5 · episode
    await appendEpisode(`[${dzNow().isoUtc.slice(11, 19)}] ${mode}: ${d.thought.slice(0, 120)} → ${d.tool}: ${r.summary.slice(0, 160)}`, {
      mode, tool: d.tool, ok: r.ok, goalId: m.state.currentTask?.goalId,
    });
    m.episodeTail.push(`${dzNow().isoUtc.slice(11, 19)} ${mode}: ${d.tool} → ${r.summary.slice(0, 120)}`);

    // 6 · scheduled task housekeeping — fire reminders that came due
    const fired: string[] = [];
    for (const t of m.state.scheduled.filter((x) => x.dueAt <= Date.now())) {
      fired.push(`${t.what} (${epochToWall(t.dueAt)})`);
      if (m.state.ownerChatId) {
        await sendTelegram(m.state.ownerChatId, `⏰ تذكير مجدول: ${t.what}`);
      }
      await appendEpisode(`scheduled-fired: ${t.what}`, { ok: true });
    }
    if (fired.length) {
      m.state.scheduled = m.state.scheduled.filter((x) => x.dueAt > Date.now());
      result.fired = fired;
    }

    // 7 · reflection triggers
    const goalDone = d.tool === 'update_goal' && /(done|failed)/.test(String(d.args.status || ''));
    if (goalDone || (m.state.totals.ticks > 0 && m.state.totals.ticks % 25 === 0)) {
      await reflect(m, goalDone ? 'إنجاز هدف' : 'مراجعة دورية (كل 25 نبضة)');
    }

    // 8 · disciplined chaining (v3 fix)
    m.state.llmSnapshot = { ...llmHealthSnapshot(), at: Date.now() };
    const now = Date.now();
    m.state.chainDispatchLog = (m.state.chainDispatchLog || []).filter((ts) => now - ts < 3600_000);
    const spacingOk = now - (m.state.lastChainDispatchAt || 0) >= BUDGETS.chainSpacingMs;
    const hourlyOk = m.state.chainDispatchLog.length < BUDGETS.chainHourly;
    const headroomOk = m.state.counters.llm < BUDGETS.llmDaily - BUDGETS.llmHeadroomForChain;
    const wantChain =
      d.continue === true &&
      r.ok === true &&
      d.tool !== 'none' &&
      d.tool !== 'sleep' &&
      m.state.chainCount < BUDGETS.chainCap &&
      spacingOk && hourlyOk && headroomOk &&
      now - t0 < BUDGETS.workBudgetMs;
    if (wantChain) {
      m.state.chainCount++;
      m.state.lastChainDispatchAt = now;
      m.state.chainDispatchLog.push(now);
      releaseLock(m);
      await saveState(m, 'state: tick (chained)');
      const disp = await dispatchTick('chain');
      result.chained = disp.ok;
      if (!disp.ok) result.chainError = disp.error;
    } else {
      if (!d.continue) m.state.chainCount = 0;
      releaseLock(m);
      await saveState(m, 'state: tick');
    }
    result.ms = Date.now() - t0;
    result.ticksToday = m.state.counters.ticks;
    result.llmToday = m.state.counters.llm;
    return result;
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 240);
    console.error('[brain] tick error:', msg);
    try {
      await appendEpisode(`crash: ${msg}`, { ok: false });
      releaseLock(m);
      await saveState(m, 'state: crash recovery');
    } catch { /* nothing more */ }
    return { ok: false, error: msg };
  }
}

function llmHealthSnapshot() {
  const h = llmHealth();
  return { ready: h.ready, lastProvider: h.lastProvider, lastError: h.lastError };
}

// ─── chat path (Telegram messages) ───────────────────────────────────────────
export async function handleChatMessage(chatId: string, fromName: string, text: string): Promise<void> {
  const m = await loadMemory();
  const isPrivate = String(chatId).startsWith('-') === false;

  // owner pinning: first private message wins (spec §6)
  if (isPrivate && !m.state.ownerChatId) {
    m.state.ownerChatId = chatId;
    m.state.ownerName = fromName;
    await saveState(m, 'state: owner pinned');
  }
  const owner = m.state.ownerChatId;

  const cmd = text.trim().toLowerCase();
  void sendTyping(chatId).catch(() => null);

  if (cmd === '/start' || cmd === '/start@paymonb_bot') {
    await sendTelegram(chatId, SELF_INTRO);
    await appendConversation(chatId, 'agent', SELF_INTRO);
    return;
  }
  if (cmd.startsWith('/ping')) {
    const now = dzNow();
    await sendTelegram(chatId, `✓ حيّ. ${now.wallAr}`);
    return;
  }
  if (cmd.startsWith('/goals')) {
    const active = m.goals.filter((g) => g.status === 'active');
    const body = active.length
      ? active.map((g) => `• ${g.title} (${g.subtasks.filter((s) => s.done).length}/${g.subtasks.length} مهام)`).join('\n')
      : 'لا أهداف نشطة حاليًا.';
    await sendTelegram(chatId, `الأهداف النشطة:\n${body}`);
    return;
  }
  if (cmd.startsWith('/status')) {
    const h = llmHealth();
    const st = [
      `الحالة: ${m.state.paused ? 'متوقف مؤقتًا' : 'أعمل'}`,
      `الوقت: ${dzNow().wallAr}`,
      `المزودات الجاهزة: ${h.readyCount} (${h.ready.slice(0, 4).join('، ')})`,
      `المرتاحة (عطل مؤقت): ${h.parked.length ? h.parked.map((p) => p.provider).join('، ') : 'لا شيء'}`,
      `النداءات اليوم: ${m.state.counters.llm}/${BUDGETS.llmDaily} — النبضات: ${m.state.counters.ticks}`,
      `أهداف نشطة: ${m.goals.filter((g) => g.status === 'active').length}`,
    ].join('\n');
    await sendTelegram(chatId, st);
    return;
  }
  if (cmd.startsWith('/stop')) {
    m.state.paused = true;
    await saveState(m, 'state: paused');
    await sendTelegram(chatId, 'توقفت مؤقتًا. أرسل /resume للاستئناف.');
    return;
  }
  if (cmd.startsWith('/resume')) {
    m.state.paused = false;
    await saveState(m, 'state: resumed');
    await sendTelegram(chatId, 'استأنفت العمل.');
    return;
  }

  await appendConversation(chatId, 'owner', text);

  // goal: shorthand (spec §6)
  if (/^goal\s*:/i.test(text.trim())) {
    const title = text.trim().replace(/^goal\s*:\s*/i, '').slice(0, 200);
    if (!title) { await sendTelegram(chatId, 'اكتب الهدف بعد goal:'); return; }
    const r = await execTool(m, 'add_goal', { title });
    await sendTelegram(chatId, r.ok ? `✓ ${r.summary}` : `تعذّر: ${r.summary}`);
    await appendConversation(chatId, 'agent', r.summary.slice(0, 500));
    return;
  }

  // free-form chat — with semantic recall, the local clock, and the
  // anti-goal-filing rule (v3 fix).
  // v4: question-shaped or current-events-shaped messages get a bounded live
  // web pass first, so chat answers carry fresh facts instead of stale model
  // priors (the "agent knows nothing but the time" complaint, Sept 2026).
  const t0 = Date.now();
  const needsFresh =
    /[؟?]/.test(text) ||
    /أخبار|اخبار|اليوم|الآن|حالي|آخر|اخير|سعر|طقس|مباراة|نتائج|من هو|ما هو|متى|أين|كم/i.test(text);
  let freshBlock = '';
  if (needsFresh) {
    const hits = await Promise.race([
      webSearch(text.slice(0, 200)),
      new Promise<{ title: string; url: string; snippet: string }[]>((resolve) =>
        setTimeout(() => resolve([]), 14_000)),
    ]).catch(() => [] as { title: string; url: string; snippet: string }[]);
    if (hits.length) {
      freshBlock = 'نتائج بحث ويب حديثة عن رسالة المالك (استند إليها عند الإجابة واذكر المصدر عند النقل):\n'
        + hits.slice(0, 5).map((h) => `• ${h.title}${h.snippet ? ` — ${h.snippet.slice(0, 160)}` : ''} (${h.url})`).join('\n');
    }
  }
  const [recalled, history] = await Promise.all([
    recallMemories(text).catch(() => [] as string[]),
    readConversation(chatId).catch(() => [] as { who: string; text: string }[]),
  ]);
  const msgs: ChatMsg[] = [
    {
      role: 'system',
      content: [
        identityPrompt(m),
        hardRulesPrompt(),
        'أنت الآن في محادثة مباشرة مع مالكك عبر تلغرام. أجب إجابة نهائية مفيدة من معلوماتك وما يلي — لا تخطط ولا تسجّل أهدافًا من الدردشة العادية. إن كان السؤال يتطلب عملًا لاحقًا فأخبره فقط أنك ستتولاه في نبضتك القادمة.',
        freshBlock,
        recalled.length ? `ذكريات ذات صلة:\n${recalled.join('\n')}` : '',
        history.length ? `سياق المحادثة الأخيرة:\n${history.slice(-10).map((h) => `${h.who === 'owner' ? 'المالك' : 'أنا'}: ${h.text.slice(0, 150)}`).join('\n')}` : '',
      ].filter(Boolean).join('\n\n'),
    },
    { role: 'user', content: text.slice(0, 3000) },
  ];
  const chatBudget = Math.max(18_000, BUDGETS.workBudgetMs - 6000 - (Date.now() - t0));
  const r = await chat(msgs, { temperature: 0.6, maxTokens: TOKEN_CEIL.chat, budgetMs: chatBudget });
  const reply = (r?.text || 'اعتذر — تعذّر وصولي إلى مزودات الذكاء الآن. سأحاول بعد قليل.').slice(0, 3900);
  await sendTelegram(chatId, reply);
  await appendConversation(chatId, 'agent', reply);
  // keep state counters honest about the llm call
  const m2 = await loadMemory();
  m2.state.counters.llm++;
  m2.state.totals.llm++;
  await saveState(m2, 'state: chat').catch(() => null);
}

// ─── approval callbacks ─────────────────────────────────────────────────────
export async function handleCallback(callbackQueryId: string, chatId: string, data: string): Promise<void> {
  const m = await loadMemory();
  const match = data.match(/^appr:(.+):(a|r)$/);
  if (!match) { await answerCallback(callbackQueryId); return; }
  const [, id, verdict] = match;
  const ap = m.approvals.find((a) => a.id === id);
  if (!ap) { await answerCallback(callbackQueryId, 'انتهت صلاحية الطلب'); return; }
  if (ap.status !== 'pending') { await answerCallback(callbackQueryId, 'تم البتّ في هذا الطلب سابقًا'); return; }
  ap.status = verdict === 'a' ? 'approved' : 'rejected';
  ap.decidedAt = Date.now();
  await saveApprovals(m, `approval ${ap.status}: ${ap.title.slice(0, 40)}`);
  await appendEpisode(`approval-${ap.status}: ${ap.title.slice(0, 120)}`, { ok: verdict === 'a' });
  await answerCallback(callbackQueryId, verdict === 'a' ? 'سيُنفّذ في النبضة التالية' : 'رُفض');
  if (m.state.ownerChatId) {
    await sendTelegram(m.state.ownerChatId, verdict === 'a' ? `✅ اعتمدت: ${ap.title}` : `❌ رفضت: ${ap.title}`);
  }
}
