/**
 * Mastermind DEMO plan — traffic quotas · SHA-256 entropy · tab gaps · stagger
 */

import { readProfileConfig, assessProfileReadiness } from './profileConfigReader';
import { buildSessionEntropy } from './mastermindEntropy';
import {
  estimateSessionSeconds,
  formatDuration,
  todayDayKey,
} from './mastermindSessionTime';
import type {
  DemoCampaignDefaults,
  DemoCampaignGoals,
  DemoCampaignVideo,
  DemoProfileSettings,
  TrafficProfileMode,
  TrafficSourceKey,
} from './mastermindDemoTypes';
import {
  DEFAULT_CAMPAIGN_DEFAULTS,
  TRAFFIC_SOURCE_KEYS,
  defaultProfileSettings,
  trafficSourceLabel,
} from './mastermindDemoTypes';
import { formatWindowLabel, planWindowBounds } from './mastermindPlanWindow';
import { isProfileVideoWatched } from './mastermindWatchHistory';
import { computeMaxDailyCapacity } from './mastermindCapacity';

export const HOURLY_WEIGHTS: Record<number, number> = {
  0: 0.15, 1: 0.10, 2: 0.07, 3: 0.05, 4: 0.07, 5: 0.12,
  6: 0.20, 7: 0.35, 8: 0.45, 9: 0.55, 10: 0.60, 11: 0.65,
  12: 0.70, 13: 0.68, 14: 0.65, 15: 0.70, 16: 0.78, 17: 0.85,
  18: 0.92, 19: 1.00, 20: 0.98, 21: 0.90, 22: 0.75, 23: 0.45,
};

export type SlotRuntimeStatus = 'done' | 'running' | 'waiting';

export interface DemoPlanSlot {
  id: string;
  profileId: string;
  profileName: string;
  scheduledAt: Date;
  scheduledEndAt: Date;
  timeLabel: string;
  endTimeLabel: string;
  hourBucket: number;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  channelName: string;
  durationSec: number;
  durationLabel: string;
  sessionSec: number;
  sessionLabel: string;
  tabIndex: number;
  tabGapSec?: number;
  bundleId: string;
  tabsInBundle: number;
  trafficSource: string;
  trafficLabel: string;
  planRowLabel: string;
  status: 'pending' | 'done' | 'skipped';
  runtimeStatus: SlotRuntimeStatus;
  sessionSeed: string;
  scrollCurveId: string;
  humanActivityId: string;
  tabSeed: string;
  scrollNoClick: boolean;
  settings: DemoProfileSettings;
  readiness: ReturnType<typeof assessProfileReadiness>;
  actionsPlanned: string[];
  dayKey: string;
  /** Session ke baad gap (sec) — agli session se pehle */
  profileCooldownSec?: number;
  cooldownLabel?: string;
  profileAction?: 'keep_open' | 'close_reopen' | 'parallel_tab';
  profileActionLabel?: string;
  /** Set when real execution is active */
  execStatus?: 'pending' | 'spawned' | 'done' | 'skipped' | 'error';
}

export interface DemoVideoSummary {
  videoId: string;
  title: string;
  channelName: string;
  viewGoal: number;
  slotsPlanned: number;
  durationSec: number;
  durationLabel: string;
}

export interface DemoActionProjection {
  key: keyof DemoCampaignGoals | 'traffic';
  label: string;
  emoji: string;
  goal: number;
  projected: number;
  ok: boolean;
  detail?: string;
}

export interface DemoTrafficProjection {
  source: string;
  label: string;
  emoji: string;
  viewGoal: number;
  viewsPlanned: number;
  profileMode: TrafficProfileMode;
}

export interface DemoProfileDaySummary {
  profileId: string;
  profileName: string;
  totalAssigned: number;
  doneCount: number;
  runningCount: number;
  pendingCount: number;
  nextSlot: DemoPlanSlot | null;
  runningSlot: DemoPlanSlot | null;
}

export interface DemoCampaignPlan {
  campaignGoals: DemoCampaignGoals;
  campaignDefaults: DemoCampaignDefaults;
  videos: DemoVideoSummary[];
  totalSlots: number;
  readyProfiles: number;
  warnProfiles: number;
  uniqueProfiles: number;
  hourSummary: { hour: number; count: number; label: string }[];
  actionProjection: DemoActionProjection[];
  trafficProjection: DemoTrafficProjection[];
  slots: DemoPlanSlot[];
  profileSummaries: DemoProfileDaySummary[];
  generatedAt: Date;
  dayKey: string;
  capacityMaxViews: number;
  capacityImpossible: boolean;
  planWindowLabel: string;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatTime(d: Date) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mockProfiles(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `demo-prof-${i + 1}`,
    name: `Demo-Profile-${String(i + 1).padStart(2, '0')}`,
  }));
}

