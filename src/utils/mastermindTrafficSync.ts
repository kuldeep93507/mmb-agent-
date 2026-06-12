/** Traffic quotas ↔ per-video view goals sync. */

import type { DemoTrafficQuotas } from './mastermindDemoTypes';
import { TRAFFIC_SOURCE_KEYS } from './mastermindDemoTypes';

export function videoGoalsTotal(videos: { viewGoal: number }[]): number {
  return videos.reduce((s, v) => s + Math.max(0, v.viewGoal || 0), 0);
}

export function trafficVideoMismatch(
  videos: { viewGoal: number }[],
  trafficTotal: number,
): { videoTotal: number; trafficTotal: number; mismatch: boolean } {
  const videoTotal = videoGoalsTotal(videos);
  return {
    videoTotal,
    trafficTotal,
    mismatch: videoTotal !== trafficTotal && videos.length > 0,
  };
}

/** Traffic quotas ko video goals total ke barabar scale karo (ratio preserve) */
export function syncTrafficToVideoGoals(
  quotas: DemoTrafficQuotas,
  videoTotal: number,
): DemoTrafficQuotas {
  const current = TRAFFIC_SOURCE_KEYS.reduce((s, k) => s + (quotas[k]?.viewCount ?? 0), 0);
  if (videoTotal <= 0) return quotas;
  if (current <= 0) {
    const per = Math.floor(videoTotal / TRAFFIC_SOURCE_KEYS.length);
    const out = { ...quotas };
    TRAFFIC_SOURCE_KEYS.forEach((k, i) => {
      out[k] = { ...out[k], viewCount: i === TRAFFIC_SOURCE_KEYS.length - 1 ? videoTotal - per * (TRAFFIC_SOURCE_KEYS.length - 1) : per };
    });
    return out;
  }
  const out = { ...quotas };
  let assigned = 0;
  TRAFFIC_SOURCE_KEYS.forEach((k, i) => {
    const ratio = (quotas[k]?.viewCount ?? 0) / current;
    const count = i === TRAFFIC_SOURCE_KEYS.length - 1
      ? videoTotal - assigned
      : Math.round(ratio * videoTotal);
    out[k] = { ...out[k], viewCount: Math.max(0, count) };
    assigned += out[k].viewCount;
  });
  return out;
}

export type VideoGoalSplitMode = 'equal' | 'keep_ratio';

/** Traffic total ko videos par baanto */
export function syncVideoGoalsFromTraffic(
  videos: { id: string; viewGoal: number }[],
  trafficTotal: number,
  mode: VideoGoalSplitMode = 'equal',
): { id: string; viewGoal: number }[] {
  if (!videos.length || trafficTotal <= 0) return videos;
  const current = videoGoalsTotal(videos);
  if (mode === 'equal') {
    const per = Math.floor(trafficTotal / videos.length);
    return videos.map((v, i) => ({
      ...v,
      viewGoal: i === videos.length - 1 ? trafficTotal - per * (videos.length - 1) : per,
    }));
  }
  if (current <= 0) {
    return syncVideoGoalsFromTraffic(videos, trafficTotal, 'equal');
  }
  let assigned = 0;
  return videos.map((v, i) => {
    const ratio = (v.viewGoal || 0) / current;
    const goal = i === videos.length - 1
      ? trafficTotal - assigned
      : Math.round(ratio * trafficTotal);
    assigned += goal;
    return { ...v, viewGoal: Math.max(1, goal) };
  });
}
