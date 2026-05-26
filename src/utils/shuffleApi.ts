import { backendFetch } from '../services/backendOrigin';
import { fetchScheduleProgress, fetchConcurrency } from './scheduleApi';

export type { ScheduleWorkerStats } from './scheduleApi';
export { fetchScheduleProgress, fetchConcurrency };

export interface ShuffleStatePayload {
  assignments: unknown[];
  channelConfigs: unknown[];
  enabledChannelIds: number[];
  settings?: Record<string, unknown>;
  recycleConfig?: Record<string, unknown>;
}

export async function fetchShuffleStateFromServer(): Promise<ShuffleStatePayload | null> {
  try {
    const res = await backendFetch('/api/shuffle/state');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function syncShuffleStateToServer(state: ShuffleStatePayload): Promise<boolean> {
  try {
    const res = await backendFetch('/api/shuffle/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearServerWatchHistory(profileId: string): Promise<boolean> {
  try {
    const res = await backendFetch('/api/watch-history/' + encodeURIComponent(profileId), {
      method: 'DELETE',
    });
    const data = await res.json();
    return data.code === 0;
  } catch {
    return false;
  }
}

export async function stopScheduleRun(scheduleId: string): Promise<void> {
  try {
    await backendFetch('/api/schedule/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleId }),
    });
  } catch {
    /* ignore */
  }
}

export function pickRandomComment(): string {
  try {
    const comments = JSON.parse(localStorage.getItem('mmb_comments') || '[]');
    if (comments.length > 0) return comments[Math.floor(Math.random() * comments.length)].text;
  } catch {
    /* ignore */
  }
  return '';
}

/** Poll until no workers running/waiting for these profiles (max 24h). */
export function pollShuffleRunUntilDone(
  profileIds: string[],
  onTick: (stats: { total: number; running: number; done: number; error: number; waiting: number }) => void,
): () => void {
  let cancelled = false;
  const interval = setInterval(async () => {
    if (cancelled) return;
    const stats = await fetchScheduleProgress(profileIds);
    if (!stats) return;
    onTick(stats);
    if (stats.total > 0 && stats.running === 0 && stats.waiting === 0) {
      clearInterval(interval);
    }
  }, 5000);
  const timeout = window.setTimeout(() => clearInterval(interval), 24 * 60 * 60 * 1000);
  return () => {
    cancelled = true;
    clearInterval(interval);
    clearTimeout(timeout);
  };
}
