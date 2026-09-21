// ─── The agent's brain: the autonomous loop ─────────────────────────
//
// One tick = one thought:
//   acquire lock -> execute approved actions -> pick mode (task/scheduled/
//   initiative) -> LLM decision (JSON) -> ONE action -> log episode -> save ->
//   maybe chain another tick immediately -> release.
//
// Interactions arrive through two doors and meet in the same memory:
//   - /api/agent/webhook : Telegram messages & approval buttons (inline reply)
//   - /api/agent/tick    : GitHub Actions every 5 min + self-dispatched chains

import { randomUUID } from 'node:crypto';
import { AGENT, AGENT_CONFIG, nowParts, dayKey, localNow, TZ_LABEL } from './config';
import { dispatchWorkflow } from './github';
import { chatJson, llmHealth } from './llm';
import {
  acquireLock,
  releaseLock,
  loadMemory,
  saveState,
  saveGoals,
  saveApprovals,
  saveIdentity,
  appendLine,
  loadConversation,
  logConversation,
  recallMemories,
  lockStolen,
  updateStateFields,
  mutateGoals,
  type MemoryBundle,
  type Goal,
} from './memory';
import { TOOL_MAP, TOOLS, execTool, describeArgs } from './tools';
import { sendApprovalButtons, sendTelegram, sendTyping, answerCallback, editMessage } from './telegram';

const SCHEDULER_REPO = AGENT_CONFIG.schedulerRepo;
const EPISODE_CAP = 400;

// ═══════════════════════════════ episode log ═════════════════════════════════

async function episode(b: MemoryBundle, kind: string, text: string) {
  const line = `[${new Date().toISOString()}] ${kind}: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`;
  await appendLine('episodic.jsonl', { ts: Date.now(), text: line }, EPISODE_CAP);
  b.episodes.push(line);
  if (b.episodes.length > 30) b.episodes.splice(0, b.episodes.length - 30);
}

// ═══════════════════════════════ prompt builder ══════════════════════════════

function toolsBlock(): string {
  return TOOLS.map((t) => `- ${t.name} ${t.args} — ${t.desc}`).join('\n');
}

function goalsBlock(b: MemoryBundle): string {
  if (!b.goals.length) return '(no goals yet)';
  return b.goals
    .filter((g) => !['done', 'failed', 'cancelled'].includes(g.status))
    .map((g) => {
      const st = g.subtasks.map((s) => `[${s.done ? 'x' : ' '}] ${s.text}`).join('; ') || 'no subtasks';
      return `#${g.id} "${g.title}" (${g.status}) — ${g.description || 'no description'} | subtasks: ${st}${g.notes.length ? ` | notes: ${g.notes.slice(-2).join(' / ')}` : ''}`;
    })
    .join('\n');
}

function systemPrompt(b: MemoryBundle, mode: string): string {
  const t = nowParts();
  const owner = b.state.ownerChatId ? `${b.state.ownerName || 'my owner'} (chat ${b.state.ownerChatId})` : 'unknown — nobody has messaged me privately yet';
  return `You are ${AGENT.name} (${AGENT.nameAr}, @${AGENT.username}), an autonomous AI agent based in ${AGENT.home}. You were upgraded from a simple chatbot into an agent that works on goals between messages, uses tools, and learns from experience. You ALWAYS write to humans in ${AGENT.language} — clear, correct, dignified فصحى; never slang, never dialect.

## Who I am (my living identity file)
${b.identity || '(empty — you will write it through reflection)'}

## Facts
- Owner: ${owner}. Date/time: ${t.utc}, ${t.alg}.
- I live in Tiaret, Algeria (Africa/Algiers, UTC+1).
- Today: LLM calls ${b.state.counters.llm}/${AGENT_CONFIG.LLM_DAILY_CAP}, ticks ${b.state.counters.ticks}/${AGENT_CONFIG.TICKS_DAILY_CAP}.
- This tick's mode: ${mode}.

## My tools (exactly ONE call per tick)
${toolsBlock()}

## Hard rules
1. Output ONE JSON object, nothing else. Format: {"thought":"سبب قرارك بالعربية في ≤40 كلمة","tool":"<tool name>","args":{...},"continue":true|false}. Keep the whole object under 150 words so it is never truncated.
2. "continue": true means you'll get another tick in ~20-60s to keep working on this same task. Set it while real work remains; set false after sending the owner a message that expects a reply, after sleep, or when done/waiting.
3. Work in small steps: search -> fetch -> read -> compute -> save (remember / update_goal) -> report (send_message). Never claim a result you didn't verify with a tool. If one tool fails twice, switch approach (different tool, different query) instead of repeating it.
4. Risky actions (non-GET HTTP, writing to repos other than my memory repo, public gists) are auto-routed to owner approval by the system — you just call the tool normally and it will queue for approval. No need to also use request_approval for those; request_approval is for anything ELSE you judge risky, expensive or irreversible.
5. Be honest and frugal: free tools first, no wasted calls, admit failures plainly.
6. Messages to the owner: warm, concise plain-text Modern Standard Arabic (no markdown headers, no bullet spam). You're friendly and real, not a corporate bot.
7. Use update_goal with check_subtask as you finish subtasks; mark the goal !done (with result) when fully achieved; mark !blocked with a note if stuck after ~3 attempts.
8. Use remember for durable lessons ("DDG search works better with quotes", "owner prefers Arabic at night", ...).`;
}

