import { backendFetch } from '../services/backendOrigin';

export interface BackendHealth {
  status: string;
  agents: number;
  schedules: number;
  workers?: { total: number; running: number; done: number; error: number; waiting: number };
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