export function slotRuntimeStatus(slot: DemoPlanSlot, now = new Date()): SlotRuntimeStatus {
  const t = now.getTime();
  if (slot.scheduledEndAt.getTime() <= t) return 'done';
  if (slot.scheduledAt.getTime() <= t && t < slot.scheduledEndAt.getTime()) return 'running';
  return 'waiting';
}

export function applyRuntimeToSlots(slots: DemoPlanSlot[], now = new Date()): DemoPlanSlot[] {
  return slots.map(s => {
    const rs = slotRuntimeStatus(s, now);
    return { ...s, runtimeStatus: rs, status: rs === 'done' ? 'done' : 'pending' };
  });
}

export type SlotExecStatus = 'pending' | 'spawned' | 'done' | 'skipped' | 'error';

/** Real execution status from backend — overrides time-based preview. */
export function applyExecutionToSlots(
  slots: DemoPlanSlot[],
  execById: Map<string, SlotExecStatus>,
): DemoPlanSlot[] {
  return slots.map(s => {
    const ex = execById.get(s.id);
    if (!ex) return s;
    let runtimeStatus: SlotRuntimeStatus = 'waiting';
    if (ex === 'spawned') runtimeStatus = 'running';
    else if (ex === 'done') runtimeStatus = 'done';
    else if (ex === 'skipped' || ex === 'error') runtimeStatus = 'done';
    return {
      ...s,
      runtimeStatus,
      status: ex === 'done' || ex === 'skipped' ? 'done' : 'pending',
      execStatus: ex,
    };
  });
}

export type SlotPreviewPhase = 'past' | 'now' | 'upcoming';

export function slotPreviewPhase(slot: DemoPlanSlot, now = new Date()): SlotPreviewPhase {
  const t = now.getTime();
  if (slot.scheduledEndAt.getTime() <= t) return 'past';
  if (slot.scheduledAt.getTime() <= t && t < slot.scheduledEndAt.getTime()) return 'now';
  return 'upcoming';
}

export function mergeProfileSettings(
  profileId: string,
  overrides: Record<string, DemoProfileSettings>,
  defaults?: DemoCampaignDefaults,
): DemoProfileSettings {
  const base = readProfileConfig(profileId);
  const def = defaultProfileSettings();
  const o = overrides[profileId];
  const d = defaults;
  return {
    watchTimeMin: o?.watchTimeMin ?? d?.watchTimeMin ?? base.watchTimeMin ?? def.watchTimeMin,
    watchTimeMax: o?.watchTimeMax ?? d?.watchTimeMax ?? base.watchTimeMax ?? def.watchTimeMax,
    volumeMin: o?.volumeMin ?? d?.volumeMin ?? def.volumeMin,
    volumeMax: o?.volumeMax ?? d?.volumeMax ?? def.volumeMax,
    trafficPreference: o?.trafficPreference ?? base.trafficPreference ?? def.trafficPreference,
    videoQuality: o?.videoQuality ?? base.videoQuality ?? def.videoQuality,
    startDelayMin: o?.startDelayMin ?? base.startDelayMin ?? def.startDelayMin,
    startDelayMax: o?.startDelayMax ?? base.startDelayMax ?? def.startDelayMax,
    likeEnabled: o?.likeEnabled ?? base.likeEnabled ?? def.likeEnabled,
    dislikeEnabled: o?.dislikeEnabled ?? def.dislikeEnabled,
    subscribeEnabled: o?.subscribeEnabled ?? base.subscribeEnabled ?? def.subscribeEnabled,
    bellEnabled: o?.bellEnabled ?? def.bellEnabled,
    commentEnabled: o?.commentEnabled ?? base.commentEnabled ?? def.commentEnabled,
    seekEnabled: o?.seekEnabled ?? def.seekEnabled,
    adSkipEnabled: o?.adSkipEnabled ?? base.adSkipEnabled ?? def.adSkipEnabled,
    adSkipDelayMinSec: o?.adSkipDelayMinSec ?? d?.adSkipDelayMinSec ?? def.adSkipDelayMinSec,
    adSkipDelayMaxSec: o?.adSkipDelayMaxSec ?? d?.adSkipDelayMaxSec ?? def.adSkipDelayMaxSec,
    captionsEnabled: o?.captionsEnabled ?? d?.captionsEnabled ?? def.captionsEnabled,
    descriptionExpand: o?.descriptionExpand ?? def.descriptionExpand,
    scrollEnabled: o?.scrollEnabled ?? d?.scrollEnabled ?? def.scrollEnabled,
    adClickEnabled: o?.adClickEnabled ?? d?.adClickEnabled ?? def.adClickEnabled,
    adClickDelayMinSec: o?.adClickDelayMinSec ?? d?.adClickDelayMinSec ?? def.adClickDelayMinSec,
    adClickDelayMaxSec: o?.adClickDelayMaxSec ?? d?.adClickDelayMaxSec ?? def.adClickDelayMaxSec,
    adClickVisitSec: o?.adClickVisitSec ?? d?.adClickVisitSec ?? def.adClickVisitSec,
    commentLikeEnabled: o?.commentLikeEnabled ?? d?.commentLikeEnabled ?? def.commentLikeEnabled,
    descriptionLinks: o?.descriptionLinks ?? d?.descriptionLinks ?? def.descriptionLinks,
    descriptionLinkUrl: o?.descriptionLinkUrl ?? d?.descriptionLinkUrl ?? def.descriptionLinkUrl,
    descriptionLinkVisitSec: o?.descriptionLinkVisitSec ?? d?.descriptionLinkVisitSec ?? def.descriptionLinkVisitSec,
    qualityChangeEnabled: o?.qualityChangeEnabled ?? d?.qualityChangeEnabled ?? def.qualityChangeEnabled,
    playbackSpeed: o?.playbackSpeed ?? d?.playbackSpeed ?? def.playbackSpeed,
  };
}