function contextBlock(b: MemoryBundle, extra: string): string {
  const recent = b.episodes.slice(-12).join('\n') || '(no history yet)';
  const insights = b.insights.slice(-10).map((i) => `- ${i.text}`).join('\n') || '(none yet)';
  const sched = (b.state.scheduled || [])
    .slice(-5)
    .map((s) => `- ${new Date(s.dueAt).toISOString()} ${s.what}`)
    .join('\n');
  return `## Goals
${goalsBlock(b)}

## Scheduled checks
${sched || '(none)'}

## What happened recently (oldest first)
${recent}

## Lessons I keep
${insights}

## Pending owner approvals: ${b.approvals.filter((a) => a.status === 'pending').length}
${extra}`;
}

// ═══════════════════════════════ decision & execution ════════════════════════

function newGoalFrom(title: string, description: string, subtasks: string[], origin: string): Goal {
  return {
    id: 'g_' + Math.random().toString(36).slice(2, 8),
    title: String(title).slice(0, 140),
    description: String(description || '').slice(0, 600),
    status: 'active',
    subtasks: (subtasks || []).slice(0, 12).map((s, i) => ({ id: 's' + i, text: String(s).slice(0, 200), done: false })),
    origin,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notes: [],
  };
}

interface Decision {
  thought: string;
  tool: string;
  args: any;
  cont: boolean;
  bypassRisk?: boolean; // owner already approved this exact action
}

async function decide(b: MemoryBundle, mode: string, modeContext: string): Promise<Decision | null> {
  const sys = systemPrompt(b, mode);
  const user = contextBlock(b, modeContext) + `\n\nDecide the single next action now.`;
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const j = await chatJson(
      attempt === 0 ? messages : [...messages, { role: 'user', content: 'Your previous answer was not valid JSON. Output ONLY the JSON object: {"thought":"<=40 words","tool":"...","args":{...},"continue":true|false}' }],
      { maxTokens: AGENT_CONFIG.DECIDE_MAX_TOKENS, temperature: attempt === 0 ? 0.5 : 0.2 }
    );
    if (j && typeof j === 'object' && j.tool) {
      return { thought: String(j.thought || ''), tool: String(j.tool), args: j.args || {}, cont: j.continue === true };
    }
  }
  return null;
}

async function askOwnerApproval(b: MemoryBundle, tool: string, args: any, reason: string): Promise<boolean> {
  const owner = b.state.ownerChatId;
  if (!owner) {
    await episode(b, 'approval', `cannot ask approval for ${tool} — owner unknown`);
    return false;
  }
  const id = 'ap_' + Math.random().toString(36).slice(2, 8);
  const title = `${tool} ${describeArgs(args)}`;
  const sent = await sendApprovalButtons(owner, id, title, reason || 'I judged this risky');
  const approval = {
    id,
    tool,
    args,
    reason: String(reason || 'risky').slice(0, 300),
    goalId: b.state.currentTask?.goalId,
    status: 'pending' as const,
    requestedAt: Date.now(),
    message: sent.ok ? { chatId: owner, messageId: sent.messageId! } : undefined,
  };
  b.approvals.push(approval);
  await saveApprovals(b);
  await episode(b, 'approval-requested', `${tool} ${describeArgs(args)} — ${reason}`);
  return true;
}

