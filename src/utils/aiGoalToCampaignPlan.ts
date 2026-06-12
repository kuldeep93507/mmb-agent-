/**
 * AI Goal Planner sessions → executable Mastermind plan (Real Run ready).
 * Same timetable, traffic, actions — backend worker_manager ko seedha chalata hai.
 */

import type { AIGoalPlannerResult } from './aiGoalPlanner';
import { fmtClock } from './aiGoalPlanner';
import { buildSessionEntropy } from './mastermindEntropy';
import {
  buildProfileDaySummary,
  mergeProfileSettings,
  slotRuntimeStatus,
  type DemoCampaignPlan,
  type DemoPlanSlot,
  type DemoActionProjection,
  type DemoTrafficProjection,
  type DemoVideoSummary,
} from './mastermindDemoPlan';
import type {
  DemoCampaignDefaults,
  DemoCampaignGoals,
  DemoCampaignVideo,
  DemoProfileSettings,
  TrafficSourceKey,
} from './mastermindDemoTypes';
import { TRAFFIC_SOURCE_KEYS, trafficSourceLabel } from './mastermindDemoTypes';
import { formatWindowLabel } from './mastermindPlanWindow';
import { formatDuration, todayDayKey } from './mastermindSessionTime';
import { assessProfileReadiness } from './profileConfigReader';
import { computeMaxDailyCapacity } from './mastermindCapacity';

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function plannedActions(s: DemoProfileSettings): string[] {
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

function profileActionFromGap(
  gapSec: number,
  defaults: DemoCampaignDefaults,
): { action?: DemoPlanSlot['profileAction']; label?: string } {
  if (gapSec <= 0) return {};
  const gapMin = gapSec / 60;
  const keepUnder = defaults.keepProfileOpenIfGapUnderMin;
  const closeOver = defaults.closeProfileIfGapOverMin;
  if (gapMin <= keepUnder) {
    return { action: 'keep_open', label: `Profile open — ${Math.round(gapMin)}m gap` };
  }
  if (gapMin > closeOver) {
    return { action: 'close_reopen', label: `Profile band → dubara khulega (${Math.round(gapMin)}m gap)` };
  }
  return { action: 'keep_open', label: 'Profile open — medium gap' };
}

function resolveVideo(
  sessionVideoId: string,
  sessionTitle: string,
  channelName: string,
  videos: DemoCampaignVideo[],
): DemoCampaignVideo {
  const found = videos.find(v => v.id === sessionVideoId);
  if (found) return found;
  return {
    id: sessionVideoId,
    url: `https://www.youtube.com/watch?v=${sessionVideoId}`,
    title: sessionTitle,
    channelName,
    viewGoal: 1,
    durationSec: 600,
  };
}

export async function convertAIGoalToCampaignPlan(
  ai: AIGoalPlannerResult,
  opts: {
    campaignGoals: DemoCampaignGoals;
    campaignDefaults: DemoCampaignDefaults;
    videos: DemoCampaignVideo[];
    profileOverrides: Record<string, DemoProfileSettings>;
  },
): Promise<DemoCampaignPlan> {
  const { campaignGoals, campaignDefaults, videos, profileOverrides } = opts;
  const now = ai.plannedAt;
  const dayKey = todayDayKey(now);
  const slots: DemoPlanSlot[] = [];

  for (let i = 0; i < ai.sessions.length; i++) {
    const row = ai.sessions[i];
    const video = resolveVideo(row.videoId, row.videoTitle, row.channelName, videos);
    const hasOv = !!profileOverrides[row.profileId];
    const settings = mergeProfileSettings(row.profileId, profileOverrides, campaignDefaults);
    const traffic = row.trafficSource as TrafficSourceKey;
    const entropy = await buildSessionEntropy({
      profileId: row.profileId,
      tabIndex: row.tabIndex,
      sessionIndex: row.seq,
      dayKey,
      trafficSource: traffic,
    });
    const { action, label } = profileActionFromGap(row.gapBeforeSec, campaignDefaults);
    const timeLabel = fmtClock(row.startAt);
    const endTimeLabel = fmtClock(row.endAt);
    const trafficLabel = trafficSourceLabel(traffic);

    const slot: DemoPlanSlot = {
      id: row.id,
      profileId: row.profileId,
      profileName: row.profileName,
      scheduledAt: row.startAt,
      scheduledEndAt: row.endAt,
      timeLabel,
      endTimeLabel,
      hourBucket: row.startAt.getHours(),
      videoId: video.id,
      videoTitle: video.title,
      videoUrl: video.url,
      channelName: video.channelName,
      durationSec: video.durationSec,
      durationLabel: formatDuration(video.durationSec),
      sessionSec: row.sessionSec,
      sessionLabel: row.sessionLabel,
      tabIndex: row.tabIndex,
      bundleId: `ai-bundle-${row.profileId.slice(0, 8)}-${Math.floor((row.seq - 1) / row.tabsInBundle)}`,
      tabsInBundle: row.tabsInBundle,
      trafficSource: traffic,
      trafficLabel,
      planRowLabel: `${row.profileName} · ${trafficLabel} · ${timeLabel}`,
      status: 'pending',
      runtimeStatus: 'waiting',
      sessionSeed: entropy.sessionSeed,
      scrollCurveId: entropy.scrollCurveId,
      humanActivityId: entropy.humanActivityId,
      tabSeed: entropy.tabSeed,
      scrollNoClick: campaignDefaults.scrollNoClick,
      settings,
      readiness: assessProfileReadiness({
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
        hasSavedConfig: hasOv,
      }),
      actionsPlanned: row.actionsPlanned.length ? row.actionsPlanned : plannedActions(settings),
      dayKey,
      profileCooldownSec: row.gapBeforeSec > 0 ? row.gapBeforeSec : undefined,
      cooldownLabel: row.gapBeforeSec > 0 ? row.gapLabel : undefined,
      profileAction: row.tabIndex === 1 ? action : undefined,
      profileActionLabel: row.tabIndex === 1 ? label : undefined,
    };
    const rs = slotRuntimeStatus(slot, now);
    slot.runtimeStatus = rs;
    slot.status = rs === 'done' ? 'done' : 'pending';
    slots.push(slot);
  }

  slots.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

  const videoSlotCounts = new Map<string, number>();
  for (const s of slots) {
    videoSlotCounts.set(s.videoId, (videoSlotCounts.get(s.videoId) ?? 0) + 1);
  }

  const campaignVideos = videos.length ? videos : ai.input.videos.map(v => ({
    id: v.id,
    url: v.url,
    title: v.title,
    channelName: v.channelName,
    channelId: v.channelId,
    viewGoal: 1,
    durationSec: v.durationSec,
  }));

  const videoSummaries: DemoVideoSummary[] = campaignVideos.map(v => ({
    videoId: v.id,
    title: v.title,
    channelName: v.channelName,
    viewGoal: v.viewGoal,
    slotsPlanned: videoSlotCounts.get(v.id) ?? 0,
    durationSec: v.durationSec,
    durationLabel: formatDuration(v.durationSec),
  }));

  const hourTotals = Array(24).fill(0) as number[];
  for (const s of slots) hourTotals[s.hourBucket] += 1;
  const hourSummary = hourTotals
    .map((count, hour) => ({ hour, count, label: `${pad2(hour)}:00` }))
    .filter(x => x.count > 0);

  const uniqueProfileIds = new Set(slots.map(s => s.profileId));
  const readyProfiles = uniqueProfileIds.size;
  const warnProfiles = new Set(
    slots.filter(s => s.readiness.warnings.length).map(s => s.profileId),
  ).size;

  const countAction = (key: string) => slots.filter(s => s.actionsPlanned.includes(key)).length;

  const goals: DemoCampaignGoals = {
    ...campaignGoals,
    views: slots.length || campaignGoals.views,
  };

  const actionProjection: DemoActionProjection[] = [
    { key: 'views', label: 'Views', emoji: '👁', goal: goals.views, projected: slots.length, ok: slots.length >= goals.views },
    { key: 'likes', label: 'Likes', emoji: '👍', goal: goals.likes, projected: countAction('like'), ok: countAction('like') >= goals.likes },
    { key: 'dislikes', label: 'Dislikes', emoji: '👎', goal: goals.dislikes, projected: countAction('dislike'), ok: countAction('dislike') >= goals.dislikes },
    { key: 'subscribes', label: 'Subscribers', emoji: '📺', goal: goals.subscribes, projected: countAction('subscribe'), ok: countAction('subscribe') >= goals.subscribes },
    { key: 'bells', label: 'Bell', emoji: '🔔', goal: goals.bells, projected: countAction('bell'), ok: countAction('bell') >= goals.bells },
    { key: 'comments', label: 'Comments', emoji: '💬', goal: goals.comments, projected: countAction('comment'), ok: countAction('comment') >= goals.comments },
    { key: 'commentLikes', label: 'Comment likes', emoji: '💬👍', goal: goals.commentLikes, projected: Math.floor(countAction('comment') * 0.6), ok: Math.floor(countAction('comment') * 0.6) >= goals.commentLikes },
    { key: 'watchProfiles', label: 'Watch profiles', emoji: '⏱', goal: goals.watchProfiles, projected: uniqueProfileIds.size, ok: uniqueProfileIds.size >= goals.watchProfiles, detail: `${campaignDefaults.watchTimeMin}–${campaignDefaults.watchTimeMax}%` },
    { key: 'volumeProfiles', label: 'Volume profiles', emoji: '🔊', goal: goals.volumeProfiles, projected: uniqueProfileIds.size, ok: uniqueProfileIds.size >= goals.volumeProfiles },
    { key: 'scrollProfiles', label: 'Scroll profiles', emoji: '📜', goal: goals.scrollProfiles, projected: new Set(slots.filter(s => s.settings.scrollEnabled).map(s => s.profileId)).size, ok: true },
    { key: 'captionsProfiles', label: 'Captions profiles', emoji: '🇨', goal: goals.captionsProfiles, projected: new Set(slots.filter(s => s.settings.captionsEnabled).map(s => s.profileId)).size, ok: true },
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
    profileCount: uniqueProfileIds.size || 1,
    avgVideoDurationSec: avgDur,
    goalViews: slots.length,
    defaults: campaignDefaults,
  });

  return {
    campaignGoals: goals,
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
