import { backendFetch } from '../services/backendOrigin';
import type { Profile } from '../types';
import { getGmailProfileIds } from './gmailProfileStore';

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
  watchPct?:   number;
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

// ── Auto-engage (Video Monitor → Engagement queue) ───────────────────────────

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getCommentTemplates(): { id: string; text: string }[] {
  try {
    const d = localStorage.getItem('mmb_comments');
    const parsed = d ? JSON.parse(d) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Same defaults as Engagement page initial sliders — safe out-of-the-box behavior. */
const AUTO_ENGAGE = {
  likePct: 70,
  dislikePct: 5,
  subscribePct: 30,
  bellPct: 30,
  commentPct: 20,
  descDefault: false,
  watchPctMin: 80,
  watchPctMax: 100,
  adSkipEnabled: true,
  videoQuality: 'auto',
  maxConcurrent: 3,
  startGapMinSec: 10,
  startGapMaxSec: 25,
} as const;

function rollAutoEngageActions() {
  return {
    source: 'notification' as const,
    like: Math.random() * 100 < AUTO_ENGAGE.likePct,
    dislike: Math.random() * 100 < AUTO_ENGAGE.dislikePct,
    subscribe: Math.random() * 100 < AUTO_ENGAGE.subscribePct,
    bell: Math.random() * 100 < AUTO_ENGAGE.bellPct,
    comment: Math.random() * 100 < AUTO_ENGAGE.commentPct,
    descriptionLinks: AUTO_ENGAGE.descDefault,
  };
}

/** Queue engagement jobs when Video Monitor detects a new upload (autoEngage ON). */
export async function triggerAutoEngagement(
  video: VideoTarget,
  profiles: Profile[],
): Promise<{ ok: boolean; message: string; jobIds?: string[] }> {
  const gmailIds = new Set(getGmailProfileIds());
  const gmailProfiles = profiles.filter(p => gmailIds.has(p.id));

  if (gmailProfiles.length === 0) {
    return {
      ok: false,
      message: 'No Gmail-tagged profiles — mark profiles in Gmail Setup first',
    };
  }

  const sel = gmailProfiles.slice(0, AUTO_ENGAGE.maxConcurrent);
  const templates = getCommentTemplates();
  const videoQueue = [video];
  let cumulativeDelayMs = 0;

  const profileEntries: EngagementProfileEntry[] = sel.map((p, i) => {
    const ov = rollAutoEngageActions();
    const commentText =
      ov.comment && templates.length > 0
        ? templates[rand(0, templates.length - 1)].text
        : '';
    const profileWatchPct = rand(AUTO_ENGAGE.watchPctMin, AUTO_ENGAGE.watchPctMax);
    if (i > 0) {
      cumulativeDelayMs += rand(
        AUTO_ENGAGE.startGapMinSec,
        Math.max(AUTO_ENGAGE.startGapMinSec, AUTO_ENGAGE.startGapMaxSec),
      ) * 1000;
    }
    return {
      profileId: p.id,
      profileName: p.name,
      browserType: p.browserType || 'morelogin',
      source: ov.source,
      delayMs: cumulativeDelayMs,
      watchPct: profileWatchPct,
      actions: {
        like: ov.like,
        dislike: ov.dislike,
        subscribe: ov.subscribe,
        bell: ov.bell,
        comment: ov.comment,
        commentText,
        descriptionLinks: ov.descriptionLinks,
      },
      videos: videoQueue,
    };
  });

  const result = await startEngagement({
    profiles: profileEntries,
    watchPct: rand(AUTO_ENGAGE.watchPctMin, AUTO_ENGAGE.watchPctMax),
    adSkipEnabled: AUTO_ENGAGE.adSkipEnabled,
    videoQuality: AUTO_ENGAGE.videoQuality,
    maxConcurrent: AUTO_ENGAGE.maxConcurrent,
  });

  if (result.code === 0) {
    return { ok: true, message: result.message, jobIds: result.jobIds };
  }
  return { ok: false, message: result.message || 'Engagement queue failed' };
}