/** Execute one decision. Returns short human summary for the episode log. */
async function execute(b: MemoryBundle, d: Decision): Promise<{ summary: string; ok: boolean; chained: boolean }> {
  const def = TOOL_MAP[d.tool];
  if (!def) {
    await episode(b, 'error', `unknown tool "${d.tool}" requested`);
    return { summary: `unknown tool ${d.tool}`, ok: false, chained: false };
  }

  // ── risk gate (skipped when the owner already approved this action) ──
  const risky = d.bypassRisk ? undefined : def.risky?.(d.args);
  if (risky) {
    const asked = await askOwnerApproval(b, d.tool, d.args, typeof risky === 'string' ? risky : 'risky');
    if (!asked) {
      // CRITICAL: never execute a risky action just because we couldn't ask.
      await episode(b, 'blocked', `${d.tool} needs approval but no owner is pinned — refusing to run`);
      return { summary: `refused: ${d.tool} needs owner approval (none pinned yet)`, ok: false, chained: false };
    }
    if (d.tool === 'send_message') return { summary: 'risky send queued', ok: true, chained: false };
    if (b.state.currentTask) {
      const g = b.goals.find((x) => x.id === b.state.currentTask!.goalId);
      if (g && g.status === 'active') g.status = 'waiting_approval';
      await saveGoals(b);
    }
    return { summary: `queued for approval: ${d.tool}`, ok: true, chained: false };
  }

  // ── local (memory-touching) tools ──
  switch (d.tool) {
    case 'add_goal': {
      const g = newGoalFrom(d.args?.title, d.args?.description, d.args?.subtasks || [], 'self');
      b.goals.push(g);
      await saveGoals(b);
      await episode(b, 'goal-added', `#${g.id} ${g.title}`);
      return { summary: `added goal #${g.id} ${g.title}`, ok: true, chained: true };
    }
    case 'update_goal': {
      const g = b.goals.find((x) => x.id === d.args?.goal_id);
      if (!g) return { summary: `update_goal: no goal ${d.args?.goal_id}`, ok: false, chained: false };
      const st = String(d.args?.status || '').replace(/^!/, '');
      if (['active', 'blocked', 'waiting_approval', 'done', 'failed', 'cancelled'].includes(st)) g.status = st as Goal['status'];
      if (d.args?.add_note) g.notes.push(String(d.args.add_note).slice(0, 300));
      if (Array.isArray(d.args?.add_subtasks))
        for (const s of d.args.add_subtasks) g.subtasks.push({ id: 's' + g.subtasks.length, text: String(s).slice(0, 200), done: false });
      if (d.args?.check_subtask) {
        const sub = g.subtasks.find((s) => s.id === d.args.check_subtask || s.text === d.args.check_subtask);
        if (sub) sub.done = true;
      }
      if (d.args?.result) g.result = String(d.args.result).slice(0, 800);
      g.updatedAt = Date.now();
      const finished = g.status === 'done' || g.status === 'failed' || g.status === 'cancelled';
      if (finished && b.state.currentTask?.goalId === g.id) b.state.currentTask = null;
      if (g.status === 'done') b.state.totals.goalsDone++;
      await saveGoals(b);
      await episode(b, 'goal-updated', `#${g.id} -> ${g.status}${g.result ? ' : ' + g.result : ''}`);
      return { summary: `goal #${g.id} -> ${g.status}`, ok: true, chained: !finished };
    }
    case 'remember': {
      const text = String(d.args?.text || '').slice(0, 400);
      if (!text) return { summary: 'remember: empty', ok: false, chained: false };
      await appendLine('insights.jsonl', { ts: Date.now(), text }, 200);
      b.insights.push({ ts: Date.now(), text });
      await episode(b, 'remember', text);
      return { summary: `remembered: ${text.slice(0, 80)}`, ok: true, chained: true };
    }
    case 'schedule_task': {
      const mins = Number(d.args?.in_minutes) || 0;
      const due = d.args?.at_iso ? Date.parse(d.args.at_iso) : Date.now() + mins * 60_000;
      if (!due || isNaN(due)) return { summary: 'schedule_task: bad time', ok: false, chained: false };
      b.state.scheduled = (b.state.scheduled || []).filter((s) => s.dueAt > Date.now()).slice(-20);
      b.state.scheduled.push({
        id: 't_' + Math.random().toString(36).slice(2, 8),
        what: String(d.args?.what || '').slice(0, 300),
        dueAt: due,
        createdAt: Date.now(),
        goalId: b.state.currentTask?.goalId,
      });
      await episode(b, 'scheduled', `${d.args?.what} at ${new Date(due).toISOString()}`);
      return { summary: 'scheduled', ok: true, chained: false };
    }
    case 'sleep': {
      const mins = Math.min(Math.max(Number(d.args?.minutes) || 15, 5), 240);
      b.state.nextWakeAt = Date.now() + mins * 60_000;
      await episode(b, 'sleep', `${mins}m`);
      return { summary: `sleeping ${mins}m`, ok: true, chained: false };
    }
    case 'request_approval': {
      const asked = await askOwnerApproval(b, String(d.args?.tool || ''), d.args?.args || {}, String(d.args?.reason || ''));
      return { summary: asked ? 'manual approval requested' : 'approval failed (no owner)', ok: asked, chained: false };
    }
  }

  // ── external tools ──
  const out = await execTool(d.tool, d.args, { ownerChatId: b.state.ownerChatId, goalId: b.state.currentTask?.goalId });
  const okSummary = out?.ok ? JSON.stringify(out).slice(0, 160) : String(out?.error || JSON.stringify(out)).slice(0, 200);
  await episode(b, d.tool, `${describeArgs(d.args)} -> ${okSummary}`);
  return { summary: `${d.tool}: ${okSummary}`, ok: !!out?.ok, chained: true };
}

