/**
 * AI Goal Planner — traffic sources + YouTube actions (bada readable UI)
 */

import { Route, Zap, ThumbsUp } from 'lucide-react';
import type {
  DemoCampaignGoals,
  DemoCampaignDefaults,
  DemoProfileSettings,
  TrafficSourceKey,
} from '../../utils/mastermindDemoTypes';
import {
  TRAFFIC_QUOTA_LABELS,
  trafficQuotasTotal,
  defaultProfileSettings,
} from '../../utils/mastermindDemoTypes';
import { useDisabledTrafficSources } from '../../hooks/useDisabledTrafficSources';
import { scaleTrafficQuotas } from '../../utils/aiGoalPlanner';

interface Props {
  viewGoal: number;
  profileCount: number;
  goals: DemoCampaignGoals;
  onGoalsChange: (g: DemoCampaignGoals) => void;
  defaults: DemoCampaignDefaults;
  onDefaultsChange: (d: DemoCampaignDefaults) => void;
  sessionActions: DemoProfileSettings;
  onSessionActionsChange: (s: DemoProfileSettings) => void;
}

const ACTION_TOGGLES: { key: keyof DemoProfileSettings; label: string; emoji: string }[] = [
  { key: 'likeEnabled', label: 'Like', emoji: '👍' },
  { key: 'dislikeEnabled', label: 'Dislike', emoji: '👎' },
  { key: 'subscribeEnabled', label: 'Subscribe', emoji: '📺' },
  { key: 'bellEnabled', label: 'Bell', emoji: '🔔' },
  { key: 'commentEnabled', label: 'Comment', emoji: '💬' },
  { key: 'commentLikeEnabled', label: 'Cmt like', emoji: '💬👍' },
  { key: 'descriptionLinks', label: 'Desc link', emoji: '🔗' },
  { key: 'qualityChangeEnabled', label: 'Quality', emoji: '⚙️' },
  { key: 'seekEnabled', label: 'Seek', emoji: '⏩' },
  { key: 'scrollEnabled', label: 'Scroll', emoji: '📜' },
  { key: 'captionsEnabled', label: 'Captions', emoji: '🇨' },
  { key: 'descriptionExpand', label: 'Description', emoji: '📄' },
];

