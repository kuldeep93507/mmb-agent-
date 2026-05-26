import { backendFetch, getAuthHeaders } from '../services/backendOrigin';

export async function fetchAllProfileConfigs(): Promise<Record<string, unknown>> {
  const res = await backendFetch('/api/profile-configs');
  if (!res.ok) return {};
  const data = await res.json();
  return data.configs && typeof data.configs === 'object' ? data.configs : {};
}

export async function saveProfileConfigToServer(profileId: string, config: unknown): Promise<boolean> {
  try {
    const res = await backendFetch(`/api/profile-config/${profileId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ config }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function hydrateProfileConfigsFromServer(): Promise<void> {
  const configs = await fetchAllProfileConfigs();
  for (const [id, cfg] of Object.entries(configs)) {
    try {
      localStorage.setItem(`mmb_profile_config_${id}`, JSON.stringify(cfg));
    } catch { /* ignore */ }
  }
}

export async function fetchCommentsFromServer(): Promise<unknown[]> {
  const res = await backendFetch('/api/comments');
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.comments) ? data.comments : [];
}

export async function saveCommentsToServer(comments: unknown[]): Promise<boolean> {
  try {
    const res = await backendFetch('/api/comments', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({ comments }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function hydrateCommentsFromServer(): Promise<void> {
  const comments = await fetchCommentsFromServer();
  if (comments.length) {
    try {
      localStorage.setItem('mmb_comments', JSON.stringify(comments));
    } catch { /* ignore */ }
  }
}

export async function fetchChannelsBundleFromServer() {
  const res = await backendFetch('/api/channels-data');
  if (!res.ok) return null;
  const data = await res.json();
  return data;
}

export async function saveChannelsBundleToServer(bundle: {
  channels: unknown[];
  videos: unknown[];
  playlists: unknown[];
}): Promise<boolean> {
  try {
    const res = await backendFetch('/api/channels-data', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(bundle),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function hydrateChannelsFromServer(): Promise<void> {
  const data = await fetchChannelsBundleFromServer();
  if (!data) return;
  try {
    if (Array.isArray(data.channels) && data.channels.length) {
      localStorage.setItem('mmb_channels', JSON.stringify(data.channels));
    }
    if (Array.isArray(data.videos) && data.videos.length) {
      localStorage.setItem('mmb_videos', JSON.stringify(data.videos));
    }
    if (Array.isArray(data.playlists) && data.playlists.length) {
      localStorage.setItem('mmb_playlists', JSON.stringify(data.playlists));
    }
  } catch { /* ignore */ }
}

export async function hydrateAllAppDataFromServer(): Promise<void> {
  await Promise.all([
    hydrateProfileConfigsFromServer(),
    hydrateCommentsFromServer(),
    hydrateChannelsFromServer(),
  ]);
}
