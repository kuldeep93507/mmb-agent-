import type { Profile } from '../types';
import { profileConfigsForSchedule } from './profileConfigsForSchedule';
import { mergeShuffleSettingsIntoProfileConfigs } from './shuffleSettingsForSchedule';
import { syncSchedulesToServer, setServerScheduleTimer, cancelServerScheduleTimer } from './scheduleApi';

export interface ScheduleVideoEntry {
  mode: 'title' | 'url';
  value: string;
  title?: string;
  url?: string;
  videoId?: string;
}

export interface Schedule {
  id: string;
  name: string;
  selectedProfiles: string[];
  selectedChannels: number[];
  assignmentMode: 'same-all' | 'per-profile';
  sameForAll: { channelId: number; channelName: string; videos: ScheduleVideoEntry[] }[];
  perProfile: {
    profileId: string;
    channelSelections: { channelId: number; channelName: string; videos: ScheduleVideoEntry[] }[];
  }[];
  profileDelayMin: number;
  profileDelayMax: number;
  tabDelayMin: number;
  tabDelayMax: number;
  runMode: 'manual' | 'countdown' | 'scheduled';
  countdownMinutes: number;
  scheduledTime: number;
  repeatEnabled: boolean;
  repeatInterval: string;
  /** Aaj dubara same video chalane ki permission (default: off = same-day skip) */
  allowSameDayRepeat?: boolean;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'scheduled' | 'countdown';
  createdAt: number;
  lastRun: number | null;
  startedAt: number | null;
  progress: { total: number; done: number; failed: number };
  profileConfigs?: Record<string, unknown>[];
  lastRunError?: string;
  lastRunMessage?: string;
  createdFrom?: 'shuffle' | 'scheduler';
}

const STORAGE_KEY = 'mmb_schedules_v2';

export function genScheduleId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function clampCountdownMinutes(n: number): number {
  return Math.max(1, Math.min(10080, Math.round(Number(n)) || 1));
}

export function loadSchedules(): Schedule[] {
  try {
    const d = localStorage.getItem(STORAGE_KEY);
    return d ? JSON.parse(d) : [];
  } catch {
    return [];
  }
}

export function saveSchedulesLocal(schedules: Schedule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
  } catch { /* ignore */ }
}

export function upsertSchedule(schedule: Schedule): Schedule[] {
  const all = loadSchedules();
  const next = all.some(s => s.id === schedule.id)
    ? all.map(s => (s.id === schedule.id ? schedule : s))
    : [...all, schedule];
  saveSchedulesLocal(next);
  return next;
}

export function enrichScheduleForServer(schedule: Schedule, profiles: Profile[]): Schedule {
  // schedule.profileConfigs already has likeEnabled etc from buildSchedulePayload
  // We just need to merge watch/quality/ads settings on top
  // DO NOT call profileConfigsForSchedule again — it loses engagement action toggles

  const existingConfigs = (schedule.profileConfigs ?? []) as Record<string, unknown>[];

  if (existingConfigs.length > 0) {
    return {
      ...schedule,
      profileConfigs: mergeShuffleSettingsIntoProfileConfigs(existingConfigs),
    };
  }

  // Fallback: no existing configs (shouldn't happen, but safe)
  return {
    ...schedule,
    profileConfigs: mergeShuffleSettingsIntoProfileConfigs(
      profileConfigsForSchedule(schedule.selectedProfiles, profiles),
    ),
  };
}

export type ScheduleSaveMode = 'idle' | 'countdown' | 'scheduled';

export function finalizeScheduleStatus(
  schedule: Schedule,
  mode: ScheduleSaveMode,
): Schedule {
  const countdownMinutes = clampCountdownMinutes(schedule.countdownMinutes);
  if (mode === 'countdown' || schedule.runMode === 'countdown') {
    return {
      ...schedule,
      countdownMinutes,
      runMode: 'countdown',
      status: 'countdown',
      startedAt: Date.now(),
    };
  }
  if (mode === 'scheduled' || (schedule.runMode === 'scheduled' && schedule.scheduledTime > Date.now())) {
    return {
      ...schedule,
      runMode: 'scheduled',
      status: 'scheduled',
      startedAt: null,
    };
  }
  return {
    ...schedule,
    // After countdown branch, `runMode === 'countdown'` is already ruled out.
    runMode: schedule.runMode === 'scheduled' ? 'scheduled' : 'manual',
    status: 'idle',
    startedAt: null,
  };
}

export async function persistSchedule(
  schedule: Schedule,
  profiles: Profile[],
  saveMode: ScheduleSaveMode = 'idle',
): Promise<{ ok: boolean; schedule: Schedule; error?: string }> {
  const saved = finalizeScheduleStatus({ ...schedule, createdFrom: schedule.createdFrom || 'shuffle' }, saveMode);
  upsertSchedule(saved);
  await syncSchedulesToServer(loadSchedules());

  if (saved.status === 'scheduled' && saved.scheduledTime > Date.now()) {
    const enriched = enrichScheduleForServer(saved, profiles);
    const ok = await setServerScheduleTimer(enriched);
    if (!ok) {
      return { ok: false, schedule: saved, error: 'Saved locally but server timer failed — keep app open.' };
    }
  } else {
    await cancelServerScheduleTimer(saved.id);
  }

  return { ok: true, schedule: saved };
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function countdownRemaining(schedule: Schedule, now: number): number {
  if (schedule.status !== 'countdown' || !schedule.startedAt) return 0;
  return Math.max(0, schedule.startedAt + schedule.countdownMinutes * 60000 - now);
}

export function scheduledRemaining(schedule: Schedule, now: number): number {
  if (schedule.status !== 'scheduled' || !schedule.scheduledTime) return 0;
  return Math.max(0, schedule.scheduledTime - now);
}

export function loadShuffleSchedules(): Schedule[] {
  return loadSchedules().filter(s => s.createdFrom === 'shuffle');
}
