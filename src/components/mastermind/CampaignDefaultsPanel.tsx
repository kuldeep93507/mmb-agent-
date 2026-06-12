import { Layers, Route, Timer, Repeat, Shuffle, SkipForward } from 'lucide-react';
import type { DemoCampaignDefaults, DemoTrafficQuotas, TrafficSourceKey } from '../../utils/mastermindDemoTypes';
import { TRAFFIC_QUOTA_LABELS, trafficQuotasTotal, DEFAULT_TRAFFIC_ENTRY_SEC } from '../../utils/mastermindDemoTypes';
import { useDisabledTrafficSources } from '../../hooks/useDisabledTrafficSources';
import type { DemoTrafficProjection } from '../../utils/mastermindDemoPlan';
import { AdControlSettings } from '../shared/AdControlSettings';

interface Props {
  defaults: DemoCampaignDefaults;
  onChange: (d: DemoCampaignDefaults) => void;
  trafficProjection?: DemoTrafficProjection[] | null;
  readOnly?: boolean;
}

export default function CampaignDefaultsPanel({ defaults, onChange, trafficProjection, readOnly }: Props) {
  const { isEnabled } = useDisabledTrafficSources();
  const patch = <K extends keyof DemoCampaignDefaults>(key: K, val: DemoCampaignDefaults[K]) => {
    onChange({ ...defaults, [key]: val });
  };

  const patchQuota = (key: TrafficSourceKey, field: 'viewCount' | 'profileMode', val: number | 'reuse' | 'rotate') => {
    const q = defaults.trafficQuotas[key];
    onChange({
      ...defaults,
      trafficQuotas: {
        ...defaults.trafficQuotas,
        [key]: field === 'viewCount'
          ? { ...q, viewCount: Math.max(0, val as number) }
          : { ...q, profileMode: val as 'reuse' | 'rotate' },
      },
    });
  };

  const patchEntry = (key: TrafficSourceKey, field: 'entryMinSec' | 'entryMaxSec', val: number) => {
    const cur = defaults.trafficEntrySec?.[key] ?? DEFAULT_TRAFFIC_ENTRY_SEC[key];
    onChange({
      ...defaults,
      trafficEntrySec: {
        ...DEFAULT_TRAFFIC_ENTRY_SEC,
        ...defaults.trafficEntrySec,
        [key]: { ...cur, [field]: Math.max(0, val) },
      },
    });
  };

  const totalViews = trafficQuotasTotal(defaults.trafficQuotas);

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 space-y-4 w-full">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold flex items-center gap-1">
        <Layers size={12} /> Campaign defaults · tabs · traffic views · stagger
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 text-xs">
        <Num label="Watch min %" value={defaults.watchTimeMin} readOnly={readOnly} onChange={v => patch('watchTimeMin', v)} />
        <Num label="Watch max %" value={defaults.watchTimeMax} readOnly={readOnly} onChange={v => patch('watchTimeMax', v)} />
        <Num label="Volume min %" value={defaults.volumeMin} readOnly={readOnly} onChange={v => patch('volumeMin', v)} />
        <Num label="Volume max %" value={defaults.volumeMax} readOnly={readOnly} onChange={v => patch('volumeMax', v)} />
        <Num label="Stagger batch" value={defaults.staggerBatchSize} readOnly={readOnly} onChange={v => patch('staggerBatchSize', Math.max(1, v))} />
        <Num label="Stagger gap max s" value={defaults.staggerDelayMaxSec} readOnly={readOnly} onChange={v => patch('staggerDelayMaxSec', v)} />
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2 text-gray-400">
          <input type="checkbox" disabled={readOnly} checked={defaults.scrollEnabled} onChange={e => patch('scrollEnabled', e.target.checked)} className="rounded" />
          Scroll ON
        </label>
        <label className="flex items-center gap-2 text-gray-400">
          <input type="checkbox" disabled={readOnly} checked={defaults.scrollNoClick} onChange={e => patch('scrollNoClick', e.target.checked)} className="rounded" />
          Scroll me click BAND (SHA-256 curves)
        </label>
        <label className="flex items-center gap-2 text-gray-400">
          <input type="checkbox" disabled={readOnly} checked={defaults.hourlyTrafficCurve} onChange={e => patch('hourlyTrafficCurve', e.target.checked)} className="rounded" />
          Hourly curve (subah search · shaam notification)
        </label>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div>
          <p className="text-[10px] text-gray-500 mb-2">Tabs per profile</p>
          <div className="flex gap-2">
            {([1, 2, 3] as const).map(n => (
              <button key={n} type="button" disabled={readOnly} onClick={() => patch('tabsPerProfile', n)}
                className={`px-4 py-2 rounded-lg text-xs font-semibold border ${defaults.tabsPerProfile === n ? 'border-amber-500 bg-amber-900/30 text-amber-100' : 'border-gray-700 text-gray-500'}`}>
                {n} tab{n > 1 ? 's' : ''}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-purple-800/40 bg-purple-950/15 p-3">
          <p className="text-[10px] text-purple-300 font-semibold uppercase flex items-center gap-1 mb-2">
            <Timer size={11} /> Tab open gaps (seconds) — hamesha set karo
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Num label="Tab-2 gap min" value={defaults.tab2GapMin} readOnly={readOnly} onChange={v => patch('tab2GapMin', v)} />
            <Num label="Tab-2 gap max" value={defaults.tab2GapMax} readOnly={readOnly} onChange={v => patch('tab2GapMax', v)} />
            <Num label="Tab-3 gap min" value={defaults.tab3GapMin} readOnly={readOnly} onChange={v => patch('tab3GapMin', v)} />
            <Num label="Tab-3 gap max" value={defaults.tab3GapMax} readOnly={readOnly} onChange={v => patch('tab3GapMax', v)} />
          </div>
          <p className="text-[9px] text-gray-600 mt-1">
            {defaults.tabsPerProfile === 1 ? '1 tab mode — gaps tab-2/3 ke liye ready rahenge' : `${defaults.tabsPerProfile} tabs — gap apply hoga`}
          </p>
        </div>

        <div className="rounded-lg border border-orange-800/40 bg-orange-950/15 p-3 space-y-2">
          <p className="text-[10px] text-orange-300 font-semibold uppercase flex items-center gap-1">
            <Timer size={11} /> Smart profile — band kab? open kab?
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <Num label="Gap &lt; min → OPEN rakho" value={defaults.keepProfileOpenIfGapUnderMin} readOnly={readOnly}
              onChange={v => patch('keepProfileOpenIfGapUnderMin', v)} />
            <Num label="Gap &gt; min → BAND karo" value={defaults.closeProfileIfGapOverMin} readOnly={readOnly}
              onChange={v => patch('closeProfileIfGapOverMin', v)} />
            <Num label="Reopen min (min)" value={defaults.profileReopenMin} readOnly={readOnly}
              onChange={v => patch('profileReopenMin', v)} />
            <Num label="Reopen max (min)" value={defaults.profileReopenMax} readOnly={readOnly}
              onChange={v => patch('profileReopenMax', v)} />
          </div>
          <p className="text-[9px] text-gray-600">
            6:10 khatam, agla 6:11–6:12 → profile band mat karo (time bachega). Gap zyada ho to band → dubara kholo.
          </p>
          <label className="flex items-center gap-2 text-[10px] text-gray-400">
            <input type="checkbox" disabled={readOnly} checked={defaults.parallelTabOnOverlap}
              onChange={e => patch('parallelTabOnOverlap', e.target.checked)} className="rounded" />
            Lambe ads — agla session nayi tab me parallel (overlap pe)
          </label>
          <label className="flex items-center gap-2 text-[10px] text-gray-400">
            <input type="checkbox" disabled={readOnly} checked={defaults.noRepeatSameVideo}
              onChange={e => patch('noRepeatSameVideo', e.target.checked)} className="rounded" />
            Same profile + same video aaj dubara na aaye (watch history)
          </label>
        </div>
      </div>

      <div className="rounded-lg border border-cyan-800/40 bg-cyan-950/15 p-3 space-y-2">
        <p className="text-[10px] text-cyan-300 font-semibold uppercase flex items-center gap-1">
          <SkipForward size={11} /> Ads — skip max wait + click (watch% alag rehta hai)
        </p>
        <AdControlSettings
          compact
          values={{
            adSkipEnabled: defaults.adSkipEnabled !== false,
            adSkipMaxSec: defaults.adSkipDelayMaxSec,
            midRollAdWaitSec: defaults.midRollAdSec,
            adClickEnabled: defaults.adClickEnabled,
            adClickDelayMinSec: defaults.adClickDelayMinSec,
            adClickDelayMaxSec: defaults.adClickDelayMaxSec,
            adClickVisitSec: defaults.adClickVisitSec,
          }}
          onChange={(p) => {
            if (p.adSkipEnabled !== undefined) patch('adSkipEnabled', p.adSkipEnabled);
            if (p.adSkipMaxSec !== undefined) patch('adSkipDelayMaxSec', p.adSkipMaxSec);
            if (p.midRollAdWaitSec !== undefined) patch('midRollAdSec', p.midRollAdWaitSec);
            if (p.adClickEnabled !== undefined) patch('adClickEnabled', p.adClickEnabled);
            if (p.adClickDelayMinSec !== undefined) patch('adClickDelayMinSec', p.adClickDelayMinSec);
            if (p.adClickDelayMaxSec !== undefined) patch('adClickDelayMaxSec', p.adClickDelayMaxSec);
            if (p.adClickVisitSec !== undefined) patch('adClickVisitSec', p.adClickVisitSec);
          }}
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs pt-2">
          <Num label="Pre-roll est (s)" value={defaults.preRollAdSec} readOnly={readOnly}
            onChange={v => patch('preRollAdSec', v)} />
          <Num label="Ad overrun buffer" value={defaults.adOverrunBufferSec} readOnly={readOnly}
            onChange={v => patch('adOverrunBufferSec', v)} />
        </div>
      </div>

      <div>
        <p className="text-[10px] text-gray-500 mb-2 flex items-center gap-1">
          <Route size={11} /> Traffic — kis source se kitne VIEWS (total: <strong className="text-amber-400">{totalViews}</strong>)
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {TRAFFIC_QUOTA_LABELS.map(({ key, label, emoji }) => {
            const q = defaults.trafficQuotas[key];
            const proj = trafficProjection?.find(t => t.source === key);
            const off = !isEnabled(key);
            return (
              <div key={key} className={`bg-gray-950/80 border rounded-lg p-2.5 space-y-2 ${off ? 'border-red-900/50 opacity-50' : 'border-gray-800'}`}>
                {off && <p className="text-[9px] text-red-400 font-semibold">OFF in Settings</p>}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-300 w-28 shrink-0">{emoji} {label}</span>
                  <input type="number" min={0} max={50000} readOnly={readOnly || off} disabled={off} value={q.viewCount}
                    onChange={e => patchQuota(key, 'viewCount', Number(e.target.value) || 0)}
                    className="w-20 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-white text-right font-mono text-xs" />
                  <span className="text-[9px] text-gray-600">views</span>
                  {proj && (
                    <span className={`text-[9px] ml-auto ${proj.viewsPlanned >= proj.viewGoal ? 'text-emerald-500' : 'text-amber-500'}`}>
                      plan {proj.viewsPlanned}/{proj.viewGoal}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" disabled={readOnly}
                    onClick={() => patchQuota(key, 'profileMode', 'reuse')}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold border ${q.profileMode === 'reuse' ? 'border-emerald-600 bg-emerald-900/30 text-emerald-200' : 'border-gray-700 text-gray-500'}`}>
                    <Repeat size={10} /> Reuse
                  </button>
                  <button type="button" disabled={readOnly}
                    onClick={() => patchQuota(key, 'profileMode', 'rotate')}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-semibold border ${q.profileMode === 'rotate' ? 'border-emerald-600 bg-emerald-900/30 text-emerald-200' : 'border-gray-700 text-gray-500'}`}>
                    <Shuffle size={10} /> Rotate
                  </button>
                  {key === 'notification' && (
                    <label className="flex items-center gap-1 text-[9px] text-gray-500 ml-auto">
                      <Timer size={9} /> wait
                      <input type="number" min={0} readOnly={readOnly} value={defaults.notificationDelayMin}
                        onChange={e => patch('notificationDelayMin', Math.max(0, Number(e.target.value) || 0))}
                        className="w-12 bg-gray-900 border border-gray-700 rounded px-1 text-white text-center" />
                      min
                    </label>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[9px]">
                  <Num label="Entry min (s)" value={(defaults.trafficEntrySec?.[key] ?? DEFAULT_TRAFFIC_ENTRY_SEC[key]).entryMinSec}
                    readOnly={readOnly} onChange={v => patchEntry(key, 'entryMinSec', v)} />
                  <Num label="Entry max (s)" value={(defaults.trafficEntrySec?.[key] ?? DEFAULT_TRAFFIC_ENTRY_SEC[key]).entryMaxSec}
                    readOnly={readOnly} onChange={v => patchEntry(key, 'entryMaxSec', v)} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Num({ label, value, onChange, readOnly }: { label: string; value: number; onChange: (n: number) => void; readOnly?: boolean }) {
  return (
    <label className="block text-gray-500">
      {label}
      <input type="number" readOnly={readOnly} value={value}
        onChange={e => onChange(Number(e.target.value) || 0)}
        className="mt-1 w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-white" />
    </label>
  );
}
