/** Shared shuffle run settings (watch %, quality, ads, volume, traffic, actions). */

import {
  DEFAULT_ACTION_TOGGLES,
  DEFAULT_TRAFFIC_MIX,
  mapRunSettingsToProfileFields,
  type ActionToggles,
  type TrafficMixPct,
  type TrafficSource,
} from './runSettingsShared';

const SHUFFLE_SETTINGS_KEY = 'mmb_shuffle_settings';

export type ShuffleRunSettings = {
  watchTimeMin: number;
  watchTimeMax: number;
  videoQuality: string;
  adSkipEnabled: boolean;
  adSkipAfterSec: number;
  adSkipMaxSec: number;
  midRollAdWaitSec: number;
  adClickEnabled: boolean;
  adClickDelayMinSec: number;
  adClickDelayMaxSec: number;
  adClickVisitSec: number;
  videosPerProfile: number;
  organicMode: boolean;
  volumePct: number;
  volumeMin: number;
  volumeMax: number;
  seekEnabled: boolean;
  seekDirection: 'forward' | 'backward' | 'both';
  pauseProbability: number;
  uniqueTypingPersonality: boolean;
  naturalScrollCurves: boolean;
  playbackSpeed: string;
  descriptionExpand: boolean;
  trafficSource: TrafficSource;
  actionToggles: ActionToggles;
  commentLikePct: number;
  descriptionLinkUrl: string;
  descriptionLinkVisitSec: number;
} & TrafficMixPct;

function clampWatchRange(min: number, max: number): { watchTimeMin: number; watchTimeMax: number } {
  let watchTimeMin = Math.max(1, Math.min(100, Math.round(min)));
  let watchTimeMax = Math.max(1, Math.min(100, Math.round(max)));
  if (watchTimeMin > watchTimeMax) [watchTimeMin, watchTimeMax] = [watchTimeMax, watchTimeMin];
  return { watchTimeMin, watchTimeMax };
}

const TRAFFIC_IDS: TrafficSource[] = [
  'direct', 'search', 'suggested', 'homepage', 'notification', 'google', 'bing', 'channel_discovery', 'random',
];

