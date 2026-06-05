/** Shared shuffle run settings (watch %, quality, ads) for Schedule + Shuffle runs. */

const SHUFFLE_SETTINGS_KEY = 'mmb_shuffle_settings';

export type ShuffleRunSettings = {
  watchTimeMin: number;
  watchTimeMax: number;
  videoQuality: string;
  adSkipEnabled: boolean;
  adSkipAfterSec: number;
  midRollAdWaitSec: number;
  /** Organic mode: 24h weighted scheduling via Orchestrator */
  organicMode: boolean;
};

function clampWatchRange(min: number, max: number): { watchTimeMin: number; watchTimeMax: number } {
  let watchTimeMin = Math.max(1, Math.min(100, Math.round(min)));
  let watchTimeMax = Math.max(1, Math.min(100, Math.round(max)));
  if (watchTimeMin > watchTimeMax) [watchTimeMin, watchTimeMax] = [watchTimeMax, watchTimeMin];
  return { watchTimeMin, watchTimeMax };
}

export function loadShuffleRunSettings(): ShuffleRunSettings {
  const defaults: ShuffleRunSettings = {
    watchTimeMin: 90,
    watchTimeMax: 100,
    videoQuality: 'auto',
    adSkipEnabled: true,
    adSkipAfterSec: 5,
    midRollAdWaitSec: 10,
    organicMode: false,
  };
  try {
    const raw = localStorage.getItem(SHUFFLE_SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ShuffleRunSettings>;
    const watch = clampWatchRange(
      Number(parsed.watchTimeMin ?? defaults.watchTimeMin),
      Number(parsed.watchTimeMax ?? defaults.watchTimeMax),
    );
    return {
      ...defaults,
      ...watch,
      videoQuality: typeof parsed.videoQuality === 'string' ? parsed.videoQuality : defaults.videoQuality,
      adSkipEnabled: parsed.adSkipEnabled !== false,
      adSkipAfterSec: Number.isFinite(Number(parsed.adSkipAfterSec))
        ? Math.max(0, Math.min(120, Number(parsed.adSkipAfterSec)))
        : defaults.adSkipAfterSec,
      midRollAdWaitSec: Number.isFinite(Number(parsed.midRollAdWaitSec))
        ? Math.max(0, Math.min(120, Number(parsed.midRollAdWaitSec)))
        : defaults.midRollAdWaitSec,
      organicMode: parsed.organicMode === true,
    };
  } catch {
    return defaults;
  }
}

/** Merge shuffle page settings into each profile config row sent to the server. */
export function mergeShuffleSettingsIntoProfileConfigs(
  configs: Record<string, unknown>[],
): Record<string, unknown>[] {
  const s = loadShuffleRunSettings();
  const watch = clampWatchRange(s.watchTimeMin, s.watchTimeMax);
  return configs.map((cfg) => ({
    ...cfg,
    ...watch,
    videoQuality: s.videoQuality,
    adSkipEnabled: s.adSkipEnabled,
    adSkipAfterSec: s.adSkipAfterSec,
    midRollAdWaitSec: s.midRollAdWaitSec,
    humanEngagementEnabled: true,
    seekForwardMax: cfg.seekForwardMax ?? 2,
    seekForwardSec: cfg.seekForwardSec ?? 10,
  }));
}
