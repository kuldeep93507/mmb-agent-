import { backendFetch, getAuthHeaders, storeApiToken } from '../services/backendOrigin';
import type { ProviderSelection } from '../services/browserProviderApi';

export type ProxyLifeSetting = '1hr' | '2hr' | '4hr' | '8hr' | '24hr';

export interface AppSettings {
  moreloginBaseUrl: string;
  moreloginApiKey: string;
  moreloginSecurityEnabled: boolean;
  moreloginPort: string;
  multiloginEmail: string;
  multiloginPassword: string;
  multiloginToken: string;
  multiloginFolderId: string;
  multiloginFolderIds: string[];   // Additional folder IDs (multi-folder support)
  proxyServer: string;
  proxyPort: string;
  proxyPassword: string;
  proxyPrefix: string;
  defaultProxyLife: ProxyLifeSetting;
  maxConcurrent: string;
  multiloginMaxConcurrent: string;
  multiloginBatchGapMs: string;
  browserProvider: ProviderSelection;
  // Cron scheduler
  cronEnabled: boolean;
  cronSchedule: string;
  // AI Brain
  anthropicApiKey: string;
  // YT Agent 24/7
  ytMaxTotalAgents: string;
  ytVideosPerSessionMin: string;
  ytVideosPerSessionMax: string;
  ytAgentCooldownMs: string;
  ytAgentLaunchGapMin: string;
  ytAgentLaunchGapMax: string;
  ytProxyType: 'smartproxy' | 'multilogin';
  ytLikeEnabled: boolean | string;
  ytLikeAfterPercent: string;
  ytMaxLikesPerSession: string;
  ytAdSkipEnabled: boolean | string;
  ytAdSkipAfterSec: string;
  ytWatchShorts: boolean | string;
  ytWatchTimeMin: string;
  ytWatchTimeMax: string;
  ytTrafficPreference: string;
  // Notifications
  telegramBotToken: string;
  telegramChatId: string;
  smtpHost: string;
  smtpUser: string;
  smtpPass: string;
  notifyEmail: string;
  mailApiUrl: string;
  // Multilogin trash
  multiloginPurgeOnDelete: boolean | string;
  multiloginAutoEmptyTrash: boolean | string;
  multiloginAutoEmptyTrashHours: string;
  multiloginAutoArrangeWindows: boolean | string;
  // Window / display resolution
  windowWidth: string;
  windowHeight: string;
  // High RPM/CPM Cookie Warmup
  highRpmCookieWarmupEnabled: boolean | string;
  warmupVisitCountMin: string;
  warmupVisitCountMax: string;
  // Search warmup (pre-video related searches)
  searchWarmupEnabled: boolean | string;
  searchWarmupAttemptMin: string;
  searchWarmupAttemptMax: string;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  moreloginBaseUrl: 'http://127.0.0.1:40000',
  moreloginApiKey: '',
  moreloginSecurityEnabled: true,
  moreloginPort: '40000',
  multiloginEmail: '',
  multiloginPassword: '',
  multiloginToken: '',
  multiloginFolderId: '',
  multiloginFolderIds: [],
  proxyServer: 'us.smartproxy.net',
  proxyPort: '3120',
  proxyPassword: '',
  proxyPrefix: '',
  defaultProxyLife: '4hr',
  maxConcurrent: '5',
  multiloginMaxConcurrent: '3',
  multiloginBatchGapMs: '45000',
  browserProvider: 'multilogin',
  cronEnabled: false,
  cronSchedule: '0 9 * * *',
  anthropicApiKey: '',
  ytMaxTotalAgents: '40',
  ytVideosPerSessionMin: '3',
  ytVideosPerSessionMax: '7',
  ytAgentCooldownMs: '60000',
  ytAgentLaunchGapMin: '10000',
  ytAgentLaunchGapMax: '15000',
  ytProxyType: 'smartproxy',
  ytLikeEnabled: false,
  ytLikeAfterPercent: '60',
  ytMaxLikesPerSession: '3',
  ytAdSkipEnabled: true,
  ytAdSkipAfterSec: '5',
  ytWatchShorts: true,
  ytWatchTimeMin: '40',
  ytWatchTimeMax: '100',
  ytTrafficPreference: 'custom',
  telegramBotToken: '',
  telegramChatId: '',
  smtpHost: '',
  smtpUser: '',
  smtpPass: '',
  notifyEmail: '',
  mailApiUrl: '',
  multiloginPurgeOnDelete: true,
  multiloginAutoEmptyTrash: false,
  multiloginAutoEmptyTrashHours: '6',
  multiloginAutoArrangeWindows: true,
  // Window / display resolution
  windowWidth: '1920',
  windowHeight: '1080',
  // High RPM/CPM Cookie Warmup
  highRpmCookieWarmupEnabled: false,
  warmupVisitCountMin: '3',
  warmupVisitCountMax: '5',
  // Search warmup (pre-video related searches)
  searchWarmupEnabled: false,
  searchWarmupAttemptMin: '3',
  searchWarmupAttemptMax: '5',
};

const STORAGE_KEY = 'mmb_yt_settings';

export function loadSettingsLocal(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveSettingsLocal(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

export function getProxyConfigFromSettings(): Pick<
  AppSettings,
  'proxyServer' | 'proxyPort' | 'proxyPassword' | 'proxyPrefix' | 'defaultProxyLife'
> {
  return loadSettingsLocal();
}

export async function fetchSettingsFromServer(): Promise<AppSettings | null> {
  try {
    const res = await backendFetch('/api/settings');
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success || !data.settings) return null;
    if (typeof data.apiToken === 'string' && data.apiToken) storeApiToken(data.apiToken);
    return { ...DEFAULT_APP_SETTINGS, ...data.settings };
  } catch {
    return null;
  }
}

export async function saveSettingsToServer(settings: AppSettings): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await backendFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(settings),
    });
    const data = await res.json();
    if (!data.success) return { success: false, error: data.error || 'Save failed' };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function testNotification(
  type: 'telegram' | 'email',
  settings: AppSettings,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await backendFetch('/api/notifications/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, settings }),
    });
    const data = await res.json();
    return { ok: !!data.success, message: data.message || data.error || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function fetchConcurrency(): Promise<{
  limit: number;
  running: number;
  available: number;
} | null> {
  try {
    const res = await backendFetch('/api/concurrency');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function testMoreLoginConnection(settings: Pick<AppSettings, 'moreloginBaseUrl' | 'moreloginApiKey' | 'moreloginSecurityEnabled'>): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await backendFetch('/api/settings/test/morelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchMultiloginToken(
  settings: Pick<AppSettings, 'multiloginEmail' | 'multiloginPassword' | 'multiloginFolderId'>,
): Promise<{ ok: boolean; message: string; tokenPreview?: string }> {
  try {
    const res = await backendFetch('/api/settings/multilogin/fetch-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function testMultiloginConnection(
  settings?: Pick<AppSettings, 'multiloginEmail' | 'multiloginPassword' | 'multiloginToken' | 'multiloginFolderId'>,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await backendFetch('/api/settings/test/multilogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings || {}),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function exportSettingsJson(settings: AppSettings): void {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mmb-settings-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseSettingsImport(text: string): AppSettings {
  const data = JSON.parse(text);
  const s = data.settings || data;
  return { ...DEFAULT_APP_SETTINGS, ...s };
}
