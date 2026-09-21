// ─── Binary — owner dashboard (/) ────────────────────────────────────────────
// Server-rendered Arabic RTL console over the agent's real memory: state,
// goals, provider cortex, scheduled tasks, approvals, episodes, insights.
// Guarded by ?key= (AGENT_TICK_SECRET); open in local dev when no secret
// is configured. No client fetches — refresh reloads from the mind repo.

import {
  Activity, Bell, Brain, Clock, Database, Github, Heart, ListTodo,
  Lock, RefreshCw, ShieldCheck, Target, Terminal, Zap,
} from "lucide-react";
import { AGENT, BUDGETS, REPOS, epochToWall, dzNow } from "@/lib/agent/config";
import { PROVIDERS, llmHealth } from "@/lib/agent/llm";
import { loadMemory } from "@/lib/agent/memory";
import { getWebhookInfo } from "@/lib/agent/telegram";
import { AutoRefresh } from "./auto-refresh";

export const dynamic = "force-dynamic";

// ─── data loading (graceful: the dashboard never crashes on a sick backend) ──
async function loadData() {
  const out: {
    memory: Awaited<ReturnType<typeof loadMemory>> | null;
    error: string;
    webhook: { url: string; pending: number; lastError: string } | null;
  } = { memory: null, error: "", webhook: null };
  try {
    out.memory = await loadMemory();
  } catch (e: unknown) {
    out.error = String((e as Error)?.message || e).slice(0, 200);
  }
  try {
    const wh = await getWebhookInfo();
    if (wh) {
      out.webhook = {
        url: String(wh.url || ""),
        pending: Number(wh.pending_update_count || 0),
        lastError: wh.last_error_message ? String(wh.last_error_message).slice(0, 120) : "",
      };
    }
  } catch { /* telegram probe is decorative */ }
  return out;
}