export function loadShuffleRunSettings(): ShuffleRunSettings {
  const defaults: ShuffleRunSettings = {
    watchTimeMin: 90,
    watchTimeMax: 100,
    videoQuality: 'auto',
    adSkipEnabled: true,
    adSkipAfterSec: 14,
    adSkipMaxSec: 14,
    midRollAdWaitSec: 10,
    adClickEnabled: false,
    adClickDelayMinSec: 10,
    adClickDelayMaxSec: 15,
    adClickVisitSec: 20,
    videosPerProfile: 1,
    organicMode: false,
    volumePct: 75,
    volumeMin: 10,
    volumeMax: 100,
    seekEnabled: true,
    seekDirection: 'forward',
    pauseProbability: 5,
    uniqueTypingPersonality: true,
    naturalScrollCurves: true,
    playbackSpeed: '1x',
    descriptionExpand: true,
    trafficSource: 'search',
    actionToggles: { ...DEFAULT_ACTION_TOGGLES },
    commentLikePct: 100,
    descriptionLinkUrl: '',
    descriptionLinkVisitSec: 120,
    ...DEFAULT_TRAFFIC_MIX,
  };
  try {
    const raw = localStorage.getItem(SHUFFLE_SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ShuffleRunSettings>;
    const watch = clampWatchRange(
      Number(parsed.watchTimeMin ?? defaults.watchTimeMin),
      Number(parsed.watchTimeMax ?? defaults.watchTimeMax),
    );
    const toggles = { ...DEFAULT_ACTION_TOGGLES, ...(parsed.actionToggles || {}) };
    const ts = TRAFFIC_IDS.includes(parsed.trafficSource as TrafficSource)
      ? (parsed.trafficSource as TrafficSource)
      : defaults.trafficSource;
    return {
      ...defaults,
      ...watch,
      videoQuality: typeof parsed.videoQuality === 'string' ? parsed.videoQuality : defaults.videoQuality,
      adSkipEnabled: parsed.adSkipEnabled !== false,
      adSkipAfterSec: Number.isFinite(Number(parsed.adSkipAfterSec))
        ? Math.max(5, Math.min(300, Number(parsed.adSkipAfterSec)))
        : defaults.adSkipAfterSec,
      adSkipMaxSec: Number.isFinite(Number(parsed.adSkipMaxSec ?? parsed.adSkipAfterSec))
        ? Math.max(5, Math.min(300, Number(parsed.adSkipMaxSec ?? parsed.adSkipAfterSec)))
        : defaults.adSkipMaxSec,
      adClickEnabled: parsed.adClickEnabled === true,
      adClickDelayMinSec: Number(parsed.adClickDelayMinSec ?? defaults.adClickDelayMinSec),
      adClickDelayMaxSec: Number(parsed.adClickDelayMaxSec ?? defaults.adClickDelayMaxSec),
      adClickVisitSec: Number(parsed.adClickVisitSec ?? defaults.adClickVisitSec),
      videosPerProfile: Math.max(1, Math.min(10, Number(parsed.videosPerProfile ?? defaults.videosPerProfile))),
      midRollAdWaitSec: Number.isFinite(Number(parsed.midRollAdWaitSec))
        ? Math.max(0, Math.min(120, Number(parsed.midRollAdWaitSec)))
        : defaults.midRollAdWaitSec,
      organicMode: parsed.organicMode === true,
      volumePct: Number.isFinite(Number(parsed.volumePct))
        ? Math.max(0, Math.min(100, Number(parsed.volumePct))) : defaults.volumePct,
      volumeMin: Number.isFinite(Number(parsed.volumeMin))
        ? Math.max(0, Math.min(100, Number(parsed.volumeMin))) : defaults.volumeMin,
      volumeMax: Number.isFinite(Number(parsed.volumeMax))
        ? Math.max(0, Math.min(100, Number(parsed.volumeMax))) : defaults.volumeMax,
      seekEnabled: parsed.seekEnabled !== false,
      seekDirection: (['forward', 'backward', 'both'] as const).includes(parsed.seekDirection as 'forward')
        ? (parsed.seekDirection as 'forward' | 'backward' | 'both') : defaults.seekDirection,
      pauseProbability: Number.isFinite(Number(parsed.pauseProbability))
        ? Math.max(0, Math.min(100, Number(parsed.pauseProbability))) : defaults.pauseProbability,
      uniqueTypingPersonality: parsed.uniqueTypingPersonality !== false,
      naturalScrollCurves: parsed.naturalScrollCurves !== false,
      playbackSpeed: typeof parsed.playbackSpeed === 'string' ? parsed.playbackSpeed : defaults.playbackSpeed,
      descriptionExpand: parsed.descriptionExpand !== false,
      trafficSource: ts,
      actionToggles: toggles,
      commentLikePct: Number.isFinite(Number(parsed.commentLikePct))
        ? Math.max(1, Math.min(100, Number(parsed.commentLikePct))) : defaults.commentLikePct,
      descriptionLinkUrl: typeof parsed.descriptionLinkUrl === 'string' ? parsed.descriptionLinkUrl.trim() : defaults.descriptionLinkUrl,
      descriptionLinkVisitSec: Number.isFinite(Number(parsed.descriptionLinkVisitSec))
        ? Math.max(30, Math.min(600, Number(parsed.descriptionLinkVisitSec))) : defaults.descriptionLinkVisitSec,
      srcNotificationPct: Number(parsed.srcNotificationPct ?? defaults.srcNotificationPct),
      srcSearchPct: Number(parsed.srcSearchPct ?? defaults.srcSearchPct),
      srcHomepagePct: Number(parsed.srcHomepagePct ?? defaults.srcHomepagePct),
      srcGooglePct: Number(parsed.srcGooglePct ?? defaults.srcGooglePct),
      srcBingPct: Number(parsed.srcBingPct ?? defaults.srcBingPct),
      srcChannelDiscPct: Number(parsed.srcChannelDiscPct ?? defaults.srcChannelDiscPct),
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
  const mapped = mapRunSettingsToProfileFields({
    ...s,
    pauseProbability: s.pauseProbability,
  });
  return configs.map((cfg) => ({
    ...cfg,
    ...mapped,
  }));
}
