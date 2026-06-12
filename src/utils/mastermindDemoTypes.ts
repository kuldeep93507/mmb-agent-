/** Demo-only types — never sent to real agent until owner approves. */

export interface DemoCampaignGoals {
  views: number;
  likes: number;
  dislikes: number;
  subscribes: number;
  bells: number;
  comments: number;
  commentLikes: number;
  watchProfiles: number;
  volumeProfiles: number;
  scrollProfiles: number;
  captionsProfiles: number;
}

export const DEFAULT_CAMPAIGN_GOALS: DemoCampaignGoals = {
  views: 1000,
  likes: 400,
  dislikes: 20,
  subscribes: 150,
  bells: 120,
  comments: 80,
  commentLikes: 50,
  watchProfiles: 48,
  volumeProfiles: 48,
  scrollProfiles: 40,
  captionsProfiles: 20,
};

export type TrafficSourceKey =
  | 'search'
  | 'google'
  | 'bing'
  | 'notification'
  | 'homepage'
  | 'channel_discovery'
  | 'backlinks';

export type TrafficProfileMode = 'reuse' | 'rotate';

export interface DemoTrafficSourceQuota {
  /** Is traffic source se kitne views chahiye */
  viewCount: number;
  profileMode: TrafficProfileMode;
}

export type DemoTrafficQuotas = Record<TrafficSourceKey, DemoTrafficSourceQuota>;

/** Per-traffic search/entry time (seconds) — plan estimate + real run hint */
export interface TrafficEntryRange {
  entryMinSec: number;
  entryMaxSec: number;
}

export type DemoTrafficEntrySec = Record<TrafficSourceKey, TrafficEntryRange>;

export const DEFAULT_TRAFFIC_ENTRY_SEC: DemoTrafficEntrySec = {
  search: { entryMinSec: 90, entryMaxSec: 210 },
  google: { entryMinSec: 60, entryMaxSec: 180 },
  bing: { entryMinSec: 60, entryMaxSec: 165 },
  notification: { entryMinSec: 15, entryMaxSec: 45 },
  homepage: { entryMinSec: 30, entryMaxSec: 90 },
  channel_discovery: { entryMinSec: 45, entryMaxSec: 120 },
  backlinks: { entryMinSec: 20, entryMaxSec: 60 },
};

export const TRAFFIC_SOURCE_KEYS: TrafficSourceKey[] = [
  'search', 'google', 'bing', 'notification', 'homepage', 'channel_discovery', 'backlinks',
];

export const DEFAULT_TRAFFIC_QUOTAS: DemoTrafficQuotas = {
  search: { viewCount: 300, profileMode: 'rotate' },
  google: { viewCount: 200, profileMode: 'rotate' },
  bing: { viewCount: 100, profileMode: 'rotate' },
  notification: { viewCount: 150, profileMode: 'reuse' },
  homepage: { viewCount: 100, profileMode: 'rotate' },
  channel_discovery: { viewCount: 100, profileMode: 'rotate' },
  backlinks: { viewCount: 50, profileMode: 'reuse' },
};

export type PlanWindowMode = '24h' | '1h' | 'custom';

export interface DemoPlanWindow {
  mode: PlanWindowMode;
  /** 1h mode — kaunsa hour (0–23) */
  oneHourStart: number;
  customStartHour: number;
  customStartMinute: number;
  customEndHour: number;
  customEndMinute: number;
  /** Is window me kitne views chahiye (optional override) */
  windowViewGoal?: number;
}

export interface DemoHourlyViewTarget {
  hour: number;
  views: number;
}

export const DEFAULT_PLAN_WINDOW: DemoPlanWindow = {
  mode: '24h',
  oneHourStart: 9,
  customStartHour: 6,
  customStartMinute: 0,
  customEndHour: 22,
  customEndMinute: 0,
};

