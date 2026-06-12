/**
 * Plan shift + timing jitter — kal / future date pe same plan, pattern kam.
 */

import {
  buildProfileDaySummary,
  slotRuntimeStatus,
  type DemoCampaignPlan,
  type DemoPlanSlot,
} from './mastermindDemoPlan';
import { todayDayKey } from './mastermindSessionTime';
import { trafficSourceLabel } from './mastermindDemoTypes';

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function formatClock(d: Date) {
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

function dateAtMidnight(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function planAnchorDate(plan: DemoCampaignPlan): Date {
  if (plan.slots.length) {
    const s = plan.slots[0].scheduledAt;
    return dateAtMidnight(s);
  }
  const [y, m, day] = plan.dayKey.split('-').map(Number);
  return new Date(y, m - 1, day, 0, 0, 0, 0);
}

export function addCalendarDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

export function parseDayKey(key: string): Date {
  const [y, m, day] = key.split('-').map(Number);
  return new Date(y, m - 1, day, 0, 0, 0, 0);
}

export interface ShiftPlanOptions {
  /** Minutes — har slot pe random shift (pattern break) */
  jitterMinMin?: number;
  jitterMaxMin?: number;
  /** Per-day alag seed (multi-day) */
  seed?: number;
  /** Profile ke beech minimum gap sec after jitter */
  minProfileGapSec?: number;
  planNameSuffix?: string;
}

function jitterSec(minMin: number, maxMin: number, rng: () => number): number {
  const lo = Math.min(minMin, maxMin) * 60;
  const hi = Math.max(minMin, maxMin) * 60;
  if (hi <= 0) return 0;
  const mag = lo + Math.round(rng() * (hi - lo));
  return rng() > 0.5 ? mag : -mag;
}

function enforceProfileGaps(
  slots: DemoPlanSlot[],
  minGapSec: number,
): DemoPlanSlot[] {
  const byProfile = new Map<string, DemoPlanSlot[]>();
  for (const s of slots) {
    const list = byProfile.get(s.profileId) ?? [];
    list.push(s);
    byProfile.set(s.profileId, list);
  }
  const adjusted = new Map<string, DemoPlanSlot>();
  for (const list of byProfile.values()) {
    list.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
    let lastEnd = 0;
    for (const s of list) {
      let startMs = s.scheduledAt.getTime();
      if (lastEnd > 0 && startMs < lastEnd + minGapSec * 1000) {
        startMs = lastEnd + minGapSec * 1000;
      }
      const endMs = startMs + s.sessionSec * 1000;
      const startAt = new Date(startMs);
      const endAt = new Date(endMs);
      adjusted.set(s.id, {
        ...s,
        scheduledAt: startAt,
        scheduledEndAt: endAt,
        timeLabel: formatClock(startAt),
        endTimeLabel: formatClock(endAt),
        hourBucket: startAt.getHours(),
        planRowLabel: `${s.profileName} · ${s.trafficLabel} · ${formatClock(startAt)}`,
      });
      lastEnd = endMs;
    }
  }
  return slots
    .map(s => adjusted.get(s.id) ?? s)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
}

function rebuildPlan(
  base: DemoCampaignPlan,
  slots: DemoPlanSlot[],
  targetDate: Date,
  nameSuffix?: string,
): DemoCampaignPlan {
  const now = new Date();
  const dayKey = todayDayKey(targetDate);
  const uniqueProfileIds = new Set(slots.map(s => s.profileId));

  slots.forEach(s => {
    s.dayKey = dayKey;
    const rs = slotRuntimeStatus(s, now);
    s.runtimeStatus = rs;
    s.status = rs === 'done' ? 'done' : 'pending';
    s.execStatus = undefined;
  });

  const hourTotals = Array(24).fill(0) as number[];
  for (const s of slots) hourTotals[s.hourBucket] += 1;
  const hourSummary = hourTotals
    .map((count, hour) => ({ hour, count, label: `${pad2(hour)}:00` }))
    .filter(x => x.count > 0);

  const profileSummaries = [...uniqueProfileIds].map(pid => {
    const name = slots.find(s => s.profileId === pid)?.profileName ?? pid;
    return buildProfileDaySummary(pid, name, slots, now);
  }).sort((a, b) => a.profileName.localeCompare(b.profileName));

  return {
    ...base,
    slots,
    dayKey,
    totalSlots: slots.length,
    uniqueProfiles: uniqueProfileIds.size,
    hourSummary,
    profileSummaries,
    generatedAt: now,
    planWindowLabel: nameSuffix
      ? `${base.planWindowLabel} · ${nameSuffix}`
      : base.planWindowLabel,
  };
}

/** Same time-of-day → nayi calendar date + optional jitter */
export function shiftPlanToDate(
  plan: DemoCampaignPlan,
  targetDate: Date,
  opts: ShiftPlanOptions = {},
): DemoCampaignPlan {
  const jitterMin = opts.jitterMinMin ?? 0;
  const jitterMax = opts.jitterMaxMin ?? 0;
  const minGap = opts.minProfileGapSec ?? 90;
  const rng = mulberry32(opts.seed ?? Date.now() % 999983);
  const anchor = planAnchorDate(plan);
  const dayDelta = Math.round(
    (dateAtMidnight(targetDate).getTime() - anchor.getTime()) / 86400000,
  );

  let slots: DemoPlanSlot[] = plan.slots.map(s => {
    const shiftedStart = new Date(s.scheduledAt);
    shiftedStart.setDate(shiftedStart.getDate() + dayDelta);
    const shiftedEnd = new Date(s.scheduledEndAt);
    shiftedEnd.setDate(shiftedEnd.getDate() + dayDelta);

    const j = jitterSec(jitterMin, jitterMax, rng);
    shiftedStart.setSeconds(shiftedStart.getSeconds() + j);
    shiftedEnd.setSeconds(shiftedEnd.getSeconds() + j);

    return {
      ...s,
      id: `${s.id}-d${dayKeyShort(targetDate)}`,
      scheduledAt: shiftedStart,
      scheduledEndAt: shiftedEnd,
      timeLabel: formatClock(shiftedStart),
      endTimeLabel: formatClock(shiftedEnd),
      hourBucket: shiftedStart.getHours(),
      trafficLabel: trafficSourceLabel(s.trafficSource),
      planRowLabel: `${s.profileName} · ${trafficSourceLabel(s.trafficSource)} · ${formatClock(shiftedStart)}`,
    };
  });

  if (jitterMax > 0) {
    slots = enforceProfileGaps(slots, minGap);
  }

  return rebuildPlan(plan, slots, targetDate, opts.planNameSuffix);
}

function dayKeyShort(d: Date) {
  return todayDayKey(d).replace(/-/g, '');
}

/** Sirf timing thodi alag — same date */
export function jitterPlanTiming(
  plan: DemoCampaignPlan,
  jitterMinMin: number,
  jitterMaxMin: number,
  seed?: number,
): DemoCampaignPlan {
  const rng = mulberry32(seed ?? Date.now() % 999983);
  const anchor = plan.slots[0]?.scheduledAt ?? new Date();
  let slots = plan.slots.map(s => {
    const j = jitterSec(jitterMinMin, jitterMaxMin, rng);
    const start = new Date(s.scheduledAt.getTime() + j * 1000);
    const end = new Date(s.scheduledEndAt.getTime() + j * 1000);
    return {
      ...s,
      scheduledAt: start,
      scheduledEndAt: end,
      timeLabel: formatClock(start),
      endTimeLabel: formatClock(end),
      hourBucket: start.getHours(),
      planRowLabel: `${s.profileName} · ${s.trafficLabel} · ${formatClock(start)}`,
    };
  });
  slots = enforceProfileGaps(slots, 90);
  return rebuildPlan(plan, slots, dateAtMidnight(anchor), 'jitter');
}

/** Day +1, +2, +3 — har din alag jitter seed */
export function buildMultiDayPlans(
  basePlan: DemoCampaignPlan,
  firstTargetDate: Date,
  dayCount: 2 | 3,
  opts: {
    jitterMinMin: number;
    jitterMaxMin: number;
  },
): DemoCampaignPlan[] {
  const out: DemoCampaignPlan[] = [];
  for (let d = 0; d < dayCount; d++) {
    const target = addCalendarDays(firstTargetDate, d);
    const label = `Day ${d + 1} · ${todayDayKey(target)}`;
    out.push(shiftPlanToDate(basePlan, target, {
      jitterMinMin: opts.jitterMinMin,
      jitterMaxMin: opts.jitterMaxMin,
      seed: (Date.now() % 999983) + d * 7919,
      planNameSuffix: label,
    }));
  }
  return out;
}

export function planFirstSlotLabel(plan: DemoCampaignPlan): string {
  if (!plan.slots.length) return '—';
  const s = [...plan.slots].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())[0];
  return `${todayDayKey(s.scheduledAt)} ${s.timeLabel} → ${s.endTimeLabel} (${s.sessionLabel})`;
}

export function planSummaryLine(plan: DemoCampaignPlan): string {
  return `${plan.dayKey} · ${plan.totalSlots} slots · ${plan.uniqueProfiles} profiles · ${planFirstSlotLabel(plan)}`;
}
