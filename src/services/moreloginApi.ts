/**
 * MoreLogin Local API Service
 * Base URL: http://127.0.0.1:40000
 * Docs: https://guide.morelogin.com/api-reference/browser
 *
 * Never put the API key in browser code — `Authorization` is injected by Vite's `/morelogin-api` proxy
 * from `.env` `MORELOGIN_API_KEY` (see vite.config.ts).
 */

// In dev mode, use Vite proxy to avoid CORS. In production, use direct URL.
const BASE_URL = '/morelogin-api';

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
  };
}

export interface MoreLoginProfile {
  id: string;
  envName: string;
  groupId: number;
  proxyId: number;
}

export interface MoreLoginProfileDetail {
  id: string;
  envName: string;
  envRemark: string;
  groupId: number;
  proxyId: number;
  browserTypeId: number;
  operatorSystemId: number;
  browserCore: number;
  isEncrypt: number;
  cookies: string;
  accountInfo: {
    platformId: number;
    customerUrl: string;
    username: string;
    password: string;
    siteId: number;
  };
  advancedSetting: Record<string, unknown>;
  afterStartupConfig: {
    afterStartup: number;
    autoOpenUrls: string[];
  };
  tagIds: number[];
  uaVersion: number;
}

export interface MoreLoginStartResult {
  envId: string;
  debugPort: string;
  webdriver?: string;
}

export interface MoreLoginStatusResult {
  envId: string;
  status: 'running' | 'stopped';
  localStatus: 'running' | 'stopped';
  debugPort?: string;
  webdriver?: string;
}

export interface MoreLoginPageResponse {
  current: number;
  dataList: MoreLoginProfile[];
  pages: number;
  total: number;
}

export interface ApiResponse<T> {
  code: number;
  msg: string;
  data: T;
  requestId?: string;
}

// ============ API FUNCTIONS ============

/**
 * Get list of browser profiles (paginated)
 */
export async function getProfiles(pageNo = 1, pageSize = 100): Promise<ApiResponse<MoreLoginPageResponse>> {
  const res = await fetch(`${BASE_URL}/api/env/page`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ pageNo, pageSize }),
  });
  return res.json();
}

/**
 * Get profile details
 */
export async function getProfileDetail(envId: string): Promise<ApiResponse<MoreLoginProfileDetail>> {
  const res = await fetch(`${BASE_URL}/api/env/detail`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId }),
  });
  return res.json();
}

/**
 * Get profile running status
 */
export async function getProfileStatus(envId: string): Promise<ApiResponse<MoreLoginStatusResult>> {
  const res = await fetch(`${BASE_URL}/api/env/status`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId }),
  });
  return res.json();
}

/**
 * Start a browser profile
 * NOTE: This can take 10-30 seconds as MoreLogin launches the browser
 */
export async function startBrowserProfile(envId: string, options?: { isHeadless?: boolean }): Promise<ApiResponse<MoreLoginStartResult>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout
  
  try {
    const res = await fetch(`${BASE_URL}/api/env/start`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ envId, ...options }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return res.json();
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      // Timeout — but profile might still be starting
      // Return a pending response, caller should poll status
      return { code: -1, msg: 'Request timeout — profile may still be starting. Check status.', data: { envId, debugPort: '' } as any, requestId: '' };
    }
    throw err;
  }
}

/**
 * Stop a browser profile
 */
export async function stopBrowserProfile(envId: string): Promise<ApiResponse<{ envId: string }>> {
  const res = await fetch(`${BASE_URL}/api/env/close`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId }),
  });
  return res.json();
}

/**
 * Quick create browser profiles
 */
export async function quickCreateProfile(params: {
  browserTypeId: number; // 1: Chrome, 2: Firefox
  operatorSystemId: number; // 1: Windows, 2: macOS, 3: Android, 4: iOS
  quantity: number;
  groupId?: number;
}): Promise<ApiResponse<string[]>> {
  const res = await fetch(`${BASE_URL}/api/env/create/quick`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(params),
  });
  return res.json();
}

/**
 * Delete browser profiles (move to recycle bin)
 */
export async function deleteProfiles(envIds: string[], removeEnvData = true): Promise<ApiResponse<boolean>> {
  const res = await fetch(`${BASE_URL}/api/env/removeToRecycleBin/batch`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envIds, removeEnvData }),
  });
  return res.json();
}

/**
 * Update/modify a browser profile
 */
export async function updateProfile(envId: string, data: Partial<MoreLoginProfileDetail>): Promise<ApiResponse<null>> {
  const res = await fetch(`${BASE_URL}/api/env/update`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId, ...data }),
  });
  return res.json();
}

/**
 * Clear local profile cache
 */
export async function clearProfileCache(envId: string, options?: {
  localStorage?: boolean;
  indexedDB?: boolean;
  cookie?: boolean;
  extension?: boolean;
}): Promise<ApiResponse<{ envId: string }>> {
  const res = await fetch(`${BASE_URL}/api/env/removeLocalCache`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId, ...options }),
  });
  return res.json();
}

/**
 * Refresh fingerprint
 */
export async function refreshFingerprint(envId: string): Promise<ApiResponse<string>> {
  const res = await fetch(`${BASE_URL}/api/env/fingerprint/refresh`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId }),
  });
  return res.json();
}

/**
 * Update fingerprint settings for real values (Canvas, WebRTC, etc.)
 * BUG FIX: Configure Multilogin to show real fingerprints instead of masked
 */
export async function configureFingerprint(envId: string, options?: {
  canvasMask?: 'enabled' | 'disabled';
  webrtcMask?: 'enabled' | 'disabled';
  randomizeScreenResolution?: boolean;
  randomizeUserAgent?: boolean;
}): Promise<ApiResponse<null>> {
  const advancedSetting = {
    canvas: options?.canvasMask === 'disabled' ? 'real' : 'masked',
    webRTC: options?.webrtcMask === 'disabled' ? 'real' : 'masked',
    randomizeScreenResolution: options?.randomizeScreenResolution ?? false,
    randomizeUserAgent: options?.randomizeUserAgent ?? false,
  };

  const res = await fetch(`${BASE_URL}/api/env/update`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId, advancedSetting }),
  });
  return res.json();
}

/**
 * Get browser security lock status
 */
export async function getLockStatus(envId: string): Promise<ApiResponse<{ envId: string; locked: boolean }>> {
  const res = await fetch(`${BASE_URL}/api/env/lock/query`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ envId }),
  });
  return res.json();
}

/**
 * Get browser kernel versions
 */
export async function getKernelVersions(): Promise<ApiResponse<{ browserType: number; versions: number[] }[]>> {
  const res = await fetch(`${BASE_URL}/api/env/advanced/ua/versions`, {
    method: 'GET',
    headers: getHeaders(),
  });
  return res.json();
}