function settingsToReadiness(settings: DemoProfileSettings, hasOverride: boolean) {
  return assessProfileReadiness({
    watchTimeMin: settings.watchTimeMin,
    watchTimeMax: settings.watchTimeMax,
    trafficPreference: settings.trafficPreference,
    likeEnabled: settings.likeEnabled,
    subscribeEnabled: settings.subscribeEnabled,
    commentEnabled: settings.commentEnabled,
    adSkipEnabled: settings.adSkipEnabled,
    videoQuality: settings.videoQuality,
    startDelayMin: settings.startDelayMin,
    startDelayMax: settings.startDelayMax,
    hasSavedConfig: hasOverride,
  });
}

function plannedActions(s: DemoProfileSettings): string[] {
  const out: string[] = [];
  if (s.likeEnabled) out.push('like');
  if (s.dislikeEnabled) out.push('dislike');
  if (s.subscribeEnabled) out.push('subscribe');
  if (s.bellEnabled) out.push('bell');
  if (s.commentEnabled) out.push('comment');
  if (s.commentLikeEnabled) out.push('comment_like');
  if (s.descriptionLinks) out.push('desc_link');
  if (s.seekEnabled) out.push('seek');
  if (s.adSkipEnabled) out.push('adskip');
  if (s.captionsEnabled) out.push('captions');
  if (s.descriptionExpand) out.push('desc');
  if (s.scrollEnabled) out.push('scroll');
  return out;
}

function distributeHourly(viewGoal: number): number[] {
  const weightSum = Object.values(HOURLY_WEIGHTS).reduce((a, b) => a + b, 0);
  const perHour = Array.from({ length: 24 }, (_, h) =>
    Math.max(0, Math.floor((HOURLY_WEIGHTS[h] / weightSum) * viewGoal)),
  );
  let assigned = perHour.reduce((a, b) => a + b, 0);
  let h = 19;
  while (assigned < viewGoal) {
    perHour[h] += 1;
    assigned += 1;
    h = (h + 1) % 24;
  }
  return perHour;
}

function randomGapSec(min: number, max: number, rng: () => number) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.round(rng() * (hi - lo));
}

function slotLabels(profileName: string, trafficSource: string, timeLabel: string) {
  const trafficLabel = trafficSourceLabel(trafficSource);
  return { trafficLabel, planRowLabel: `${profileName} · ${trafficLabel} · ${timeLabel}` };
}

function pickHourForTraffic(traffic: TrafficSourceKey, curve: boolean, rng: () => number): number {
  if (!curve) return Math.floor(rng() * 24);
  if (traffic === 'notification') return 17 + Math.floor(rng() * 6);
  if (traffic === 'search' || traffic === 'google' || traffic === 'bing') return 6 + Math.floor(rng() * 6);
  if (traffic === 'homepage') return 12 + Math.floor(rng() * 10);
  return Math.floor(rng() * 24);
}

interface RawSlot {
  profileId: string;
  profileName: string;
  targetHour: number;
  video: DemoCampaignVideo;
  settings: DemoProfileSettings;
  readiness: ReturnType<typeof assessProfileReadiness>;
  trafficSource: TrafficSourceKey;
  hasOverride: boolean;
  sessionIndex: number;
  bundleId: string;
  bundleOrder: number;
  tabsInBundle: number;
}