// ═══════════════════════════════ reflection ══════════════════════════════════

async function reflect(b: MemoryBundle, trigger: string): Promise<void> {
  try {
    const recentEps = b.episodes.slice(-15).join('\n');
    const j = await chatJson(
      [
        {
          role: 'system',
          content: `You maintain the identity file and lessons of ${AGENT.name} (${AGENT.nameAr}), an autonomous agent from ${AGENT.home}. The identity file is ALWAYS written in Modern Standard Arabic. Never change his name. Identity evolves slowly and honestly — rewrite the whole file (max 250 words) keeping what's still true, adjusting what experience has changed: interests, style, confidence, lessons about how he works. Output JSON: {"identity":"<full new identity file markdown, in Modern Standard Arabic>","insights":["1-3 durable lessons from recent events, in Arabic"]}`,
        },
        {
          role: 'user',
          content: `Current identity:\n${b.identity || '(empty)'}\n\nRecent events:\n${recentEps}\n\nTrigger: ${trigger}`,
        },
      ],
      { maxTokens: AGENT_CONFIG.REFLECT_MAX_TOKENS, temperature: 0.6 }
    );
    if (j?.identity) await saveIdentity(b, String(j.identity));
    if (Array.isArray(j?.insights))
      for (const ins of j.insights.slice(0, 3)) {
        const text = String(ins).slice(0, 400);
        if (text) await appendLine('insights.jsonl', { ts: Date.now(), text }, 200);
      }
    await episode(b, 'reflected', trigger);
  } catch (e: any) {
    console.error('[agent.brain] reflect failed:', e?.message);
  }
}

// ═══════════════════════════════ governor ════════════════════════════════════

function pickMode(b: MemoryBundle): { mode: string; context: string } {
  const now = Date.now();

  // 0) sleeping (sleep tool set a wake time)
  if ((b.state.nextWakeAt || 0) > now) return { mode: 'idle', context: '(sleeping until next wake)' };

  // 1) due scheduled tasks
  const due = (b.state.scheduled || []).find((s) => s.dueAt <= now);
  if (due) {
    b.state.scheduled = (b.state.scheduled || []).filter((s) => s.id !== due.id);
    return {
      mode: 'scheduled',
      context: `A scheduled check is DUE now: "${due.what}". Handle it — usually: fresh web_search/web_fetch if it needs current info, then send_message the owner with a useful, compact answer.`,
    };
  }

  // 2) active work
  const active = b.goals.filter((g) => g.status === 'active' || g.status === 'waiting_approval');
  const task = b.state.currentTask ? b.goals.find((g) => g.id === b.state.currentTask!.goalId && g.status === 'active') : null;
  const goal = task || active.find((g) => g.status === 'active');
  if (goal) {
    b.state.currentTask = { goalId: goal.id, note: goal.title, startedAt: b.state.currentTask?.goalId === goal.id ? b.state.currentTask.startedAt : now };
    const sub = goal.subtasks.filter((s) => !s.done);
    return {
      mode: 'task',
      context: `Focus goal #${goal.id} "${goal.title}" (origin: ${goal.origin}).
Description: ${goal.description || '—'}
Remaining subtasks: ${sub.length ? sub.map((s) => `${s.id}: ${s.text}`).join(' | ') : '(none listed — do the direct next step)'}
${goal.notes.length ? `Notes: ${goal.notes.slice(-3).join(' | ')}` : ''}
${goal.result ? `Previous result: ${goal.result}` : ''}
Advance it ONE step. If it is already fully achieved, mark it !done instead.`,
    };
  }

  // 3) quiet hours: initiative or idle
  if (now - b.state.lastInitiativeAt > AGENT_CONFIG.INITIATIVE_GAP_MS) {
    return {
      mode: 'initiative',
      context: `No urgent tasks. Free time. Options:
(a) propose a goal to the owner via send_message ("would you like me to ...") — don't add_goal before they nod, unless it's trivial self-maintenance;
(b) learn something for 1-2 ticks: web_search something aligned with your identity/owner's interests, web_fetch it, remember the takeaway;
(c) tidy up: review goals below, schedule a useful check;
(d) sleep if nothing feels worthwhile. Don't repeat something you did in recent events.`,
    };
  }

  return { mode: 'idle', context: '(nothing due)' };
}