export interface DemoCampaignDefaults {
  watchTimeMin: number;
  watchTimeMax: number;
  volumeMin: number;
  volumeMax: number;
  scrollEnabled: boolean;
  /** Scroll ke dauran koi click nahi — entropy rule */
  scrollNoClick: boolean;
  captionsEnabled: boolean;
  tabsPerProfile: 1 | 2 | 3;
  tab2GapMin: number;
  tab2GapMax: number;
  tab3GapMin: number;
  tab3GapMax: number;
  /** Gap is minute se kam ho to profile BAND mat karo — seedha agla session */
  keepProfileOpenIfGapUnderMin: number;
  /** Gap is minute se zyada ho to profile band + dubara kholo */
  closeProfileIfGapOverMin: number;
  /** Band → dubara khulne me kitna time (minutes) */
  profileReopenMin: number;
  profileReopenMax: number;
  /** Lambe ads — estimate me extra buffer (sec) */
  adOverrunBufferSec: number;
  /** Ad skip on/off + max wait before skip */
  adSkipEnabled: boolean;
  adSkipDelayMinSec: number;
  adSkipDelayMaxSec: number;
  adClickEnabled: boolean;
  adClickDelayMinSec: number;
  adClickDelayMaxSec: number;
  adClickVisitSec: number;
  commentLikeEnabled: boolean;
  descriptionLinks: boolean;
  descriptionLinkUrl: string;
  descriptionLinkVisitSec: number;
  qualityChangeEnabled: boolean;
  playbackSpeed: string;
  /** Plan estimate — pre/mid-roll ad seconds (watch% se alag) */
  preRollAdSec: number;
  midRollAdSec: number;
  /** Traffic source ke hisaab se entry/search time */
  trafficEntrySec: DemoTrafficEntrySec;
  /** Session overlap ho to nayi tab me parallel chalao */
  parallelTabOnOverlap: boolean;
  staggerBatchSize: number;
  staggerDelayMinSec: number;
  staggerDelayMaxSec: number;
  hourlyTrafficCurve: boolean;
  notificationDelayMin: number;
  trafficQuotas: DemoTrafficQuotas;
  planWindow: DemoPlanWindow;
  /** Per-hour view targets — "is time me itne views" */
  hourlyViewTargets: DemoHourlyViewTarget[];
  /** Same profile + same video aaj dubara na aaye */
  noRepeatSameVideo: boolean;
  commentTemplateId: string;
}

export const DEFAULT_CAMPAIGN_DEFAULTS: DemoCampaignDefaults = {
  watchTimeMin: 80,
  watchTimeMax: 95,
  volumeMin: 60,
  volumeMax: 80,
  scrollEnabled: true,
  scrollNoClick: true,
  captionsEnabled: false,
  tabsPerProfile: 1,
  tab2GapMin: 15,
  tab2GapMax: 45,
  tab3GapMin: 20,
  tab3GapMax: 60,
  staggerBatchSize: 5,
  staggerDelayMinSec: 30,
  staggerDelayMaxSec: 90,
  hourlyTrafficCurve: true,
  notificationDelayMin: 30,
  trafficQuotas: { ...DEFAULT_TRAFFIC_QUOTAS },
  keepProfileOpenIfGapUnderMin: 3,
  closeProfileIfGapOverMin: 3,
  profileReopenMin: 2,
  profileReopenMax: 4,
  adOverrunBufferSec: 120,
  adSkipEnabled: true,
  adSkipDelayMinSec: 8,
  adSkipDelayMaxSec: 60,
  adClickEnabled: false,
  adClickDelayMinSec: 10,
  adClickDelayMaxSec: 15,
  adClickVisitSec: 20,
  commentLikeEnabled: false,
  descriptionLinks: false,
  descriptionLinkUrl: '',
  descriptionLinkVisitSec: 120,
  qualityChangeEnabled: true,
  playbackSpeed: '1x',
  preRollAdSec: 20,
  midRollAdSec: 45,
  trafficEntrySec: { ...DEFAULT_TRAFFIC_ENTRY_SEC },
  parallelTabOnOverlap: true,
  planWindow: { ...DEFAULT_PLAN_WINDOW },
  hourlyViewTargets: [],
  noRepeatSameVideo: true,
  commentTemplateId: '',
};

export function trafficSourceLabel(source: string): string {
  const map: Record<string, string> = {
    search: 'Search',
    google: 'Google',
    bing: 'Bing',
    notification: 'Notification',
    homepage: 'Homepage',
    channel_discovery: 'Channel',
    backlinks: 'Backlinks',
    direct: 'Backlinks',
  };
  return map[source] ?? source;
}

