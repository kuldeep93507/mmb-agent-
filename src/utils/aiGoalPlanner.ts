/**
 * AI Goal Planner (demo) — current time se session timetable + capacity math.
 * Har profile ka exact start/end + agla session clearly.
 */

import { HOURLY_WEIGHTS } from './mastermindDemoPlan';
import { estimateSessionSeconds, formatDuration } from './mastermindSessionTime';
import type {
  DemoCampaignDefaults,
  DemoCampaignGoals,
  DemoCampaignVideo,
  DemoHourlyViewTarget,
  DemoPlanWindow,
  DemoProfileSettings,
  DemoTrafficQuotas,
  TrafficSourceKey,
} from './mastermindDemoTypes';
import {
  DEFAULT_CAMPAIGN_DEFAULTS,
  DEFAULT_CAMPAIGN_GOALS,
  DEFAULT_TRAFFIC_QUOTAS,
  TRAFFIC_SOURCE_KEYS,
  trafficSourceLabel,
  trafficQuotasTotal,
} from './mastermindDemoTypes';
import { syncVideoGoalsFromTraffic } from './mastermindTrafficSync';

export type GoalWindowMode = '1h' | 'custom' | 'duration';
export type VideoRotationMode = 'same' | 'different';

export interface AIGoalProfileRef {
  id: string;
  name: string;
}

export interface AIGoalVideoRef {
  id: string;
  url: string;
  title: string;
  channelName: string;
  channelId?: number;
  durationSec: number;
}

export interface AIGoalPlannerInput {
  windowMode: GoalWindowMode;
  windowStartAt: Date;
  windowEndAt: Date;
  durationHours: number;
  viewGoal: number;
  /** Fallback avg duration jab videos khali hon */
  videoDurationSec: number;
  viewsPerTabPerHour: number;
  tabsPerProfile: 1 | 2 | 3;
  profiles: AIGoalProfileRef[];
  /** Multi-channel videos — 3 tab = 3 videos recommend */
  videos: AIGoalVideoRef[];
  /** same = sab profiles (1,2,3) · different = Profile A (1,2,3) Profile B (3,2,1) */
  videoRotationMode: VideoRotationMode;
  /** User-set engagement targets (likes, subs, …) */
  engagementGoals?: Partial<DemoCampaignGoals>;
  /** Traffic source quotas — sessions inke hisaab se assign honge */
  trafficQuotas?: DemoTrafficQuotas;
  /** Watch %, volume, scroll defaults */
  defaultsPatch?: Partial<DemoCampaignDefaults>;
  /** Per-session YouTube actions (like, sub, ad skip, …) */
  sessionActions?: DemoProfileSettings;
}

export interface AIGoalSessionRow {
  id: string;
  seq: number;
  profileId: string;
  profileName: string;
  tabIndex: number;
  tabsInBundle: number;
  videoId: string;
  videoTitle: string;
  channelName: string;
  trafficSource: TrafficSourceKey;
  trafficLabel: string;
  actionsPlanned: string[];
  campaignPhase: number;
  startAt: Date;
  endAt: Date;
  startLabel: string;
  endLabel: string;
  sessionSec: number;
  sessionLabel: string;
  nextSessionAt: Date | null;
  nextSessionLabel: string;
  gapBeforeSec: number;
  gapLabel: string;
  phase: 'past' | 'now' | 'upcoming';
}

export interface AIGoalProfileTimeline {
  profileId: string;
  profileName: string;
  sessionCount: number;
  firstStart: string;
  lastEnd: string;
  nextUp: AIGoalSessionRow | null;
  sessions: AIGoalSessionRow[];
}

export interface AIGoalCampaignSegment {
  id: string;
  phase: number;
  startAt: Date;
  endAt: Date;
  timeLabel: string;
  viewGoal: number;
  profilesUsed: number;
  tabsPerProfile: number;
  trafficHint: string;
  rationale: string;
}

export interface AIGoalHourSlot {
  hour: number;
  label: string;
  views: number;
  weight: number;
}

export interface AIGoalCapacityBreakdown {
  viewsPerTabPerHour: number;
  viewsPerProfilePerHour: number;
  fleetViewsPerHour: number;
  windowHours: number;
  windowLabel: string;
  windowStartLabel: string;
  windowEndLabel: string;
  maxByUserRule: number;
  maxByVideoDuration: number;
  maxViewsPossible: number;
  sessionSecEstimate: number;
  minGapSec: number;
  sessionsPerTabPerHour: number;
  feasible: boolean;
  gap: number;
}

