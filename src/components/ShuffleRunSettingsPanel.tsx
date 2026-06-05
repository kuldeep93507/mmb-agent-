import { useEffect, useState } from 'react';
import { Settings2, Clock } from 'lucide-react';
import {
  loadShuffleRunSettings,
  type ShuffleRunSettings,
} from '../utils/shuffleSettingsForSchedule';

const SHUFFLE_SETTINGS_KEY = 'mmb_shuffle_settings';
const QUALITY_OPTIONS = ['auto', '144p', '240p', '360p', '480p', '720p', '1080p'] as const;

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

export default function ShuffleRunSettingsPanel({ compact = false }: { compact?: boolean }) {
  const [settings, setSettings] = useState<ShuffleRunSettings>(() => loadShuffleRunSettings());

  useEffect(() => {
    saveShuffleRunSettings(settings);
  }, [settings]);

  const update = <K extends keyof ShuffleRunSettings>(key: K, value: ShuffleRunSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className={`bg-gray-900 border border-gray-800 rounded-2xl ${compact ? 'p-4' : 'p-5'}`}>
      <h2 className="text-white font-semibold text-sm flex items-center gap-2 mb-3">
        <Settings2 size={15} className="text-amber-400" />
        Run Settings (Shuffle + Scheduler + 24/7)
      </h2>
      <p className="text-xs text-gray-500 mb-4">Ye settings sab runs me use hoti hain — watch %, quality, ad skip.</p>

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
              <button key={q} type="button"
                onClick={() => update('videoQuality', q)}
                className={`px-2 py-1 rounded-lg border text-xs ${settings.videoQuality === q ? 'border-purple-500 bg-purple-900/30 text-purple-300' : 'border-gray-700 bg-gray-800 text-gray-400'}`}>
                {q}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-gray-800 pt-3">
        <label className="text-xs text-gray-400 block mb-2 font-medium text-amber-300/90">Ads</label>
        <div className="grid sm:grid-cols-3 gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-400">
            <input type="checkbox" checked={settings.adSkipEnabled}
              onChange={(e) => update('adSkipEnabled', e.target.checked)}
              className="rounded border-gray-600" />
            Skip ads
          </label>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Pre-roll skip after (sec)</label>
            <input type="number" min={0} max={120} value={settings.adSkipAfterSec}
              disabled={!settings.adSkipEnabled}
              onChange={(e) => update('adSkipAfterSec', Math.max(0, Number(e.target.value) || 0))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm disabled:opacity-50" />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Mid-roll wait (sec)</label>
            <input type="number" min={0} max={120} value={settings.midRollAdWaitSec}
              disabled={!settings.adSkipEnabled}
              onChange={(e) => update('midRollAdWaitSec', Math.max(0, Number(e.target.value) || 0))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm disabled:opacity-50" />
          </div>
        </div>
        <p className="text-xs text-gray-600 mt-2">
          Skip OFF = poori ad dekhega · Skip ON = itne seconds ke baad skip try (button aane par)
        </p>
      </div>

      {/* ── Organic Mode ── */}
      <div className="border-t border-gray-800 pt-3 mt-1">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => update('organicMode', !settings.organicMode)}
            className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ${
              settings.organicMode ? 'bg-emerald-600' : 'bg-gray-700'
            }`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${
              settings.organicMode ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <Clock size={13} className={settings.organicMode ? 'text-emerald-400' : 'text-gray-500'} />
              <span className={`text-sm font-medium ${settings.organicMode ? 'text-emerald-300' : 'text-gray-300'}`}>
                Organic Mode (24h Scheduling)
              </span>
              {settings.organicMode && (
                <span className="text-[10px] bg-emerald-900/50 text-emerald-400 border border-emerald-700/40 px-1.5 py-0.5 rounded-full">
                  ON
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              {settings.organicMode
                ? '✅ Orchestrator 24h weighted slots use karega — peak hour (7-10pm) pe zyada views, raat ko kam. 12s stagger + RAM-aware concurrency.'
                : 'OFF = standard run (sabhi profiles ek saath start). ON = 24h organic traffic pattern.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