// ═══════════════════════════════ main tick ═══════════════════════════════════

export async function runTick(source: string): Promise<any> {
  const t0 = Date.now();
  const b = await loadMemory();
  const lockId = randomUUID().slice(0, 8);

  if (source === 'cron') b.state.chainCount = 0; // fresh work period
  if (b.state.paused) return { ok: true, idle: 'paused' };
  if (b.state.counters.ticks >= AGENT_CONFIG.TICKS_DAILY_CAP) return { ok: true, idle: 'tick-cap' };

  const gotLock = await acquireLock(b, lockId);
  if (!gotLock) return { ok: true, idle: 'busy' };

  let result: any = { ok: true };
  try {
    // ── 1. execute owner-approved actions ──
    const approved = b.approvals.filter((a) => a.status === 'approved' && !a.args?.__executed);
    for (const ap of approved) {
      ap.args = { ...ap.args, __executed: true };
      const prevTask = b.state.currentTask;
      if (ap.goalId) b.state.currentTask = { goalId: ap.goalId, note: 'approved action', startedAt: Date.now() };
      const d: Decision = { thought: 'owner approved this action', tool: ap.tool, args: ap.args, cont: false, bypassRisk: true };
      const r = await execute(b, d);
      if (ap.goalId) b.state.currentTask = prevTask;
      const g = b.goals.find((x) => x.id === ap.goalId);
      if (g && g.status === 'waiting_approval') {
        g.status = r.ok ? 'active' : 'failed';
        g.notes.push(`approval ${ap.id} ${r.ok ? 'executed' : 'failed'}`);
        await saveGoals(b);
      }
      ap.status = r.ok ? ('approved' as const) : ('rejected' as const);
      ap.decidedAt = Date.now();
      ap.reason = `${ap.reason} [executed: ${r.summary}]`;
      await episode(b, 'approval-executed', `${ap.tool} -> ${r.summary}`);
      if (b.state.ownerChatId)
        await sendTelegram(b.state.ownerChatId, `${r.ok ? '✅ Done' : '❌ Failed'}: ${ap.tool}\n${r.summary.slice(0, 400)}`);
    }
    if (approved.length) await saveApprovals(b);

    // ── 2. governor: what kind of thought is this? ──
    const { mode, context } = pickMode(b);
    if (mode === 'idle') {
      await saveState(b);
      return { ok: true, idle: true, ticksToday: b.state.counters.ticks };
    }

    if (b.state.counters.llm >= AGENT_CONFIG.LLM_DAILY_CAP) {
      await episode(b, 'budget', 'daily LLM cap reached — staying quiet until tomorrow');
      await saveState(b);
      return { ok: true, idle: 'llm-cap' };
    }

    // ── 3. think ──
    const d = await decide(b, mode, context);
    b.state.counters.llm++;
    b.state.totals.llm++;
    if (!d) {
      await episode(b, 'error', `decision parse failed (mode=${mode})`);
      await saveState(b);
      return { ok: false, error: 'no-decision' };
    }

    // ── 4. act ──
    const wasTaskMode = mode === 'task';
    const r = await execute(b, d);
    b.state.lastAction = { tool: d.tool, summary: r.summary.slice(0, 200), ok: r.ok, ts: Date.now() };
    b.state.counters.ticks++;
    b.state.totals.ticks++;
    if (mode === 'initiative') b.state.lastInitiativeAt = Date.now();

    // chain control
    const wantChain = d.cont && r.chained !== false && b.state.chainCount < AGENT_CONFIG.CHAIN_CAP;
    if (wantChain) b.state.chainCount++;
    else if (!d.cont) b.state.chainCount = 0;

    // reflection triggers
    const goalJustDone = d.tool === 'update_goal' && /-> (done|failed)/.test(r.summary);
    if (goalJustDone || b.state.totals.ticks % 25 === 0) await reflect(b, goalJustDone ? `goal completed: ${r.summary}` : 'periodic review (25 ticks)');

    if (lockStolen(b, lockId)) return { ok: true, note: 'lock stolen, skipping save' };
    await saveState(b);

    // ── 5. fast-follow ──
    if (wantChain && Date.now() - t0 < AGENT_CONFIG.WORK_BUDGET_MS) {
      const disp = await dispatchWorkflow(AGENT_CONFIG.ghToken, SCHEDULER_REPO, 'agent-tick.yml', { source: 'chain' });
      result.chained = disp.ok;
      if (!disp.ok) console.error('[agent.brain] chain dispatch failed:', disp.error);
    }

    result.mode = mode;
    result.thought = d.thought.slice(0, 200);
    result.action = `${d.tool} ${describeArgs(d.args)}`;
    result.outcome = r.summary.slice(0, 200);
    result.ms = Date.now() - t0;
    return result;
  } catch (e: any) {
    console.error('[agent.brain] tick error:', e?.message);
    try {
      await episode(b, 'crash', String(e?.message || e).slice(0, 250));
      await saveState(b);
    } catch {
      /* nothing more we can do */
    }
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    await releaseLock(b, lockId);
  }
}

