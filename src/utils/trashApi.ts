/**
 * Multilogin trash API — list / permanent delete / empty trash
 */

import { backendFetch } from '../services/backendOrigin';
import type { StandardProfile, StandardResponse } from '../services/browserProviderApi';

export interface TrashListData {
  profiles: StandardProfile[];
  total: number;
  pages: number;
  current: number;
}

async function readJson<T>(res: Response): Promise<StandardResponse<T>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as StandardResponse<T>;
  } catch {
    return { code: -1, message: `Invalid JSON (HTTP ${res.status})`, data: null };
  }
}

export async function listTrashProfiles(
  pageNo = 1,
  pageSize = 50,
): Promise<StandardResponse<TrashListData>> {
  try {
    const q = new URLSearchParams({
      provider: 'multilogin',
      pageNo: String(pageNo),
      pageSize: String(pageSize),
    });
    const res = await backendFetch(`/api/profiles/trash?${q}`);
    return readJson<TrashListData>(res);
  } catch (err: unknown) {
    return {
      code: -1,
      message: err instanceof Error ? err.message : 'Network error',
      data: null,
    };
  }
}

export async function deleteTrashProfiles(
  profileIds: string[],
): Promise<StandardResponse<{ profileIds: string[]; deleted: number }>> {
  try {
    const res = await backendFetch('/api/profiles/trash/delete?provider=multilogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds }),
    });
    return readJson(res);
  } catch (err: unknown) {
    return {
      code: -1,
      message: err instanceof Error ? err.message : 'Network error',
      data: null,
    };
  }
}

export async function emptyTrash(): Promise<StandardResponse<{ deleted: number; warning?: string }>> {
  try {
    const res = await backendFetch('/api/profiles/trash/empty?provider=multilogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return readJson(res);
  } catch (err: unknown) {
    return {
      code: -1,
      message: err instanceof Error ? err.message : 'Network error',
      data: null,
    };
  }
}