function assignProfile(
  mode: TrafficProfileMode,
  pool: { id: string; name: string }[],
  traffic: TrafficSourceKey,
  videoId: string,
  reusePools: Map<string, { ids: string[]; cursor: number }>,
  rotateIdx: Map<TrafficSourceKey, number>,
): { id: string; name: string } {
  const key = `${videoId}::${traffic}`;
  if (mode === 'reuse') {
    let entry = reusePools.get(key);
    if (!entry) {
      const slice = Math.max(3, Math.ceil(pool.length * 0.12));
      const start = (reusePools.size * slice) % pool.length;
      entry = { ids: Array.from({ length: slice }, (_, i) => pool[(start + i) % pool.length].id), cursor: 0 };
      reusePools.set(key, entry);
    }
    const pid = entry.ids[entry.cursor % entry.ids.length];
    entry.cursor += 1;
    return pool.find(p => p.id === pid) ?? pool[0];
  }
  const idx = rotateIdx.get(traffic) ?? 0;
  rotateIdx.set(traffic, idx + 1);
  return pool[idx % pool.length];
}

function pickVideoNoRepeat(
  videos: DemoCampaignVideo[],
  profileId: string,
  dayKey: string,
  usedInPlan: Set<string>,
  noRepeat: boolean,
  startIdx: number,
): DemoCampaignVideo {
  for (let i = 0; i < videos.length; i++) {
    const v = videos[(startIdx + i) % videos.length];
    const key = `${profileId}::${v.id}`;
    if (!noRepeat) return v;
    if (usedInPlan.has(key)) continue;
    if (isProfileVideoWatched(profileId, v.id, dayKey)) continue;
    return v;
  }
  return videos[startIdx % videos.length];
}

