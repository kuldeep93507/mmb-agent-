/** Export / import Mastermind plans — CSV + JSON download. */

import type { DemoCampaignPlan, DemoPlanSlot } from './mastermindDemoPlan';

export interface SerializedPlanSlot extends Omit<DemoPlanSlot, 'scheduledAt' | 'scheduledEndAt'> {
  scheduledAt: string;
  scheduledEndAt: string;
}

export interface SerializedCampaignPlan extends Omit<DemoCampaignPlan, 'generatedAt' | 'slots'> {
  generatedAt: string;
  slots: SerializedPlanSlot[];
}

export function serializePlan(plan: DemoCampaignPlan): SerializedCampaignPlan {
  return {
    ...plan,
    generatedAt: plan.generatedAt.toISOString(),
    slots: plan.slots.map(s => ({
      ...s,
      scheduledAt: s.scheduledAt.toISOString(),
      scheduledEndAt: s.scheduledEndAt.toISOString(),
    })),
  };
}

export function deserializePlan(raw: SerializedCampaignPlan): DemoCampaignPlan {
  return {
    ...raw,
    generatedAt: new Date(raw.generatedAt),
    slots: raw.slots.map(s => ({
      ...s,
      scheduledAt: new Date(s.scheduledAt),
      scheduledEndAt: new Date(s.scheduledEndAt),
    })),
  };
}

function csvEscape(val: string | number | undefined | null): string {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function slotProfileActionLabel(slot: DemoPlanSlot): string {
  if (slot.profileAction === 'keep_open') return 'open';
  if (slot.profileAction === 'close_reopen') return 'close→open';
  if (slot.profileAction === 'parallel_tab') return 'parallel tab';
  return '';
}

export function planToCsv(plan: DemoCampaignPlan): string {
  const headers = [
    'time_start', 'time_end', 'profile_id', 'profile_name', 'traffic',
    'video_id', 'video_title', 'channel', 'video_duration', 'session_est',
    'tab', 'status', 'profile_action', 'day_key',
  ];
  const rows = [...plan.slots]
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
    .map(s => [
      s.timeLabel,
      s.endTimeLabel,
      s.profileId,
      s.profileName,
      s.trafficLabel,
      s.videoId,
      s.videoTitle,
      s.channelName,
      s.durationLabel,
      s.sessionLabel,
      `T${s.tabIndex}`,
      s.runtimeStatus,
      slotProfileActionLabel(s),
      s.dayKey,
    ].map(csvEscape).join(','));

  return [headers.join(','), ...rows].join('\n');
}

export function planToJson(plan: DemoCampaignPlan): string {
  return JSON.stringify(serializePlan(plan), null, 2);
}

export function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadPlanCsv(plan: DemoCampaignPlan) {
  const name = `mastermind-plan-${plan.dayKey}-${plan.totalSlots}slots.csv`;
  downloadTextFile(name, planToCsv(plan), 'text/csv;charset=utf-8');
}

export function downloadPlanJson(plan: DemoCampaignPlan) {
  const name = `mastermind-plan-${plan.dayKey}.json`;
  downloadTextFile(name, planToJson(plan), 'application/json;charset=utf-8');
}

export function parseImportedPlanJson(text: string): DemoCampaignPlan {
  const raw = JSON.parse(text) as SerializedCampaignPlan;
  if (!raw?.slots || !Array.isArray(raw.slots)) {
    throw new Error('Invalid plan JSON — slots missing');
  }
  return deserializePlan(raw);
}
