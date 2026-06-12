/** Session duration estimates for Mastermind demo planner. */

import type { DemoCampaignDefaults, DemoTrafficEntrySec, TrafficSourceKey } from './mastermindDemoTypes';
import { DEFAULT_TRAFFIC_ENTRY_SEC } from './mastermindDemoTypes';

const ACTIONS_BUFFER_SEC = 45;

export function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

export function entryRangeForTraffic(
  trafficSource: string,
  trafficEntrySec: DemoTrafficEntrySec = DEFAULT_TRAFFIC_ENTRY_SEC,
): { min: number; max: number } {
  const key = (trafficSource === 'direct' ? 'backlinks' : trafficSource) as TrafficSourceKey;
  const r = trafficEntrySec[key] ?? DEFAULT_TRAFFIC_ENTRY_SEC.search;
  return { min: r.entryMinSec, max: r.entryMaxSec };
}

export function estimateAdSeconds(
  durationSec: number,
  adSkipEnabled: boolean,
  preRollAdSec = 20,
  midRollAdSec = 45,
): number {
  if (!adSkipEnabled) return Math.min(90, Math.floor(durationSec * 0.08));
  let ads = preRollAdSec;
  if (durationSec >= 480) ads += midRollAdSec;
  if (durationSec >= 900) ads += midRollAdSec;
  return ads;
}

export function estimateSessionSeconds(opts: {
  durationSec: number;
  watchTimeMin: number;
  watchTimeMax: number;
  adSkipEnabled: boolean;
  startDelayMin: number;
  startDelayMax: number;
  trafficSource?: string;
  trafficEntrySec?: DemoTrafficEntrySec;
  preRollAdSec?: number;
  midRollAdSec?: number;
  rng?: () => number;
}): number {
  const rng = opts.rng ?? (() => 0.5);
  const dur = Math.max(60, opts.durationSec || 300);
  const watchPct = (opts.watchTimeMin + opts.watchTimeMax) / 2 / 100;
  const entryRange = entryRangeForTraffic(opts.trafficSource ?? 'search', opts.trafficEntrySec);
  const entry = entryRange.min + rng() * Math.max(0, entryRange.max - entryRange.min);
  const gap = (opts.startDelayMin + opts.startDelayMax) / 2;
  const watch = dur * watchPct;
  const ads = estimateAdSeconds(
    dur,
    opts.adSkipEnabled,
    opts.preRollAdSec ?? 20,
    opts.midRollAdSec ?? 45,
  );
  return Math.round(entry + watch + ads + ACTIONS_BUFFER_SEC + gap);
}

/** Merge campaign defaults into estimate opts */
export function estimateFromCampaignDefaults(
  opts: Omit<Parameters<typeof estimateSessionSeconds>[0], 'trafficEntrySec' | 'preRollAdSec' | 'midRollAdSec'> & {
    defaults?: Pick<DemoCampaignDefaults, 'trafficEntrySec' | 'preRollAdSec' | 'midRollAdSec'>;
  },
): number {
  const d = opts.defaults;
  return estimateSessionSeconds({
    ...opts,
    trafficEntrySec: d?.trafficEntrySec,
    preRollAdSec: d?.preRollAdSec,
    midRollAdSec: d?.midRollAdSec,
  });
}

export function todayDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function isSlotDone(endAt: Date, now = new Date()): boolean {
  return endAt.getTime() <= now.getTime();
}
