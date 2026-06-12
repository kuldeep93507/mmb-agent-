import { backendFetch } from '../services/backendOrigin';

export type WatchHistoryEntry = {
  videoId: string;
  watchedAt: number;
  videoTitle?: string;
};

export type ScheduleVideoLike = {
  mode?: 'title' | 'url';
  value?: string;
  title?: string;
  url?: string;
  videoId?: string;
};

export function extractVideoIdFromEntry(video: ScheduleVideoLike): string {
  if (video.videoId) return video.videoId;
  const raw = video.url || (video.mode === 'url' ? video.value : '') || '';
  const m = raw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : '';
}

export function watchedToday(entry: WatchHistoryEntry, now = Date.now()): boolean {
  if (!entry.watchedAt) return false;
  const w = new Date(entry.watchedAt);
  const n = new Date(now);
  return (
    w.getFullYear() === n.getFullYear()
    && w.getMonth() === n.getMonth()
    && w.getDate() === n.getDate()
  );
}

export function shouldSkipVideoToday(
  profileId: string,
  videoId: string,
  historyByProfile: Record<string, WatchHistoryEntry[]>,
  allowSameDayRepeat: boolean,
  now = Date.now(),
): boolean {
  if (allowSameDayRepeat || !profileId || !videoId) return false;
  return (historyByProfile[profileId] || []).some(
    e => e.videoId === videoId && watchedToday(e, now),
  );
}

export async function fetchWatchHistoryBatch(
  profileIds: string[],
): Promise<Record<string, WatchHistoryEntry[]>> {
  const out: Record<string, WatchHistoryEntry[]> = {};
  await Promise.all(profileIds.map(async (pid) => {
    try {
      const res = await backendFetch('/api/watch-history/' + encodeURIComponent(pid));
      if (!res.ok) {
        out[pid] = [];
        return;
      }
      const data = await res.json();
      out[pid] = (data.data || []) as WatchHistoryEntry[];
    } catch {
      out[pid] = [];
    }
  }));
  return out;
}

export type ScheduleSkipAnalysis = {
  skipPairs: { profileId: string; videoId: string; title: string }[];
  profilesAllSkipped: string[];
};

export function analyzeScheduleSkipsToday(
  schedule: {
    assignmentMode: 'same-all' | 'per-profile';
    selectedProfiles: string[];
    sameForAll: { videos: ScheduleVideoLike[] }[];
    perProfile: { profileId: string; channelSelections: { videos: ScheduleVideoLike[] }[] }[];
  },
  historyByProfile: Record<string, WatchHistoryEntry[]>,
  allowSameDayRepeat: boolean,
  now = Date.now(),
): ScheduleSkipAnalysis {
  const skipPairs: ScheduleSkipAnalysis['skipPairs'] = [];
  const playableByProfile = new Map<string, number>();

  const checkPair = (profileId: string, video: ScheduleVideoLike) => {
    const videoId = extractVideoIdFromEntry(video);
    if (!videoId) {
      playableByProfile.set(profileId, (playableByProfile.get(profileId) || 0) + 1);
      return;
    }
    if (shouldSkipVideoToday(profileId, videoId, historyByProfile, allowSameDayRepeat, now)) {
      skipPairs.push({
        profileId,
        videoId,
        title: video.title || video.value || videoId,
      });
    } else {
      playableByProfile.set(profileId, (playableByProfile.get(profileId) || 0) + 1);
    }
  };

  if (schedule.assignmentMode === 'same-all') {
    const allVideos = schedule.sameForAll.flatMap(cs => cs.videos);
    for (const profileId of schedule.selectedProfiles) {
      for (const video of allVideos) checkPair(profileId, video);
    }
  } else {
    for (const pa of schedule.perProfile) {
      for (const cs of pa.channelSelections) {
        for (const video of cs.videos) checkPair(pa.profileId, video);
      }
    }
  }

  const profilesAllSkipped = schedule.selectedProfiles.filter((pid) => {
    const hasVideos = schedule.assignmentMode === 'same-all'
      ? schedule.sameForAll.some(cs => cs.videos.length > 0)
      : (schedule.perProfile.find(p => p.profileId === pid)?.channelSelections.some(cs => cs.videos.length > 0) ?? false);
    if (!hasVideos) return false;
    return (playableByProfile.get(pid) || 0) === 0;
  });

  return { skipPairs, profilesAllSkipped };
}