async function resolveProfileTimelines(
  rawSlots: RawSlot[],
  dayStart: Date,
  defaults: DemoCampaignDefaults,
  rng: () => number,
  dayKey: string,
  now: Date,
): Promise<DemoPlanSlot[]> {
  const { startMs: windowStartMs, endMs: windowEndMs } = planWindowBounds(defaults.planWindow, dayStart);
  const tabsPerProfile = defaults.tabsPerProfile;
  const byProfile = new Map<string, RawSlot[]>();
  for (const r of rawSlots) {
    const list = byProfile.get(r.profileId) ?? [];
    list.push(r);
    byProfile.set(r.profileId, list);
  }

  const out: DemoPlanSlot[] = [];
  let slotIdx = 0;

  for (const [profileId, list] of byProfile) {
    const bundleMap = new Map<string, RawSlot[]>();
    for (const r of list) {
      const arr = bundleMap.get(r.bundleId) ?? [];
      arr.push(r);
      bundleMap.set(r.bundleId, arr);
    }
    const bundles = [...bundleMap.entries()]
      .map(([id, slots]) => ({
        id,
        slots: slots.sort((a, b) => a.bundleOrder - b.bundleOrder),
        hour: Math.max(...slots.map(s => s.targetHour)),
      }))
      .sort((a, b) => a.hour - b.hour || a.id.localeCompare(b.id));

    let cursorMs = Math.max(windowStartMs, dayStart.getTime() + 6 * 3600000);
    let prevBundleEndMs = 0;

    for (const bundle of bundles) {
      const batch = bundle.slots;
      const hourTarget = bundle.hour;
      const hourStartMs = dayStart.getTime() + hourTarget * 3600000;
      const jitter = Math.floor(rng() * 45) * 60000;
      let bundleStartMs = Math.max(cursorMs, hourStartMs + jitter);
      if (bundleStartMs >= windowEndMs) continue;

      let cooldownSec = 0;
      let profileAction: DemoPlanSlot['profileAction'];
      let profileActionLabel: string | undefined;
      let gapLabel: string | undefined;

      if (prevBundleEndMs > 0) {
        const idealStartMs = Math.max(bundleStartMs, hourStartMs + jitter);
        const gapMin = (idealStartMs - prevBundleEndMs) / 60000;
        const keepUnder = defaults.keepProfileOpenIfGapUnderMin;
        const closeOver = defaults.closeProfileIfGapOverMin;

        if (idealStartMs < prevBundleEndMs && defaults.parallelTabOnOverlap) {
          profileAction = 'parallel_tab';
          bundleStartMs = prevBundleEndMs;
          cooldownSec = 0;
          gapLabel = 'Nayi tab — pehli session/ads abhi chal rahi (parallel)';
          profileActionLabel = gapLabel;
        } else if (gapMin <= keepUnder) {
          profileAction = 'keep_open';
          cooldownSec = randomGapSec(15, 45, rng);
          bundleStartMs = prevBundleEndMs + cooldownSec * 1000;
          gapLabel = `Profile open — gap ${Math.round(gapMin)}m (band nahi)`;
          profileActionLabel = gapLabel;
        } else if (gapMin > closeOver) {
          profileAction = 'close_reopen';
          cooldownSec = randomGapSec(
            defaults.profileReopenMin * 60,
            defaults.profileReopenMax * 60,
            rng,
          );
          bundleStartMs = prevBundleEndMs + cooldownSec * 1000;
          gapLabel = `Profile band → ${Math.round(cooldownSec / 60)}m baad dubara khulega`;
          profileActionLabel = gapLabel;
        } else {
          profileAction = 'keep_open';
          cooldownSec = randomGapSec(30, 90, rng);
          bundleStartMs = prevBundleEndMs + cooldownSec * 1000;
          gapLabel = 'Profile open — medium gap';
          profileActionLabel = gapLabel;
        }
      }
      if (bundleStartMs >= windowEndMs) continue;

      let maxEndMs = bundleStartMs;
      let tabCursorMs = bundleStartMs;
      let prevTabStart = bundleStartMs;

      for (let tabIdx = 0; tabIdx < batch.length; tabIdx++) {
        const raw = batch[tabIdx];
        let tabGapSec = 0;
        if (tabIdx === 1) {
          tabGapSec = randomGapSec(defaults.tab2GapMin, defaults.tab2GapMax, rng);
          tabCursorMs = prevTabStart + tabGapSec * 1000;
        }
        if (tabIdx === 2) {
          tabGapSec = randomGapSec(defaults.tab3GapMin, defaults.tab3GapMax, rng);
          tabCursorMs = prevTabStart + tabGapSec * 1000;
        }
        const tabStartMs = tabIdx === 0 ? bundleStartMs : tabCursorMs;
        prevTabStart = tabStartMs;
        const tabStartAt = new Date(tabStartMs);

        const sessionSec = estimateSessionSeconds({
          durationSec: raw.video.durationSec,
          watchTimeMin: raw.settings.watchTimeMin,
          watchTimeMax: raw.settings.watchTimeMax,
          adSkipEnabled: raw.settings.adSkipEnabled,
          startDelayMin: raw.settings.startDelayMin,
          startDelayMax: raw.settings.startDelayMax,
          trafficSource: raw.trafficSource,
          trafficEntrySec: defaults.trafficEntrySec,
          preRollAdSec: defaults.preRollAdSec,
          midRollAdSec: defaults.midRollAdSec,
          rng,
        }) + Math.round(defaults.adOverrunBufferSec * (rng() * 0.35));
        const endMs = tabStartMs + sessionSec * 1000;
        maxEndMs = Math.max(maxEndMs, endMs);
        const endAt = new Date(endMs);
        const timeLabel = formatTime(tabStartAt);
        const labels = slotLabels(raw.profileName, raw.trafficSource, timeLabel);
        const entropy = await buildSessionEntropy({
          profileId,
          tabIndex: tabIdx + 1,
          sessionIndex: raw.sessionIndex,
          dayKey,
          trafficSource: raw.trafficSource,
        });

        const slot: DemoPlanSlot = {
          id: `slot-${slotIdx++}-${profileId.slice(0, 6)}-${raw.video.id}-t${tabIdx + 1}`,
          profileId,
          profileName: raw.profileName,
          scheduledAt: tabStartAt,
          scheduledEndAt: endAt,
          timeLabel,
          endTimeLabel: formatTime(endAt),
          hourBucket: hourTarget,
          videoId: raw.video.id,
          videoTitle: raw.video.title,
          videoUrl: raw.video.url,
          channelName: raw.video.channelName,
          durationSec: raw.video.durationSec,
          durationLabel: formatDuration(raw.video.durationSec),
          sessionSec,
          sessionLabel: formatDuration(sessionSec),
          tabIndex: tabIdx + 1,
          tabGapSec: tabIdx > 0 ? tabGapSec : undefined,
          bundleId: raw.bundleId,
          tabsInBundle: raw.tabsInBundle,
          trafficSource: raw.trafficSource,
          trafficLabel: labels.trafficLabel,
          planRowLabel: labels.planRowLabel,
          status: 'pending',
          runtimeStatus: 'waiting',
          sessionSeed: entropy.sessionSeed,
          scrollCurveId: entropy.scrollCurveId,
          humanActivityId: entropy.humanActivityId,
          tabSeed: entropy.tabSeed,
          scrollNoClick: defaults.scrollNoClick,
          settings: raw.settings,
          readiness: raw.readiness,
          actionsPlanned: plannedActions(raw.settings),
          dayKey,
          profileCooldownSec: tabIdx === 0 && cooldownSec > 0 ? cooldownSec : undefined,
          cooldownLabel: tabIdx === 0 ? gapLabel : undefined,
          profileAction: tabIdx === 0 ? profileAction : undefined,
          profileActionLabel: tabIdx === 0 ? profileActionLabel : undefined,
        };
        const rs = slotRuntimeStatus(slot, now);
        slot.runtimeStatus = rs;
        slot.status = rs === 'done' ? 'done' : 'pending';
        out.push(slot);
      }

      prevBundleEndMs = maxEndMs;
      cursorMs = maxEndMs;
    }
  }

  return out
    .filter(s => s.scheduledAt.getTime() >= windowStartMs && s.scheduledAt.getTime() < windowEndMs)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

function applyNotificationDelay(slots: DemoPlanSlot[], delayMin: number, now: Date): DemoPlanSlot[] {
  const offset = delayMin * 60000;
  return slots.map(s => {
    if (s.trafficSource !== 'notification') return s;
    const at = new Date(s.scheduledAt.getTime() + offset);
    const end = new Date(s.scheduledEndAt.getTime() + offset);
    const timeLabel = formatTime(at);
    const labels = slotLabels(s.profileName, s.trafficSource, timeLabel);
    const next = {
      ...s,
      scheduledAt: at,
      scheduledEndAt: end,
      timeLabel,
      endTimeLabel: formatTime(end),
      trafficLabel: labels.trafficLabel,
      planRowLabel: labels.planRowLabel,
    };
    const rs = slotRuntimeStatus(next, now);
    return { ...next, runtimeStatus: rs, status: rs === 'done' ? 'done' : 'pending' };
  });
}

function applyTrafficStagger(slots: DemoPlanSlot[], defaults: DemoCampaignDefaults, rng: () => number, now: Date): DemoPlanSlot[] {
  const { staggerBatchSize, staggerDelayMinSec, staggerDelayMaxSec } = defaults;
  const bundlesByTraffic = new Map<string, Map<string, DemoPlanSlot[]>>();

  for (const s of slots) {
    const trafficMap = bundlesByTraffic.get(s.trafficSource) ?? new Map();
    const bundle = trafficMap.get(s.bundleId) ?? [];
    bundle.push(s);
    trafficMap.set(s.bundleId, bundle);
    bundlesByTraffic.set(s.trafficSource, trafficMap);
  }

  const shifted = new Map<string, DemoPlanSlot>();

  for (const [, bundleMap] of bundlesByTraffic) {
    const bundleList = [...bundleMap.entries()]
      .map(([id, tabs]) => ({
        id,
        tabs: tabs.sort((a, b) => a.tabIndex - b.tabIndex),
        start: Math.min(...tabs.map(t => t.scheduledAt.getTime())),
      }))
      .sort((a, b) => a.start - b.start);

    let batchBase = bundleList[0]?.start ?? 0;
    let bundlesInBatch = 0;

    for (const { tabs } of bundleList) {
      if (bundlesInBatch >= staggerBatchSize) {
        batchBase += randomGapSec(staggerDelayMinSec, staggerDelayMaxSec, rng) * 1000;
        bundlesInBatch = 0;
      }
      const anchor = tabs[0].scheduledAt.getTime();
      for (const s of tabs) {
        const offset = s.scheduledAt.getTime() - anchor;
        const dur = s.scheduledEndAt.getTime() - s.scheduledAt.getTime();
        const at = new Date(batchBase + offset);
        const end = new Date(at.getTime() + dur);
        const timeLabel = formatTime(at);
        const labels = slotLabels(s.profileName, s.trafficSource, timeLabel);
        const next = {
          ...s,
          scheduledAt: at,
          scheduledEndAt: end,
          timeLabel,
          endTimeLabel: formatTime(end),
          trafficLabel: labels.trafficLabel,
          planRowLabel: labels.planRowLabel,
        };
        const rs = slotRuntimeStatus(next, now);
        shifted.set(s.id, { ...next, runtimeStatus: rs, status: rs === 'done' ? 'done' : 'pending' });
      }
      const bundleEnd = Math.max(...tabs.map(t => shifted.get(t.id)!.scheduledEndAt.getTime()));
      batchBase = bundleEnd + 15000 + Math.floor(rng() * 20000);
      bundlesInBatch += 1;
    }
  }

  return slots.map(s => shifted.get(s.id) ?? s).sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

export function buildProfileDaySummary(
  profileId: string,
  profileName: string,
  slots: DemoPlanSlot[],
  now = new Date(),
): DemoProfileDaySummary {
  const dayKey = todayDayKey(now);
  const today = slots.filter(s => s.profileId === profileId && s.dayKey === dayKey);
  const done = today.filter(s => s.runtimeStatus === 'done');
  const running = today.filter(s => s.runtimeStatus === 'running');
  const waiting = today.filter(s => s.runtimeStatus === 'waiting');
  const next = waiting
    .filter(s => s.scheduledAt.getTime() > now.getTime())
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0]
    ?? waiting.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0]
    ?? null;

  return {
    profileId,
    profileName,
    totalAssigned: today.length,
    doneCount: done.length,
    runningCount: running.length,
    pendingCount: waiting.length,
    nextSlot: next,
    runningSlot: running[0] ?? null,
  };
}