export interface AIGoalProfileVideoOrder {
  profileId: string;
  profileName: string;
  /** Tab order labels e.g. ["Ch A: Vid 1", "Ch B: Vid 2"] */
  tabOrderLabels: string[];
}

export interface AIGoalPlannerResult {
  input: AIGoalPlannerInput;
  plannedAt: Date;
  capacity: AIGoalCapacityBreakdown;
  profileVideoOrders: AIGoalProfileVideoOrder[];
  sessions: AIGoalSessionRow[];
  profileTimelines: AIGoalProfileTimeline[];
  hourlySlots: AIGoalHourSlot[];
  campaignSegments: AIGoalCampaignSegment[];
  narrativeHi: string;
  warnings: string[];
  tips: string[];
  planWindow: DemoPlanWindow;
  hourlyViewTargets: DemoHourlyViewTarget[];
  suggestedGoals: DemoCampaignGoals;
  suggestedDefaults: Partial<DemoCampaignDefaults>;
  suggestedTrafficQuotas: DemoTrafficQuotas;
}

const TRAFFIC_ROTATE: TrafficSourceKey[] = [
  'search', 'google', 'homepage', 'notification', 'channel_discovery', 'bing', 'backlinks',
];

function plannedActionsFromSettings(s: DemoProfileSettings): string[] {
  const out: string[] = [];
  if (s.likeEnabled) out.push('like');
  if (s.dislikeEnabled) out.push('dislike');
  if (s.subscribeEnabled) out.push('subscribe');
  if (s.bellEnabled) out.push('bell');
  if (s.commentEnabled) out.push('comment');
  if (s.seekEnabled) out.push('seek');
  if (s.adSkipEnabled) out.push('adskip');
  if (s.captionsEnabled) out.push('captions');
  if (s.descriptionExpand) out.push('desc');
  if (s.scrollEnabled) out.push('scroll');
  return out;
}

/** Traffic quotas se session queue — har source ki viewCount utni baar */
export function buildTrafficQueue(quotas: DemoTrafficQuotas): TrafficSourceKey[] {
  const queue: TrafficSourceKey[] = [];
  for (const key of TRAFFIC_SOURCE_KEYS) {
    const count = quotas[key]?.viewCount ?? 0;
    for (let i = 0; i < count; i++) queue.push(key);
  }
  return queue;
}

function resolvedDefaults(input: AIGoalPlannerInput): DemoCampaignDefaults {
  return { ...DEFAULT_CAMPAIGN_DEFAULTS, ...input.defaultsPatch };
}

