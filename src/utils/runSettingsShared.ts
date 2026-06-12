/** Shared run settings — Scheduler, Shuffle, Notification Hub. */

export type TrafficSource =
  | 'direct'
  | 'search'
  | 'suggested'
  | 'homepage'
  | 'notification'
  | 'google'
  | 'bing'
  | 'channel_discovery'
  | 'random';

export type ActionToggles = {
  like: boolean;
  dislike: boolean;
  subscribe: boolean;
  bell: boolean;
  comment: boolean;
  commentLike: boolean;
  descriptionLinks: boolean;
  scroll: boolean;
  qualityChange: boolean;
  captionsToggle: boolean;
};

export const DEFAULT_ACTION_TOGGLES: ActionToggles = {
  like: true,
  dislike: false,
  subscribe: true,
  bell: false,
  comment: false,
  commentLike: false,
  descriptionLinks: false,
  scroll: true,
  qualityChange: true,
  captionsToggle: false,
};

export const TRAFFIC_SOURCES: { id: TrafficSource; label: string; desc: string }[] = [
  { id: 'random', label: '🎲 Random', desc: 'Har profile alag source (mix %)' },
  { id: 'notification', label: '🔔 Notification', desc: 'Bell → notification panel → video' },
  { id: 'search', label: '🔍 YT Search', desc: 'YouTube search → click video' },
  { id: 'channel_discovery', label: '📺 Channel Disc', desc: 'Search → channel → video' },
  { id: 'google', label: '🌐 Google', desc: 'Google → YouTube link' },
  { id: 'bing', label: '🔷 Bing', desc: 'Bing → YouTube link' },
  { id: 'homepage', label: '🏠 Homepage', desc: 'YouTube home feed browse' },
  { id: 'direct', label: '🔗 Direct URL', desc: 'Direct watch URL (entropy skip)' },
  { id: 'suggested', label: '💡 Suggested', desc: 'Sidebar / suggested click' },
];

export type TrafficMixPct = {
  srcNotificationPct: number;
  srcSearchPct: number;
  srcHomepagePct: number;
  srcGooglePct: number;
  srcBingPct: number;
  srcChannelDiscPct: number;
};

export const DEFAULT_TRAFFIC_MIX: TrafficMixPct = {
  srcNotificationPct: 20,
  srcSearchPct: 30,
  srcHomepagePct: 20,
  srcGooglePct: 12,
  srcBingPct: 8,
  srcChannelDiscPct: 10,
};