// ═══════════════════════════════ chat path ═══════════════════════════════════

export async function handleChatMessage(msg: any): Promise<any> {
  const chatId = msg.chat?.id;
  const text = String(msg.text || msg.caption || '').trim();
  if (!chatId || !text) return { skipped: 'empty' };
  const from = msg.from || {};
  if (from.id === AGENT.numericId) return { skipped: 'self' };
  const isPrivate = msg.chat.type === 'private';
  const stale = msg.date && Date.now() / 1000 - msg.date > 600;

  const b = await loadMemory();

  // pin owner on first private DM (targeted write — a tick may hold the lock)
  if (isPrivate && !b.state.ownerChatId) {
    const name = String(from.first_name || from.username || 'my owner').slice(0, 60);
    await updateStateFields((s) => {
      if (s.ownerChatId) return false; // someone pinned first
      s.ownerChatId = String(chatId);
      s.ownerName = name;
    });
    b.state.ownerChatId = String(chatId);
    b.state.ownerName = name;
    await episode(b, 'owner-pinned', `chat ${chatId} (${name})`);
  }

  const isOwner = isPrivate && String(chatId) === b.state.ownerChatId;
  await logConversation(chatId, from.first_name || 'someone', text);
  if (stale) return { skipped: 'stale' };

  // ── commands (no LLM) ──
  const cmd = /^\/([a-zA-Z0-9_]+)\s*([\s\S]*)$/.exec(text);
  if (cmd) {
    const name = cmd[1].toLowerCase();
    if (name === 'start' || name === 'help') {
      await sendTelegram(
        chatId,
        `أنا ${AGENT.nameAr} — وكيل ذكي مستقل، وليس مجرد روبوت محادثة.\n\nما أستطيع فعله:\n• العمل على أهدافك بين رسائلك (بحث، مراقبة، كتابة، برمجة، واجهات برمجية)\n• البحث في الإنترنت وقراءة الصفحات وتنفيذ الشيفرات ومناداة الخدمات العامة\n• حفظ الدروس التي أتعلمها والاحتفاظ بهوية تتطور مع الخبرة\n• طلب إذنك قبل أي إجراء قد يكون محفوفًا بالخطر\n\nحدّثني بشكل طبيعي، أو استخدم:\n/goals — لوحة أهدافي\n/status — حالتي وميزانياتي\n/stop — إيقاف العمل الذاتي مؤقتًا\n/resume — استئناف\nاطلب أي مهمة: "goal: تتبّع سعر X يوميًا" أو ببساطة "ابحث لي عن ..."`
      );
      return { ok: 'help' };
    }
    if (name === 'ping') {
      await sendTelegram(chatId, `pong — أنا حيّ. دورات اليوم: ${b.state.counters.ticks}، نداءات الذكاء: ${b.state.counters.llm}.`);
      return { ok: 'ping' };
    }
    if (name === 'goals') {
      const g = b.goals.length ? b.goals.map((x) => `#${x.id} ${x.status === 'done' ? '✅' : x.status === 'failed' ? '✖' : x.status === 'blocked' ? '⛔' : '🔹'} ${x.title}${x.subtasks.length ? ` (${x.subtasks.filter((s) => s.done).length}/${x.subtasks.length})` : ''}`).join('\n') : '(لا أهداف بعد — أعطني واحدًا: "goal: ...")';
      await sendTelegram(chatId, `لوحة أهدافي:\n${g}`);
      return { ok: 'goals' };
    }
    if (name === 'status') {
      await sendTelegram(chatId, buildStatus(b));
      return { ok: 'status' };
    }
    if (name === 'stop') {
      await updateStateFields((s) => {
        s.paused = true;
        s.chainCount = 0;
      });
      await sendTelegram(chatId, 'أوقفتُ العمل الذاتي مؤقتًا. سأبقى أجيبك هنا، لكنني لن أعمل بين رسائلك. أرسل /resume للاستئناف.');
      return { ok: 'paused' };
    }
    if (name === 'resume') {
      await updateStateFields((s) => {
        s.paused = false;
      });
      await sendTelegram(chatId, 'عدتُ إلى واجبي. سأتابع أهدافي كل بضع دقائق وأوافيك بالنتائج.');
      return { ok: 'resumed' };
    }
    // unknown command -> fall through to chat
  }

  // ── owner goal shorthand ──
  const gm = /^(?:goal|task)\s*[:：]\s*(.+)$/i.exec(text);
  if (gm && (isOwner || isPrivate)) {
    const g = newGoalFrom(gm[1], '', [], `owner:${b.state.ownerName || chatId}`);
    await mutateGoals((goals) => {
      goals.push(g);
    });
    await episode(b, 'goal-added', `#${g.id} ${g.title} (owner)`);
    await sendTelegram(chatId, `على رأي العين — الهدف #${g.id}: «${g.title}». سأعمل على خطوات وأوافيك بالتقرير هنا.`);
    await dispatchWorkflow(AGENT_CONFIG.ghToken, SCHEDULER_REPO, 'agent-tick.yml', { source: 'chain' });
    return { ok: 'goal-added', goalId: g.id };
  }

  // ── group etiquette: only speak when addressed ──
  if (!isPrivate) {
    const addressed = text.toLowerCase().includes('@' + AGENT.username.toLowerCase());
    const replyToMe = msg.reply_to_message?.from?.id === AGENT.numericId;
    if (!addressed && !replyToMe) return { skipped: 'not-addressed' };
  }

  // ── conversational reply (LLM, may spawn a goal) ──
  sendTyping(chatId);
  try {
    const conv = await loadConversation(chatId, 16);
    // Semantic recall from the Supabase memory DB (best-effort, never blocks).
    let recallBlock = '';
    try {
      const mem = await recallMemories(text, isPrivate ? String(chatId) : null);
      if (mem) recallBlock = `\n\nRelevant long-term memories (from your own memory DB):\n${mem}`;
    } catch {}
    const j = await chatJson(
      [
        {
          role: 'system',
          content: `${b.identity || ''}${recallBlock}\n\nYou are ${AGENT.name} (${AGENT.nameAr}), an autonomous agent from ${AGENT.home}, chatting on Telegram with ${isOwner ? `your owner (${b.state.ownerName || 'them'})` : 'a person'}.\nCurrent local time at home: ${localNow()} (${TZ_LABEL}). UTC: ${nowParts().utc}.\nYou are mid-life with these goals: ${goalsBlock(b) || 'none'}.\n\nHard rules:\n1. Reply in clean Modern Standard Arabic (العربية الفصحى) — 1-4 sentences, plain text, no headers. NEVER mix any other language or script (English words, Chinese characters, etc.) into the Arabic. If the human writes in another language, mirror that language instead.\n2. If the message is a QUESTION (asking the time, your goals, your progress, what you can do, or anything informational), ANSWER it directly and truthfully from the facts above — it is NOT a new task. Never invent or re-register existing goals when merely asked about them.\n3. Only set newGoal when the human clearly asks you to DO real work (research/find/build/monitor/track/write/fetch something NEW). Small talk, statements, corrections and questions never create goals.\n4. If asked about the current time, use the current local time above exactly.\n\nOutput JSON only: {"reply":"...","newGoal":{"title":"...","description":"..."} | null}`,
        },
        { role: 'user', content: `Recent conversation:\n${conv.slice(-14).join('\n') || '(start)'}\n\nNew message from ${from.first_name || 'them'}: ${text.slice(0, 1200)}` },
      ],
      { maxTokens: AGENT_CONFIG.CHAT_REPLY_MAX_TOKENS, temperature: 0.6, strictRetry: true }
    );
    const reply =
      j?.reply ||
      (typeof j === 'string' ? j : null) ||
      'تعثّرت اتصالاتي بمزوّدي الذكاء لحظة — سأعيد المحاولة تلقائيًا، جرّب مرة أخرى بعد قليل.';
    await sendTelegram(chatId, String(reply).slice(0, 1500), { replyTo: isPrivate ? undefined : msg.message_id });
    await logConversation(chatId, AGENT.name, String(reply));
    await updateStateFields((s) => {
      s.counters.llm = (s.counters.llm || 0) + 1;
      s.totals.llm = (s.totals.llm || 0) + 1;
    });
    await episode(b, 'chat', `${from.first_name}: ${text.slice(0, 120)} -> replied${j?.newGoal ? ' + goal' : ''}`);

    if (j?.newGoal?.title && (isOwner || isPrivate)) {
      const g = newGoalFrom(j.newGoal.title, j.newGoal.description, [], `owner:${b.state.ownerName || chatId}`);
      await mutateGoals((goals) => {
        goals.push(g);
      });
      await sendTelegram(chatId, `سُجّل كهدف #${g.id} — سأعمل عليه بين رسائلك وأخبرك بالنتيجة.`);
      await episode(b, 'goal-added', `#${g.id} ${g.title} (from chat)`);
      await dispatchWorkflow(AGENT_CONFIG.ghToken, SCHEDULER_REPO, 'agent-tick.yml', { source: 'chain' });
    }
    return { ok: 'chat' };
  } catch (e: any) {
    console.error('[agent.brain] chat failed:', e?.message);
    await sendTelegram(chatId, 'دماغي معطّل للحظة (فشلت جميع مزودات الذكاء). سأتذكر أنك كتبت هذا وأستأنف العمل حين أعود.');
    await episode(b, 'chat-missed', `${from.first_name}: ${text.slice(0, 150)}`);
    return { ok: false, error: 'llm-down' };
  }
}

