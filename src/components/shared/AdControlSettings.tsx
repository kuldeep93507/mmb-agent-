/** Shared ad skip + ad click controls — Shuffle, Engagement, Fleet, Scheduler, Mastermind. */

export type AdControlValues = {
  adSkipEnabled: boolean;
  adSkipMaxSec: number;
  midRollAdWaitSec: number;
  adClickEnabled: boolean;
  adClickDelayMinSec: number;
  adClickDelayMaxSec: number;
  adClickVisitSec: number;
};

export const DEFAULT_AD_CONTROLS: AdControlValues = {
  adSkipEnabled: true,
  adSkipMaxSec: 14,
  midRollAdWaitSec: 10,
  adClickEnabled: false,
  adClickDelayMinSec: 10,
  adClickDelayMaxSec: 15,
  adClickVisitSec: 20,
};

type Props = {
  values: AdControlValues;
  onChange: (patch: Partial<AdControlValues>) => void;
  compact?: boolean;
  showPerProfileHint?: boolean;
};

export function AdControlSettings({ values, onChange, compact, showPerProfileHint }: Props) {
  const v = values;
  const grid = compact ? 'grid-cols-1' : 'sm:grid-cols-2 lg:grid-cols-3';

  return (
    <div className="space-y-3">
      {showPerProfileHint && (
        <p className="text-[10px] text-gray-500">
          Global default — har profile par Engagement / Profile Settings se alag override ho sakta hai.
        </p>
      )}

      <div className={`grid ${grid} gap-3`}>
        <label className="flex items-center gap-2 text-sm text-gray-300 col-span-full">
          <input
            type="checkbox"
            checked={v.adSkipEnabled}
            onChange={(e) => onChange({ adSkipEnabled: e.target.checked })}
            className="rounded border-gray-600"
          />
          Skip ads (max wait ke baad skip — pehle khatam ho to OK)
        </label>

        <div>
          <label className="text-xs text-gray-500 block mb-1">Ad skip max wait (sec)</label>
          <input
            type="number"
            min={5}
            max={300}
            disabled={!v.adSkipEnabled}
            value={v.adSkipMaxSec}
            onChange={(e) => onChange({ adSkipMaxSec: Math.max(5, Number(e.target.value) || 14) })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm disabled:opacity-50"
          />
          <p className="text-[10px] text-gray-600 mt-0.5">例: 60 = 1 min baad skip try</p>
        </div>

        <div>
          <label className="text-xs text-gray-500 block mb-1">Mid-roll extra wait (sec)</label>
          <input
            type="number"
            min={0}
            max={120}
            disabled={!v.adSkipEnabled}
            value={v.midRollAdWaitSec}
            onChange={(e) => onChange({ midRollAdWaitSec: Math.max(0, Number(e.target.value) || 0) })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm disabled:opacity-50"
          />
        </div>
      </div>

      <div className="border-t border-gray-800 pt-3">
        <label className="flex items-center gap-2 text-sm text-gray-300 mb-2">
          <input
            type="checkbox"
            checked={v.adClickEnabled}
            onChange={(e) => onChange({ adClickEnabled: e.target.checked })}
            className="rounded border-gray-600"
          />
          Ad click (1 video = sirf 1 ad — pre ya mid roll)
        </label>

        <div className={`grid ${grid} gap-3 ${!v.adClickEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Click delay min (sec)</label>
            <input
              type="number"
              min={5}
              max={60}
              value={v.adClickDelayMinSec}
              onChange={(e) => onChange({ adClickDelayMinSec: Math.max(5, Number(e.target.value) || 10) })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Click delay max (sec)</label>
            <input
              type="number"
              min={5}
              max={60}
              value={v.adClickDelayMaxSec}
              onChange={(e) => onChange({ adClickDelayMaxSec: Math.max(v.adClickDelayMinSec, Number(e.target.value) || 15) })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm"
            />
            <p className="text-[10px] text-gray-600 mt-0.5">Ad start ke 10–15s baad click</p>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">Advertiser site visit (sec)</label>
            <input
              type="number"
              min={1}
              max={300}
              value={v.adClickVisitSec}
              onChange={(e) => onChange({ adClickVisitSec: Math.max(1, Number(e.target.value) || 20) })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Map UI ad controls → server worker / engagement fields */
export function adControlsToServerFields(v: AdControlValues): Record<string, unknown> {
  return {
    adSkipEnabled: v.adSkipEnabled,
    adSkipAfterSec: v.adSkipMaxSec,
    adSkipMaxSec: v.adSkipMaxSec,
    adSkipDelaySec: Math.min(10, v.adSkipMaxSec),
    adSkipDelayMaxSec: v.adSkipMaxSec,
    midRollAdWaitSec: v.midRollAdWaitSec,
    adClickEnabled: v.adClickEnabled,
    adClickDelayMinSec: v.adClickDelayMinSec,
    adClickDelayMaxSec: v.adClickDelayMaxSec,
    adClickVisitSec: v.adClickVisitSec,
  };
}