/** Map shared settings → profileConfig fields for server schedule/worker. */
export function mapRunSettingsToProfileFields(s: {
  watchTimeMin: number;
  watchTimeMax: number;
  videoQuality: string;
  adSkipEnabled: boolean;
  adSkipAfterSec: number;
  adSkipMaxSec?: number;
  midRollAdWaitSec: number;
  adClickEnabled?: boolean;
  adClickDelayMinSec?: number;
  adClickDelayMaxSec?: number;
  adClickVisitSec?: number;
  videosPerProfile?: number;
  volumePct?: number;
  volumeMin: number;
  volumeMax: number;
  seekEnabled?: boolean;
  seekDirection?: string;
  pauseProbability?: number;
  uniqueTypingPersonality?: boolean;
  naturalScrollCurves?: boolean;
  playbackSpeed?: string;
  descriptionExpand?: boolean;
  descriptionLinkUrl?: string;
  descriptionLinkVisitSec?: number;
  commentLikePct?: number;
  trafficSource: TrafficSource;
  actionToggles: ActionToggles;
} & Partial<TrafficMixPct>): Record<string, unknown> {
  const watchMin = Math.max(1, Math.min(100, s.watchTimeMin));
  const watchMax = Math.max(watchMin, Math.min(100, s.watchTimeMax));
  const pauseProb = Number.isFinite(Number(s.pauseProbability))
    ? Math.max(0, Math.min(100, Number(s.pauseProbability))) / 100
    : 0.05;
  const speed = s.playbackSpeed || '1x';

  return {
    watchTimeMin: watchMin,
    watchTimeMax: watchMax,
    videoQuality: s.videoQuality,
    adSkipEnabled: s.adSkipEnabled !== false,
    adSkipAfterSec: s.adSkipMaxSec ?? s.adSkipAfterSec,
    adSkipMaxSec: s.adSkipMaxSec ?? s.adSkipAfterSec,
    adSkipDelaySec: Math.min(10, s.adSkipMaxSec ?? s.adSkipAfterSec),
    adSkipDelayMaxSec: s.adSkipMaxSec ?? s.adSkipAfterSec,
    midRollAdWaitSec: s.midRollAdWaitSec,
    adClickEnabled: s.adClickEnabled === true,
    adClickDelayMinSec: s.adClickDelayMinSec ?? 10,
    adClickDelayMaxSec: s.adClickDelayMaxSec ?? 15,
    adClickVisitSec: s.adClickVisitSec ?? 20,
    videosPerProfile: Math.max(1, Math.min(10, s.videosPerProfile ?? 1)),
    maxVideosPerSession: Math.max(1, Math.min(10, s.videosPerProfile ?? 1)),
    humanEngagementEnabled: true,
    likeEnabled: s.actionToggles.like,
    subscribeEnabled: s.actionToggles.subscribe,
    bellEnabled: s.actionToggles.bell,
    commentEnabled: s.actionToggles.comment,
    dislikeEnabled: s.actionToggles.dislike,
    commentLikeEnabled: s.actionToggles.commentLike,
    commentLikePct: s.actionToggles.commentLike
      ? Math.max(1, Math.min(100, s.commentLikePct ?? 100))
      : 0,
    descriptionLinks: s.actionToggles.descriptionLinks,
    descriptionLinkUrl: s.descriptionLinkUrl ?? '',
    descriptionLinkVisitSec: s.descriptionLinkVisitSec ?? 120,
    descriptionExpand: s.descriptionExpand !== false,
    seekEnabled: s.seekEnabled !== false,
    seekDirection: s.seekDirection || 'forward',
    seekForwardMax: 2,
    seekForwardSec: 10,
    volumePct: s.volumePct ?? 75,
    volumeMin: s.volumeMin,
    volumeMax: s.volumeMax,
    pauseProbability: pauseProb,
    uniqueTypingPersonality: s.uniqueTypingPersonality !== false,
    naturalScrollCurves: s.naturalScrollCurves !== false,
    scrollActivity: s.actionToggles.scroll,
    qualityChange: s.actionToggles.qualityChange,
    qualityChangeEnabled: s.actionToggles.qualityChange,
    captionsToggle: s.actionToggles.captionsToggle,
    captionsEnabled: s.actionToggles.captionsToggle,
    playbackSpeed: speed,
    speedChange: speed !== '1x',
    speedChangeEnabled: speed !== '1x',
    trafficSource: s.trafficSource,
    ...(s.trafficSource === 'random'
      ? {
          srcNotificationPct: s.srcNotificationPct ?? DEFAULT_TRAFFIC_MIX.srcNotificationPct,
          srcSearchPct: s.srcSearchPct ?? DEFAULT_TRAFFIC_MIX.srcSearchPct,
          srcHomepagePct: s.srcHomepagePct ?? DEFAULT_TRAFFIC_MIX.srcHomepagePct,
          srcGooglePct: s.srcGooglePct ?? DEFAULT_TRAFFIC_MIX.srcGooglePct,
          srcBingPct: s.srcBingPct ?? DEFAULT_TRAFFIC_MIX.srcBingPct,
          srcChannelDiscPct: s.srcChannelDiscPct ?? DEFAULT_TRAFFIC_MIX.srcChannelDiscPct,
        }
      : {}),
  };
}
