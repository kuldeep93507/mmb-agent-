import { useEffect, useMemo, useState } from 'react';
import { X, Save, CheckCircle, AlertTriangle, Clock, Film, List } from 'lucide-react';
import type { DemoPlanSlot } from '../../utils/mastermindDemoPlan';
import type { DemoProfileSettings } from '../../utils/mastermindDemoTypes';
import { TRAFFIC_OPTIONS, QUALITY_OPTIONS } from '../../utils/mastermindDemoTypes';
import { useDisabledTrafficSources } from '../../hooks/useDisabledTrafficSources';
import { todayDayKey } from '../../utils/mastermindSessionTime';
import ProfileDayTimeline from './ProfileDayTimeline';
import { AdControlSettings } from '../shared/AdControlSettings';

interface Props {
  slot: DemoPlanSlot | null;
  allSlots?: DemoPlanSlot[];
  onClose: () => void;
  onSave: (profileId: string, settings: DemoProfileSettings) => void;
}

function trafficOptionEnabled(id: string, isEnabled: (s: string) => boolean): boolean {
  if (id === 'random') return true;
  if (id === 'custom') return isEnabled('search');
  return isEnabled(id);
}

export default function ProfileDetailDrawer({ slot, allSlots = [], onClose, onSave }: Props) {
  const { isEnabled } = useDisabledTrafficSources();
  const trafficOptions = useMemo(
    () => TRAFFIC_OPTIONS.filter((t) => trafficOptionEnabled(t, isEnabled)),
    [isEnabled],
  );
  const [draft, setDraft] = useState<DemoProfileSettings | null>(null);
  const [tab, setTab] = useState<'schedule' | 'settings'>('schedule');

  useEffect(() => {
    if (slot) {
      setDraft({ ...slot.settings });
      setTab('schedule');
    }
  }, [slot]);

  const profileTodaySlots = useMemo(() => {
    if (!slot) return [];
    const dayKey = todayDayKey();
    return allSlots.filter(s => s.profileId === slot.profileId && s.dayKey === dayKey);
  }, [slot, allSlots]);

  if (!slot || !draft) return null;

  const r = slot.readiness;

  const patch = <K extends keyof DemoProfileSettings>(key: K, val: DemoProfileSettings[K]) => {
    setDraft(d => d ? { ...d, [key]: val } : d);
  };

  const save = () => {
    onSave(slot.profileId, draft);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-2xl bg-gray-950 border-l border-gray-800 shadow-2xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/80">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-emerald-500 font-semibold">Profile day plan + settings</p>
            <h2 className="text-white font-bold">{slot.profileName}</h2>
            <p className="text-[10px] text-gray-600 font-mono">{slot.profileId}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-gray-500 hover:text-white rounded-lg">
            <X size={18} />
          </button>
        </div>

        <div className="flex gap-1 p-2 border-b border-gray-800 bg-gray-900/50">
          <button type="button" onClick={() => setTab('schedule')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs ${tab === 'schedule' ? 'bg-amber-900/30 text-amber-100' : 'text-gray-500'}`}>
            <List size={12} /> Aaj ki videos ({profileTodaySlots.length})
          </button>
          <button type="button" onClick={() => setTab('settings')}
            className={`px-3 py-1.5 rounded-lg text-xs ${tab === 'settings' ? 'bg-amber-900/30 text-amber-100' : 'text-gray-500'}`}>
            Settings edit
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
          {tab === 'schedule' && (
            <>
              <div className={`rounded-xl border p-3 ${slot.runtimeStatus === 'running' ? 'border-blue-700/50 bg-blue-950/20' : r.ready ? 'border-emerald-800/50 bg-emerald-950/20' : 'border-amber-800/50 bg-amber-950/20'}`}>
                <p className="text-[10px] uppercase font-semibold text-gray-400 mb-1">Selected slot</p>
                <p className="text-emerald-300 font-medium">{slot.planRowLabel}</p>
                <p className="text-gray-400 mt-1 flex items-center gap-1">
                  <Clock size={11} /> {slot.timeLabel} – {slot.endTimeLabel}
                  {slot.runtimeStatus === 'running' && <span className="text-blue-400 ml-2">● LIVE</span>}
                </p>
                <p className="flex items-center gap-1 text-gray-500 mt-1">
                  <Film size={11} className="text-red-400" /> {slot.videoTitle}
                </p>
                {slot.tabGapSec != null && <p className="text-[10px] text-purple-400 mt-1">Tab gap: +{slot.tabGapSec}s pehle wali tab ke baad</p>}
                <p className="text-[9px] text-gray-600 font-mono mt-2">sha256 seed:{slot.sessionSeed} · curve:{slot.scrollCurveId}</p>
              </div>
              <div>
                <h3 className="text-[10px] uppercase text-gray-500 font-semibold mb-2">Poori din ki list — kab chalegi · kab nahi</h3>
                <ProfileDayTimeline slots={profileTodaySlots} highlightId={slot.id} compact />
              </div>
            </>
          )}

          {tab === 'settings' && (
            <>
              <div className={`rounded-xl border p-3 ${r.ready ? 'border-emerald-800/50' : 'border-amber-800/50'}`}>
                <div className="flex items-center gap-2 font-semibold">
                  {r.ready ? <CheckCircle size={14} className="text-emerald-400" /> : <AlertTriangle size={14} className="text-amber-400" />}
                  <span>Readiness</span>
                </div>
              </div>
              <section className="space-y-3">
                <h3 className="text-gray-400 font-semibold uppercase text-[10px]">Watch & volume</h3>
                <div className="grid grid-cols-2 gap-2">
                  <Num label="Watch min %" value={draft.watchTimeMin} onChange={v => patch('watchTimeMin', v)} />
                  <Num label="Watch max %" value={draft.watchTimeMax} onChange={v => patch('watchTimeMax', v)} />
                  <Num label="Volume min %" value={draft.volumeMin} onChange={v => patch('volumeMin', v)} />
                  <Num label="Volume max %" value={draft.volumeMax} onChange={v => patch('volumeMax', v)} />
                </div>
                <p className="text-[9px] text-gray-600">Min = Max rakho to exact value chalegi, alag rakho to beech me random (human-like)</p>
              </section>
              <section className="space-y-2">
                <h3 className="text-gray-400 font-semibold uppercase text-[10px]">Ads — skip max wait + click</h3>
                <AdControlSettings
                  compact
                  values={{
                    adSkipEnabled: draft.adSkipEnabled,
                    adSkipMaxSec: draft.adSkipDelayMaxSec ?? 60,
                    midRollAdWaitSec: 10,
                    adClickEnabled: draft.adClickEnabled ?? false,
                    adClickDelayMinSec: draft.adClickDelayMinSec ?? 10,
                    adClickDelayMaxSec: draft.adClickDelayMaxSec ?? 15,
                    adClickVisitSec: draft.adClickVisitSec ?? 20,
                  }}
                  onChange={(p) => {
                    if (p.adSkipEnabled !== undefined) patch('adSkipEnabled', p.adSkipEnabled);
                    if (p.adSkipMaxSec !== undefined) {
                      patch('adSkipDelayMaxSec', p.adSkipMaxSec);
                      patch('adSkipDelayMinSec', Math.min(draft.adSkipDelayMinSec ?? 8, p.adSkipMaxSec));
                    }
                    if (p.adClickEnabled !== undefined) patch('adClickEnabled', p.adClickEnabled);
                    if (p.adClickDelayMinSec !== undefined) patch('adClickDelayMinSec', p.adClickDelayMinSec);
                    if (p.adClickDelayMaxSec !== undefined) patch('adClickDelayMaxSec', p.adClickDelayMaxSec);
                    if (p.adClickVisitSec !== undefined) patch('adClickVisitSec', p.adClickVisitSec);
                  }}
                />
              </section>
              <section className="space-y-2">
                <h3 className="text-gray-400 font-semibold uppercase text-[10px]">Traffic & quality</h3>
                <select value={trafficOptions.includes(draft.trafficPreference as typeof TRAFFIC_OPTIONS[number]) ? draft.trafficPreference : (trafficOptions[0] ?? 'search')} onChange={e => patch('trafficPreference', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-white">
                  {trafficOptions.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <select value={draft.videoQuality} onChange={e => patch('videoQuality', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-white">
                  {QUALITY_OPTIONS.map(q => <option key={q} value={q}>{q}</option>)}
                </select>
                <label className="text-[10px] text-gray-500 block mt-2">Playback speed</label>
                <select value={draft.playbackSpeed || '1x'} onChange={e => patch('playbackSpeed', e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-white">
                  {['0.75x', '1x', '1.25x', '1.5x', '1.75x', '2x'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </section>
              {draft.descriptionLinks && (
                <section className="space-y-2">
                  <h3 className="text-gray-400 font-semibold uppercase text-[10px]">Description link</h3>
                  <input type="url" value={draft.descriptionLinkUrl || ''} placeholder="https://..."
                    onChange={e => patch('descriptionLinkUrl', e.target.value.trim())}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 text-white text-xs" />
                  <Num label="Visit sec" value={draft.descriptionLinkVisitSec ?? 120}
                    onChange={v => patch('descriptionLinkVisitSec', v)} />
                </section>
              )}
              <section>
                <h3 className="text-gray-400 font-semibold uppercase text-[10px] mb-2">Actions</h3>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    ['likeEnabled', '👍 Like'], ['dislikeEnabled', '👎'], ['subscribeEnabled', '📺 Sub'],
                    ['bellEnabled', '🔔'], ['commentEnabled', '💬'], ['commentLikeEnabled', '💬👍 Cmt like'],
                    ['descriptionLinks', '🔗 Desc link'], ['qualityChangeEnabled', '⚙️ Quality'],
                    ['seekEnabled', '⏩'], ['captionsEnabled', '🇨'], ['descriptionExpand', '📄'],
                    ['scrollEnabled', '📜 Scroll'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 p-2 rounded-lg bg-gray-900 border border-gray-800">
                      <input type="checkbox" checked={draft[key]} onChange={e => patch(key, e.target.checked)} className="rounded" />
                      <span className="text-gray-300">{label}</span>
                    </label>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>

        {tab === 'settings' && (
          <div className="p-3 border-t border-gray-800 flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 py-2 rounded-xl border border-gray-700 text-gray-400 text-sm">Cancel</button>
            <button type="button" onClick={save} className="flex-1 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold flex items-center justify-center gap-1">
              <Save size={14} /> Save
            </button>
          </div>
        )}
      </aside>
    </>
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block text-gray-500">
      {label}
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value) || 0)}
        className="mt-1 w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-white" />
    </label>
  );
}
