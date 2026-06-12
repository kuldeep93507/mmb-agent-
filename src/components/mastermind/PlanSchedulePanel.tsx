/**
 * Plan shift (kal / custom date) + 2–3 day advance calendar + timing jitter
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays, Clock, Shuffle, ChevronRight, Trash2, Play,
  Loader2, CheckCircle2, AlertCircle, RefreshCw,
} from 'lucide-react';
import type { DemoCampaignPlan } from '../../utils/mastermindDemoPlan';
import {
  addCalendarDays,
  buildMultiDayPlans,
  jitterPlanTiming,
  planSummaryLine,
  shiftPlanToDate,
} from '../../utils/mastermindPlanShift';
import { todayDayKey } from '../../utils/mastermindSessionTime';
import {
  deleteScheduledPlan,
  fetchScheduledPlans,
  planFromServerEntry,
  saveMastermindPlan,
  saveScheduledPlan,
  type MastermindScheduledPlan,
} from '../../utils/mastermindApi';

interface Props {
  plan: DemoCampaignPlan;
  backendReady: boolean;
  onPlanChange: (plan: DemoCampaignPlan) => void;
  onStartRealRun?: (plan: DemoCampaignPlan) => void;
}

function tomorrowDateStr() {
  return todayDayKey(addCalendarDays(new Date(), 1));
}

export default function PlanSchedulePanel({
  plan,
  backendReady,
  onPlanChange,
  onStartRealRun,
}: Props) {
  const [targetDate, setTargetDate] = useState(tomorrowDateStr());
  const [jitterMin, setJitterMin] = useState(3);
  const [jitterMax, setJitterMax] = useState(18);
  const [dayCount, setDayCount] = useState<2 | 3>(3);
  const [autoStartQueue, setAutoStartQueue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<MastermindScheduledPlan[]>([]);

  const loadScheduled = useCallback(async () => {
    const list = await fetchScheduledPlans();
    setScheduled(list);
  }, []);

  useEffect(() => {
    void loadScheduled();
  }, [loadScheduled, plan.dayKey]);

  const previewShift = useMemo(() => {
    const [y, m, d] = targetDate.split('-').map(Number);
    const target = new Date(y, m - 1, d, 0, 0, 0, 0);
    return shiftPlanToDate(plan, target, {
      jitterMinMin: jitterMin,
      jitterMaxMin: jitterMax,
      planNameSuffix: `shift preview`,
    });
  }, [plan, targetDate, jitterMin, jitterMax]);

  const applyShift = async (dateStr: string, label: string) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1, d, 0, 0, 0, 0);
    const shifted = shiftPlanToDate(plan, target, {
      jitterMinMin: jitterMin,
      jitterMaxMin: jitterMax,
      planNameSuffix: label,
    });
    onPlanChange(shifted);
    setMsg(`✓ Plan shift ho gaya → ${dateStr} (jitter ${jitterMin}–${jitterMax} min)`);
    await saveMastermindPlan(shifted, label);
  };

  const applyJitterOnly = () => {
    const next = jitterPlanTiming(plan, jitterMin, jitterMax);
    onPlanChange(next);
    setMsg(`✓ Isi din timing adjust — ±${jitterMin}–${jitterMax} min (pattern break)`);
  };

  const queueMultiDay = async () => {
    if (!backendReady) {
      setMsg('Backend offline — START.bat chalao');
      return;
    }
    setBusy(true);
    setMsg(null);
    const [y, m, d] = targetDate.split('-').map(Number);
    const first = new Date(y, m - 1, d, 0, 0, 0, 0);
    const plans = buildMultiDayPlans(plan, first, dayCount, {
      jitterMinMin: jitterMin,
      jitterMaxMin: jitterMax,
    });
    let ok = 0;
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const res = await saveScheduledPlan({
        plan: p,
        targetDate: p.dayKey,
        name: `Day ${i + 1} · ${p.dayKey} · ${p.totalSlots} slots`,
        autoStart: autoStartQueue,
      });
      if (res.ok) ok++;
      await saveMastermindPlan(p, `Scheduled Day ${i + 1}`);
    }
    await loadScheduled();
    setBusy(false);
    setMsg(ok === plans.length
      ? `✓ ${ok} din queue me save — auto-start ${autoStartQueue ? 'ON' : 'OFF'}`
      : `⚠ Sirf ${ok}/${plans.length} save hua`);
  };

  const queueCurrentShift = async () => {
    if (!backendReady) return;
    setBusy(true);
    const res = await saveScheduledPlan({
      plan: previewShift,
      targetDate: previewShift.dayKey,
      name: `Shift · ${previewShift.dayKey} · ${previewShift.totalSlots} slots`,
      autoStart: autoStartQueue,
    });
    if (res.ok) {
      await saveMastermindPlan(previewShift, `Shift ${previewShift.dayKey}`);
      await loadScheduled();
      setMsg(`✓ Queue me save — ${previewShift.dayKey}`);
    } else {
      setMsg(res.error || 'Save fail');
    }
    setBusy(false);
  };

  const loadScheduledPlan = (entry: MastermindScheduledPlan) => {
    if (!entry.plan) return;
    const loaded = planFromServerEntry({ plan: entry.plan });
    onPlanChange(loaded);
    setMsg(`Loaded: ${entry.name}`);
  };

  const removeScheduled = async (id: string) => {
    await deleteScheduledPlan(id);
    await loadScheduled();
  };

  return (
    <div className="space-y-4">
      {/* Shift + jitter */}
      <div className="rounded-2xl border-2 border-cyan-800/50 bg-cyan-950/20 p-5 space-y-4">
        <p className="text-sm font-bold text-cyan-200 uppercase flex items-center gap-2">
          <CalendarDays size={18} /> Plan shift — kal / kisi bhi din + timing alag
        </p>
        <p className="text-xs text-gray-400">
          Same settings & videos — sirf date shift + thoda time jitter taaki kal ka pattern aaj jaisa na lage.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block font-medium">Target date</span>
            <input type="date" value={targetDate} min={todayDayKey(new Date())}
              onChange={e => setTargetDate(e.target.value)}
              className="w-full bg-gray-950 border-2 border-gray-600 rounded-xl px-3 py-2.5 text-white font-mono text-sm" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block font-medium">Jitter min (min)</span>
            <input type="number" min={0} max={60} value={jitterMin}
              onChange={e => setJitterMin(Math.max(0, Number(e.target.value) || 0))}
              className="w-full bg-gray-950 border-2 border-gray-600 rounded-xl px-3 py-2.5 text-white font-mono text-lg font-bold text-center" />
          </label>
          <label className="block">
            <span className="text-xs text-gray-500 mb-1 block font-medium">Jitter max (min)</span>
            <input type="number" min={0} max={90} value={jitterMax}
              onChange={e => setJitterMax(Math.max(jitterMin, Number(e.target.value) || jitterMin))}
              className="w-full bg-gray-950 border-2 border-gray-600 rounded-xl px-3 py-2.5 text-white font-mono text-lg font-bold text-center" />
          </label>
          <label className="flex items-end gap-2 pb-1">
            <input type="checkbox" checked={autoStartQueue} onChange={e => setAutoStartQueue(e.target.checked)}
              className="rounded w-4 h-4" />
            <span className="text-sm text-gray-300">Queue me auto-start</span>
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy}
            onClick={() => void applyShift(tomorrowDateStr(), 'Kal · shifted')}
            className="px-4 py-2.5 rounded-xl bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-bold disabled:opacity-50">
            → Kal shift karo
          </button>
          <button type="button" disabled={busy}
            onClick={() => void applyShift(targetDate, `Shift · ${targetDate}`)}
            className="px-4 py-2.5 rounded-xl bg-gray-800 border border-gray-600 text-white text-sm font-semibold disabled:opacity-50">
            Is date pe shift
          </button>
          <button type="button" disabled={busy} onClick={applyJitterOnly}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-violet-900/50 border border-violet-600 text-violet-100 text-sm font-semibold disabled:opacity-50">
            <Shuffle size={14} /> Sirf timing mix (aaj)
          </button>
          <button type="button" disabled={busy || !backendReady}
            onClick={() => void queueCurrentShift()}
            className="px-4 py-2.5 rounded-xl bg-emerald-800/60 border border-emerald-600 text-emerald-100 text-sm font-bold disabled:opacity-50">
            Queue me save (shift preview)
          </button>
        </div>

        <div className="bg-gray-950/60 border border-gray-800 rounded-xl px-4 py-3 text-xs text-gray-400">
          <span className="text-cyan-400 font-semibold">Preview:</span>{' '}
          {planSummaryLine(previewShift)}
        </div>
      </div>

      {/* Multi-day calendar */}
      <div className="rounded-2xl border-2 border-violet-800/50 bg-violet-950/20 p-5 space-y-4">
        <p className="text-sm font-bold text-violet-200 uppercase flex items-center gap-2">
          <Clock size={18} /> 2–3 din advance calendar
        </p>
        <p className="text-xs text-gray-400">
          Pehle se Day 1, 2, 3 plan bana ke chhod do — har din alag jitter. Backend + PC on ho to slot time pe auto-start.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-gray-400">Pehla din:</span>
          <input type="date" value={targetDate} min={todayDayKey(new Date())}
            onChange={e => setTargetDate(e.target.value)}
            className="bg-gray-950 border border-gray-600 rounded-lg px-3 py-2 text-white font-mono text-sm" />
          <div className="flex gap-1">
            {([2, 3] as const).map(n => (
              <button key={n} type="button" onClick={() => setDayCount(n)}
                className={`px-4 py-2 rounded-lg text-sm font-bold border ${
                  dayCount === n ? 'border-violet-500 bg-violet-900/40 text-violet-100' : 'border-gray-700 text-gray-500'
                }`}>
                {n} din
              </button>
            ))}
          </div>
          <button type="button" disabled={busy || !backendReady}
            onClick={() => void queueMultiDay()}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-bold disabled:opacity-50">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <CalendarDays size={16} />}
            {dayCount} din queue me banao
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {buildMultiDayPlans(
            plan,
            (() => {
              const [y, m, d] = targetDate.split('-').map(Number);
              return new Date(y, m - 1, d, 0, 0, 0, 0);
            })(),
            dayCount,
            { jitterMinMin: jitterMin, jitterMaxMin: jitterMax },
          ).map((p, i) => (
            <div key={p.dayKey} className="bg-gray-900/60 border border-gray-800 rounded-xl p-3">
              <p className="text-white font-bold text-sm">Day {i + 1}</p>
              <p className="text-xs text-violet-300 font-mono mt-1">{p.dayKey}</p>
              <p className="text-[10px] text-gray-500 mt-1">{p.totalSlots} slots · jitter alag</p>
            </div>
          ))}
        </div>
      </div>

      {/* Scheduled queue list */}
      <div className="rounded-2xl border border-gray-700 bg-gray-900/60 p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-white flex items-center gap-2">
            <ChevronRight size={16} className="text-emerald-400" /> Scheduled queue
          </p>
          <button type="button" onClick={() => void loadScheduled()}
            className="text-xs text-gray-500 hover:text-white flex items-center gap-1">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {!scheduled.length && (
          <p className="text-xs text-gray-600 py-4 text-center">Koi scheduled plan nahi — upar se queue banao</p>
        )}

        <div className="space-y-2 max-h-56 overflow-y-auto">
          {scheduled.map(entry => (
            <div key={entry.id} className="flex flex-wrap items-center gap-2 bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2.5">
              <StatusBadge status={entry.status} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white font-semibold truncate">{entry.name}</p>
                <p className="text-[10px] text-gray-500">
                  {entry.targetDate} · {entry.totalSlots ?? '—'} slots
                  {entry.autoStart && ' · auto-start'}
                </p>
              </div>
              <button type="button" onClick={() => loadScheduledPlan(entry)}
                className="text-xs px-2 py-1 rounded-lg bg-gray-800 text-gray-300 hover:text-white">
                Load
              </button>
              {onStartRealRun && entry.plan && entry.status === 'pending' && (
                <button type="button"
                  onClick={() => onStartRealRun(planFromServerEntry({ plan: entry.plan! }))}
                  className="text-xs px-2 py-1 rounded-lg bg-emerald-800 text-emerald-100 flex items-center gap-1">
                  <Play size={10} /> Run
                </button>
              )}
              <button type="button" onClick={() => void removeScheduled(entry.id)}
                className="p-1.5 rounded-lg text-red-400 hover:bg-red-950/40">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-gray-600">
          Auto-start: backend har 30s check karta hai — jis din ka pehla slot due ho, Real Run khud start.
          PC + START.bat + MoreLogin chalu rakho.
        </p>
      </div>

      {msg && (
        <p className={`text-xs flex items-center gap-1.5 ${msg.startsWith('✓') ? 'text-emerald-400' : msg.startsWith('⚠') ? 'text-amber-400' : 'text-red-400'}`}>
          {msg.startsWith('✓') ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {msg}
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-amber-950/50 text-amber-300 border-amber-700/50',
    active: 'bg-blue-950/50 text-blue-300 border-blue-700/50',
    done: 'bg-emerald-950/50 text-emerald-300 border-emerald-700/50',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${colors[status] ?? colors.pending}`}>
      {status}
    </span>
  );
}