export default function AIGoalEngagementTrafficPanel({
  viewGoal,
  profileCount,
  goals,
  onGoalsChange,
  defaults,
  onDefaultsChange,
  sessionActions,
  onSessionActionsChange,
}: Props) {
  const { isEnabled } = useDisabledTrafficSources();
  const trafficTotal = trafficQuotasTotal(defaults.trafficQuotas);

  const patchQuota = (key: TrafficSourceKey, viewCount: number) => {
    onDefaultsChange({
      ...defaults,
      trafficQuotas: {
        ...defaults.trafficQuotas,
        [key]: { ...defaults.trafficQuotas[key], viewCount: Math.max(0, viewCount) },
      },
    });
  };

  const autoScaleTraffic = () => {
    onDefaultsChange({
      ...defaults,
      trafficQuotas: scaleTrafficQuotas(viewGoal),
    });
  };

  const autoScaleEngagement = () => {
    const v = viewGoal;
    const p = Math.max(1, profileCount);
    onGoalsChange({
      ...goals,
      views: v,
      likes: Math.round(v * 0.35),
      subscribes: Math.round(v * 0.12),
      bells: Math.round(v * 0.1),
      comments: Math.round(v * 0.06),
      commentLikes: Math.round(v * 0.04),
      dislikes: Math.max(1, Math.round(v * 0.02)),
      watchProfiles: p,
      volumeProfiles: p,
      scrollProfiles: Math.max(1, Math.floor(p * 0.85)),
      captionsProfiles: Math.max(1, Math.floor(p * 0.4)),
    });
  };

  const toggleAction = (key: keyof DemoProfileSettings) => {
    const cur = sessionActions[key];
    if (typeof cur === 'boolean') {
      onSessionActionsChange({ ...sessionActions, [key]: !cur });
    }
  };

  return (
    <div className="space-y-4">
      {/* YouTube actions */}
      <div className="rounded-2xl border-2 border-emerald-800/50 bg-emerald-950/20 p-5">
        <p className="text-sm font-bold text-emerald-200 uppercase flex items-center gap-2 mb-4">
          <Zap size={18} /> YouTube actions — har session me kya kare
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {ACTION_TOGGLES.map(({ key, label, emoji }) => (
            <button key={key} type="button" onClick={() => toggleAction(key)}
              className={`flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-semibold transition-colors ${
                sessionActions[key]
                  ? 'border-emerald-500 bg-emerald-900/40 text-emerald-100'
                  : 'border-gray-700 bg-gray-900/50 text-gray-500'
              }`}>
              <span className="text-lg">{emoji}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
          <Num label="Watch min %" value={defaults.watchTimeMin}
            onChange={v => onDefaultsChange({ ...defaults, watchTimeMin: v })} />
          <Num label="Watch max %" value={defaults.watchTimeMax}
            onChange={v => onDefaultsChange({ ...defaults, watchTimeMax: v })} />
          <Num label="Volume min %" value={defaults.volumeMin}
            onChange={v => onDefaultsChange({ ...defaults, volumeMin: v })} />
          <Num label="Volume max %" value={defaults.volumeMax}
            onChange={v => onDefaultsChange({ ...defaults, volumeMax: v })} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3">
          <label className="block text-xs text-gray-500">
            Playback speed
            <select value={defaults.playbackSpeed || '1x'}
              onChange={e => onDefaultsChange({ ...defaults, playbackSpeed: e.target.value })}
              className="mt-1 w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm">
              {['0.75x', '1x', '1.25x', '1.5x', '1.75x', '2x'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          {sessionActions.descriptionLinks && (
            <>
              <label className="block text-xs text-gray-500 sm:col-span-2">
                Desc link URL
                <input type="url" value={defaults.descriptionLinkUrl || ''} placeholder="https://..."
                  onChange={e => onDefaultsChange({ ...defaults, descriptionLinkUrl: e.target.value.trim() })}
                  className="mt-1 w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
              </label>
            </>
          )}
        </div>
        <label className="flex items-center gap-2 mt-3 text-sm text-gray-300">
          <input type="checkbox" checked={defaults.scrollNoClick}
            onChange={e => onDefaultsChange({ ...defaults, scrollNoClick: e.target.checked })}
            className="rounded w-4 h-4" />
          Scroll me click band (natural)
        </label>
      </div>

      {/* Engagement targets */}
      <div className="rounded-2xl border-2 border-gray-700 bg-gray-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <p className="text-sm font-bold text-white uppercase flex items-center gap-2">
            <ThumbsUp size={18} className="text-amber-400" /> Engagement targets
          </p>
          <button type="button" onClick={autoScaleEngagement}
            className="text-xs px-3 py-1.5 rounded-lg bg-amber-800/50 text-amber-200 font-semibold border border-amber-600/50">
            Auto-fill from {viewGoal} views
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {([
            ['likes', '👍 Likes'],
            ['subscribes', '📺 Subs'],
            ['bells', '🔔 Bell'],
            ['comments', '💬 Comments'],
            ['commentLikes', '💬👍'],
            ['dislikes', '👎'],
            ['views', '👁 Views'],
          ] as const).map(([key, label]) => (
            <Num key={key} label={label} value={goals[key]}
              onChange={v => onGoalsChange({ ...goals, [key]: v })} />
          ))}
        </div>
      </div>

      {/* Traffic sources */}
      <div className="rounded-2xl border-2 border-cyan-800/50 bg-cyan-950/20 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <p className="text-sm font-bold text-cyan-200 uppercase flex items-center gap-2">
            <Route size={18} /> Traffic sources — kahan se view aayega
          </p>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">
              Total: <strong className="text-white text-lg font-mono">{trafficTotal}</strong>
              {trafficTotal !== viewGoal && (
                <span className="text-amber-400 ml-2">≠ goal {viewGoal}</span>
              )}
            </span>
            <button type="button" onClick={autoScaleTraffic}
              className="text-xs px-3 py-1.5 rounded-lg bg-cyan-800/50 text-cyan-100 font-semibold border border-cyan-600/50">
              Auto-match {viewGoal} views
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {TRAFFIC_QUOTA_LABELS.map(({ key, label, emoji }) => {
            const q = defaults.trafficQuotas[key];
            const off = !isEnabled(key);
            return (
              <div key={key}
                className={`rounded-xl border p-4 ${off ? 'border-red-900/50 opacity-50' : 'border-gray-700 bg-gray-900/50'}`}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-base font-semibold text-white">{emoji} {label}</span>
                  {off && <span className="text-xs text-red-400">OFF in Settings</span>}
                </div>
                <input type="number" min={0} disabled={off} value={q.viewCount}
                  onChange={e => patchQuota(key, Number(e.target.value) || 0)}
                  className="w-full bg-gray-950 border-2 border-gray-600 rounded-xl px-4 py-3 text-white font-mono text-2xl font-bold text-center" />
                <div className="flex gap-2 mt-2">
                  <button type="button" disabled={off}
                    onClick={() => onDefaultsChange({
                      ...defaults,
                      trafficQuotas: { ...defaults.trafficQuotas, [key]: { ...q, profileMode: 'reuse' } },
                    })}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-bold border ${
                      q.profileMode === 'reuse' ? 'border-emerald-500 text-emerald-300 bg-emerald-950/40' : 'border-gray-700 text-gray-500'
                    }`}>
                    Reuse
                  </button>
                  <button type="button" disabled={off}
                    onClick={() => onDefaultsChange({
                      ...defaults,
                      trafficQuotas: { ...defaults.trafficQuotas, [key]: { ...q, profileMode: 'rotate' } },
                    })}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-bold border ${
                      q.profileMode === 'rotate' ? 'border-emerald-500 text-emerald-300 bg-emerald-950/40' : 'border-gray-700 text-gray-500'
                    }`}>
                    Rotate
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function buildDefaultSessionActions(): DemoProfileSettings {
  return defaultProfileSettings();
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500 mb-1 block font-medium">{label}</span>
      <input type="number" min={0} value={value}
        onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="w-full bg-gray-950 border-2 border-gray-600 rounded-xl px-3 py-2.5 text-white font-mono text-lg font-bold text-center" />
    </label>
  );
}
