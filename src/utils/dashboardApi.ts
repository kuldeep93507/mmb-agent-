import { backendFetch } from '../services/backendOrigin';

export interface BackendHealth {
  status: string;
  agents: number;
  schedules: number;
  workers: { total: number; running: number; done: number; error: number; waiting: number };
  uptime?: number;
  version?: string;
  engagement?: Record<string, number>;
  recycleEnabled?: boolean;
  concurrency?: { limit: number; running: number; available: number };
}

export interface EngagementJobLogEntry {
  t?: string;
  msg?: string;
}

export interface EngagementJobSummary {
  id: string;
  profileId: string;
  profileName?: string;
  status: string;
  videoCount?: number;
  videosOk?: number;
  videosFailed?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  log?: EngagementJobLogEntry[];
}

export interface EngagementStatusResponse {
  jobs: EngagementJobSummary[];
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  cancelled: number;
  partial: number;
}

export async function fetchEngagementStatus(): Promise<EngagementStatusResponse | null> {
  try {
    const res = await backendFetch('/api/engagement/status');
    if (!res.ok) return null;
    const body = await res.json();
    return body.data ?? body;
  } catch {
    return null;
  }
}

export async function fetchBackendHealth(): Promise<BackendHealth | null> {
  try {
    const res = await backendFetch('/api/health');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export { fetchConcurrency } from './settingsApi';
export { fetchAnalytics, formatWatchTime } from './analyticsApi';
