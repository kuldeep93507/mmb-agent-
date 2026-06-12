import { backendFetch } from '../services/backendOrigin';
import { loadShuffleRunSettings } from './shuffleSettingsForSchedule';
import { mapRunSettingsToProfileFields } from './runSettingsShared';

export interface HubVideo {
  url: string;
  title?: string;
  channelName?: string;
  videoId?: string;
  channelId?: number;
}

export interface NotificationPlan {
  id: string;
  name: string;
  enabled: boolean;
  profileIds: string[];
  videos: HubVideo[];
  channelIds?: string[];
  dailyTimes: string[];
  gapMin: number;
  gapMax: number;
  useFleet: boolean;
  fleetMachineIds: string[];
  runSettings?: Record<string, unknown>;
  firedToday?: Record<string, string[]>;
  lastRunAt?: number;
  lastRunSlot?: string;
}

export function buildRunSettingsPayload(): Record<string, unknown> {
  const s = loadShuffleRunSettings();
  return {
    ...mapRunSettingsToProfileFields({ ...s, pauseProbability: s.pauseProbability }),
    trafficSource: 'notification',
  };
}

export async function fetchNotificationPlans(): Promise<{
  plans: NotificationPlan[];
  status: { serverTime: string; serverDate: string; plans: unknown[] };
} | null> {
  try {
    const res = await backendFetch('/api/notification-hub/plans');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      plans: Array.isArray(data.plans) ? data.plans : [],
      status: data.status || { serverTime: '', serverDate: '', plans: [] },
    };
  } catch {
    return null;
  }
}

export async function saveNotificationPlans(plans: NotificationPlan[]): Promise<boolean> {
  const withSettings = plans.map(p => ({
    ...p,
    runSettings: p.runSettings || buildRunSettingsPayload(),
  }));
  try {
    const res = await backendFetch('/api/notification-hub/plans', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plans: withSettings }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runNotificationPlan(planId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await backendFetch('/api/notification-hub/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function fetchFleetMachines(): Promise<{ id: string; name: string; online: boolean }[]> {
  try {
    const res = await backendFetch('/api/fleet/status');
    if (!res.ok) return [];
    const data = await res.json();
    const list = data.machines || data.data?.machines || [];
    return Array.isArray(list)
      ? list.map((m: { id?: string; name?: string; online?: boolean }) => ({
          id: String(m.id || ''),
          name: String(m.name || m.id || ''),
          online: Boolean(m.online),
        }))
      : [];
  } catch {
    return [];
  }
}