export function trafficQuotasTotal(quotas: DemoTrafficQuotas): number {
  return TRAFFIC_SOURCE_KEYS.reduce((s, k) => s + (quotas[k]?.viewCount ?? 0), 0);
}

/** Legacy % mix → view counts */
export function migrateTrafficMixToQuotas(
  mix: Record<string, number> | undefined,
  totalViews: number,
): DemoTrafficQuotas {
  const q = { ...DEFAULT_TRAFFIC_QUOTAS };
  if (!mix) return q;
  const sum = Object.values(mix).reduce((a, b) => a + b, 0) || 100;
  const mapKey = (k: string): TrafficSourceKey => (k === 'direct' ? 'backlinks' : k as TrafficSourceKey);
  for (const [k, pct] of Object.entries(mix)) {
    const key = mapKey(k);
    if (TRAFFIC_SOURCE_KEYS.includes(key)) {
      q[key] = { ...q[key], viewCount: Math.round((pct / sum) * totalViews) };
    }
  }
  return q;
}

export interface DemoCampaignVideo {
  id: string;
  url: string;
  title: string;
  channelName: string;
  channelId?: number;
  viewGoal: number;
  durationSec: number;
}

export interface DemoProfileSettings {
  watchTimeMin: number;
  watchTimeMax: number;
  volumeMin: number;
  volumeMax: number;
  trafficPreference: string;
  videoQuality: string;
  startDelayMin: number;
  startDelayMax: number;
  likeEnabled: boolean;
  dislikeEnabled: boolean;
  subscribeEnabled: boolean;
  bellEnabled: boolean;
  commentEnabled: boolean;
  seekEnabled: boolean;
  adSkipEnabled: boolean;
  adSkipDelayMinSec?: number;
  adSkipDelayMaxSec?: number;
  adClickEnabled?: boolean;
  adClickDelayMinSec?: number;
  adClickDelayMaxSec?: number;
  adClickVisitSec?: number;
  commentLikeEnabled: boolean;
  descriptionLinks: boolean;
  descriptionLinkUrl: string;
  descriptionLinkVisitSec: number;
  qualityChangeEnabled: boolean;
  playbackSpeed: string;
  captionsEnabled: boolean;
  descriptionExpand: boolean;
  scrollEnabled: boolean;
}

export const TRAFFIC_OPTIONS = [
  'search', 'google', 'bing', 'notification', 'homepage', 'channel_discovery', 'backlinks', 'direct', 'custom', 'random',
] as const;

export const TRAFFIC_QUOTA_LABELS: { key: TrafficSourceKey; label: string; emoji: string }[] = [
  { key: 'search', label: 'YT Search', emoji: '🔍' },
  { key: 'google', label: 'Google', emoji: '🌐' },
  { key: 'bing', label: 'Bing', emoji: '🔷' },
  { key: 'notification', label: 'Notification', emoji: '🔔' },
  { key: 'homepage', label: 'Homepage', emoji: '🏠' },
  { key: 'channel_discovery', label: 'Channel', emoji: '📺' },
  { key: 'backlinks', label: 'Backlinks', emoji: '🔗' },
];

export const QUALITY_OPTIONS = ['auto', '144p', '240p', '360p', '480p', '720p', '1080p'] as const;

export function defaultProfileSettings(): DemoProfileSettings {
  return {
    watchTimeMin: 80,
    watchTimeMax: 100,
    volumeMin: 60,
    volumeMax: 80,
    trafficPreference: 'search',
    videoQuality: 'auto',
    startDelayMin: 10,
    startDelayMax: 25,
    likeEnabled: true,
    dislikeEnabled: false,
    subscribeEnabled: true,
    bellEnabled: true,
    commentEnabled: false,
    seekEnabled: true,
    adSkipEnabled: true,
    adSkipDelayMinSec: 8,
    adSkipDelayMaxSec: 60,
    adClickEnabled: false,
    adClickDelayMinSec: 10,
    adClickDelayMaxSec: 15,
    adClickVisitSec: 20,
    commentLikeEnabled: false,
    descriptionLinks: false,
    descriptionLinkUrl: '',
    descriptionLinkVisitSec: 120,
    qualityChangeEnabled: true,
    playbackSpeed: '1x',
    captionsEnabled: false,
    descriptionExpand: true,
    scrollEnabled: true,
  };
}
