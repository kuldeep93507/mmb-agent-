/**
 * Auto Update Checker
 * - Dev (localhost): git pull via backend
 * - Team (.exe): download new installer from GitHub release
 */

import { backendFetch, getAuthHeaders } from './backendOrigin';
import { isPackagedElectron } from '../utils/appMode';

const GITHUB_RAW_URL = 'https://raw.githubusercontent.com/kuldeep93507/MMB-AGENT-24-7/main/version.json';
const LOCAL_VERSION_KEY = 'mmb_current_version';
const BUNDLED_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.5.0';

export interface VersionInfo {
  version: string;
  lastUpdate: string;
  changelog: string[];
  downloadUrl?: string;
}

export interface UpdateStatus {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  changelog: string[];
  downloadUrl?: string;
  mode: 'download' | 'git';
}

export interface UpdateResult {
  success: boolean;
  message: string;
  mode?: 'download' | 'git';
  newVersion?: string;
}

function parseVersion(v: string): number[] {
  return String(v || '0')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => parseInt(part.replace(/[^0-9].*$/, ''), 10) || 0);
}

export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Seed installed version on first run so banner is accurate in team app */
export function initAppVersion(): void {
  try {
    if (!localStorage.getItem(LOCAL_VERSION_KEY)) {
      localStorage.setItem(LOCAL_VERSION_KEY, BUNDLED_VERSION);
    }
  } catch {
    /* ignore storage errors */
  }
}

export function getCurrentVersion(): string {
  try {
    const stored = localStorage.getItem(LOCAL_VERSION_KEY);
    return stored || BUNDLED_VERSION;
  } catch {
    return BUNDLED_VERSION;
  }
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  initAppVersion();
  const currentVersion = getCurrentVersion();
  const mode: UpdateStatus['mode'] = isPackagedElectron() ? 'download' : 'git';

  try {
    const res = await fetch(GITHUB_RAW_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch version');

    const remote: VersionInfo = await res.json();
    const hasUpdate = isNewerVersion(remote.version, currentVersion);

    return {
      hasUpdate,
      currentVersion,
      latestVersion: remote.version,
      changelog: remote.changelog || [],
      downloadUrl: remote.downloadUrl,
      mode,
    };
  } catch {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      changelog: [],
      mode,
    };
  }
}

export async function runUpdate(downloadUrl?: string): Promise<UpdateResult> {
  if (isPackagedElectron()) {
    const url = downloadUrl?.trim();
    if (!url) {
      return {
        success: false,
        mode: 'download',
        message: 'No download link in version.json yet. Ask owner for the latest setup ZIP.',
      };
    }

    try {
      window.open(url, '_blank', 'noopener,noreferrer');
      return {
        success: true,
        mode: 'download',
        message: 'Download opened in browser. Install the new setup, then reopen MMB Agent.',
      };
    } catch (err) {
      return {
        success: false,
        mode: 'download',
        message: err instanceof Error ? err.message : 'Could not open download link',
      };
    }
  }

  try {
    const res = await backendFetch('/api/update/run', {
      method: 'POST',
      headers: { ...getAuthHeaders() },
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem(LOCAL_VERSION_KEY, data.newVersion || getCurrentVersion());
    }
    return { ...data, mode: 'git' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, mode: 'git', message: 'Backend not running: ' + message };
  }
}

export function setCurrentVersion(version: string) {
  localStorage.setItem(LOCAL_VERSION_KEY, version);
}