// ─── page ────────────────────────────────────────────────────────────────────
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const key = typeof sp?.key === "string" ? sp.key : "";
  const secret = process.env.AGENT_TICK_SECRET || "";
  const devOpen = !secret;
  if (!devOpen && key !== secret) return <LockScreen />;

  const { memory: m, error, webhook } = await loadData();
  const health = llmHealth();
  const now = dzNow();

  if (!m) {
    return (
      <Shell dev={devOpen}>
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 max-w-2xl mx-auto mt-16">
          <h2 className="text-lg font-bold text-amber-300 mb-2">تعذّر قراءة الذاكرة من GitHub</h2>
          <p className="text-sm text-zinc-400 leading-7">
            تأكد من ضبط متغير البيئة <code className="text-emerald-300">AGENT_GH_TOKEN</code> بصلاحيات
            مستودع الذاكرة <code className="text-emerald-300">{REPOS.memory}</code>.
          </p>
          {error && <p className="mt-3 text-xs text-zinc-500 font-mono break-all" dir="ltr">{error}</p>}
        </div>
      </Shell>
    );
  }

  const activeGoals = m.goals.filter((g) => g.status === "active");
  const doneGoals = m.goals.filter((g) => g.status === "done");
  const pendingApprovals = m.approvals.filter((a) => a.status === "pending");
  const scheduled = [...m.state.scheduled].sort((a, b) => a.dueAt - b.dueAt);
  const snapshotReady = m.state.llmSnapshot?.ready || [];
  const llmPct = Math.min(100, Math.round((m.state.counters.llm / BUDGETS.llmDaily) * 100));
  const tickPct = Math.min(100, Math.round((m.state.counters.ticks / BUDGETS.ticksDaily) * 100));

  return (
    <Shell dev={devOpen}>
      {/* header */}
      <header className="flex flex-wrap items-center gap-4 justify-between">
        <div className="flex items-center gap-4">
          <div className="h-14 w-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 grid place-items-center">
            <Brain className="h-7 w-7 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">
              {AGENT.nameAr} <span className="text-zinc-500 font-semibold text-lg">Binary</span>
            </h1>
            <p className="text-sm text-zinc-400">الوكيل الذكي المستقل — @{AGENT.username} · {AGENT.homeAr}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold border ${
            m.state.paused
              ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
              : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
          }`}>
            <Heart className="h-4 w-4" />
            {m.state.paused ? "متوقف مؤقتًا" : "أعمل"}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm text-zinc-300 border border-zinc-700 bg-zinc-900">
            <Clock className="h-4 w-4 text-emerald-400" />
            {now.wall} بتوقيت الجزائر
          </span>
        </div>
      </header>

      {/* row 1: status + cortex */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="الميزانية اليومية" icon={<Zap className="h-4 w-4" />}>
          <Meter label="نداءات الذكاء الاصطناعي" value={m.state.counters.llm} max={BUDGETS.llmDaily} pct={llmPct} />
          <Meter label="النبضات" value={m.state.counters.ticks} max={BUDGETS.ticksDaily} pct={tickPct} />
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Stat label="أهداف نشطة" value={activeGoals.length} />
            <Stat label="أهداف منجزة" value={m.state.totals.goalsDone} />
            <Stat label="مربوطة بالسلاسل" value={m.state.chainCount} />
          </div>
          <p className="mt-4 text-xs text-zinc-500 leading-6">
            إجمالي منذ الإنشاء: {m.state.totals.ticks} نبضة · {m.state.totals.llm} نداء ذكاء
          </p>
        </Card>

        <Card title="قشرة الذكاء — سباق المزودات" icon={<Activity className="h-4 w-4" />} className="lg:col-span-2">
          <div className="space-y-3">
            {([1, 2, 3] as const).map((wave) => {
              const names = Object.entries(PROVIDERS).filter(([, p]) => p.wave === wave).map(([n]) => n);
              return (
                <div key={wave} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-zinc-500 w-20 shrink-0">
                    الموجة {wave === 1 ? "١ — القوية" : wave === 2 ? "٢ — الاحتياط" : "٣ — الشبكة الواسعة"}
                  </span>
                  {names.map((name) => {
                    const def = PROVIDERS[name];
                    const hasKey = def.keyless || Boolean(process.env[def.keyEnv]);
                    const parked = health.parked.some((p) => p.provider === name);
                    const snapOk = snapshotReady.includes(name);
                    return (
                      <span key={name} title={def.note || name} className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium border ${
                        !hasKey
                          ? "bg-zinc-900 text-zinc-600 border-zinc-800"
                          : parked
                            ? "bg-red-500/10 text-red-300 border-red-500/30"
                            : snapOk
                              ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40"
                              : "bg-zinc-800/60 text-zinc-300 border-zinc-700"
                      }`} dir="ltr">
                        {name}
                        {!hasKey && <span className="text-zinc-600">· بدون مفتاح</span>}
                        {hasKey && parked && <span className="text-red-400">· معطّل مؤقتًا</span>}
                      </span>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="mt-4 pt-4 border-t border-zinc-800 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
            <span>آخر مزود أجاب: <b className="text-zinc-300" dir="ltr">{m.state.llmSnapshot?.lastProvider || "—"}</b></span>
            {m.state.llmSnapshot?.lastError && (
              <span>آخر خطأ: <b className="text-amber-400" dir="ltr">{m.state.llmSnapshot.lastError.slice(0, 60)}</b></span>
            )}
            <span>المرابطة الآن: {health.readyCount} جاهز · {health.parked.length} معطّل</span>
          </div>
        </Card>
      </div>

      {/* row 2: goals + scheduled */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`الأهداف النشطة (${activeGoals.length})`} icon={<Target className="h-4 w-4" />}>
          {activeGoals.length === 0 ? (
            <p className="text-sm text-zinc-500">لا أهداف نشطة — أرسل "goal: عنوان الهدف" للوكيل عبر تلغرام.</p>
          ) : (
            <ul className="space-y-3 max-h-96 overflow-y-auto nice-scroll pe-1">
              {activeGoals.map((g) => {
                const done = g.subtasks.filter((s) => s.done).length;
                const pct = g.subtasks.length ? Math.round((done / g.subtasks.length) * 100) : 0;
                const isCurrent = m.state.currentTask?.goalId === g.id;
                return (
                  <li key={g.id} className={`rounded-xl border p-3 ${isCurrent ? "border-emerald-500/40 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900/40"}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm">{g.title}</span>
                      {isCurrent && <span className="text-[11px] text-emerald-300 font-semibold">قيد العمل الآن</span>}
                    </div>
                    {g.subtasks.length > 0 && (
                      <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    <div className="mt-1.5 text-xs text-zinc-500" dir="ltr">{g.id} · {done}/{g.subtasks.length} مهام فرعية</div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title={`المهام المجدولة (${scheduled.length})`} icon={<Bell className="h-4 w-4" />}>
          {scheduled.length === 0 ? (
            <p className="text-sm text-zinc-500">لا مهام مجدولة.</p>
          ) : (
            <ul className="space-y-2 max-h-96 overflow-y-auto nice-scroll pe-1">
              {scheduled.slice(0, 12).map((t) => {
                const overdue = t.dueAt <= Date.now();
                return (
                  <li key={t.id} className={`flex items-center justify-between gap-3 rounded-xl border p-3 text-sm ${overdue ? "border-amber-500/40 bg-amber-500/5" : "border-zinc-800 bg-zinc-900/40"}`}>
                    <span>{t.what}</span>
                    <span className={`text-xs font-mono shrink-0 ${overdue ? "text-amber-300" : "text-zinc-500"}`} dir="ltr">
                      {epochToWall(t.dueAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {pendingApprovals.length > 0 && (
            <div className="mt-4 pt-4 border-t border-zinc-800">
              <p className="text-xs font-semibold text-amber-300 mb-2 flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5" /> طلبات اعتماد معلّقة ({pendingApprovals.length})
              </p>
              {pendingApprovals.slice(0, 3).map((a) => (
                <p key={a.id} className="text-xs text-zinc-400 leading-6">• {a.title}</p>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* row 3: identity + episodes + insights */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="من أنا (الذاكرة طويلة الأمد)" icon={<Brain className="h-4 w-4" />}>
          <pre className="text-sm text-zinc-300 leading-7 whitespace-pre-wrap font-sans">{m.identity.slice(0, 900)}</pre>
          {m.insightTail.length > 0 && (
            <div className="mt-4 pt-4 border-t border-zinc-800 space-y-1.5">
              <p className="text-xs font-semibold text-zinc-500 flex items-center gap-1.5"><Database className="h-3.5 w-3.5" /> دروس متراكمة</p>
              {m.insightTail.slice(-4).map((l, i) => {
                let text = l;
                try { text = JSON.parse(l).text || l; } catch { /* raw line */ }
                return <p key={i} className="text-xs text-zinc-400 leading-6">• {String(text).slice(0, 140)}</p>;
              })}
            </div>
          )}
        </Card>

        <Card title="سجل التجارب (آخر الأحداث)" icon={<Terminal className="h-4 w-4" />} className="lg:col-span-2">
          <ul className="space-y-1.5 max-h-96 overflow-y-auto nice-scroll pe-1 font-mono text-xs" dir="ltr">
            {[...m.episodeTail].reverse().slice(0, 18).map((l, i) => {
              let text = l;
              try { const d = JSON.parse(l); text = `[${new Date(d.ts).toISOString().slice(5, 16)}] ${d.text || ""}`; } catch { /* raw */ }
              return (
                <li key={i} className="text-zinc-400 leading-5 whitespace-pre-wrap break-all">
                  {String(text).slice(0, 220)}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      {/* footer facts */}
      <footer className="text-xs text-zinc-600 flex flex-wrap gap-x-6 gap-y-2 items-center border-t border-zinc-800/60 pt-4">
        <span className="inline-flex items-center gap-1.5"><Github className="h-3.5 w-3.5" /> <span dir="ltr">{REPOS.scheduler}</span></span>
        <span className="inline-flex items-center gap-1.5"><ListTodo className="h-3.5 w-3.5" /> الذاكرة: <span dir="ltr">{REPOS.memory}</span></span>
        {webhook?.url && (
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Webhook: <span dir="ltr" className="text-zinc-500">{webhook.url.replace("https://", "")}</span>
            {webhook.pending > 0 && <b className="text-amber-400"> ({webhook.pending} معلّقة)</b>}
            {webhook.lastError && <b className="text-red-400"> خطأ أخير</b>}
          </span>
        )}
        <span className="ms-auto">مستودع واحد · أسرار في البيئة فقط · حزمة مجانية بالكامل</span>
      </footer>
    </Shell>
  );
}

// ─── shell / shared pieces ───────────────────────────────────────────────────
function Shell({ children, dev }: { children: React.ReactNode; dev: boolean }) {
  return (
    <main className="min-h-screen max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
      {dev && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-300">
          وضع التطوير المحلي — لوحة القيادة مفتوحة لأن AGENT_TICK_SECRET غير مضبوط. في الإنتاج تُقفل بمفتاح سري.
        </div>
      )}
      {children}
      <AutoRefresh seconds={30} />
    </main>
  );
}

function Card({ title, icon, children, className = "" }: {
  title: string; icon: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5 ${className}`}>
      <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-300 mb-4">
        <span className="text-emerald-400">{icon}</span> {title}
      </h2>
      {children}
    </section>
  );
}

function Meter({ label, value, max, pct }: { label: string; value: number; max: number; pct: number }) {
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-zinc-400">{label}</span>
        <span className="font-mono text-zinc-300" dir="ltr">{value}/{max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full rounded-full ${pct > 85 ? "bg-amber-400" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl bg-zinc-900/60 border border-zinc-800 py-2">
      <div className="text-lg font-bold" dir="ltr">{value}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  );
}

function LockScreen() {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <div className="mx-auto mb-4 h-14 w-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 grid place-items-center">
          <Lock className="h-6 w-6 text-emerald-400" />
        </div>
        <h1 className="text-xl font-bold mb-2">بيناري — لوحة القيادة</h1>
        <p className="text-sm text-zinc-400 leading-7 mb-6">هذه اللوحة محمية بمفتاح سري. أدخل المفتاح للمتابعة.</p>
        <form method="GET" action="/" className="flex gap-2">
          <input
            name="key"
            type="password"
            placeholder="المفتاح السري"
            className="flex-1 rounded-xl bg-zinc-950 border border-zinc-800 px-4 py-2.5 text-sm outline-none focus:border-emerald-500/50"
          />
          <button type="submit" className="rounded-xl bg-emerald-500/90 hover:bg-emerald-400 text-zinc-950 font-bold px-5 text-sm transition-colors">
            دخول
          </button>
        </form>
      </div>
    </main>
  );
}
