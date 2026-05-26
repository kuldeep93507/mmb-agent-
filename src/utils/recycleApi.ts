import { backendFetch } from '../services/backendOrigin';

export interface RecycleSlotStatus {
  slotId: string;
  profileName: string;
  currentProfileId: string;
  status: string;
  cycleCount: number;
  cooldownUntil: number | null;
  lastError: string | null;
  videoCount: number;
  enabled: boolean;
  isPaused?: boolean;
  profileIdChangedAt?: number | null;
}

export interface RecycleStatus {
  enabled: boolean;
  cooldownMinMs: number;
  cooldownMaxMs: number;
  activeSlots: number;
  slots: RecycleSlotStatus[];
}

export interface RecycleProfileInput {
  id: string;
  name: string;
  os?: string;
  browserType: string;
  proxyType?: string;
}

export async function fetchRecycleStatus(): Promise<RecycleStatus | null> {
  try {
    const res = await backendFetch('/api/recycle/status');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function startRecycleLoop(opts: {
  profiles: RecycleProfileInput[];
  cooldownMinMinutes: number;
  cooldownMaxMinutes: number;
}): Promise<{ ok: boolean; error?: string; status?: RecycleStatus }> {
  try {
    const res = await backendFetch('/api/recycle/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, status: data.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function stopRecycleLoop(opts?: { slotId?: string; profileId?: string }): Promise<boolean> {
  try {
    const res = await backendFetch('/api/recycle/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts || {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function pauseRecycleLoop(): Promise<boolean> {
  try {
    const res = await backendFetch('/api/recycle/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return res.ok;
  } catch { return false; }
}

export async function resumeRecycleLoop(): Promise<boolean> {
  try {
    const res = await backendFetch('/api/recycle/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return res.ok;
  } catch { return false; }
}

export function formatCooldownRemaining(until: number | null, now: number): string {
  if (!until || until <= now) return '—';
  const sec = Math.ceil((until - now) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}m ${rem}s` : `${min}m`;
}

export function recycleStatusLabel(status: string): string {
  switch (status) {
    case 'running': return 'Running';
    case 'cooldown': return 'Cooldown';
    case 'recreating': return 'Recreating';
    case 'queued': return 'Queued';
    case 'error': return 'Error';
    case 'needs_attention': return 'Needs attention';
    case 'paused': return 'Paused';
    case 'stopped': return 'Stopped';
    default: return 'Idle';
  }
}