/** Production alias — same engine, Real Run ready. */
export const generateCampaignPlan = generateCampaignDemoPlan;

export async function generateCampaignDemoPlan(opts: {
  campaignGoals: DemoCampaignGoals;
  campaignDefaults: DemoCampaignDefaults;
  videos: DemoCampaignVideo[];
  profiles: { id: string; name: string }[];
  profileOverrides: Record<string, DemoProfileSettings>;
  seed?: number;
}): Promise<DemoCampaignPlan> {
  const { campaignGoals, campaignDefaults, videos, profileOverrides } = opts;
  const rng = mulberry32(opts.seed ?? Date.now() % 999983);
  const pool = opts.profiles.length ? opts.profiles : mockProfiles(48);
  const now = new Date();
  const dayKey = todayDayKey(now);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  const campaignVideos = videos.length
    ? videos
    : [{
      id: 'demo-v1',
      url: 'https://youtube.com/watch?v=demo',
      title: 'Demo video',
      channelName: 'Demo Channel',
      viewGoal: campaignGoals.views || 1000,
      durationSec: 600,
    }];

  const trafficAssignments: { traffic: TrafficSourceKey; mode: TrafficProfileMode }[] = [];
  for (const key of TRAFFIC_SOURCE_KEYS) {
    const q = campaignDefaults.trafficQuotas[key];
    for (let i = 0; i < Math.max(0, q?.viewCount ?? 0); i++) {
      trafficAssignments.push({ traffic: key, mode: q.profileMode });
    }
  }

  const windowGoal = campaignDefaults.planWindow.windowViewGoal;
  const totalFromTraffic = windowGoal && windowGoal > 0
    ? Math.min(trafficAssignments.length, windowGoal)
    : trafficAssignments.length;

  const hourlyTargets = campaignDefaults.hourlyViewTargets.filter(t => t.views > 0);
  const hourQueue: number[] = [];
  if (hourlyTargets.length) {
    for (const t of hourlyTargets) {
      for (let i = 0; i < t.views; i++) hourQueue.push(t.hour);
    }
  }

  const rawSlots: RawSlot[] = [];
  const reusePools = new Map<string, { ids: string[]; cursor: number }>();
  const rotateIdx = new Map<TrafficSourceKey, number>();
  const videoSlotCounts = new Map<string, number>();
  const usedProfileVideo = new Set<string>();

  const tabsPerProfile = campaignDefaults.tabsPerProfile;
  let sessionIndex = 0;
  let bundleProfileIdx = 0;

  for (let ai = 0; ai < totalFromTraffic; ) {
    const bundleSize = Math.min(tabsPerProfile, totalFromTraffic - ai);
    const prof = pool[bundleProfileIdx % pool.length];
    bundleProfileIdx += 1;
    const bundleId = `bundle-${prof.id.slice(0, 6)}-${ai}`;
    const hour = hourQueue.length > ai
      ? hourQueue[ai]
      : pickHourForTraffic(trafficAssignments[ai].traffic, campaignDefaults.hourlyTrafficCurve, rng);

    for (let b = 0; b < bundleSize; b++) {
      const { traffic, mode } = trafficAssignments[ai + b];
      const video = pickVideoNoRepeat(
        campaignVideos,
        prof.id,
        dayKey,
        usedProfileVideo,
        campaignDefaults.noRepeatSameVideo,
        ai + b,
      );
      if (campaignDefaults.noRepeatSameVideo) {
        usedProfileVideo.add(`${prof.id}::${video.id}`);
      }
      const settings = mergeProfileSettings(prof.id, profileOverrides, campaignDefaults);
      const hasOv = !!profileOverrides[prof.id];
      rawSlots.push({
        profileId: prof.id,
        profileName: prof.name,
        targetHour: hour,
        video,
        settings,
        readiness: settingsToReadiness(settings, hasOv),
        trafficSource: traffic,
        hasOverride: hasOv,
        sessionIndex: sessionIndex++,
        bundleId,
        bundleOrder: b,
        tabsInBundle: bundleSize,
      });
      videoSlotCounts.set(video.id, (videoSlotCounts.get(video.id) ?? 0) + 1);
    }
    ai += bundleSize;
  }

  const videoSummaries: DemoVideoSummary[] = campaignVideos.map(v => ({
    videoId: v.id,
    title: v.title,
    channelName: v.channelName,
    viewGoal: v.viewGoal,
    slotsPlanned: videoSlotCounts.get(v.id) ?? 0,
    durationSec: v.durationSec,
    durationLabel: formatDuration(v.durationSec),
  }));

  let slots = await resolveProfileTimelines(rawSlots, dayStart, campaignDefaults, rng, dayKey, now);
  slots = applyNotificationDelay(slots, campaignDefaults.notificationDelayMin, now);
  slots = applyTrafficStagger(slots, campaignDefaults, rng, now);

  const hourTotals = Array(24).fill(0) as number[];
  for (const s of slots) hourTotals[s.hourBucket] += 1;
  const hourSummary = hourTotals.map((count, hour) => ({ hour, count, label: `${pad2(hour)}:00` })).filter(x => x.count > 0);

  const uniqueProfileIds = new Set(slots.map(s => s.profileId));
  const readyProfiles = new Set(slots.filter(s => s.readiness.ready).map(s => s.profileId)).size;
  const warnProfiles = new Set(slots.filter(s => !s.readiness.ready || s.readiness.warnings.length).map(s => s.profileId)).size;

  const countAction = (key: string) => slots.filter(s => s.actionsPlanned.includes(key)).length;

  const actionProjection: DemoActionProjection[] = [
    { key: 'views', label: 'Views', emoji: '👁', goal: campaignGoals.views, projected: slots.length, ok: slots.length >= campaignGoals.views },
    { key: 'likes', label: 'Likes', emoji: '👍', goal: campaignGoals.likes, projected: countAction('like'), ok: countAction('like') >= campaignGoals.likes },
    { key: 'dislikes', label: 'Dislikes', emoji: '👎', goal: campaignGoals.dislikes, projected: countAction('dislike'), ok: countAction('dislike') >= campaignGoals.dislikes },
    { key: 'subscribes', label: 'Subscribers', emoji: '📺', goal: campaignGoals.subscribes, projected: countAction('subscribe'), ok: countAction('subscribe') >= campaignGoals.subscribes },
    { key: 'bells', label: 'Bell', emoji: '🔔', goal: campaignGoals.bells, projected: countAction('bell'), ok: countAction('bell') >= campaignGoals.bells },
    { key: 'comments', label: 'Comments', emoji: '💬', goal: campaignGoals.comments, projected: countAction('comment'), ok: countAction('comment') >= campaignGoals.comments },
    { key: 'commentLikes', label: 'Comment likes', emoji: '💬👍', goal: campaignGoals.commentLikes, projected: Math.floor(countAction('comment') * 0.6), ok: Math.floor(countAction('comment') * 0.6) >= campaignGoals.commentLikes },
    { key: 'watchProfiles', label: 'Watch profiles', emoji: '⏱', goal: campaignGoals.watchProfiles, projected: uniqueProfileIds.size, ok: uniqueProfileIds.size >= campaignGoals.watchProfiles, detail: `${campaignDefaults.watchTimeMin}–${campaignDefaults.watchTimeMax}%` },
    { key: 'volumeProfiles', label: 'Volume profiles', emoji: '🔊', goal: campaignGoals.volumeProfiles, projected: uniqueProfileIds.size, ok: uniqueProfileIds.size >= campaignGoals.volumeProfiles },
    { key: 'scrollProfiles', label: 'Scroll profiles', emoji: '📜', goal: campaignGoals.scrollProfiles, projected: new Set(slots.filter(s => s.settings.scrollEnabled).map(s => s.profileId)).size, ok: true },
    { key: 'captionsProfiles', label: 'Captions profiles', emoji: '🇨', goal: campaignGoals.captionsProfiles, projected: new Set(slots.filter(s => s.settings.captionsEnabled).map(s => s.profileId)).size, ok: true },
  ];

  const emojiMap: Record<string, string> = {
    search: '🔍', google: '🌐', bing: '🔷', notification: '🔔', homepage: '🏠', channel_discovery: '📺', backlinks: '🔗',
  };

  const trafficProjection: DemoTrafficProjection[] = TRAFFIC_SOURCE_KEYS.map(source => {
    const q = campaignDefaults.trafficQuotas[source];
    const planned = slots.filter(s => s.trafficSource === source).length;
    return {
      source,
      label: trafficSourceLabel(source),
      emoji: emojiMap[source] ?? '🔗',
      viewGoal: q.viewCount,
      viewsPlanned: planned,
      profileMode: q.profileMode,
    };
  });

  const profileSummaries = [...uniqueProfileIds].map(pid => {
    const name = slots.find(s => s.profileId === pid)?.profileName ?? pid;
    return buildProfileDaySummary(pid, name, slots, now);
  }).sort((a, b) => a.profileName.localeCompare(b.profileName));

  const avgDur = campaignVideos.length
    ? Math.round(campaignVideos.reduce((s, v) => s + v.durationSec, 0) / campaignVideos.length)
    : 600;
  const capacity = computeMaxDailyCapacity({
    profileCount: pool.length,
    avgVideoDurationSec: avgDur,
    goalViews: slots.length,
    defaults: campaignDefaults,
  });

  return {
    campaignGoals: { ...campaignGoals, views: slots.length || campaignGoals.views },
    campaignDefaults,
    videos: videoSummaries,
    totalSlots: slots.length,
    readyProfiles,
    warnProfiles,
    uniqueProfiles: uniqueProfileIds.size,
    hourSummary,
    actionProjection,
    trafficProjection,
    slots,
    profileSummaries,
    generatedAt: now,
    dayKey,
    capacityMaxViews: capacity.maxViews,
    capacityImpossible: capacity.impossible,
    planWindowLabel: formatWindowLabel(campaignDefaults.planWindow),
  };
}
