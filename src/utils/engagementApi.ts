import { backendFetch } from '../services/backendOrigin';

export interface VideoTarget {
  url:         string;
  title:       string;
  channelName: string;
}

export interface EngagementJobAction {
  like?:             boolean;
  dislike?:          boolean;
  subscribe?:        boolean;
  bell?:             boolean;
  comment?:          boolean;
  commentText?:      string;
  descriptionLinks?: boolean;
}

export interface EngagementProfileEntry {
  profileId:   string;
  profileName: string;
  browserType: string;
  source:      'notification' | 'search' | 'direct';
  delayMs:     number;
  actions:     EngagementJobAction;
  videos:      VideoTarget[];   // one entry per channel/video → one tab each
}

export interface StartEngagementPayload {
  profiles:       EngagementProfileEntry[];
  watchPct:       number;
  adSkipEnabled?: boolean;
  videoQuality?:  string;
  maxConcurrent?: number;
}

export interface EngagementJobStatus {
  id:          string;
  profileName: string;
  profileId:   string;
  source:      string;
  status:      'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  scheduledAt: number;
  startedAt:   number | null;
  finishedAt:  number | null;
  error:       string | null;
  log:         { t: string; msg: string }[];
  actions:     EngagementJobAction;
  videoCount?: number;
}

export interface EngagementQueueStatus {
  total:     number;
  pending:   number;
  running:   number;
  done:      number;
  failed:    number;
  cancelled: number;
  jobs:      EngagementJobStatus[];
}

export async function startEngagement(
  payload: StartEngagementPayload,
): Promise<{ code: number; message: string; jobIds?: string[] }> {
  const res = await backendFetch('/api/engagement/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function fetchEngagementStatus(): Promise<EngagementQueueStatus | null> {
  try {
    const res = await backendFetch('/api/engagement/status');
    if (!res.ok) return null;
    const data = await res.json();
    return data.data ?? null;
  } catch { return null; }
}

export async function cancelEngagement(): Promise<void> {
  await backendFetch('/api/engagement/cancel', { method: 'POST' });
}

export async function clearEngagementJobs(): Promise<void> {
  await backendFetch('/api/engagement/clear', { method: 'POST' });
}
