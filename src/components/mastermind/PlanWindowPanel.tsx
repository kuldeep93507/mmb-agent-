import { Clock, Target, Calendar } from 'lucide-react';
import type { DemoCampaignDefaults, DemoHourlyViewTarget, DemoPlanWindow } from '../../utils/mastermindDemoTypes';
import { formatWindowLabel, planWindowBounds } from '../../utils/mastermindPlanWindow';

interface Props {
  defaults: DemoCampaignDefaults;
  onChange: (d: DemoCampaignDefaults) => void;
  readOnly?: boolean;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export default function PlanWindowPanel({ defaults, onChange, readOnly }: Props) {
  const w = defaults.planWindow;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const { startMs, endMs } = planWindowBounds(w, dayStart);
  const visibleHours = (() => {
    if (w.mode === '24h') return Array.from({ length: 24 }, (_, i) => i);
    if (w.mode === '1h') return [w.oneHourStart];
    const hrs: number[] = [];
    let t = startMs;
    while (t < endMs && hrs.length < 24) {
      const h = new Date(t).getHours();
      if (!hrs.includes(h)) hrs.push(h);
      t += 3600000;
    }
    return hrs.length ? hrs : [w.customStartHour];
  })();

  const patchWindow = (patch: Partial<DemoPlanWindow>) => {
    onChange({ ...defaults, planWindow: { ...w, ...patch } });
  };

  const patchHourTarget = (hour: number, views: number) => {
    const existing = defaults.hourlyViewTargets.filter(t => t.hour !== hour);
    const next: DemoHourlyViewTarget[] = views > 0
      ? [...existing, { hour, views }]
      : existing;
    onChange({ ...defaults, hourlyViewTargets: next.sort((a, b) => a.hour - b.hour) });
  };

  const getHourViews = (hour: number) =>
    defaults.hourlyViewTargets.find(t => t.hour === hour)?.views ?? 0;

  const hourlyTotal = defaults.hourlyViewTargets.reduce((s, t) => s + t.views, 0);

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 space-y-4">
      <div>
        <p className="text-xs uppercase tracking-wide text-gray-400 font-semibold flex items-center gap-2">
          <Clock size={14} className="text-amber-400" /> Plan window — 24h / 1h / custom
        </p>
        <p className="text-sm text-amber-200/90 mt-1 font-medium">{formatWindowLabel(w)}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['24h', '1h', 'custom'] as const).map(mode => (
          <button key={mode} type="button" disabled={readOnly}
            onClick={() => patchWindow({ mode })}
            className={`px-4 py-2 rounded-lg text-xs font-semibold border ${
              w.mode === mode ? 'border-amber-500 bg-amber-900/30 text-amber-100' : 'border-gray-700 text-gray-500'
            }`}>
            {mode === '24h' ? 'Poora din (24h)' : mode === '1h' ? 'Sirf 1 ghanta' : 'Custom range'}
          </button>
        ))}
      </div>

      {w.mode === '1h' && (
        <label className="flex items-center gap-3 text-sm text-gray-300">
          Kaunsa ghanta:
          <select disabled={readOnly} value={w.oneHourStart}
            onChange={e => patchWindow({ oneHourStart: Number(e.target.value) })}
            className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{pad2(h)}:00 – {pad2(h)}:59</option>
            ))}
          </select>
        </label>
      )}

      {w.mode === 'custom' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TimeField label="Start time" hour={w.customStartHour} minute={w.customStartMinute} readOnly={readOnly}
            onChange={(h, m) => patchWindow({ customStartHour: h, customStartMinute: m })} />
          <TimeField label="End time" hour={w.customEndHour} minute={w.customEndMinute} readOnly={readOnly}
            onChange={(h, m) => patchWindow({ customEndHour: h, customEndMinute: m })} />
          <label className="flex flex-col gap-1 text-sm text-gray-400">
            <span className="flex items-center gap-1"><Target size={12} className="text-amber-400" /> Window views (optional)</span>
            <input type="number" min={0} disabled={readOnly}
              value={w.windowViewGoal ?? ''}
              placeholder="sab traffic use hoga"
              onChange={e => patchWindow({ windowViewGoal: e.target.value ? Math.max(0, Number(e.target.value)) : undefined })}
              className="bg-gray-950 border border-gray-700 rounded-lg px-3 py-2 text-white font-mono text-sm" />
          </label>
        </div>
      )}

      {hourlyTotal > 0 && (
        <p className="text-sm text-violet-300 bg-violet-950/30 border border-violet-800/40 rounded-xl px-4 py-3">
          AI / plan se <strong className="text-white">{hourlyTotal}</strong> views ghanton me set hain — manual change sirf advanced ke liye
        </p>
      )}

      <div className="border-2 border-gray-700 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 bg-gray-900/80 border-b border-gray-700 flex items-center justify-between">
          <p className="text-sm text-white font-bold flex items-center gap-2">
            <Calendar size={16} className="text-amber-400" /> Har ghante kitne views (advanced)
          </p>
          <span className="text-base text-amber-400 font-mono font-bold">Total: {hourlyTotal || '—'}</span>
        </div>
        <div className="divide-y divide-gray-800/60 max-h-80 overflow-y-auto">
          {visibleHours.map(hour => (
            <div key={hour} className="flex items-center gap-6 px-5 py-4 hover:bg-gray-900/40">
              <div className="w-24 shrink-0">
                <p className="text-2xl font-bold text-amber-400 font-mono">{pad2(hour)}:00</p>
              </div>
              <div className="flex-1">
                <input type="number" min={0} disabled={readOnly}
                  value={getHourViews(hour) || ''}
                  placeholder="0"
                  onChange={e => patchHourTarget(hour, Math.max(0, Number(e.target.value) || 0))}
                  className="w-full max-w-[160px] bg-gray-950 border-2 border-gray-600 rounded-xl px-4 py-3 text-white font-mono text-2xl font-bold text-center" />
              </div>
              {getHourViews(hour) > 0 && (
                <span className="text-sm text-emerald-400 font-bold shrink-0">{getHourViews(hour)} views</span>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 px-5 py-3 border-t border-gray-800">
          AI Goal Planner use kiya ho to yahan haath mat lagao — wahan se auto aata hai
        </p>
      </div>
    </div>
  );
}

function TimeField({ label, hour, minute, readOnly, onChange }: {
  label: string; hour: number; minute: number; readOnly?: boolean;
  onChange: (h: number, m: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm text-gray-400">
      <span>{label}</span>
      <div className="flex items-center gap-2">
        <input type="number" min={0} max={23} disabled={readOnly} value={hour}
          onChange={e => onChange(Math.min(23, Math.max(0, Number(e.target.value) || 0)), minute)}
          className="w-16 bg-gray-950 border border-gray-700 rounded-lg px-2 py-2 text-white font-mono text-lg text-center" />
        <span className="text-gray-500 text-lg">:</span>
        <input type="number" min={0} max={59} disabled={readOnly} value={minute}
          onChange={e => onChange(hour, Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
          className="w-16 bg-gray-950 border border-gray-700 rounded-lg px-2 py-2 text-white font-mono text-lg text-center" />
      </div>
    </label>
  );
}
