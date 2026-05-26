/**
 * videoMonitorStore.ts
 * Persists new-video monitor settings + detected notifications in localStorage.
 *
 * Keys:
 *   mmb_monitor_config        — { [channelId]: MonitorConfig }
 *   mmb_monitor_lastVideo     — { [channelId]: string }  (last-seen video ID)
 *   mmb_monitor_notifications — NewVideoNotification[]
 */

export interface MonitorConfig {
  enabled: boolean;
  autoEngage: boolean;       // if true → auto-queue engagement on new video
  pollIntervalMin: number;   // check interval in minutes (default 5)
}

export interface NewVideoNotification {
  id: string;
  channelId: string;
  channelName: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  thumbnail: string;
  detectedAt: number;
  dismissed: boolean;
  engagementStarted: boolean;
}

// ── Monitor config ────────────────────────────────────────────────────────────

const CONFIG_KEY = 'mmb_monitor_config';
const LAST_VIDEO_KEY = 'mmb_monitor_lastVideo';
const NOTIF_KEY = 'mmb_monitor_notifications';

function loadConfigs(): Record<string, MonitorConfig> {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); } catch { return {}; }
}
function saveConfigs(d: Record<string, MonitorConfig>) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(d)); } catch {}
}

export function getMonitorConfig(channelId: string): MonitorConfig {
  const all = loadConfigs();
  return all[channelId] ?? { enabled: false, autoEngage: false, pollIntervalMin: 5 };
}

export function setMonitorConfig(channelId: string, patch: Partial<MonitorConfig>): void {
  const all = loadConfigs();
  all[channelId] = { ...getMonitorConfig(channelId), ...patch };
  saveConfigs(all);
}

export function getAllMonitoredChannelIds(): string[] {
  return Object.entries(loadConfigs())
    .filter(([, c]) => c.enabled)
    .map(([id]) => id);
}

// ── Last-known video ──────────────────────────────────────────────────────────

function loadLastVideos(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LAST_VIDEO_KEY) || '{}'); } catch { return {}; }
}

export function getLastKnownVideoId(channelId: string): string | null {
  return loadLastVideos()[channelId] ?? null;
}

export function setLastKnownVideoId(channelId: string, videoId: string): void {
  const d = loadLastVideos();
  d[channelId] = videoId;
  try { localStorage.setItem(LAST_VIDEO_KEY, JSON.stringify(d)); } catch {}
}

// ── Notifications ─────────────────────────────────────────────────────────────

export function getNotifications(): NewVideoNotification[] {
  try { return JSON.parse(localStorage.getItem(NOTIF_KEY) || '[]'); } catch { return []; }
}

function saveNotifications(notifs: NewVideoNotification[]) {
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify(notifs.slice(0, 50))); } catch {}
}

export function addNotification(n: NewVideoNotification): void {
  const all = getNotifications();
  // Avoid duplicate for same video
  if (all.some(x => x.videoId === n.videoId)) return;
  saveNotifications([n, ...all]);
}

export function dismissNotification(id: string): void {
  saveNotifications(getNotifications().map(n => n.id === id ? { ...n, dismissed: true } : n));
}

export function markEngagementStarted(id: string): void {
  saveNotifications(getNotifications().map(n => n.id === id ? { ...n, engagementStarted: true } : n));
}

export function clearAllNotifications(): void {
  saveNotifications([]);
}

export function getUnreadCount(): number {
  return getNotifications().filter(n => !n.dismissed).length;
}
