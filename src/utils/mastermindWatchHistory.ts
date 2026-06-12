/** Demo mock watch history — same profile + video aaj dubara na aaye. */

import { todayDayKey } from './mastermindSessionTime';

const STORAGE_KEY = 'mmb_mastermind_watch_history';

export interface WatchRecord {
  dayKey: string;
  profileId: string;
  videoId: string;
  videoTitle?: string;
  watchedAt: string;
}

function loadAll(): WatchRecord[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(records: WatchRecord[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch { /* ignore */ }
}

export function getWatchHistory(dayKey = todayDayKey()): WatchRecord[] {
  return loadAll().filter(r => r.dayKey === dayKey);
}

export function isProfileVideoWatched(profileId: string, videoId: string, dayKey = todayDayKey()): boolean {
  return loadAll().some(r => r.dayKey === dayKey && r.profileId === profileId && r.videoId === videoId);
}

export function markProfileVideoWatched(
  profileId: string,
  videoId: string,
  videoTitle?: string,
  dayKey = todayDayKey(),
): void {
  const all = loadAll();
  if (all.some(r => r.dayKey === dayKey && r.profileId === profileId && r.videoId === videoId)) return;
  all.push({
    dayKey,
    profileId,
    videoId,
    videoTitle,
    watchedAt: new Date().toISOString(),
  });
  saveAll(all);
}

/** Demo: kuch pehle se watched pairs seed karo */
export function seedDemoWatchHistory(
  pairs: { profileId: string; videoId: string; videoTitle?: string }[],
  dayKey = todayDayKey(),
): void {
  const all = loadAll();
  for (const p of pairs) {
    if (!all.some(r => r.dayKey === dayKey && r.profileId === p.profileId && r.videoId === p.videoId)) {
      all.push({
        dayKey,
        profileId: p.profileId,
        videoId: p.videoId,
        videoTitle: p.videoTitle,
        watchedAt: new Date().toISOString(),
      });
    }
  }
  saveAll(all);
}

export function clearWatchHistory(dayKey?: string) {
  if (!dayKey) {
    saveAll([]);
    return;
  }
  saveAll(loadAll().filter(r => r.dayKey !== dayKey));
}
