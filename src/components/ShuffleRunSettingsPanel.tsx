import { useEffect, useState } from 'react';
import { Settings2, Clock, Volume2, Globe, Zap } from 'lucide-react';
import {
  loadShuffleRunSettings,
  type ShuffleRunSettings,
} from '../utils/shuffleSettingsForSchedule';
import { TRAFFIC_SOURCES, type ActionToggles } from '../utils/runSettingsShared';
import { AdControlSettings } from './shared/AdControlSettings';
import { useDisabledTrafficSources } from '../hooks/useDisabledTrafficSources';

const SHUFFLE_SETTINGS_KEY = 'mmb_shuffle_settings';
const QUALITY_OPTIONS = ['auto', '144p', '240p', '360p', '480p', '720p', '1080p'] as const;
type Tab = 'basic' | 'playback' | 'traffic' | 'actions';

function saveShuffleRunSettings(s: ShuffleRunSettings) {
  try {
    localStorage.setItem(SHUFFLE_SETTINGS_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

function clampWatchRange(min: number, max: number) {
  let watchTimeMin = Math.max(1, Math.min(100, Math.round(min)));
  let watchTimeMax = Math.max(1, Math.min(100, Math.round(max)));
  if (watchTimeMin > watchTimeMax) [watchTimeMin, watchTimeMax] = [watchTimeMax, watchTimeMin];
  return { watchTimeMin, watchTimeMax };
}

const ACTION_ROWS: { key: keyof ActionToggles; emoji: string; label: string }[] = [
  { key: 'like', emoji: '👍', label: 'Like' },
  { key: 'dislike', emoji: '👎', label: 'Dislike' },
  { key: 'subscribe', emoji: '📺', label: 'Subscribe' },
  { key: 'bell', emoji: '🔔', label: 'Bell' },
  { key: 'comment', emoji: '💬', label: 'Comment' },
  { key: 'commentLike', emoji: '💬👍', label: 'Comment like' },
  { key: 'descriptionLinks', emoji: '🔗', label: 'Desc links' },
  { key: 'scroll', emoji: '📜', label: 'Scroll activity' },
  { key: 'qualityChange', emoji: '🎬', label: 'Quality change' },
  { key: 'captionsToggle', emoji: 'CC', label: 'Captions' },
];

const MIX_SLIDER_SOURCES: { key: keyof ShuffleRunSettings; label: string; sourceId: string }[] = [
  { key: 'srcNotificationPct', label: 'Notification', sourceId: 'notification' },
  { key: 'srcSearchPct', label: 'YT Search', sourceId: 'search' },
  { key: 'srcHomepagePct', label: 'Homepage', sourceId: 'homepage' },
  { key: 'srcGooglePct', label: 'Google', sourceId: 'google' },
  { key: 'srcBingPct', label: 'Bing', sourceId: 'bing' },
  { key: 'srcChannelDiscPct', label: 'Channel Disc', sourceId: 'channel_discovery' },
];

export default function ShuffleRunSettingsPanel({ compact = false }: { compact?: boolean }) {
  const { isEnabled } = useDisabledTrafficSources();
  const enabledTrafficSources = TRAFFIC_SOURCES.filter(s => isEnabled(s.id));
  const [settings, setSettings] = useState<ShuffleRunSettings>(() => loadShuffleRunSettings());
  const [tab, setTab] = useState<Tab>('basic');

  useEffect(() => {
    if (!enabledTrafficSources.length) return;
    if (!enabledTrafficSources.some(s => s.id === settings.trafficSource)) {
      setSettings(prev => ({ ...prev, trafficSource: enabledTrafficSources[0].id }));
    }
  }, [enabledTrafficSources, settings.trafficSource]);

  useEffect(() => {
    saveShuffleRunSettings(settings);
  }, [settings]);

  const update = <K extends keyof ShuffleRunSettings>(key: K, value: ShuffleRunSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const updateToggle = (key: keyof ActionToggles, val: boolean) => {
    setSettings(prev => ({
      ...prev,
      actionToggles: { ...prev.actionToggles, [key]: val },
    }));
  };

  const tabs: { id: Tab; label: string; icon: typeof Settings2 }[] = [
    { id: 'basic', label: 'Watch & Ads', icon: Settings2 },
    { id: 'playback', label: 'Volume', icon: Volume2 },
    { id: 'traffic', label: 'Traffic', icon: Globe },
    { id: 'actions', label: 'Actions', icon: Zap },
  ];

  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-2xl ${compact ? 'p-4' : 'p-5'}`}>
      <h2 className="text-white font-semibold text-sm flex items-center gap-2 mb-2">
        <Settings2 size={15} className="text-amber-400" />
        Run Settings (Scheduler + Shuffle + Notification Hub)
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Ye settings har schedule / shuffle / notification run mein use hoti hain.
      </p>

      <div className="flex flex-wrap gap-1 mb-4">
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition ${
              tab === t.id ? 'bg-amber-600/20 text-amber-300 border border-amber-600/40' : 'text-gray-500 hover:text-gray-300 border border-transparent'
            }`}>
            <t.icon size={12} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'basic' && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-400 block mb-2">Watch % (min – max, random per profile)</label>
              <div className="flex items-center gap-2">
                <input type="number" min={1} max={100} value={settings.watchTimeMin}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(100, Number(e.target.value) || 90));
                    setSettings(s => ({ ...s, ...clampWatchRange(v, s.watchTimeMax) }));
                  }}
                  className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                <span className="text-gray-600">—</span>
                <input type="number" min={1} max={100} value={settings.watchTimeMax}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(100, Number(e.target.value) || 100));
                    setSettings(s => ({ ...s, ...clampWatchRange(s.watchTimeMin, v) }));
                  }}
                  className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                <span className="text-xs text-gray-500">%</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-2">Video quality</label>
              <div className="flex flex-wrap gap-1.5">
                {QUALITY_OPTIONS.map(q => (
                  <button key={q} type="button" onClick={() => update('videoQuality', q)}
                    className={`px-2 py-1 rounded-lg border text-xs ${settings.videoQuality === q ? 'border-purple-500 bg-purple-900/30 text-purple-300' : 'border-gray-700 bg-gray-800 text-gray-400'}`}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="border-t border-gray-800 pt-3">
            <label className="text-xs text-gray-400 block mb-2 font-medium text-amber-300/90">Ads</label>
            <AdControlSettings
              compact
              values={{
                adSkipEnabled: settings.adSkipEnabled,
                adSkipMaxSec: settings.adSkipMaxSec ?? settings.adSkipAfterSec,
                midRollAdWaitSec: settings.midRollAdWaitSec,
                adClickEnabled: settings.adClickEnabled,
                adClickDelayMinSec: settings.adClickDelayMinSec,
                adClickDelayMaxSec: settings.adClickDelayMaxSec,
                adClickVisitSec: settings.adClickVisitSec,
              }}
              onChange={(patch) => {
                setSettings(prev => ({
                  ...prev,
                  ...patch,
                  adSkipAfterSec: patch.adSkipMaxSec ?? prev.adSkipMaxSec ?? prev.adSkipAfterSec,
                }));
              }}
            />
          </div>

          <div className="border-t border-gray-800 pt-3 mt-3">
            <label className="text-xs text-gray-500 block mb-1">Videos per profile (sequential, same tab)</label>
            <input type="number" min={1} max={10} value={settings.videosPerProfile}
              onChange={(e) => update('videosPerProfile', Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
            <p className="text-[10px] text-gray-600 mt-1">Tab 1 + 3 videos = pehle 1, phir 2, phir 3 — har video ka traffic alag set kar sakte ho</p>
          </div>

          <div className="border-t border-gray-800 pt-3 mt-3">
            <div className="flex items-start gap-3">
              <button type="button" onClick={() => update('organicMode', !settings.organicMode)}
                className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors ${settings.organicMode ? 'bg-emerald-600' : 'bg-gray-700'}`}>
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${settings.organicMode ? 'translate-x-5' : ''}`} />
              </button>
              <div>
                <div className="flex items-center gap-2">
                  <Clock size={13} className={settings.organicMode ? 'text-emerald-400' : 'text-gray-500'} />
                  <span className={`text-sm font-medium ${settings.organicMode ? 'text-emerald-300' : 'text-gray-300'}`}>
                    Organic Mode (24h Scheduling)
                  </span>
                </div>
                <p className="text-xs text-gray-500 mt-0.5">ON = 24h weighted slots · OFF = sab ek saath start</p>
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'playback' && (
        <div className="space-y-4">
          <div>
            <label className="text-xs text-gray-400 block mb-2">Volume range (random per profile)</label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500 w-8">Min</span>
              <input type="range" min={0} max={100} step={5} value={settings.volumeMin}
                onChange={e => {
                  const v = Number(e.target.value);
                  setSettings(s => ({ ...s, volumeMin: v, volumeMax: Math.max(v, s.volumeMax) }));
                }}
                className="flex-1 accent-teal-500" />
              <span className="text-teal-300 text-xs font-mono w-10">{settings.volumeMin}%</span>
              <span className="text-xs text-gray-500 w-8">Max</span>
              <input type="range" min={0} max={100} step={5} value={settings.volumeMax}
                onChange={e => {
                  const v = Number(e.target.value);
                  setSettings(s => ({ ...s, volumeMax: v, volumeMin: Math.min(v, s.volumeMin) }));
                }}
                className="flex-1 accent-teal-500" />
              <span className="text-teal-300 text-xs font-mono w-10">{settings.volumeMax}%</span>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={settings.seekEnabled}
              onChange={e => update('seekEnabled', e.target.checked)} className="rounded border-gray-600" />
            Seek during watch (j/l keys)
          </label>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Pause probability %</label>
            <input type="number" min={0} max={50} value={settings.pauseProbability}
              onChange={e => update('pauseProbability', Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
              className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
          </div>
        </div>
      )}

      {tab === 'traffic' && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Traffic source — kaise video par pahunchega profile</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {enabledTrafficSources.map(source => (
              <button key={source.id} type="button"
                onClick={() => update('trafficSource', source.id)}
                className={`p-2.5 rounded-lg border text-left transition ${
                  settings.trafficSource === source.id
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-gray-700 hover:border-gray-500'
                }`}>
                <div className="text-xs font-medium text-white">{source.label}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{source.desc}</div>
              </button>
            ))}
          </div>
          {settings.trafficSource === 'random' && (
            <div className="mt-3 p-3 bg-gray-800/50 rounded-xl border border-gray-700 space-y-2">
              <p className="text-xs text-blue-400/90">Random mix % (total ~100)</p>
              {MIX_SLIDER_SOURCES.filter(s => isEnabled(s.sourceId)).map(({ key, label }) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-28">{label}</span>
                  <input type="range" min={0} max={60} value={settings[key] as number}
                    onChange={e => update(key, Number(e.target.value))}
                    className="flex-1 accent-blue-500" />
                  <span className="text-xs font-mono text-gray-300 w-8">{settings[key] as number}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'actions' && (
        <div className="grid sm:grid-cols-2 gap-2">
          {ACTION_ROWS.map(row => (
            <label key={row.key} className="flex items-center justify-between p-2.5 rounded-lg bg-gray-800/60 border border-gray-700 cursor-pointer">
              <span className="text-sm text-gray-300">{row.emoji} {row.label}</span>
              <input type="checkbox" checked={settings.actionToggles[row.key]}
                onChange={e => updateToggle(row.key, e.target.checked)}
                className="rounded border-gray-600" />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
