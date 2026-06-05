import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchChannelFromRSS, fetchPlaylistVideos } from '../services/youtubeApi';
import type { YouTubeVideo } from '../services/youtubeApi';
import { PERMANENT_CHANNEL_IDS, isPermanentChannel } from '../data/defaultChannels';
import { hydrateChannelsFromServer, saveChannelsBundleToServer } from '../utils/appDataApi';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type ChannelStatus = 'active' | 'inactive' | 'syncing';
export type AutoSync = '1hr' | '6hr' | '12hr' | 'daily' | 'manual';
export type VideoStatus = 'available' | 'queued' | 'running' | 'done';
export type PlaylistStatus = 'active' | 'inactive';

export interface Channel {
  id: number;
  channel_id: string;
  channel_name: string;
  channel_handle: string;
  channel_url: string;
  subscriber_count: number;
  status: ChannelStatus;
  auto_sync: AutoSync;
  last_sync: number | null;
  total_videos: number;
  created_at: number;
}

export interface Video {
  id: number;
  channel_id: number;
  video_id: string;
  title: string;
  url: string;
  duration: number;
  views: number;
  upload_date: number;
  is_enabled: number;
  is_new: number;
  watch_count: number;
  last_watched: number | null;
  status: VideoStatus;
  created_at: number;
  thumbnail?: string;
  likes?: number;
  priority?: 'high' | 'normal';
}

