export interface NotificationPrefs {
  browserEnabled: boolean;
  onScheduleComplete: boolean;
  onScheduleError: boolean;
  onWorkerError: boolean;
}

const KEY = 'mmb_notification_prefs';

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  browserEnabled: true,
  onScheduleComplete: true,
  onScheduleError: true,
  onWorkerError: false,
};

export function loadNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_NOTIFICATION_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_NOTIFICATION_PREFS };
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { /* ignore */ }
}

export function shouldNotifyBrowser(kind: keyof Pick<NotificationPrefs, 'onScheduleComplete' | 'onScheduleError' | 'onWorkerError'>): boolean {
  const p = loadNotificationPrefs();
  return p.browserEnabled && p[kind];
}
