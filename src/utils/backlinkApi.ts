import { backendFetch } from '../services/backendOrigin';
import { fetchScheduleProgress } from './scheduleApi';
import { stopScheduleRun } from './shuffleApi';

export type BacklinkSourceType =
  | 'linkedin'
  | 'quora'
  | 'reddit'
  | 'blog'
  | 'twitter'
  | 'facebook'
  | 'other';

export interface Backlink {
  id: string;
  sourceUrl: string;
  sourceType: BacklinkSourceType;
  targetVideoTitle: string;
  targetYoutubeUrl: string;
  usedCount: number;
  lastUsed: number | null;
}

export interface BacklinksState {
  links: Backlink[];
  manualAssign: Record<string, string[]>;
}

const LOCAL_KEY = 'mmb_backlinks';
const LOCAL_ASSIGN_KEY = 'mmb_backlink_manual_assign';

export function loadBacklinksLocal(): Backlink[] {
  try {
    const d = localStorage.getItem(LOCAL_KEY);
    const parsed = d ? JSON.parse(d) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeBacklink) : [];
  } catch {
    return [];
  }
}

export function loadManualAssignLocal(): Record<string, string[]> {
  try {
    const d = localStorage.getItem(LOCAL_ASSIGN_KEY);
    return d ? JSON.parse(d) : {};
  } catch {
    return {};
  }
}

function normalizeBacklink(b: Partial<Backlink> & { sourceUrl: string }): Backlink {
  return {
    id: b.id || Date.now().toString(),
    sourceUrl: b.sourceUrl,
    sourceType: (b.sourceType as BacklinkSourceType) || 'blog',
    targetVideoTitle: b.targetVideoTitle || '',
    targetYoutubeUrl: b.targetYoutubeUrl || '',
    usedCount: b.usedCount || 0,
    lastUsed: b.lastUsed ?? null,
  };
}

export async function fetchBacklinksFromServer(): Promise<BacklinksState | null> {
  try {
    const res = await backendFetch('/api/backlinks');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      links: Array.isArray(data.links) ? data.links.map(normalizeBacklink) : [],
      manualAssign: data.manualAssign && typeof data.manualAssign === 'object' ? data.manualAssign : {},
    };
  } catch {
    return null;
  }
}

export async function syncBacklinksToServer(state: BacklinksState): Promise<boolean> {
  try {
    const res = await backendFetch('/api/backlinks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!res.ok) return false;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state.links));
    localStorage.setItem(LOCAL_ASSIGN_KEY, JSON.stringify(state.manualAssign));
    return true;
  } catch {
    return false;
  }
}

export function exportBacklinksJson(links: Backlink[]): void {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), links }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mmb-backlinks-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseBacklinksImport(text: string): Backlink[] {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.links;
  if (!Array.isArray(list)) throw new Error('Invalid format');
  return list
    .filter((x) => x && String(x.sourceUrl || '').trim())
    .map((x) =>
      normalizeBacklink({
        id: x.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sourceUrl: String(x.sourceUrl).trim(),
        sourceType: x.sourceType,
        targetVideoTitle: x.targetVideoTitle || '',
        targetYoutubeUrl: x.targetYoutubeUrl || x.youtubeUrl || '',
        usedCount: x.usedCount || 0,
        lastUsed: x.lastUsed ?? null,
      }),
    );
}

export function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export { fetchScheduleProgress, stopScheduleRun };

export function pollBacklinkRunUntilDone(
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
