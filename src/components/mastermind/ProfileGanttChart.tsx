import { useMemo } from 'react';
import type { DemoPlanSlot } from '../../utils/mastermindDemoPlan';
import { planWindowBounds } from '../../utils/mastermindPlanWindow';
import { DEFAULT_PLAN_WINDOW } from '../../utils/mastermindDemoTypes';

interface Props {
  slots: DemoPlanSlot[];
  planWindow?: typeof DEFAULT_PLAN_WINDOW;
  now?: Date;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export default function ProfileGanttChart({ slots, planWindow = DEFAULT_PLAN_WINDOW, now = new Date() }: Props) {
  const dayStart = useMemo(() => {
    const d = slots[0]?.scheduledAt ?? now;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }, [slots, now]);

  const { startMs, endMs } = planWindowBounds(planWindow, dayStart);
  const spanMs = endMs - startMs;

  const byProfile = useMemo(() => {
    const map = new Map<string, { name: string; slots: DemoPlanSlot[] }>();
    for (const s of slots) {
      const e = map.get(s.profileId) ?? { name: s.profileName, slots: [] };
      e.slots.push(s);
      map.set(s.profileId, e);
    }
    return [...map.entries()]
      .map(([id, v]) => ({ id, name: v.name, slots: v.slots.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [slots]);

  const hourTicks = useMemo(() => {
    const ticks: number[] = [];
    const startHour = Math.floor((startMs - dayStart.getTime()) / 3600000);
    const endHour = Math.ceil((endMs - dayStart.getTime()) / 3600000);
    for (let h = startHour; h <= endHour; h += Math.max(1, Math.floor((endHour - startHour) / 8))) {
      ticks.push(h);
    }
    return ticks;
  }, [startMs, endMs, dayStart]);

  if (!slots.length) {
    return <p className="text-[10px] text-gray-600 py-4 text-center">Gantt ke liye pehle plan generate karo</p>;
  }

  const nowPct = ((now.getTime() - startMs) / spanMs) * 100;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[8px] text-gray-600 px-1 font-mono">
        {hourTicks.map(h => (
          <span key={h}>{pad2(h % 24)}:00</span>
        ))}
      </div>
      <div className="relative border border-gray-800 rounded-xl overflow-hidden bg-gray-950/50 max-h-[60vh] overflow-y-auto">
        {nowPct >= 0 && nowPct <= 100 && (
          <div className="absolute top-0 bottom-0 w-px bg-red-500/60 z-20 pointer-events-none" style={{ left: `${nowPct}%` }} />
        )}
        {byProfile.map(row => (
          <div key={row.id} className="flex items-center gap-2 border-b border-gray-800/60 px-2 py-1.5 min-h-[36px]">
            <span className="w-28 shrink-0 text-[9px] text-gray-400 truncate" title={row.name}>{row.name}</span>
            <div className="relative flex-1 h-6 bg-gray-900/80 rounded">
              {row.slots.map((slot, idx) => {
                const left = ((slot.scheduledAt.getTime() - startMs) / spanMs) * 100;
                const width = Math.max(0.8, ((slot.scheduledEndAt.getTime() - slot.scheduledAt.getTime()) / spanMs) * 100);
                const color = slot.runtimeStatus === 'done'
                  ? 'bg-emerald-600/70'
                  : slot.runtimeStatus === 'running'
                    ? 'bg-blue-500/80'
                    : 'bg-amber-600/60';
                const prev = row.slots[idx - 1];
                const gapSec = slot.profileCooldownSec;
                const gapLeft = prev && gapSec
                  ? ((prev.scheduledEndAt.getTime() - startMs) / spanMs) * 100
                  : null;
                const gapWidth = gapSec ? (gapSec * 1000 / spanMs) * 100 : 0;

                return (
                  <span key={slot.id}>
                    {gapLeft !== null && gapWidth > 0 && (
                      <span
                        className="absolute top-1 h-4 border border-dashed border-gray-600/50 bg-gray-800/40 rounded-sm"
                        style={{ left: `${gapLeft}%`, width: `${Math.max(0.5, gapWidth)}%` }}
                        title={`Profile gap ${Math.round((gapSec ?? 0) / 60)}m`}
                      />
                    )}
                    <span
                      className={`absolute top-1 h-4 rounded-sm ${color} border border-white/10`}
                      style={{ left: `${Math.max(0, left)}%`, width: `${width}%` }}
                      title={`${slot.timeLabel}━━${slot.endTimeLabel} · ${slot.videoTitle} · ${slot.trafficLabel}`}
                    />
                  </span>
                );
              })}
            </div>
            <span className="w-16 shrink-0 text-[8px] text-gray-600 text-right">{row.slots.length}</span>
          </div>
        ))}
      </div>
      <p className="text-[9px] text-gray-600">
        <span className="inline-block w-3 h-2 bg-amber-600/60 rounded-sm mr-1" /> waiting ·
        <span className="inline-block w-3 h-2 bg-blue-500/80 rounded-sm mx-1" /> LIVE ·
        <span className="inline-block w-3 h-2 bg-emerald-600/70 rounded-sm mx-1" /> done ·
        <span className="inline-block w-3 h-2 border border-dashed border-gray-600 mx-1" /> profile close/open gap
      </p>
    </div>
  );
}