export interface Playlist {
  id: number;
  channel_id: number;
  playlist_id: string;
  playlist_name: string;
  video_count: number;
  status: PlaylistStatus;
  created_at: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function nanoid(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ── Fix: init from localStorage so IDs never collide after page reload ──────
function initAutoIncrement() {
  try {
    const ch = JSON.parse(localStorage.getItem('mmb_channels') || '[]') as { id: number }[];
    const vi = JSON.parse(localStorage.getItem('mmb_videos')   || '[]') as { id: number }[];
    const pl = JSON.parse(localStorage.getItem('mmb_playlists')|| '[]') as { id: number }[];
    return {
      channel:  ch.reduce((m, x) => Math.max(m, x.id ?? 0), 0),
      video:    vi.reduce((m, x) => Math.max(m, x.id ?? 0), 0),
      playlist: pl.reduce((m, x) => Math.max(m, x.id ?? 0), 0),
    };
  } catch { return { channel: 0, video: 0, playlist: 0 }; }
}
let autoIncrement = initAutoIncrement();

/** Parse "12:34" or "1:23:45" → seconds. Returns -1 for unknown/missing. */
function parseDurationToSeconds(dur: string): number {
  if (!dur) return -1;
  const parts = dur.trim().split(':').map(Number);
  if (parts.some(isNaN)) return -1;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return -1;
}

function youtubeVideoToVideo(ytVideo: YouTubeVideo, channelDbId: number): Video {
  autoIncrement.video++;
  return {
    id: autoIncrement.video,
    channel_id: channelDbId,
    video_id: ytVideo.videoId,
    title: ytVideo.title,
    url: ytVideo.url,
    duration: parseDurationToSeconds(ytVideo.duration || '0:00'),
    views: ytVideo.views,
    upload_date: ytVideo.publishedAt,
    is_enabled: 1,
    is_new: (Date.now() - ytVideo.publishedAt) < 7 * 24 * 60 * 60 * 1000 ? 1 : 0,
    watch_count: 0,
    last_watched: null,
    status: 'available',
    created_at: Date.now(),
    thumbnail: ytVideo.thumbnail,
    likes: ytVideo.likes,
    priority: 'normal',
  };
}

const MANUAL_CHANNEL_NAME = 'Manual Videos';

function parseYtVideoId(url: string): string | null {
  const m = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHANNEL STORE HOOK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// LocalStorage helpers
function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch { return fallback; }
}
function saveToStorage(key: string, data: unknown) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
}

export function useChannelStore() {
  const [channels, setChannels] = useState<Channel[]>(() => loadFromStorage('mmb_channels', []));
  const [videos, setVideos] = useState<Video[]>(() => loadFromStorage('mmb_videos', []));
  const [playlists, setPlaylists] = useState<Playlist[]>(() => loadFromStorage('mmb_playlists', []));
  const [toasts, setToasts] = useState<{ id: string; message: string; type: 'success' | 'error' | 'info' }[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const serverSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Channels that need a background re-sync because their videos have missing data (duration=0, views=0)
  const autoSyncNeeded = useRef<string[]>([]);

  useEffect(() => {
    hydrateChannelsFromServer().then(() => {
      // After server data is written to localStorage, re-read into React state
      const ch = loadFromStorage<Channel[]>('mmb_channels', []);
      const vi = loadFromStorage<Video[]>('mmb_videos', []);
      const pl = loadFromStorage<Playlist[]>('mmb_playlists', []);
      if (ch.length > 0) {
        setChannels(ch);
        autoIncrement.channel = ch.reduce((m, x) => Math.max(m, x.id ?? 0), autoIncrement.channel);
      }
      if (vi.length > 0) {
        setVideos(vi);
        autoIncrement.video = vi.reduce((m, x) => Math.max(m, x.id ?? 0), autoIncrement.video);
      }
      if (pl.length > 0) {
        setPlaylists(pl);
        autoIncrement.playlist = pl.reduce((m, x) => Math.max(m, x.id ?? 0), autoIncrement.playlist);
      }

      // Detect channels with missing duration/views — mark them for auto-sync
      if (ch.length > 0 && vi.length > 0) {
        const needSync = ch.filter(c => {
          const chVids = vi.filter(v => v.channel_id === c.id);
          // Needs sync if all videos have duration ≤ 0 (placeholder zeros from bad import)
          return chVids.length > 0 && chVids.every(v => (v.duration ?? 0) <= 0);
        }).map(c => c.channel_id);
        autoSyncNeeded.current = needSync;
      }

      setHydrated(true);
    }).catch(() => setHydrated(true));
  }, []);

  // Persist to localStorage + server on change
  useEffect(() => { saveToStorage('mmb_channels', channels); }, [channels]);
  useEffect(() => { saveToStorage('mmb_videos', videos); }, [videos]);
  useEffect(() => { saveToStorage('mmb_playlists', playlists); }, [playlists]);

  useEffect(() => {
    if (!hydrated) return;  // Don't sync to server until hydration is complete (avoid overwrite on mount)
    if (serverSyncTimer.current) clearTimeout(serverSyncTimer.current);
    serverSyncTimer.current = setTimeout(() => {
      void saveChannelsBundleToServer({ channels, videos, playlists });
    }, 1200);
    return () => {
      if (serverSyncTimer.current) clearTimeout(serverSyncTimer.current);
    };
  }, [hydrated, channels, videos, playlists]);

  const permanentSeedInFlight = useRef(false);

  // ── Auto-sync channels with missing duration/views data ──────────────────
  // Runs once after hydration. Uses fetchChannelFromRSS directly (not syncChannel)
  // to avoid closure issues with newly-set state.
  useEffect(() => {
    if (!hydrated) return;
    const channelIds = autoSyncNeeded.current;
    if (channelIds.length === 0) return;
    autoSyncNeeded.current = []; // clear so it doesn't re-run

    (async () => {
      const { fetchChannelFromRSS } = await import('../services/youtubeApi');
      for (let i = 0; i < channelIds.length; i++) {
        const chId = channelIds[i];
        if (i > 0) await new Promise(r => setTimeout(r, 3000));
        try {
          const data = await fetchChannelFromRSS(chId);
          // Update channel name + stats
          setChannels(prev => prev.map(ch =>
            ch.channel_id === chId
              ? { ...ch, channel_name: data.channelName || ch.channel_name, last_sync: Date.now(), total_videos: data.videos.length, subscriber_count: data.subscriberCount || ch.subscriber_count }
              : ch
          ));
          // Update video duration + views in place; add any new videos
          setVideos(prev => {
            const channelDbId = channels.find(c => c.channel_id === chId)?.id ?? 0;
            if (!channelDbId) return prev;
            const existingIds = new Set(prev.filter(v => v.channel_id === channelDbId).map(v => v.video_id));
            const updated = prev.map(v => {
              if (v.channel_id !== channelDbId) return v;
              const fresh = data.videos.find(yv => yv.videoId === v.video_id);
              if (!fresh) return v;
              const sec = parseDurationToSeconds(fresh.duration || '');
              return {
                ...v,
                duration: sec > 0 ? sec : v.duration,
                views: fresh.views > 0 ? fresh.views : v.views,
                thumbnail: fresh.thumbnail || v.thumbnail,
              };
            });
            // Add new videos not in store
            const newVids = data.videos.filter(yv => !existingIds.has(yv.videoId)).map(yv => {
              autoIncrement.video++;
              return {
                id: autoIncrement.video,
                channel_id: channelDbId,
                video_id: yv.videoId,
                title: yv.title,
                url: yv.url,
                duration: parseDurationToSeconds(yv.duration || ''),
                views: yv.views,
                upload_date: yv.publishedAt,
                is_enabled: 1 as 1,
                is_new: (Date.now() - yv.publishedAt) < 7 * 24 * 60 * 60 * 1000 ? 1 as 1 : 0 as 0,
                watch_count: 0,
                last_watched: null,
                status: 'available' as const,
                created_at: Date.now(),
                thumbnail: yv.thumbnail,
                likes: yv.likes,
                priority: 'normal' as const,
              };
            });
            return newVids.length > 0 ? [...newVids, ...updated] : updated;
          });
        } catch (e) {
          console.warn(`[AutoSync] Failed for channel ${chId}:`, e);
        }
      }
    })();
  }, [hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = nanoid(6);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // ─── GET channels with stats ───
  const getChannels = useCallback(() => {
    return channels.map(ch => ({
      ...ch,
      total_videos: videos.filter(v => v.channel_id === ch.id).length,
      enabled_videos: videos.filter(v => v.channel_id === ch.id && v.is_enabled === 1).length,
      new_videos: videos.filter(v => v.channel_id === ch.id && v.is_new === 1).length,
    }));
  }, [channels, videos]);

  // ─── ADD CHANNEL (fetch real data from YouTube InnerTube) ───
  const addChannel = useCallback(async (
    channelId: string,
    autoSync: AutoSync,
    status: ChannelStatus,
    includePlaylists = false,
  ) => {
    addToast('Fetching channel data from YouTube...', 'info');

    try {
      const data = await fetchChannelFromRSS(channelId);

      // Use the real UC ID returned by InnerTube (handles @handle resolution)
      const realChannelId = data.channelId || channelId;

      // Check duplicate by real UC ID
      if (channels.find(c => c.channel_id === realChannelId)) {
        addToast('Channel already exists!', 'error');
        return null;
      }

      autoIncrement.channel++;
      const newChannel: Channel = {
        id: autoIncrement.channel,
        channel_id: realChannelId,
        channel_name: data.channelName,
        channel_handle: `@${data.channelName.replace(/\s+/g, '').toLowerCase()}`,
        channel_url: data.channelUrl,
        subscriber_count: data.subscriberCount ?? 0,
        status,
        auto_sync: autoSync,
        last_sync: Date.now(),
        total_videos: data.videos.length,
        created_at: Date.now(),
      };

      const newVideos = data.videos.map(v => youtubeVideoToVideo(v, newChannel.id));

      setChannels(prev => [...prev, newChannel]);
      setVideos(prev => [...prev, ...newVideos]);

      // ── Include Playlists: fetch Uploads playlist automatically ──────────
      if (includePlaylists) {
        const uploadsId = `UU${realChannelId.slice(2)}`; // UU + rest of UC ID = uploads playlist
        try {
          const plVideos = await fetchPlaylistVideos(uploadsId);
          if (plVideos.length > 0) {
            autoIncrement.playlist++;
            const uploadsPlaylist = {
              id: autoIncrement.playlist,
              channel_id: newChannel.id,
              playlist_id: uploadsId,
              playlist_name: `${data.channelName} — Uploads`,
              video_count: plVideos.length,
              status: 'active' as PlaylistStatus,
              created_at: Date.now(),
            };
            setPlaylists(prev => [...prev, uploadsPlaylist]);
            addToast(`Added Uploads playlist (${plVideos.length} videos)`, 'info');
          }
        } catch { /* playlist fetch failure is non-blocking */ }
      }

      addToast(`Channel "${data.channelName}" added! ${data.videos.length} videos found.`, 'success');
      return newChannel;
    } catch (err: any) {
      addToast(`Failed to fetch channel: ${err.message}`, 'error');
      return null;
    }
  }, [channels, addToast]);

  // Auto-add permanent channels on load if missing — wait until server hydration is done
  useEffect(() => {
    if (!hydrated) return;  // Don't run until server data is loaded
    const missing = PERMANENT_CHANNEL_IDS.filter(
      id => !channels.some(c => c.channel_id === id),
    );
    if (missing.length === 0 || permanentSeedInFlight.current) return;

    permanentSeedInFlight.current = true;
    (async () => {
      for (const channelId of missing) {
        if (channels.some(c => c.channel_id === channelId)) continue;
        await addChannel(channelId, 'daily', 'active', true);
      }
    })().finally(() => {
      permanentSeedInFlight.current = false;
    });
  }, [hydrated, channels, addChannel]);

  // ─── UPDATE CHANNEL ───
  const updateChannel = useCallback((id: number, updates: Partial<Pick<Channel, 'auto_sync' | 'status' | 'channel_name'>>) => {
    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, ...updates } : ch));
    addToast('Channel updated!', 'success');
  }, [addToast]);

  // ─── DELETE CHANNEL (CASCADE) ───
  const deleteChannel = useCallback((id: number) => {
    const target = channels.find(ch => ch.id === id);
    if (target && isPermanentChannel(target.channel_id)) {
      addToast('Built-in channel cannot be deleted.', 'error');
      return;
    }
    setChannels(prev => prev.filter(ch => ch.id !== id));
    setVideos(prev => prev.filter(v => v.channel_id !== id));
    setPlaylists(prev => prev.filter(p => p.channel_id !== id));
    addToast('Channel deleted!', 'success');
  }, [channels, addToast]);

  // ─── SYNC CHANNEL (re-fetch from YouTube RSS) ───
  const syncChannel = useCallback(async (id: number) => {
    const channel = channels.find(c => c.id === id);
    if (!channel) return;

    setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, status: 'syncing' as ChannelStatus } : ch));