// ═══════════════════════════════ approvals ═══════════════════════════════════

export async function handleCallback(cq: any): Promise<any> {
  const data = String(cq?.data || '');
  const m = /^appr:([a-z0-9_]+):(a|r)$/.exec(data);
  if (!m) return { skipped: 'unknown-callback' };
  const [, id, choice] = m;
  const approve = choice === 'a';

  const b = await loadMemory();
  const ap = b.approvals.find((a) => a.id === id && a.status === 'pending');
  if (!ap) {
    await answerCallback(cq.id, 'انتهى عليه الحل بالفعل (أو انتهت صلاحيته).');
    return { skipped: 'not-found' };
  }
  ap.status = approve ? 'approved' : 'rejected';
  ap.decidedAt = Date.now();
  await saveApprovals(b);
  const g = b.goals.find((x) => x.id === ap.goalId);
  if (g && g.status === 'waiting_approval') {
    g.status = approve ? 'active' : 'blocked';
    if (!approve) g.notes.push(`owner rejected: ${ap.tool}`);
    await saveGoals(b);
  }
  if (ap.message) await editMessage(ap.message.chatId, ap.message.messageId, `${approve ? '✅ اعتُمد' : '❌ رُفض'} — ${ap.tool}\n${approve ? 'سأنفّذه في دورتي القادمة (خلال ثوانٍ).' : 'لن أفعله.'}`);
  await answerCallback(cq.id, approve ? 'اعتُمد — أنفّذه الآن' : 'رُفض');
  await appendLine('episodic.jsonl', { ts: Date.now(), text: `[${new Date().toISOString()}] approval-${approve ? 'granted' : 'denied'}: ${ap.tool} ${describeArgs(ap.args)}` }, EPISODE_CAP);
  if (approve) await dispatchWorkflow(AGENT_CONFIG.ghToken, SCHEDULER_REPO, 'agent-tick.yml', { source: 'chain' });
  return { ok: approve ? 'approved' : 'rejected' };
}

