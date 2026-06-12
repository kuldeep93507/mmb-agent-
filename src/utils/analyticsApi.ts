import { backendFetch } from '../services/backendOrigin';

export type AnalyticsTimeFilter = 'today' | 'yesterday' | '7d' | '30d' | 'all';

export interface ProfileAnalytics {
  views: number;
  watchTime: number;
  likes: number;
  subscribes: number;
  comments: number;
}

export interface DailyTrendPoint {
  date: string;
  views: number;
  watchTime: number;
}

/** One day's activity for a single profile (per-profile daily report). */
export interface ProfileDailyPoint {
  date: string;
  views: number;       // videos watched that day
  watchTime: number;   // seconds
  likes: number;
  subscribes: number;
  comments: number;
  ads: number;         // ads shown
  adsSkipped: number;
}

export interface RecentActivityEntry {
  time: number;
  profileId: string;
  action: string;
  value?: number;
  detail?: string;
}

export interface AnalyticsResponse {
  totalViews: number;
  totalWatchTime: number;
  totalSessions: number;
  totalLikes: number;
  totalSubscribes: number;
  totalComments: number;
  totalAds: number;
  adsSkipped: number;
  adsWatchedFull: number;
  adWatchTime: number;
  trafficYouTube: number;
  trafficGoogle: number;
  trafficBing: number;
  trafficDirect: number;
  trafficChannel: number;
  trafficBacklink: number;
  /** When direct/backlink source could not be determined */
  trafficDirectFallback?: number;
  trafficBacklinkFallback?: number;
  perProfile: Record<string, ProfileAnalytics>;
  /** Each profile's day-by-day activity (newest day first). */
  perProfileDaily?: Record<string, ProfileDailyPoint[]>;
  recentActivity?: RecentActivityEntry[];
  dailyTrend?: DailyTrendPoint[];
  filter?: string;
}

export interface ProfileEngagementConfig {
  likeDailyCap: number;
  subscribeDailyCap: number;
  commentDailyCap: number;
  likeEnabled: boolean;
  subscribeEnabled: boolean;
  commentEnabled: boolean;
}

const DEFAULT_ENGAGEMENT: ProfileEngagementConfig = {
  likeDailyCap: 5,
  subscribeDailyCap: 1,
  commentDailyCap: 3,
  likeEnabled: false,
  subscribeEnabled: false,
  commentEnabled: false,
};

export function getProfileEngagementConfig(profileId: string): ProfileEngagementConfig {
  try {
    const d = localStorage.getItem(`mmb_profile_config_${profileId}`);
    if (!d) return { ...DEFAULT_ENGAGEMENT };
    return { ...DEFAULT_ENGAGEMENT, ...JSON.parse(d) };
  } catch {
    return { ...DEFAULT_ENGAGEMENT };
  }
}

export function formatWatchTime(seconds: number): string {
  if (!seconds || seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`;
}

export async function fetchAnalytics(filter: AnalyticsTimeFilter): Promise<AnalyticsResponse | null> {
  try {
    const res = await backendFetch(`/api/analytics?filter=${filter}`);
    if (!res.ok) return null;
    return (await res.json()) as AnalyticsResponse;
  } catch {
    return null;
  }
}

export async function resetTodayEngagement(): Promise<boolean> {
  try {
    const res = await backendFetch('/api/analytics/reset-today-engagement', { method: 'POST' });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.success;
  } catch {
    return false;
  }
}

export function exportAnalyticsJson(data: AnalyticsResponse, filter: string): void {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), filter, ...data }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mmb-analytics-${filter}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
