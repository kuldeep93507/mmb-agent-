import { useState } from 'react';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp, Film, CheckCircle2 } from 'lucide-react';
import type { DemoCampaignDefaults, DemoCampaignVideo } from '../../utils/mastermindDemoTypes';
import { trafficQuotasTotal } from '../../utils/mastermindDemoTypes';
import {
  syncTrafficToVideoGoals,
  syncVideoGoalsFromTraffic,
  trafficVideoMismatch,
  type VideoGoalSplitMode,
} from '../../utils/mastermindTrafficSync';

interface Props {
  videos: DemoCampaignVideo[];
  defaults: DemoCampaignDefaults;
  onSyncTraffic: (defaults: DemoCampaignDefaults) => void;
  onVideosChange: (videos: DemoCampaignVideo[]) => void;
  /** AI se aaya ho to simple message */
  fromAI?: boolean;
}

export default function TrafficSyncPanel({ videos, defaults, onSyncTraffic, onVideosChange, fromAI }: Props) {
  const [expanded, setExpanded] = useState(!fromAI);
  const [splitMode, setSplitMode] = useState<VideoGoalSplitMode>('equal');
  const [draftGoals, setDraftGoals] = useState<Record<string, number>>({});

  const trafficTotal = trafficQuotasTotal(defaults.trafficQuotas);
  const { mismatch } = trafficVideoMismatch(videos, trafficTotal);

  if (!videos.length) return null;

  const getGoal = (v: DemoCampaignVideo) => draftGoals[v.id] ?? v.viewGoal;
  const draftTotal = videos.reduce((s, v) => s + getGoal(v), 0);

  const setGoal = (id: string, n: number) => {
    setDraftGoals(prev => ({ ...prev, [id]: Math.max(1, n) }));
  };

  const applyDraftGoals = () => {
    onVideosChange(videos.map(v => ({ ...v, viewGoal: getGoal(v) })));
    setDraftGoals({});
  };

  const autoMatch = () => {
    const updated = syncVideoGoalsFromTraffic(
      videos.map(v => ({ id: v.id, viewGoal: getGoal(v) })),
      trafficTotal,
      'equal',
    );
    onVideosChange(videos.map(v => {
      const u = updated.find(x => x.id === v.id);
      return u ? { ...v, viewGoal: u.viewGoal } : v;
    }));
    setDraftGoals({});
  };

  const syncTrafficFromVideos = () => {
    const total = videos.reduce((s, v) => s + getGoal(v), 0);
    const synced = syncTrafficToVideoGoals(defaults.trafficQuotas, total);
    onSyncTraffic({ ...defaults, trafficQuotas: synced });
    applyDraftGoals();
  };

  const syncVideosFromTraffic = () => {
    autoMatch();
  };

  if (fromAI && !mismatch) {
    return (
      <div className="rounded-xl border-2 border-emerald-700/50 bg-emerald-950/25 px-5 py-4 flex items-center gap-3">
        <CheckCircle2 size={24} className="text-emerald-400 shrink-0" />
        <div>
          <p className="text-base font-bold text-emerald-100">Videos + traffic match ✓ (AI se set)</p>
          <p className="text-sm text-gray-400 mt-0.5">
            {videos.length} videos · total <strong className="text-white">{trafficTotal}</strong> views — change ki zarurat nahi
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl border-2 ${mismatch ? 'border-amber-600/60 bg-amber-950/30' : 'border-emerald-700/50 bg-emerald-950/20'}`}>
      <button type="button" onClick={() => setExpanded(e => !e)}
        className="w-full flex flex-wrap items-center gap-4 px-5 py-4 text-left">
        {mismatch ? (
          <AlertTriangle size={28} className="text-amber-400 shrink-0" />
        ) : (
          <CheckCircle2 size={26} className="text-emerald-400 shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-base font-bold text-white">Video views ↔ Traffic total</p>
          <p className="text-sm text-gray-300 mt-1">
            Videos ka total = <strong className="text-amber-300 text-lg font-mono">{draftTotal}</strong>
            {' · '}Traffic = <strong className="text-emerald-300 text-lg font-mono">{trafficTotal}</strong>
          </p>
          {mismatch && (
            <p className="text-sm text-amber-300 mt-2 font-semibold">
              ⚠ Match nahi — neeche <strong>Ek click: Sab match karo</strong> dabao
            </p>
          )}
          {fromAI && (
            <p className="text-xs text-violet-300 mt-1">AI se aaye ho? Auto-match button use karo, manually mat ghabrao</p>
          )}
        </div>
        {expanded ? <ChevronUp size={20} className="text-gray-500" /> : <ChevronDown size={20} className="text-gray-500" />}
      </button>

      {expanded && (
        <div className="px-5 pb-5 space-y-4 border-t border-gray-700/60 pt-4">
          {mismatch && (
            <button type="button" onClick={autoMatch}
              className="w-full flex items-center justify-center gap-2 px-6 py-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-base font-bold shadow-lg">
              <RefreshCw size={18} /> Ek click: Sab match karo (traffic = {trafficTotal})
            </button>
          )}

          <div className="border border-gray-700 rounded-xl overflow-hidden divide-y divide-gray-800">
            {videos.map(v => (
              <div key={v.id} className="flex flex-wrap items-center gap-4 px-5 py-4 bg-gray-900/50">
                <Film size={22} className="text-red-400 shrink-0" />
                <div className="flex-1 min-w-[200px]">
                  <p className="text-base text-gray-100 font-medium line-clamp-2">{v.title}</p>
                  <p className="text-sm text-gray-500 mt-0.5">{v.channelName}</p>
                </div>
                <label className="flex flex-col gap-1 shrink-0">
                  <span className="text-xs text-gray-400 font-semibold uppercase">View goal</span>
                  <input type="number" min={1} max={50000}
                    value={getGoal(v)}
                    onChange={e => setGoal(v.id, Number(e.target.value) || 1)}
                    className="w-32 bg-gray-950 border-2 border-gray-600 rounded-xl px-4 py-3 text-white font-mono text-2xl font-bold text-center" />
                </label>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={syncTrafficFromVideos}
              className="px-4 py-3 rounded-xl bg-amber-800/50 border border-amber-600/50 text-amber-100 text-sm font-bold">
              Traffic ← video goals
            </button>
            <button type="button" onClick={syncVideosFromTraffic}
              className="px-4 py-3 rounded-xl bg-emerald-800/50 border border-emerald-600/50 text-emerald-100 text-sm font-bold">
              Video goals ← traffic
            </button>
            <select value={splitMode} onChange={e => setSplitMode(e.target.value as VideoGoalSplitMode)}
              className="bg-gray-950 border-2 border-gray-600 rounded-xl px-4 py-3 text-sm text-gray-200">
              <option value="equal">Barabar baanto</option>
              <option value="keep_ratio">Ratio rakho</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