// ═══════════════════════════════ status ══════════════════════════════════════

function buildStatus(b: MemoryBundle): string {
  const up = Math.round((Date.now() - (b.state.totals.startedAt || Date.now())) / 86400_000);
  const health = llmHealth();
  const lines = [
    `🧠 ${AGENT.nameAr} — حالة الوكيل`,
    `• الوضع: ${b.state.paused ? 'متوقف مؤقتًا' : 'ذاتي'} · عمر التشغيل ${up} يومًا`,
    `• المالك: ${b.state.ownerName || 'لم يُحدَّد بعد'} (${b.state.ownerChatId || '—'})`,
    `• اليوم: ${b.state.counters.ticks} دورة، ${b.state.counters.llm}/${AGENT_CONFIG.LLM_DAILY_CAP} نداء ذكاء`,
    `• الإجماليات: ${b.state.totals.ticks} دورة · ${b.state.totals.goalsDone} هدف منجز · بدأ في ${new Date(b.state.totals.startedAt || Date.now()).toISOString().slice(0, 10)}`,
    `• آخر إجراء: ${b.state.lastAction ? `${b.state.lastAction.tool} (${b.state.lastAction.ok ? 'ناجح' : 'فاشل'}) — ${b.state.lastAction.summary}` : 'لا شيء بعد'}`,
    `• فحوص مجدولة: ${(b.state.scheduled || []).length} · موافقات معلّقة: ${b.approvals.filter((a) => a.status === 'pending').length}`,
    `• اليوم (توقيتي): ${dayKey()} · ${nowParts().alg}`,
    `• مزوّدو الذكاء: جاهز ${health.ready.join('، ') || '—'}${health.parked.length ? ` · موقوف مؤقتًا ${health.parked.join('، ')}` : ''}${health.lastError ? ` · آخر خطأ: ${health.lastError.slice(0, 80)}` : ''}`,
  ];
  const active = b.goals.filter((g) => ['active', 'blocked', 'waiting_approval'].includes(g.status));
  if (active.length) lines.push('', 'الأهداف النشطة:', ...active.map((g) => `#${g.id} ${g.title} [${g.status}]`));
  return lines.join('\n');
}