function resolvedSessionActions(input: AIGoalPlannerInput): DemoProfileSettings {
  const d = resolvedDefaults(input);
  return {
    watchTimeMin: d.watchTimeMin,
    watchTimeMax: d.watchTimeMax,
    volumeMin: d.volumeMin,
    volumeMax: d.volumeMax,
    trafficPreference: 'search',
    videoQuality: 'auto',
    startDelayMin: 10,
    startDelayMax: 25,
    likeEnabled: input.sessionActions?.likeEnabled ?? true,
    dislikeEnabled: input.sessionActions?.dislikeEnabled ?? false,
    subscribeEnabled: input.sessionActions?.subscribeEnabled ?? true,
    bellEnabled: input.sessionActions?.bellEnabled ?? true,
    commentEnabled: input.sessionActions?.commentEnabled ?? false,
    seekEnabled: input.sessionActions?.seekEnabled ?? true,
    adSkipEnabled: input.sessionActions?.adSkipEnabled ?? true,
    adSkipDelayMinSec: d.adSkipDelayMinSec,
    adSkipDelayMaxSec: d.adSkipDelayMaxSec,
    captionsEnabled: input.sessionActions?.captionsEnabled ?? d.captionsEnabled,
    descriptionExpand: input.sessionActions?.descriptionExpand ?? true,
    scrollEnabled: input.sessionActions?.scrollEnabled ?? d.scrollEnabled,
  };
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export function fmtClock(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtClockFull(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Abhi se window — UI default */
export function defaultWindowFromNow(mode: GoalWindowMode, durationHours = 6): {
  start: Date;
  end: Date;
  durationHours: number;
} {
  const start = new Date();
  start.setSeconds(0, 0);
  if (mode === '1h') {
    const end = new Date(start.getTime() + 3600000);
    return { start, end, durationHours: 1 };
  }
  const end = new Date(start.getTime() + durationHours * 3600000);
  return { start, end, durationHours };
}

function toPlanWindow(input: AIGoalPlannerInput): DemoPlanWindow {
  const s = input.windowStartAt;
  const e = input.windowEndAt;
  const spanMs = e.getTime() - s.getTime();
  if (spanMs <= 3600000 + 60000) {
    return {
      mode: '1h',
      oneHourStart: s.getHours(),
      customStartHour: s.getHours(),
      customStartMinute: s.getMinutes(),
      customEndHour: e.getHours(),
      customEndMinute: e.getMinutes(),
      windowViewGoal: input.viewGoal,
    };
  }
  return {
    mode: 'custom',
    oneHourStart: s.getHours(),
    customStartHour: s.getHours(),
    customStartMinute: s.getMinutes(),
    customEndHour: e.getHours(),
    customEndMinute: e.getMinutes(),
    windowViewGoal: input.viewGoal,
  };
}

function windowLabel(input: AIGoalPlannerInput): string {
  const s = fmtClock(input.windowStartAt);
  const e = fmtClock(input.windowEndAt);
  const hrs = ((input.windowEndAt.getTime() - input.windowStartAt.getTime()) / 3600000).toFixed(1);
  if (input.windowMode === 'duration') {
    return `Ab se ${hrs}h (${s} → ${e})`;
  }
  if (input.windowMode === '1h') {
    return `Agla 1 ghanta (${s} → ${e})`;
  }
  return `Aaj ${s} → ${e} (${hrs}h)`;
}

function sessionPhase(row: AIGoalSessionRow, now = new Date()): AIGoalSessionRow['phase'] {
  const t = now.getTime();
  if (row.endAt.getTime() <= t) return 'past';
  if (row.startAt.getTime() <= t && t < row.endAt.getTime()) return 'now';
  return 'upcoming';
}

function organicWeightAt(ms: number): number {
  const h = new Date(ms).getHours();
  return HOURLY_WEIGHTS[h] ?? 0.5;
}

/** Window ke andar organic timestamps — peak hours pe zyada views */
function assignTargetTimes(count: number, startMs: number, endMs: number): number[] {
  if (count <= 0) return [];
  const span = endMs - startMs;
  if (span <= 0) return Array(count).fill(startMs);

  const buckets = 24;
  const bucketMs = span / buckets;
  const weights: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const mid = startMs + bucketMs * (i + 0.5);
    weights.push(Math.max(0.05, organicWeightAt(mid)));
  }
  const wSum = weights.reduce((a, b) => a + b, 0);

  const times: number[] = [];
  let assigned = 0;
  for (let i = 0; i < buckets; i++) {
    const share = i === buckets - 1
      ? count - assigned
      : Math.floor((weights[i] / wSum) * count);
    const n = Math.max(0, share);
    for (let j = 0; j < n; j++) {
      const jitter = (Math.random() * 0.7 + 0.15) * bucketMs;
      times.push(startMs + i * bucketMs + jitter);
    }
    assigned += n;
  }
  while (times.length < count) {
    times.push(startMs + Math.random() * span);
  }
  return times.sort((a, b) => a - b);
}

function resolvedVideos(input: AIGoalPlannerInput): AIGoalVideoRef[] {
  if (input.videos.length) return input.videos;
  return [{
    id: 'fallback-v1',
    url: 'https://youtube.com/watch?v=demo',
    title: 'Target Video',
    channelName: 'Channel',
    durationSec: Math.max(60, input.videoDurationSec),
  }];
}

function avgVideoDurationSec(input: AIGoalPlannerInput): number {
  const vids = resolvedVideos(input);
  return Math.round(vids.reduce((s, v) => s + v.durationSec, 0) / vids.length);
}

function videoLabel(v: AIGoalVideoRef, short = true): string {
  if (short) return `${v.channelName}: ${v.title.slice(0, 36)}${v.title.length > 36 ? '…' : ''}`;
  return `${v.channelName} — ${v.title}`;
}

/** Per-profile tab video index order */
export function buildProfileVideoOrders(
  profiles: AIGoalProfileRef[],
  videoCount: number,
  mode: VideoRotationMode,
): Map<string, number[]> {
  const n = Math.max(1, videoCount);
  const base = Array.from({ length: n }, (_, i) => i);
  const map = new Map<string, number[]>();

  profiles.forEach((p, profileIdx) => {
    if (mode === 'same') {
      map.set(p.id, [...base]);
      return;
    }
    // different: even = rotate, odd = reverse (Profile A 1,2,3 · Profile B 3,2,1)
    const shift = profileIdx % n;
    const rotated = base.map((_, i) => (i + shift) % n);
    if (profileIdx % 2 === 1) {
      map.set(p.id, [...rotated].reverse());
    } else {
      map.set(p.id, rotated);
    }
  });
  return map;
}

function computeCapacity(input: AIGoalPlannerInput): AIGoalCapacityBreakdown {
  const profiles = Math.max(1, input.profiles.length || 1);
  const tabs = input.tabsPerProfile;
  const vptph = Math.max(1, input.viewsPerTabPerHour);
  const vppph = vptph * tabs;
  const fleetPerHour = profiles * vppph;
  const windowHours = Math.max(0.25, (input.windowEndAt.getTime() - input.windowStartAt.getTime()) / 3600000);
  const maxByUserRule = Math.floor(fleetPerHour * windowHours);
  const avgDur = avgVideoDurationSec(input);
  const defs = resolvedDefaults(input);
  const actions = resolvedSessionActions(input);

  const sessionSec = estimateSessionSeconds({
    durationSec: Math.max(60, avgDur),
    watchTimeMin: defs.watchTimeMin,
    watchTimeMax: defs.watchTimeMax,
    adSkipEnabled: actions.adSkipEnabled,
    startDelayMin: actions.startDelayMin,
    startDelayMax: actions.startDelayMax,
    trafficSource: 'search',
  });
  const sessionsPerTabPerHour = Math.max(1, Math.floor(3600 / sessionSec));
  const maxByVideoDuration = Math.floor(profiles * tabs * sessionsPerTabPerHour * windowHours);
  const maxViewsPossible = Math.min(maxByUserRule, maxByVideoDuration);
  const minGapSec = Math.max(sessionSec + 30, Math.floor(3600 / Math.max(1, vppph)));
  const feasible = input.viewGoal <= maxViewsPossible;

  return {
    viewsPerTabPerHour: vptph,
    viewsPerProfilePerHour: vppph,
    fleetViewsPerHour: fleetPerHour,
    windowHours,
    windowLabel: windowLabel(input),
    windowStartLabel: fmtClock(input.windowStartAt),
    windowEndLabel: fmtClock(input.windowEndAt),
    maxByUserRule,
    maxByVideoDuration,
    maxViewsPossible,
    sessionSecEstimate: sessionSec,
    minGapSec,
    sessionsPerTabPerHour,
    feasible,
    gap: input.viewGoal - maxViewsPossible,
  };
}

function buildProfileVideoOrderLabels(
  profiles: AIGoalProfileRef[],
  videos: AIGoalVideoRef[],
  mode: VideoRotationMode,
): AIGoalProfileVideoOrder[] {
  const orders = buildProfileVideoOrders(profiles, videos.length, mode);
  return profiles.map(p => {
    const idxs = orders.get(p.id) ?? [0];
    return {
      profileId: p.id,
      profileName: p.name,
      tabOrderLabels: idxs.map((vi, ti) => `Tab ${ti + 1}: ${videoLabel(videos[vi % videos.length])}`),
    };
  });
}

function buildSessions(
  input: AIGoalPlannerInput,
  capacity: AIGoalCapacityBreakdown,
  effectiveGoal: number,
  now: Date,
): AIGoalSessionRow[] {
  const pool = input.profiles.length
    ? input.profiles
    : [{ id: 'demo-1', name: 'Demo-Profile-01' }];
  const videos = resolvedVideos(input);
  const profileOrders = buildProfileVideoOrders(pool, videos.length, input.videoRotationMode);
  const startMs = Math.max(now.getTime(), input.windowStartAt.getTime());
  const endMs = input.windowEndAt.getTime();
  const minGap = capacity.minGapSec;
  const tabs = input.tabsPerProfile;
  const defs = resolvedDefaults(input);
  const sessionActions = resolvedSessionActions(input);
  const actionsPlanned = plannedActionsFromSettings(sessionActions);
  const trafficQueue = input.trafficQuotas
    ? buildTrafficQueue(input.trafficQuotas)
    : [];

  const targetTimes = assignTargetTimes(effectiveGoal, startMs, endMs);
  const profileLastEnd = new Map<string, number>();
  const profileSessionCount = new Map<string, number>();
  const rows: AIGoalSessionRow[] = [];
  let seq = 0;

  for (let i = 0; i < targetTimes.length; i++) {
    const prof = pool[i % pool.length];
    const sessOnProfile = profileSessionCount.get(prof.id) ?? 0;
    const tabIdx = sessOnProfile % tabs;
    const round = Math.floor(sessOnProfile / tabs);
    const order = profileOrders.get(prof.id) ?? [0];
    const videoIdx = order[(tabIdx + round) % order.length];
    const vid = videos[videoIdx % videos.length];

    const sessionSec = estimateSessionSeconds({
      durationSec: Math.max(60, vid.durationSec),
      watchTimeMin: defs.watchTimeMin,
      watchTimeMax: defs.watchTimeMax,
      adSkipEnabled: sessionActions.adSkipEnabled,
      startDelayMin: sessionActions.startDelayMin,
      startDelayMax: sessionActions.startDelayMax,
      trafficSource: 'search',
    });

    const traffic = trafficQueue.length
      ? trafficQueue[i % trafficQueue.length]
      : TRAFFIC_ROTATE[i % TRAFFIC_ROTATE.length];

    let startMsResolved = targetTimes[i];
    const lastEnd = profileLastEnd.get(prof.id) ?? 0;
    if (lastEnd > 0 && startMsResolved < lastEnd + minGap * 1000) {
      startMsResolved = lastEnd + minGap * 1000;
    }
    if (startMsResolved + sessionSec * 1000 > endMs) continue;

    const startAt = new Date(startMsResolved);
    const endAt = new Date(startMsResolved + sessionSec * 1000);
    const gapBeforeSec = lastEnd > 0 ? Math.round((startMsResolved - lastEnd) / 1000) : 0;

    profileLastEnd.set(prof.id, endAt.getTime());
    profileSessionCount.set(prof.id, sessOnProfile + 1);

    const phaseNum = Math.min(3, Math.floor((startMsResolved - startMs) / Math.max(1, (endMs - startMs) / 3))) + 1;

    rows.push({
      id: `ai-sess-${seq}`,
      seq: seq++,
      profileId: prof.id,
      profileName: prof.name,
      tabIndex: tabIdx + 1,
      tabsInBundle: tabs,
      videoId: vid.id,
      videoTitle: vid.title,
      channelName: vid.channelName,
      trafficSource: traffic,
      trafficLabel: trafficSourceLabel(traffic),
      actionsPlanned,
      campaignPhase: phaseNum,
      startAt,
      endAt,
      startLabel: fmtClock(startAt),
      endLabel: fmtClock(endAt),
      sessionSec,
      sessionLabel: formatDuration(sessionSec),
      nextSessionAt: null,
      nextSessionLabel: '—',
      gapBeforeSec,
      gapLabel: gapBeforeSec > 0 ? `${Math.round(gapBeforeSec / 60)}m gap` : 'pehla session',
      phase: 'upcoming',
    });
  }

  rows.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  rows.forEach((r, idx) => { r.seq = idx + 1; });

  const byProfile = new Map<string, AIGoalSessionRow[]>();
  for (const r of rows) {
    const list = byProfile.get(r.profileId) ?? [];
    list.push(r);
    byProfile.set(r.profileId, list);
  }
  for (const list of byProfile.values()) {
    list.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    for (let j = 0; j < list.length; j++) {
      const next = list[j + 1];
      if (next) {
        list[j].nextSessionAt = next.startAt;
        list[j].nextSessionLabel = fmtClock(next.startAt);
      }
    }
  }

  return rows.map(r => ({ ...r, phase: sessionPhase(r, now) }));
}

function buildProfileTimelines(sessions: AIGoalSessionRow[], now: Date): AIGoalProfileTimeline[] {
  const map = new Map<string, AIGoalSessionRow[]>();
  for (const s of sessions) {
    const list = map.get(s.profileId) ?? [];
    list.push(s);
    map.set(s.profileId, list);
  }
  return [...map.entries()].map(([profileId, list]) => {
    const sorted = [...list].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const nextUp = sorted.find(s => sessionPhase(s, now) === 'upcoming' || sessionPhase(s, now) === 'now') ?? null;
    return {
      profileId,
      profileName: sorted[0]?.profileName ?? profileId,
      sessionCount: sorted.length,
      firstStart: sorted[0]?.startLabel ?? '—',
      lastEnd: sorted[sorted.length - 1]?.endLabel ?? '—',
      nextUp,
      sessions: sorted,
    };
  }).sort((a, b) => a.profileName.localeCompare(b.profileName));
}

function buildHourlySlots(sessions: AIGoalSessionRow[]): AIGoalHourSlot[] {
  const map = new Map<number, number>();
  for (const s of sessions) {
    const h = s.startAt.getHours();
    map.set(h, (map.get(h) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, views]) => ({
      hour,
      label: `${pad2(hour)}:00`,
      views,
      weight: HOURLY_WEIGHTS[hour] ?? 0.5,
    }));
}

function buildCampaignSegments(sessions: AIGoalSessionRow[], input: AIGoalPlannerInput): AIGoalCampaignSegment[] {
  if (!sessions.length) return [];
  const startMs = sessions[0].startAt.getTime();
  const endMs = sessions[sessions.length - 1].endAt.getTime();
  const span = endMs - startMs;
  const phases = span <= 2 * 3600000 ? 1 : span <= 6 * 3600000 ? 2 : 3;
  const chunk = span / phases;
  const hints = [
    'Search + Google — organic discovery',
    'Homepage + Channel browse mix',
    'Notification + peak hour push',
  ];

  const segments: AIGoalCampaignSegment[] = [];
  for (let p = 0; p < phases; p++) {
    const pStart = startMs + chunk * p;
    const pEnd = p === phases - 1 ? endMs : startMs + chunk * (p + 1);
    const inPhase = sessions.filter(s =>
      s.startAt.getTime() >= pStart - 1000 && s.startAt.getTime() < pEnd + 1000,
    );
    if (!inPhase.length) continue;
    const profSet = new Set(inPhase.map(s => s.profileId));
    segments.push({
      id: `camp-${p + 1}`,
      phase: p + 1,
      startAt: new Date(pStart),
      endAt: new Date(pEnd),
      timeLabel: `${fmtClock(new Date(pStart))} → ${fmtClock(new Date(pEnd))}`,
      viewGoal: inPhase.length,
      profilesUsed: profSet.size,
      tabsPerProfile: input.tabsPerProfile,
      trafficHint: hints[p] ?? hints[1],
      rationale: `${inPhase.length} sessions · ${profSet.size} profiles · ${hints[p] ?? hints[1]}`,
    });
  }
  return segments;
}

export function scaleTrafficQuotas(totalViews: number): DemoTrafficQuotas {
  const base = DEFAULT_TRAFFIC_QUOTAS;
  const baseTotal = TRAFFIC_SOURCE_KEYS.reduce((s, k) => s + (base[k]?.viewCount ?? 0), 0) || 1000;
  const q = { ...base } as DemoTrafficQuotas;
  for (const k of TRAFFIC_SOURCE_KEYS) {
    q[k] = { ...base[k], viewCount: Math.round(((base[k]?.viewCount ?? 0) / baseTotal) * totalViews) };
  }
  const assigned = TRAFFIC_SOURCE_KEYS.reduce((s, k) => s + q[k].viewCount, 0);
  if (assigned < totalViews) q.search = { ...q.search, viewCount: q.search.viewCount + (totalViews - assigned) };
  return q;
}

function buildNarrative(
  input: AIGoalPlannerInput,
  capacity: AIGoalCapacityBreakdown,
  sessions: AIGoalSessionRow[],
  segments: AIGoalCampaignSegment[],
): { hi: string; warnings: string[]; tips: string[] } {
  const warnings: string[] = [];
  const tips: string[] = [];

  if (!capacity.feasible) {
    warnings.push(`Goal ${input.viewGoal} possible nahi — max ~${capacity.maxViewsPossible} (${capacity.gap} zyada)`);
    tips.push('Profiles/tabs badhao, window lamba karo, ya goal ghatao');
  }
  if (capacity.maxByUserRule > capacity.maxByVideoDuration) {
    warnings.push(`Video lambi hai — duration cap ~${capacity.maxByVideoDuration} views`);
  }
  if (sessions.length < input.viewGoal) {
    warnings.push(`Sirf ${sessions.length}/${input.viewGoal} sessions window me fit hui — time badhao ya goal ghatao`);
  }

  const vids = resolvedVideos(input);
  if (input.tabsPerProfile > 1 && vids.length < input.tabsPerProfile) {
    warnings.push(`${input.tabsPerProfile} tabs hain lekin sirf ${vids.length} video — zyada videos add karo`);
  }
  if (input.videoRotationMode === 'different') {
    tips.push('Har profile ka video order alag — A: 1→2→3, B: 3→2→1 jaisa rotate');
  } else {
    tips.push('Sab profiles me same video tab order');
  }
  tips.push('Peak hours (5–9 PM) pe zyada sessions — organic pattern');
  tips.push('Har profile ke beech minimum gap — robotic feel kam');

  const videoBit = vids.length === 1
    ? `"${vids[0].title}"`
    : `${vids.length} videos · ${new Set(vids.map(v => v.channelName)).size} channels`;

  const hi = [
    `🕐 **Abhi:** ${fmtClock(new Date())} · Plan **${capacity.windowStartLabel} → ${capacity.windowEndLabel}**`,
    `🎬 **Videos:** ${videoBit} · rotation: **${input.videoRotationMode === 'same' ? 'sab same' : 'har profile alag'}**`,
    `🎯 **Goal:** ${input.viewGoal} views · **Scheduled:** ${sessions.length} sessions`,
    `👥 **${input.profiles.length} profiles** × **${input.tabsPerProfile} tab** = **${capacity.viewsPerProfilePerHour}/profile/ghanta**`,
    `⚡ Fleet max **~${capacity.fleetViewsPerHour}/ghanta** · window cap **~${capacity.maxViewsPossible}**`,
    capacity.feasible ? '✅ Goal realistic' : '⚠️ Goal adjust karo',
    '',
    `📋 **${segments.length} campaign block:**`,
    ...segments.map(s => `  Block ${s.phase}: ${s.timeLabel} — ${s.viewGoal} views (${s.profilesUsed} profiles)`),
    '',
    '👇 Neeche har profile ki exact list — start, end, video, agla session.',
  ].join('\n');

  return { hi, warnings, tips };
}

export function buildAIGoalPlan(input: AIGoalPlannerInput, now = new Date()): AIGoalPlannerResult {
  const capacity = computeCapacity(input);
  const effectiveGoal = capacity.feasible ? input.viewGoal : capacity.maxViewsPossible;
  const vids = resolvedVideos(input);
  const profileVideoOrders = buildProfileVideoOrderLabels(
    input.profiles.length ? input.profiles : [{ id: 'demo-1', name: 'Demo' }],
    vids,
    input.videoRotationMode,
  );
  const sessions = buildSessions(input, capacity, effectiveGoal, now);
  const profileTimelines = buildProfileTimelines(sessions, now);
  const hourlySlots = buildHourlySlots(sessions);
  const campaignSegments = buildCampaignSegments(sessions, input);
  const { hi, warnings, tips } = buildNarrative(input, capacity, sessions, campaignSegments);
  const planWindow = toPlanWindow(input);

  const hourlyViewTargets: DemoHourlyViewTarget[] = hourlySlots.map(s => ({
    hour: s.hour,
    views: s.views,
  }));

  const profiles = Math.max(1, input.profiles.length);
  const viewCount = sessions.length || effectiveGoal;
  const autoGoals: DemoCampaignGoals = {
    ...DEFAULT_CAMPAIGN_GOALS,
    views: viewCount,
    watchProfiles: profiles,
    volumeProfiles: profiles,
    scrollProfiles: Math.max(1, Math.floor(profiles * 0.85)),
    captionsProfiles: Math.max(1, Math.floor(profiles * 0.4)),
    likes: Math.round(viewCount * 0.35),
    subscribes: Math.round(viewCount * 0.12),
    bells: Math.round(viewCount * 0.1),
    comments: Math.round(viewCount * 0.06),
    commentLikes: Math.round(viewCount * 0.04),
    dislikes: Math.max(1, Math.round(viewCount * 0.02)),
  };
  const suggestedGoals: DemoCampaignGoals = {
    ...autoGoals,
    ...input.engagementGoals,
    views: input.engagementGoals?.views ?? viewCount,
  };

  const defs = resolvedDefaults(input);
  const trafficQuotas = input.trafficQuotas ?? scaleTrafficQuotas(viewCount);

  return {
    input,
    plannedAt: now,
    capacity,
    profileVideoOrders,
    sessions,
    profileTimelines,
    hourlySlots,
    campaignSegments,
    narrativeHi: hi,
    warnings,
    tips,
    planWindow,
    hourlyViewTargets,
    suggestedGoals,
    suggestedDefaults: {
      ...input.defaultsPatch,
      watchTimeMin: defs.watchTimeMin,
      watchTimeMax: defs.watchTimeMax,
      volumeMin: defs.volumeMin,
      volumeMax: defs.volumeMax,
      scrollEnabled: defs.scrollEnabled,
      scrollNoClick: defs.scrollNoClick,
      captionsEnabled: defs.captionsEnabled,
      tabsPerProfile: input.tabsPerProfile,
      planWindow,
      hourlyViewTargets,
      hourlyTrafficCurve: true,
      parallelTabOnOverlap: input.tabsPerProfile > 1,
      staggerBatchSize: Math.min(5, Math.max(2, Math.floor(profiles / 10))),
    },
    suggestedTrafficQuotas: trafficQuotas,
  };
}

export function applyAIGoalPlanToMastermind(
  plan: AIGoalPlannerResult,
  current: {
    goals: DemoCampaignGoals;
    defaults: DemoCampaignDefaults;
    videos: DemoCampaignVideo[];
  },
): {
  goals: DemoCampaignGoals;
  defaults: DemoCampaignDefaults;
  videos: DemoCampaignVideo[];
  campaignName: string;
  profileOverrides: Record<string, DemoProfileSettings>;
} {
  const { input, suggestedGoals, suggestedDefaults, suggestedTrafficQuotas } = plan;
  const totalViews = plan.sessions.length || suggestedGoals.views;
  const src = resolvedVideos(input);

  const trafficTotal = trafficQuotasTotal(suggestedTrafficQuotas);

  let videos: DemoCampaignVideo[] = current.videos;
  if (input.videos.length) {
    const base = src.map(v => ({
      id: v.id,
      url: v.url,
      title: v.title,
      channelName: v.channelName,
      channelId: v.channelId,
      durationSec: v.durationSec,
      viewGoal: 1,
    }));
    const synced = syncVideoGoalsFromTraffic(
      base.map(v => ({ id: v.id, viewGoal: v.viewGoal })),
      trafficTotal || totalViews,
      'equal',
    );
    videos = base.map(v => ({
      ...v,
      viewGoal: synced.find(s => s.id === v.id)?.viewGoal ?? 1,
    }));
  } else if (!videos.length) {
    videos = [{
      id: src[0].id,
      url: src[0].url,
      title: src[0].title,
      channelName: src[0].channelName,
      channelId: src[0].channelId,
      viewGoal: totalViews,
      durationSec: src[0].durationSec,
    }];
  }

  const defaults: DemoCampaignDefaults = {
    ...current.defaults,
    ...suggestedDefaults,
    trafficQuotas: suggestedTrafficQuotas,
    planWindow: plan.planWindow,
    hourlyViewTargets: plan.hourlyViewTargets,
    tabsPerProfile: input.tabsPerProfile,
  };

  const sessionSettings = resolvedSessionActions(input);
  const profilePool = input.profiles.length
    ? input.profiles
    : [{ id: 'demo-1', name: 'Demo' }];
  const profileOverrides: Record<string, DemoProfileSettings> = {};
  for (const p of profilePool) {
    profileOverrides[p.id] = { ...sessionSettings };
  }

  return {
    goals: { ...current.goals, ...suggestedGoals },
    defaults,
    videos,
    campaignName: `AI · ${plan.capacity.windowStartLabel}–${plan.capacity.windowEndLabel} · ${plan.sessions.length} sessions`,
    profileOverrides,
  };
}
