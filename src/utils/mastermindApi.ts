/** Mastermind backend API — save/load + plan execution. */

import { backendFetch } from '../services/backendOrigin';
import type { DemoCampaignGoals, DemoCampaignDefaults, DemoCampaignVideo, DemoProfileSettings } from './mastermindDemoTypes';
import { deserializePlan, serializePlan, type SerializedCampaignPlan } from './mastermindExport';
import type { DemoCampaignPlan } from './mastermindDemoPlan';

export interface MastermindCampaignPayload {
  goals: DemoCampaignGoals;
  defaults: DemoCampaignDefaults;
  videos: DemoCampaignVideo[];
  overrides: Record<string, DemoProfileSettings>;
  /** null/undefined = sab profiles selected */
  selectedProfileIds?: string[] | null;
}

export interface MastermindExecutionSlot {
  id: string;
  profileId: string;
  status: 'pending' | 'spawned' | 'done' | 'skipped' | 'error';
  workerStatus?: string;
  error?: string;
}

export interface MastermindExecutionStatus {
  active: boolean;
  planDayKey: string;
  planName: string;
  startedAt?: string;
  stoppedAt?: string;
  allowSameDayRepeat?: boolean;
  stats: {
    total: number;
    pending: number;
    spawned: number;
    done: number;
    skipped: number;
    error: number;
    retries?: number;
  };
  slots: MastermindExecutionSlot[];
}

export interface MastermindStateResponse {
  campaign: MastermindCampaignPayload & { updatedAt?: string } | null;
  latestPlan: { id: string; name: string; savedAt: string; plan: SerializedCampaignPlan } | null;
  planHistory: { id: string; name: string; dayKey?: string; totalSlots?: number; savedAt: string }[];
  scheduledPlans?: MastermindScheduledPlan[];
  updatedAt?: string;
  execution?: MastermindExecutionStatus;
}

export interface MastermindScheduledPlan {
  id: string;
  name: string;
  targetDate: string;
  autoStart: boolean;
  status: 'pending' | 'active' | 'done';
  totalSlots?: number;
  savedAt?: string;
  completedAt?: string;
  plan?: SerializedCampaignPlan;
}

async function readApiJson<T>(res: Response): Promise<{ data: T | null; error?: string }> {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!text.trim()) {
    return { data: null, error: res.ok ? 'Empty response' : `HTTP ${res.status}` };
  }
  if (!ct.includes('json') && text.trimStart().startsWith('<!')) {
    if (res.status === 404) {
      return {
        data: null,
        error: 'Backend purana lag raha hai — MMB Backend window band karke START.bat dubara chalao (naya code load hoga)',
      };
    }
    return {
      data: null,
      error: `Server ne HTML bheja JSON ki jagah (HTTP ${res.status}) — backend restart karo`,
    };
  }
  try {
    return { data: JSON.parse(text) as T };
  } catch {
    return { data: null, error: `Invalid JSON (HTTP ${res.status})` };
  }
}

/** True when Python backend responds (same check as sidebar API Online). */
export async function isBackendReachable(): Promise<boolean> {
  try {
    const res = await backendFetch('/api/health', { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Mastermind routes loaded on running backend (404 = old server, restart needed). */
export async function isMastermindBackendReady(): Promise<boolean> {
  try {
    const res = await backendFetch('/api/mastermind/state', { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchMastermindState(): Promise<MastermindStateResponse | null> {
  try {
    const res = await backendFetch('/api/mastermind/state');
    const { data } = await readApiJson<MastermindStateResponse>(res);
    return data;
  } catch {
    return null;
  }
}

export async function saveMastermindCampaign(payload: MastermindCampaignPayload): Promise<boolean> {
  try {
    const res = await backendFetch('/api/mastermind/campaign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function saveMastermindPlan(plan: DemoCampaignPlan, name?: string): Promise<{ ok: boolean; planId?: string }> {
  try {
    const res = await backendFetch('/api/mastermind/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: serializePlan(plan), name }),
    });
    if (!res.ok) return { ok: false };
    const data = await res.json() as { planId?: string };
    return { ok: true, planId: data.planId };
  } catch {
    return { ok: false };
  }
}

export function planFromServerEntry(entry: { plan: SerializedCampaignPlan }): DemoCampaignPlan {
  return deserializePlan(entry.plan);
}

export async function fetchMastermindExecutionStatus(): Promise<MastermindExecutionStatus | null> {
  try {
    const res = await backendFetch('/api/mastermind/execute/status');
    if (!res.ok) return null;
    return await res.json() as MastermindExecutionStatus;
  } catch {
    return null;
  }
}

export async function startMastermindExecution(
  plan?: DemoCampaignPlan,
  name?: string,
): Promise<{ ok: boolean; error?: string; totalSlots?: number }> {
  try {
    const body: Record<string, unknown> = {};
    if (plan) body.plan = serializePlan(plan);
    if (name) body.name = name;
    const res = await backendFetch('/api/mastermind/execute/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const { data, error: parseErr } = await readApiJson<{ success?: boolean; error?: string; totalSlots?: number }>(res);
    if (parseErr) return { ok: false, error: parseErr };
    if (!data) return { ok: false, error: `HTTP ${res.status}` };
    if (!res.ok || !data.success) {
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    return { ok: true, totalSlots: data.totalSlots };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function stopMastermindExecution(): Promise<boolean> {
  try {
    const res = await backendFetch('/api/mastermind/execute/stop', { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchScheduledPlans(): Promise<MastermindScheduledPlan[]> {
  try {
    const res = await backendFetch('/api/mastermind/scheduled');
    if (!res.ok) return [];
    const data = await res.json() as { plans?: MastermindScheduledPlan[] };
    return data.plans ?? [];
  } catch {
    return [];
  }
}

export async function saveScheduledPlan(payload: {
  plan: DemoCampaignPlan;
  targetDate: string;
  name: string;
  autoStart?: boolean;
  id?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    const res = await backendFetch('/api/mastermind/scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: serializePlan(payload.plan),
        targetDate: payload.targetDate,
        name: payload.name,
        autoStart: payload.autoStart ?? true,
        id: payload.id,
      }),
    });
    const { data, error: parseErr } = await readApiJson<{ success?: boolean; id?: string; error?: string }>(res);
    if (parseErr) return { ok: false, error: parseErr };
    if (!res.ok || !data?.success) return { ok: false, error: data?.error || `HTTP ${res.status}` };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function deleteScheduledPlan(id: string): Promise<boolean> {
  try {
    const res = await backendFetch(`/api/mastermind/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