    try {
      const data = await fetchChannelFromRSS(channel.channel_id);

      // Find new videos (not already in our list)
      const existingVideoIds = videos.filter(v => v.channel_id === id).map(v => v.video_id);
      const newYtVideos = data.videos.filter(v => !existingVideoIds.includes(v.videoId));

      // Update existing video stats (views, likes, duration)
      setVideos(prev => prev.map(v => {
        if (v.channel_id !== id) return v;
        const ytVideo = data.videos.find(yv => yv.videoId === v.video_id);
        if (ytVideo) {
          const newDuration = parseDurationToSeconds(ytVideo.duration || '');
          return {
            ...v,
            views: ytVideo.views,
            likes: ytVideo.likes,
            thumbnail: ytVideo.thumbnail || v.thumbnail,
            // Only update duration if we got a valid one (> 0)
            duration: newDuration > 0 ? newDuration : v.duration,
          };
        }
        return v;
      }));

      // Add new videos
      if (newYtVideos.length > 0) {
        const newVideos = newYtVideos.map(v => youtubeVideoToVideo(v, id));
        setVideos(prev => [...newVideos, ...prev]);
      }

      setChannels(prev => prev.map(ch => ch.id === id ? {
        ...ch,
        status: 'active' as ChannelStatus,
        last_sync: Date.now(),
        channel_name: data.channelName,
        total_videos: data.videos.length,
        subscriber_count: data.subscriberCount > 0 ? data.subscriberCount : ch.subscriber_count,
      } : ch));

      addToast(`Synced "${data.channelName}"! ${newYtVideos.length} new videos found.`, 'success');
    } catch (err: any) {
      setChannels(prev => prev.map(ch => ch.id === id ? { ...ch, status: 'active' as ChannelStatus } : ch));
      addToast(`Sync failed: ${err.message}`, 'error');
    }
  }, [channels, videos, addToast]);

  // ─── SYNC ALL — Rate limited (1 per 3 seconds to avoid YouTube blocking) ───
  const syncAllChannels = useCallback(async () => {
    const activeChannels = channels.filter(ch => ch.status === 'active');
    for (let i = 0; i < activeChannels.length; i++) {
      syncChannel(activeChannels[i].id);
      if (i < activeChannels.length - 1) {
        await new Promise(r => setTimeout(r, 3000)); // 3 sec between each
      }
    }
  }, [channels, syncChannel]);

  // ─── TOGGLE CHANNEL ───
  const toggleChannel = useCallback((id: number) => {
    setChannels(prev => prev.map(ch => {
      if (ch.id !== id) return ch;
      return { ...ch, status: ch.status === 'active' ? 'inactive' as ChannelStatus : 'active' as ChannelStatus };
    }));
  }, []);

  const enableAllChannels = useCallback(() => {
    setChannels(prev => prev.map(ch => ({ ...ch, status: 'active' as ChannelStatus })));
    addToast('All channels enabled!', 'success');
  }, [addToast]);

  const disableAllChannels = useCallback(() => {
    setChannels(prev => prev.map(ch => ({ ...ch, status: 'inactive' as ChannelStatus })));
    addToast('All channels disabled!', 'info');
  }, [addToast]);

  // ─── GET VIDEOS ───
  const getVideos = useCallback((channelId: number, filter?: string, sort?: string, search?: string) => {
    let result = videos.filter(v => v.channel_id === channelId);

    if (filter === 'enabled') result = result.filter(v => v.is_enabled === 1);
    else if (filter === 'disabled') result = result.filter(v => v.is_enabled === 0);
    else if (filter === 'new') result = result.filter(v => v.is_new === 1);
    else if (filter === 'watched') result = result.filter(v => v.watch_count > 0);
    else if (filter === 'unwatched') result = result.filter(v => v.watch_count === 0);

    if (search) {
      const s = search.toLowerCase();
      result = result.filter(v => v.title.toLowerCase().includes(s));
    }

    if (sort === 'newest') result = [...result].sort((a, b) => b.upload_date - a.upload_date);
    else if (sort === 'oldest') result = [...result].sort((a, b) => a.upload_date - b.upload_date);
    else if (sort === 'views') result = [...result].sort((a, b) => b.views - a.views);
    else if (sort === 'duration') result = [...result].sort((a, b) => b.duration - a.duration);
    else result = [...result].sort((a, b) => b.upload_date - a.upload_date);

    return result;
  }, [videos]);

  // ─── TOGGLE VIDEO ───
  const toggleVideo = useCallback((videoId: number) => {
    setVideos(prev => prev.map(v => v.id === videoId ? { ...v, is_enabled: v.is_enabled === 1 ? 0 : 1 } : v));
  }, []);

  const enableAllVideos = useCallback((channelId: number) => {
    setVideos(prev => prev.map(v => v.channel_id === channelId ? { ...v, is_enabled: 1 } : v));
    addToast('All videos enabled!', 'success');
  }, [addToast]);

  const disableAllVideos = useCallback((channelId: number) => {
    setVideos(prev => prev.map(v => v.channel_id === channelId ? { ...v, is_enabled: 0 } : v));
    addToast('All videos disabled!', 'info');
  }, [addToast]);

  // ─── PLAYLISTS ───
  const getPlaylists = useCallback((channelId: number) => {
    return playlists.filter(p => p.channel_id === channelId);
  }, [playlists]);

  const addPlaylist = useCallback((channelId: number, playlistId: string, playlistName: string) => {
    if (playlists.find(p => p.playlist_id === playlistId)) {
      addToast('Playlist already exists!', 'error');
      return;
    }
    autoIncrement.playlist++;
    const newPlaylist: Playlist = {
      id: autoIncrement.playlist,
      channel_id: channelId,
      playlist_id: playlistId,
      playlist_name: playlistName || 'Playlist ' + nanoid(4),
      video_count: 0,
      status: 'active',
      created_at: Date.now(),
    };
    setPlaylists(prev => [...prev, newPlaylist]);
    addToast('Playlist added!', 'success');
  }, [playlists, addToast]);

  const deletePlaylist = useCallback((id: number) => {
    setPlaylists(prev => prev.filter(p => p.id !== id));
    addToast('Playlist removed!', 'success');
  }, [addToast]);

  const togglePlaylist = useCallback((id: number) => {
    setPlaylists(prev => prev.map(p => {
      if (p.id !== id) return p;
      return { ...p, status: p.status === 'active' ? 'inactive' as PlaylistStatus : 'active' as PlaylistStatus };
    }));
  }, []);

  const ensureManualChannel = useCallback((): number => {
    const existing = channels.find(c => c.channel_name === MANUAL_CHANNEL_NAME);
    if (existing) return existing.id;
    autoIncrement.channel++;
    const ch: Channel = {
      id: autoIncrement.channel,
      channel_id: `manual_${Date.now()}`,
      channel_name: MANUAL_CHANNEL_NAME,
      channel_handle: '@manual',
      channel_url: '',
      subscriber_count: 0,
      status: 'active',
      auto_sync: 'manual',
      last_sync: Date.now(),
      total_videos: 0,
      created_at: Date.now(),
    };
    setChannels(prev => [...prev, ch]);
    return ch.id;
  }, [channels]);

  const addManualVideo = useCallback((url: string, title: string, priority: 'high' | 'normal' = 'normal'): Video | null => {
    const videoId = parseYtVideoId(url);
    if (!videoId) return null;
    if (videos.some(v => v.video_id === videoId)) return null;
    const channelId = ensureManualChannel();
    autoIncrement.video++;
    const v: Video = {
      id: autoIncrement.video,
      channel_id: channelId,
      video_id: videoId,
      title,
      url: url.includes('http') ? url : `https://www.youtube.com/watch?v=${videoId}`,
      duration: 0,
      views: 0,
      upload_date: Date.now(),
      is_enabled: 1,
      is_new: 1,
      watch_count: 0,
      last_watched: null,
      status: 'available',
      created_at: Date.now(),
      priority,
    };
    setVideos(prev => [v, ...prev]);
    addToast(`Video added: ${title}`, 'success');
    return v;
  }, [videos, ensureManualChannel, addToast]);

  const deleteVideoById = useCallback((id: number) => {
    setVideos(prev => prev.filter(v => v.id !== id));
    addToast('Video removed', 'info');
  }, [addToast]);

  const setVideoPriority = useCallback((id: number, priority: 'high' | 'normal') => {
    setVideos(prev => prev.map(v => v.id === id ? { ...v, priority } : v));
  }, []);

  const shuffleVideos = useCallback(() => {
    setVideos(prev => {
      const a = [...prev];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    });
    addToast('Video order shuffled', 'info');
  }, [addToast]);

  const forceSyncToServer = useCallback(async () => {
    const ok = await saveChannelsBundleToServer({ channels, videos, playlists });
    addToast(ok ? 'Videos server pe sync ho gaye' : 'Server sync fail', ok ? 'success' : 'error');
    return ok;
  }, [channels, videos, playlists, addToast]);

  return {
    channels,
    videos,
    playlists,
    toasts,
    dismissToast,
    getChannels,
    addChannel,
    updateChannel,
    deleteChannel,
    syncChannel,
    syncAllChannels,
    toggleChannel,
    enableAllChannels,
    disableAllChannels,
    getVideos,
    toggleVideo,
    enableAllVideos,
    disableAllVideos,
    getPlaylists,
    addPlaylist,
    deletePlaylist,
    togglePlaylist,
    addManualVideo,
    deleteVideoById,
    setVideoPriority,
    shuffleVideos,
    forceSyncToServer,
  };
}
