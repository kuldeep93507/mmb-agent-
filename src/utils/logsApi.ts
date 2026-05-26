import { backendFetch, getAuthHeaders, storeApiToken } from '../services/backendOrigin';
import type { LogEntry, LogLevel, LogSource } from '../types';

export interface FetchLogsParams {
  limit?: number;
  since?: number;
  level?: LogLevel | 'all';
  source?: LogSource | 'all';
  profileId?: string;
  search?: string;
}

export interface ActivityLogsResponse {
  entries: LogEntry[];
  total: number;
  stats?: Record<LogLevel, number>;
  filtered?: number;
}

async function ensureApiToken(): Promise<void> {
  if (getAuthHeaders()['X-MMB-Token']) return;
  try {
    const res = await backendFetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.apiToken === 'string' && data.apiToken) storeApiToken(data.apiToken);
  } catch { /* ignore */ }
}

export async function fetchActivityLogs(params: FetchLogsParams = {}): Promise<ActivityLogsResponse> {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.since) q.set('since', String(params.since));
  if (params.level && params.level !== 'all') q.set('level', params.level);
  if (params.source && params.source !== 'all') q.set('source', params.source);
  if (params.profileId) q.set('profileId', params.profileId);
  if (params.search) q.set('search', params.search);

  const res = await backendFetch(`/api/logs${q.toString() ? `?${q}` : ''}`);
  if (!res.ok) throw new Error(`Logs API ${res.status}`);
  return res.json();
}

export async function postActivityLog(
  level: LogLevel,
  message: string,
  opts?: { profileId?: string; profileName?: string; source?: LogSource; id?: string },
): Promise<void> {
  try {
    await backendFetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        message,
        profileId: opts?.profileId,
        profileName: opts?.profileName,
        source: opts?.source || 'profile',
        id: opts?.id,
        timestamp: Date.now(),
      }),
    });
  } catch {
    /* offline — local-only fallback handled by caller */
  }
}

export async function clearActivityLogs(): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureApiToken();
    const res = await backendFetch('/api/logs', { method: 'DELETE', headers: getAuthHeaders() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.message || data.error || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export const LOG_SOURCE_LABELS: Record<LogSource, string> = {
  profile: 'Profile',
  worker: 'Worker',
  scheduler: 'Scheduler',
  shuffle: 'Shuffle',
  backlink: 'Backlink',
  manual: 'Manual',
  settings: 'Settings',
  system: 'System',
  'yt-agent': 'YT Agent',
};
