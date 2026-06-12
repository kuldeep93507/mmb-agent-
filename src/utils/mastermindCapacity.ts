/** Max views capacity estimate for Mastermind demo planner. */

import type { DemoCampaignDefaults } from './mastermindDemoTypes';
import { estimateSessionSeconds } from './mastermindSessionTime';
import { planWindowMinutes } from './mastermindPlanWindow';

export interface CapacityResult {
  maxViews: number;
  avgSessionSec: number;
  avgCooldownSec: number;
  sessionsPerProfile: number;
  windowMinutes: number;
  detail: string;
  impossible: boolean;
  goalViews: number;
}

export function computeMaxDailyCapacity(opts: {
  profileCount: number;
  avgVideoDurationSec: number;
  goalViews: number;
  defaults: DemoCampaignDefaults;
}): CapacityResult {
  const { profileCount, avgVideoDurationSec, goalViews, defaults } = opts;
  const profiles = Math.max(1, profileCount || 48);
  const dur = Math.max(60, avgVideoDurationSec || 600);
  const tabs = defaults.tabsPerProfile;

  const avgSessionSec = estimateSessionSeconds({
    durationSec: dur,
    watchTimeMin: defaults.watchTimeMin,
    watchTimeMax: defaults.watchTimeMax,
    adSkipEnabled: true,
    startDelayMin: 10,
    startDelayMax: 25,
    trafficSource: 'search',
    trafficEntrySec: defaults.trafficEntrySec,
    preRollAdSec: defaults.preRollAdSec,
    midRollAdSec: defaults.midRollAdSec,
  });

  const avgReopenSec = ((defaults.profileReopenMin + defaults.profileReopenMax) / 2) * 60;
  const avgKeepOpenSec = Math.min(90, defaults.keepProfileOpenIfGapUnderMin * 20);
  const avgCooldownSec = avgKeepOpenSec * 0.7 + avgReopenSec * 0.3;
  const cycleSec = avgSessionSec + avgCooldownSec;
  const windowMinutes = planWindowMinutes(defaults.planWindow);
  const windowSec = windowMinutes * 60;

  const sessionsPerProfile = Math.max(1, Math.floor(windowSec / cycleSec));
  const maxViews = profiles * sessionsPerProfile * tabs;

  const windowLabel = defaults.planWindow.mode === '24h'
    ? '24h'
    : defaults.planWindow.mode === '1h'
      ? `1h @ ${defaults.planWindow.oneHourStart}:00`
      : `${defaults.planWindow.customStartHour}:${String(defaults.planWindow.customStartMinute).padStart(2, '0')}–${defaults.planWindow.customEndHour}:${String(defaults.planWindow.customEndMinute).padStart(2, '0')}`;

  const detail = `${profiles} profiles · ~${Math.round(avgSessionSec / 60)}m session + ~${Math.round(avgCooldownSec / 60)}m cooldown · ${tabs} tab(s) · ${windowLabel}`;

  return {
    maxViews,
    avgSessionSec,
    avgCooldownSec,
    sessionsPerProfile,
    windowMinutes,
    detail,
    impossible: goalViews > maxViews,
    goalViews,
  };
}

export function videoGoalsTotal(videos: { viewGoal: number }[]): number {
  return videos.reduce((s, v) => s + (v.viewGoal || 0), 0);
}
