import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Shuffle, Save, RotateCcw, Play, Eye, AlertTriangle, CheckCircle, Download, Upload, Pin, Square,
  Calendar, Timer, RefreshCw,
} from 'lucide-react';
import type { Profile } from '../types';
import { inferProxyTypeFromProfile } from '../utils/profileAdapter';
import type { Channel, Video } from '../store/useChannelStore';
import LiveProgressPanel from './LiveProgressPanel';
import { backendFetch } from '../services/backendOrigin';
import { postActivityLog } from '../utils/logsApi';
import { profileConfigsForSchedule } from '../utils/profileConfigsForSchedule';
import { PERMANENT_CHANNEL_IDS } from '../data/defaultChannels';
import { toScheduleVideo } from '../utils/shuffleVideos';
import {
  fetchShuffleStateFromServer,
  syncShuffleStateToServer,
  clearServerWatchHistory,
  stopScheduleRun,
  fetchConcurrency,
  pollShuffleRunUntilDone,
  pickRandomComment,
} from '../utils/shuffleApi';
import {
  fetchRecycleStatus,
  startRecycleLoop,
  stopRecycleLoop,
  formatCooldownRemaining,
  recycleStatusLabel,
  type RecycleStatus,
} from '../utils/recycleApi';
import {
  type Schedule,
  genScheduleId,
  clampCountdownMinutes,
  persistSchedule,
  enrichScheduleForServer,
  loadShuffleSchedules,
  upsertSchedule,
  loadSchedules,
  saveSchedulesLocal,
  formatCountdown,
  countdownRemaining,
} from '../utils/scheduleStore';
import { syncSchedulesToServer, cancelServerScheduleTimer } from '../utils/scheduleApi';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
interface ChannelConfig {
  channelId: number;
  channelName: string;
  totalVideos: number;
  minPerProfile: number;
  maxPerProfile: number;
}

interface ProfileAssignment {
  profileId: string;
  profileName: string;
  videos: { channelId: number; channelName: string; videoId: string; title: string; url: string }[];
}

interface WatchHistory {
  profileId: string;
  videoId: string;
  watchedAt: number;
}

/** Matches local shuffle expiry — server rows older than this are ignored when merging */
const SHUFFLE_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;

type ServerHistRow = { norm: string; watchedAt: number };

function normalizeWatchTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function videoIsWatched(
  profileId: string,
  video: Video,
  localHist: WatchHistory[],
  serverHist: Record<string, ServerHistRow[]>,
): boolean {
  if (localHist.some(h => h.profileId === profileId && h.videoId === video.video_id)) return true;
  const n = normalizeWatchTitle(video.title);
  return (serverHist[profileId] || []).some(r => r.norm === n);
}

function videoLastWatchedAt(
  profileId: string,
  video: Video,
  localHist: WatchHistory[],
  serverHist: Record<string, ServerHistRow[]>,
): number {
  let t = 0;
  const loc = localHist.find(h => h.profileId === profileId && h.videoId === video.video_id);
  if (loc) t = Math.max(t, loc.watchedAt);
  const n = normalizeWatchTitle(video.title);
  for (const r of serverHist[profileId] || []) {
    if (r.norm === n) t = Math.max(t, r.watchedAt);
  }
  return t;
}

interface VideoShufflePageProps {
  profiles: Profile[];
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
  onRefreshProfiles?: () => void;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PERSISTENCE HELPERS — backend watch_history (+ optional LS mirror after local edits only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Sab profiles ki history `GET /api/watch-history/:id` se — sirf backend, localStorage read nahi. */
async function loadHistoryFromBackend(profileIds: string[]): Promise<{
  shuffleRows: WatchHistory[];
  titleIndex: Record<string, ServerHistRow[]>;
}> {
  const cutoff = Date.now() - SHUFFLE_HISTORY_MS;
  const shuffleRows: WatchHistory[] = [];
  const titleIndex: Record<string, ServerHistRow[]> = {};
  await Promise.all(
    profileIds.map(async (profileId) => {
      try {
        const res = await backendFetch('/api/watch-history/' + encodeURIComponent(profileId));
        const data = await res.json();
        if (data.code !== 0 || !Array.isArray(data.data)) return;
        const norms: ServerHistRow[] = [];
        for (const h of data.data) {
          const watchedAt = typeof h?.watchedAt === 'number' ? h.watchedAt : 0;
          if (watchedAt <= cutoff) continue;
          const vid = typeof h?.videoId === 'string' ? h.videoId.trim() : '';
          if (vid) {
            shuffleRows.push({ profileId, videoId: vid, watchedAt });
          }
          const title = typeof h?.videoTitle === 'string' ? h.videoTitle.trim() : '';
          if (title) {
            norms.push({ norm: normalizeWatchTitle(title), watchedAt });
          }
        }
        if (norms.length) titleIndex[profileId] = norms;
      } catch {
        /* skip profile */
      }
    }),
  );
  return { shuffleRows, titleIndex };
}
function saveHistory(history: WatchHistory[]) {
  try { localStorage.setItem('mmb_watch_history', JSON.stringify(history)); } catch {}
}

function loadAssignments(): ProfileAssignment[] {
  try { const d = localStorage.getItem('mmb_shuffle_assignments'); return d ? JSON.parse(d) : []; } catch { return []; }
}
function saveAssignments(assignments: ProfileAssignment[]) {
  try { localStorage.setItem('mmb_shuffle_assignments', JSON.stringify(assignments)); } catch {}
}

const SHUFFLE_SETTINGS_KEY = 'mmb_shuffle_settings';

type AssignmentMode = 'unique' | 'same-all';
type ShuffleVideoQuality = '144p' | '240p' | '360p' | '480p' | '720p' | '1080p' | 'auto';
const QUALITY_OPTIONS: ShuffleVideoQuality[] = ['auto', '144p', '240p', '360p', '480p', '720p', '1080p'];

interface ShuffleSettings {
  channelConfigs: ChannelConfig[];
  enabledChannelIds: number[];
  assignmentMode: AssignmentMode;
  watchTimeMin: number;
  watchTimeMax: number;
  videoQuality: ShuffleVideoQuality;
  sameModeManualPicks: Record<number, string>;
  adSkipEnabled: boolean;
  adSkipAfterSec: number;
  midRollAdWaitSec: number;
}

const DEFAULT_SHUFFLE_SETTINGS: ShuffleSettings = {
  channelConfigs: [],
  enabledChannelIds: [],
  assignmentMode: 'unique',
  watchTimeMin: 80,
  watchTimeMax: 100,
  videoQuality: 'auto',
  sameModeManualPicks: {},
  adSkipEnabled: true,
  adSkipAfterSec: 5,
  midRollAdWaitSec: 10,
};

function loadShuffleSettings(): ShuffleSettings {
  try {
    const d = localStorage.getItem(SHUFFLE_SETTINGS_KEY);
    if (d) {
      const parsed = JSON.parse(d) as Partial<ShuffleSettings>;
      return normalizeShuffleSettings(parsed);
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_SHUFFLE_SETTINGS };
}

function normalizeShuffleSettings(parsed: Partial<ShuffleSettings>): ShuffleSettings {
  const merged = { ...DEFAULT_SHUFFLE_SETTINGS, ...parsed };
  const picksRaw = merged.sameModeManualPicks;
  const sameModeManualPicks: Record<number, string> = {};
  if (picksRaw && typeof picksRaw === 'object') {
    for (const [key, val] of Object.entries(picksRaw)) {
      if (typeof val === 'string') sameModeManualPicks[Number(key)] = val;
    }
  }
  return {
    ...merged,
    ...clampWatchRange(Number(merged.watchTimeMin), Number(merged.watchTimeMax)),
    assignmentMode: merged.assignmentMode === 'same-all' ? 'same-all' : 'unique',
    videoQuality: QUALITY_OPTIONS.includes(merged.videoQuality as ShuffleVideoQuality)
      ? (merged.videoQuality as ShuffleVideoQuality)
      : 'auto',
    sameModeManualPicks,
    adSkipEnabled: merged.adSkipEnabled !== false,
    adSkipAfterSec: Number.isFinite(Number(merged.adSkipAfterSec)) ? Math.max(0, Math.min(120, Number(merged.adSkipAfterSec))) : 5,
    midRollAdWaitSec: Number.isFinite(Number(merged.midRollAdWaitSec)) ? Math.max(0, Math.min(120, Number(merged.midRollAdWaitSec))) : 10,
  };
}

function clampWatchRange(min: number, max: number): { watchTimeMin: number; watchTimeMax: number } {
  let watchTimeMin = Math.max(1, Math.min(100, Math.round(min)));
  let watchTimeMax = Math.max(1, Math.min(100, Math.round(max)));
  if (watchTimeMin > watchTimeMax) [watchTimeMin, watchTimeMax] = [watchTimeMax, watchTimeMin];
  return { watchTimeMin, watchTimeMax };
}

type AssignedVideo = ProfileAssignment['videos'][number];

interface ScheduleDraft {
  name: string;
  runMode: 'manual' | 'countdown' | 'scheduled';
  countdownMinutes: number;
  scheduledTime: number;
  profileDelayMin: number;
  profileDelayMax: number;
  tabDelayMin: number;
  tabDelayMax: number;
}

const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
  name: '',
  runMode: 'manual',
  countdownMinutes: 5,
  scheduledTime: 0,
  profileDelayMin: 5,
  profileDelayMax: 20,
  tabDelayMin: 2,
  tabDelayMax: 8,
};

function saveShuffleSettings(s: ShuffleSettings) {
  try { localStorage.setItem(SHUFFLE_SETTINGS_KEY, JSON.stringify(s)); } catch {}
}


function fisherYatesShuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clampChannelConfig(c: ChannelConfig, totalVideos: number): ChannelConfig {
  const total = Math.max(0, totalVideos);
  if (total === 0) return { ...c, totalVideos: 0, minPerProfile: 0, maxPerProfile: 0 };
  let min = Math.max(0, Math.min(c.minPerProfile, total));
  let max = Math.max(min, Math.min(c.maxPerProfile, total));
  if (min > max) [min, max] = [max, min];
  return { ...c, totalVideos: total, minPerProfile: min, maxPerProfile: max };
}

function buildChannelConfigs(
  channels: Channel[],
  enabledChannelIds: number[],
  saved: ChannelConfig[],
  getVideos: (channelId: number, filter?: string) => Video[],
): ChannelConfig[] {
  const active = channels.filter(ch => ch.status === 'active');
  const enabledSet = new Set(enabledChannelIds.length ? enabledChannelIds : active.map(c => c.id));
  return active
    .filter(ch => enabledSet.has(ch.id))
    .map(ch => {
      const prev = saved.find(s => s.channelId === ch.id);
      const base: ChannelConfig = {
        channelId: ch.id,
        channelName: ch.channel_name,
        totalVideos: getVideos(ch.id).length,
        minPerProfile: prev?.minPerProfile ?? 2,
        maxPerProfile: prev?.maxPerProfile ?? 4,
      };
      return clampChannelConfig(base, base.totalVideos);
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN COMPONENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function VideoShufflePage({ profiles, channels, getVideos, onRefreshProfiles }: VideoShufflePageProps) {
  const [settings, setSettings] = useState<ShuffleSettings>(() => loadShuffleSettings());
  const [channelConfigs, setChannelConfigs] = useState<ChannelConfig[]>([]);
  const [assignments, setAssignments] = useState<ProfileAssignment[]>(() => loadAssignments());
  const [watchHistory, setWatchHistory] = useState<WatchHistory[]>([]);
  const [serverHist, setServerHist] = useState<Record<string, ServerHistRow[]>>({});
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [isShuffled, setIsShuffled] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeRunProfileIds, setActiveRunProfileIds] = useState<string[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState<{ limit: number; running: number; available: number } | null>(null);
  const [detailProfile, setDetailProfile] = useState<string | null>(null);
  const [poolExhaustedNotice, setPoolExhaustedNotice] = useState<string[]>([]);
  const [runStatus, setRunStatus] = useState<{ type: 'info' | 'warn' | 'error' | 'success'; text: string } | null>(null);
  const [profileSearch, setProfileSearch] = useState('');
  const [profilePage, setProfilePage] = useState(1);
  const [serverSynced, setServerSynced] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(DEFAULT_SCHEDULE_DRAFT);
  const [shuffleSchedules, setShuffleSchedules] = useState<Schedule[]>(() => loadShuffleSchedules());
  const [scheduleNow, setScheduleNow] = useState(Date.now());
  const [recycleStatus, setRecycleStatus] = useState<RecycleStatus | null>(null);
  const [loopProfileIds, setLoopProfileIds] = useState<string[]>([]);
  const [activeLoopLimit, setActiveLoopLimit] = useState(3);
  const [cooldownMin, setCooldownMin] = useState(10);
  const [cooldownMax, setCooldownMax] = useState(30);
  const [loopBusy, setLoopBusy] = useState(false);
  const stopPollRef = useRef<(() => void) | null>(null);
  const runSavedScheduleRef = useRef<(s: Schedule) => Promise<void>>(async () => {});
  const firedCountdownIds = useRef<Set<string>>(new Set());
  const profilesPerPage = 24;

  const profileIdSet = useMemo(() => new Set(profiles.map(p => p.id)), [profiles]);

  useEffect(() => {
    setChannelConfigs(buildChannelConfigs(channels, settings.enabledChannelIds, settings.channelConfigs, getVideos));
  }, [channels, settings.enabledChannelIds, settings.channelConfigs, getVideos]);

  useEffect(() => {
    saveShuffleSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!serverSynced) return;
    const t = window.setTimeout(() => {
      void syncShuffleStateToServer({
        assignments,
        channelConfigs,
        enabledChannelIds: settings.enabledChannelIds,
        settings: settings as unknown as Record<string, unknown>,
        recycleConfig: {
          enabled: recycleStatus?.enabled ?? false,
          profileIds: loopProfileIds,
          activeProfileLimit: activeLoopLimit,
          cooldownMinMinutes: cooldownMin,
          cooldownMaxMinutes: cooldownMax,
        },
      });
    }, 800);
    return () => clearTimeout(t);
  }, [assignments, channelConfigs, settings, loopProfileIds, activeLoopLimit, cooldownMin, cooldownMax, serverSynced, recycleStatus?.enabled]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const remote = await fetchShuffleStateFromServer();
      if (cancelled) return;
      if (remote?.assignments?.length) {
        setAssignments(remote.assignments as ProfileAssignment[]);
        saveAssignments(remote.assignments as ProfileAssignment[]);
      }
      if (remote?.channelConfigs?.length || remote?.enabledChannelIds?.length) {
        setSettings(prev => normalizeShuffleSettings({
          ...prev,
          channelConfigs: (remote.channelConfigs as ChannelConfig[]) || prev.channelConfigs,
          enabledChannelIds: remote.enabledChannelIds || prev.enabledChannelIds,
          ...(remote.settings ? remote.settings as Partial<ShuffleSettings> : {}),
        }));
      }
      const rc = remote?.recycleConfig as { profileIds?: string[]; activeProfileLimit?: number; cooldownMinMinutes?: number; cooldownMaxMinutes?: number } | undefined;
      if (rc?.profileIds?.length) setLoopProfileIds(rc.profileIds.filter((id) => profiles.some((p) => p.id === id)));
      if (typeof rc?.activeProfileLimit === 'number') setActiveLoopLimit(Math.max(1, rc.activeProfileLimit));
      if (typeof rc?.cooldownMinMinutes === 'number') setCooldownMin(rc.cooldownMinMinutes);
      if (typeof rc?.cooldownMaxMinutes === 'number') setCooldownMax(rc.cooldownMaxMinutes);
      setServerSynced(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setAssignments(prev => prev.filter(a => profileIdSet.has(a.profileId)));
  }, [profileIdSet]);

  useEffect(() => {
    const load = () => { void fetchConcurrency().then(setConcurrency); };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const poll = () => { void fetchRecycleStatus().then(setRecycleStatus); };
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, []);

  const toggleLoopProfile = (id: string) => {
    setLoopProfileIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleStartLoop = async () => {
    if (loopProfileIds.length === 0) {
      setRunStatus({ type: 'warn', text: '24/7 loop: pehle kam se kam 1 profile select karo' });
      return;
    }
    if (channelConfigs.length === 0) {
      setRunStatus({ type: 'warn', text: '24/7 loop: pehle channels enable karo' });
      return;
    }
    setLoopBusy(true);
    const selectedLoopIds = loopProfileIds.slice(0, Math.max(1, activeLoopLimit));
    const payload = selectedLoopIds
      .map(id => profiles.find(p => p.id === id))
      .filter(Boolean)
      .map(p => ({
        id: p!.id,
        name: p!.name,
        os: p!.os,
        browserType: p!.browserType || 'multilogin',
        proxyType: inferProxyTypeFromProfile(p!),
      }));
    const r = await startRecycleLoop({
      profiles: payload,
      cooldownMinMinutes: cooldownMin,
      cooldownMaxMinutes: cooldownMax,
    });
    setLoopBusy(false);
    if (r.ok) {
      setRecycleStatus(r.status || null);
      setRunStatus({ type: 'success', text: `24/7 loop ON — running ${payload.length}/${loopProfileIds.length} selected profile(s), cooldown ${cooldownMin}–${cooldownMax} min` });
      void postActivityLog('success', `24/7 recycle started — running ${payload.length}/${loopProfileIds.length} selected profiles`, { source: 'shuffle' });
    } else {
      setRunStatus({ type: 'error', text: r.error || '24/7 start failed' });
    }
  };

  const handleStopLoop = async () => {
    setLoopBusy(true);
    await stopRecycleLoop();
    setRecycleStatus(await fetchRecycleStatus());
    setLoopBusy(false);
    setRunStatus({ type: 'info', text: '24/7 loop stopped' });
    void postActivityLog('info', '24/7 recycle stopped', { source: 'shuffle' });
  };

  useEffect(() => () => { stopPollRef.current?.(); }, []);

  useEffect(() => {
    const t = setInterval(() => setScheduleNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshShuffleSchedules = useCallback(() => {
    setShuffleSchedules(loadShuffleSchedules());
  }, []);

  useEffect(() => {
    if (profiles.length === 0) {
      setWatchHistory([]);
      setServerHist({});
      return;
    }
    let cancelled = false;
    const profileIds = profiles.map((p) => p.id);
    loadHistoryFromBackend(profileIds).then(({ shuffleRows, titleIndex }) => {
      if (cancelled) return;
      setWatchHistory(shuffleRows);
      setServerHist(titleIndex);
    });
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  const refreshShuffleHistoryFromBackend = useCallback(async () => {
    if (profiles.length === 0) {
      setWatchHistory([]);
      setServerHist({});
      return;
    }
    const profileIds = profiles.map((p) => p.id);
    const { shuffleRows, titleIndex } = await loadHistoryFromBackend(profileIds);
    setWatchHistory(shuffleRows);
    saveHistory(shuffleRows);
    setServerHist(titleIndex);
  }, [profiles]);

  // Stats
  const totalPool = useMemo(() => channelConfigs.reduce((sum, c) => sum + c.totalVideos, 0), [channelConfigs]);
  const totalAssigned = useMemo(() => assignments.reduce((sum, a) => sum + a.videos.length, 0), [assignments]);
  const hasOverlap = useMemo(() => {
    if (settings.assignmentMode === 'same-all') return false;
    const videoMap = new Map<string, string[]>();
    for (const a of assignments) {
      for (const v of a.videos) {
        const key = v.videoId;
        if (!videoMap.has(key)) videoMap.set(key, []);
        videoMap.get(key)!.push(a.profileId);
      }
    }
    return [...videoMap.values()].some(ids => ids.length > 1);
  }, [assignments, settings.assignmentMode]);

  const sameVideoActive = settings.assignmentMode === 'same-all' && assignments.some(a => a.videos.length > 0);

  const watchedCountsByProfile = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of profiles) {
      const pid = p.id;
      const localRows = watchHistory.filter(h => h.profileId === pid);
      const countedVideoIds = new Set(localRows.map(h => h.videoId));
      let count = localRows.length;
      const serverRows = serverHist[pid] || [];
      const titlesCountedFromServer = new Set<string>();
      for (const ch of channelConfigs) {
        for (const v of getVideos(ch.channelId, 'enabled')) {
          if (countedVideoIds.has(v.video_id)) continue;
          const n = normalizeWatchTitle(v.title);
          if (serverRows.some(r => r.norm === n)) {
            if (!titlesCountedFromServer.has(n)) {
              titlesCountedFromServer.add(n);
              count++;
              countedVideoIds.add(v.video_id);
            }
          }
        }
      }
      out[pid] = count;
    }
    return out;
  }, [profiles, watchHistory, serverHist, channelConfigs, getVideos]);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SHUFFLE ALGORITHM
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const pickUniqueVideosForProfile = useCallback((
    profileId: string,
    profileName: string,
    usedInThisRun: Set<string>,
    notices: string[],
  ): AssignedVideo[] => {
    const profileVideos: AssignedVideo[] = [];

    for (const config of channelConfigs) {
      const allChannelVideos = getVideos(config.channelId);
      if (allChannelVideos.length === 0) continue;

      const count = Math.floor(Math.random() * (config.maxPerProfile - config.minPerProfile + 1)) + config.minPerProfile;

      let available = allChannelVideos.filter(v =>
        !videoIsWatched(profileId, v, watchHistory, serverHist) && !usedInThisRun.has(v.video_id),
      );

      if (available.length < count) {
        notices.push(`${profileName}: Pool exhausted for "${config.channelName}" — repeating oldest`);
        const oldestWatched = allChannelVideos
          .filter(v => !usedInThisRun.has(v.video_id))
          .sort((a, b) => {
            const aTime = videoLastWatchedAt(profileId, a, watchHistory, serverHist);
            const bTime = videoLastWatchedAt(profileId, b, watchHistory, serverHist);
            return aTime - bTime;
          });
        available = [...new Map([...available, ...oldestWatched].map(v => [v.video_id, v])).values()];
      }

      const shuffled = fisherYatesShuffle(available);
      let picked = shuffled.slice(0, Math.min(count, shuffled.length));
      if (picked.length < count && shuffled.length > 0) {
        while (picked.length < count) {
          picked = [...picked, ...shuffled.slice(0, count - picked.length)];
        }
      }

      for (const video of picked) {
        usedInThisRun.add(video.video_id);
        profileVideos.push({
          channelId: config.channelId,
          channelName: config.channelName,
          videoId: video.video_id,
          title: video.title,
          url: video.url,
        });
      }
    }

    return profileVideos;
  }, [channelConfigs, getVideos, watchHistory, serverHist]);

  const sameModePicks = useMemo(
    () => settings.sameModeManualPicks ?? {},
    [settings.sameModeManualPicks],
  );

  const pickSameVideosPerChannel = useCallback((notices: string[]): AssignedVideo[] => {
    const shared: AssignedVideo[] = [];

    for (const config of channelConfigs) {
      const allChannelVideos = getVideos(config.channelId);
      if (allChannelVideos.length === 0) continue;

      const manualPick = sameModePicks[config.channelId] ?? sameModePicks[Number(config.channelId) as unknown as number];
      if (manualPick && manualPick !== 'random') {
        const fixed = allChannelVideos.find(v => v.video_id === manualPick);
        if (fixed) {
          shared.push({
            channelId: config.channelId,
            channelName: config.channelName,
            videoId: fixed.video_id,
            title: fixed.title,
            url: fixed.url,
          });
          continue;
        }
        notices.push(`"${config.channelName}": selected video missing — random pick used`);
      }

      const unwatched = allChannelVideos.filter(v =>
        !profiles.some(p => videoIsWatched(p.id, v, watchHistory, serverHist)),
      );
      if (unwatched.length === 0 && allChannelVideos.length > 0) {
        notices.push(`"${config.channelName}": pool exhausted — random repeat`);
      }
      const pickFrom = unwatched.length ? unwatched : allChannelVideos;
      const picked = pickFrom[Math.floor(Math.random() * pickFrom.length)];
      shared.push({
        channelId: config.channelId,
        channelName: config.channelName,
        videoId: picked.video_id,
        title: picked.title,
        url: picked.url,
      });
    }

    return shared;
  }, [channelConfigs, getVideos, profiles, watchHistory, serverHist, sameModePicks]);

  const shuffleAll = useCallback(() => {
    const notices: string[] = [];

    if (settings.assignmentMode === 'same-all') {
      const shared = pickSameVideosPerChannel(notices);
      const newAssignments = profiles.map(profile => ({
        profileId: profile.id,
        profileName: profile.name,
        videos: shared.map(v => ({ ...v })),
      }));
      setAssignments(newAssignments);
      setPoolExhaustedNotice(notices);
      setIsShuffled(true);
      return;
    }

    const usedInThisRun = new Set<string>();
    const newAssignments = profiles.map(profile => ({
      profileId: profile.id,
      profileName: profile.name,
      videos: pickUniqueVideosForProfile(profile.id, profile.name, usedInThisRun, notices),
    }));

    setAssignments(newAssignments);
    setPoolExhaustedNotice(notices);
    setIsShuffled(true);
  }, [profiles, settings.assignmentMode, pickSameVideosPerChannel, pickUniqueVideosForProfile]);

  const shuffleSelected = useCallback(() => {
    if (selectedProfileIds.length === 0) return;
    const notices: string[] = [];

    if (settings.assignmentMode === 'same-all') {
      const shared = pickSameVideosPerChannel(notices);
      const newAssignments = assignments.map(a =>
        selectedProfileIds.includes(a.profileId)
          ? { ...a, videos: shared.map(v => ({ ...v })) }
          : a,
      );
      for (const profile of profiles.filter(p => selectedProfileIds.includes(p.id) && !newAssignments.some(a => a.profileId === p.id))) {
        newAssignments.push({ profileId: profile.id, profileName: profile.name, videos: shared.map(v => ({ ...v })) });
      }
      setAssignments(newAssignments);
      setPoolExhaustedNotice(notices);
      setIsShuffled(true);
      return;
    }

    const existingOthers = assignments.filter(a => !selectedProfileIds.includes(a.profileId));
    const usedInThisRun = new Set(existingOthers.flatMap(a => a.videos.map(v => v.videoId)));
    const newAssignments: ProfileAssignment[] = [...existingOthers];

    for (const profile of profiles.filter(p => selectedProfileIds.includes(p.id))) {
      newAssignments.push({
        profileId: profile.id,
        profileName: profile.name,
        videos: pickUniqueVideosForProfile(profile.id, profile.name, usedInThisRun, notices),
      });
    }

    setAssignments(newAssignments);
    setPoolExhaustedNotice(notices);
    setIsShuffled(true);
  }, [selectedProfileIds, profiles, assignments, settings.assignmentMode, pickSameVideosPerChannel, pickUniqueVideosForProfile]);

  const reshuffleSingle = useCallback((profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;
    const notices: string[] = [];

    if (settings.assignmentMode === 'same-all') {
      const shared = pickSameVideosPerChannel(notices);
      setAssignments(prev => prev.map(a => ({ ...a, videos: shared.map(v => ({ ...v })) })));
      if (notices.length) setPoolExhaustedNotice(notices);
      setIsShuffled(true);
      return;
    }

    const usedByOthers = new Set(
      assignments.filter(a => a.profileId !== profileId).flatMap(a => a.videos.map(v => v.videoId)),
    );
    const usedInThisRun = new Set<string>();
    const profileVideos: AssignedVideo[] = [];

    for (const config of channelConfigs) {
      const allChannelVideos = getVideos(config.channelId);
      const count = Math.floor(Math.random() * (config.maxPerProfile - config.minPerProfile + 1)) + config.minPerProfile;

      let available = allChannelVideos.filter(v =>
        !videoIsWatched(profileId, v, watchHistory, serverHist) && !usedByOthers.has(v.video_id) && !usedInThisRun.has(v.video_id),
      );

      if (available.length < count) {
        available = allChannelVideos.filter(v => !usedByOthers.has(v.video_id) && !usedInThisRun.has(v.video_id));
      }

      const shuffled = fisherYatesShuffle(available);
      const picked = shuffled.slice(0, Math.min(count, shuffled.length));

      for (const video of picked) {
        usedInThisRun.add(video.video_id);
        profileVideos.push({
          channelId: config.channelId,
          channelName: config.channelName,
          videoId: video.video_id,
          title: video.title,
          url: video.url,
        });
      }
    }

    setAssignments(prev => prev.map(a => a.profileId === profileId ? { ...a, videos: profileVideos } : a));
    setIsShuffled(true);
  }, [assignments, channelConfigs, getVideos, watchHistory, serverHist, profiles, settings.assignmentMode, pickSameVideosPerChannel]);

  const updateChannelConfig = (channelId: number, patch: Partial<ChannelConfig>) => {
    setChannelConfigs(prev => {
      const next = prev.map(c => c.channelId === channelId ? clampChannelConfig({ ...c, ...patch }, patch.totalVideos ?? c.totalVideos) : c);
      setSettings(s => ({ ...s, channelConfigs: next }));
      return next;
    });
  };

  const setChannelEnabled = (channelId: number, enabled: boolean) => {
    const activeIds = channels.filter(c => c.status === 'active').map(c => c.id);
    setSettings(prev => {
      let ids = prev.enabledChannelIds.length ? [...prev.enabledChannelIds] : activeIds;
      if (enabled) ids = [...new Set([...ids, channelId])];
      else ids = ids.filter(id => id !== channelId);
      return { ...prev, enabledChannelIds: ids };
    });
  };

  const selectFixedChannels = () => {
    const fixedIds = channels
      .filter(c => PERMANENT_CHANNEL_IDS.includes(c.channel_id as typeof PERMANENT_CHANNEL_IDS[number]))
      .map(c => c.id);
    setSettings(prev => ({
      ...prev,
      enabledChannelIds: [...new Set([...(prev.enabledChannelIds.length ? prev.enabledChannelIds : channels.filter(c => c.status === 'active').map(c => c.id)), ...fixedIds])],
    }));
  };

  const handleSave = () => {
    saveAssignments(assignments);
    setSettings(s => ({ ...s, channelConfigs }));
    setIsShuffled(false);
    void syncShuffleStateToServer({ assignments, channelConfigs, enabledChannelIds: settings.enabledChannelIds });
  };

  const handleReset = () => {
    if (!window.confirm('Clear all shuffle assignments?')) return;
    setAssignments([]);
    setPoolExhaustedNotice([]);
    setIsShuffled(false);
    localStorage.removeItem('mmb_shuffle_assignments');
    setSelectedProfileIds([]);
    void syncShuffleStateToServer({ assignments: [], channelConfigs, enabledChannelIds: settings.enabledChannelIds });
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify({
      assignments,
      channelConfigs,
      enabledChannelIds: settings.enabledChannelIds,
      assignmentMode: settings.assignmentMode,
      watchTimeMin: settings.watchTimeMin,
      watchTimeMax: settings.watchTimeMax,
      videoQuality: settings.videoQuality,
      sameModeManualPicks: settings.sameModeManualPicks,
      adSkipEnabled: settings.adSkipEnabled,
      adSkipAfterSec: settings.adSkipAfterSec,
      midRollAdWaitSec: settings.midRollAdWaitSec,
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mmb-shuffle-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed.assignments) setAssignments(parsed.assignments);
        if (parsed.channelConfigs || parsed.enabledChannelIds || parsed.assignmentMode) {
          setSettings(prev => normalizeShuffleSettings({
            ...prev,
            channelConfigs: parsed.channelConfigs || prev.channelConfigs,
            enabledChannelIds: parsed.enabledChannelIds || prev.enabledChannelIds,
            assignmentMode: parsed.assignmentMode === 'same-all' ? 'same-all' : parsed.assignmentMode === 'unique' ? 'unique' : prev.assignmentMode,
            watchTimeMin: Number(parsed.watchTimeMin ?? prev.watchTimeMin),
            watchTimeMax: Number(parsed.watchTimeMax ?? prev.watchTimeMax),
            videoQuality: QUALITY_OPTIONS.includes(parsed.videoQuality) ? parsed.videoQuality : prev.videoQuality,
            sameModeManualPicks: parsed.sameModeManualPicks && typeof parsed.sameModeManualPicks === 'object'
              ? parsed.sameModeManualPicks as Record<number, string>
              : prev.sameModeManualPicks,
            adSkipEnabled: typeof parsed.adSkipEnabled === 'boolean' ? parsed.adSkipEnabled : prev.adSkipEnabled,
            adSkipAfterSec: Number(parsed.adSkipAfterSec ?? prev.adSkipAfterSec),
            midRollAdWaitSec: Number(parsed.midRollAdWaitSec ?? prev.midRollAdWaitSec),
          }));
        }
        setIsShuffled(true);
      } catch {
        window.alert('Invalid shuffle JSON export file.');
      }
    };
    input.click();
  };

  const resetProfileHistory = async (profileId: string) => {
    if (!window.confirm('Clear watch history for this profile (local + server)?')) return;
    await clearServerWatchHistory(profileId);
    const updated = watchHistory.filter(h => h.profileId !== profileId);
    setWatchHistory(updated);
    saveHistory(updated);
    setServerHist(prev => {
      const next = { ...prev };
      delete next[profileId];
      return next;
    });
    void refreshShuffleHistoryFromBackend();
  };

  const handleStopRun = () => {
    if (activeRunId) void stopScheduleRun(activeRunId);
    stopPollRef.current?.();
    stopPollRef.current = null;
    setRunning(false);
    setActiveRunId(null);
    setActiveRunProfileIds([]);
  };

  const setSameModePick = (channelId: number, videoId: string) => {
    setSettings(s => ({
      ...s,
      sameModeManualPicks: { ...(s.sameModeManualPicks ?? {}), [channelId]: videoId },
    }));
    if (settings.assignmentMode !== 'same-all') return;

    const config = channelConfigs.find(c => c.channelId === channelId);
    if (!config) return;

    if (videoId === 'random') {
      const notices: string[] = [];
      const shared = pickSameVideosPerChannel(notices);
      setAssignments(prev => prev.map(a => ({ ...a, videos: shared.map(v => ({ ...v })) })));
      if (notices.length) setPoolExhaustedNotice(notices);
      setIsShuffled(true);
      return;
    }

    const video = getVideos(channelId).find(v => v.video_id === videoId);
    if (!video) return;
    const entry: AssignedVideo = {
      channelId,
      channelName: config.channelName,
      videoId: video.video_id,
      title: video.title,
      url: video.url,
    };
    setAssignments(prev => prev.map(a => {
      const others = a.videos.filter(v => v.channelId !== channelId);
      return { ...a, videos: [...others, entry] };
    }));
    setIsShuffled(true);
  };

  const buildSchedulePayload = (profilesToRun: ProfileAssignment[], scheduleId: string, name: string) => {
    const { watchTimeMin, watchTimeMax } = clampWatchRange(settings.watchTimeMin, settings.watchTimeMax);
    const profileConfigs = profileConfigsForSchedule(profilesToRun.map(a => a.profileId), profiles).map(cfg => ({
      ...cfg,
      watchTimeMin,
      watchTimeMax,
      videoQuality: settings.videoQuality,
      adSkipEnabled: settings.adSkipEnabled,
      adSkipAfterSec: settings.adSkipAfterSec,
      midRollAdWaitSec: settings.midRollAdWaitSec,
      humanEngagementEnabled: true,
      seekForwardMax: 2,
      seekForwardSec: 10,
    }));

    const sameForAll = settings.assignmentMode === 'same-all' && profilesToRun[0]
      ? channelConfigs.map(config => ({
          channelId: config.channelId,
          channelName: config.channelName,
          videos: profilesToRun[0].videos
            .filter(v => v.channelId === config.channelId)
            .map(toScheduleVideo),
        }))
      : [];

    return {
      id: scheduleId,
      name,
      selectedProfiles: profilesToRun.map(a => a.profileId),
      selectedChannels: channelConfigs.map(c => c.channelId),
      assignmentMode: settings.assignmentMode === 'same-all' ? 'same-all' as const : 'per-profile' as const,
      sameForAll,
      perProfile: settings.assignmentMode === 'same-all'
        ? []
        : profilesToRun.map(a => ({
            profileId: a.profileId,
            channelSelections: channelConfigs.map(config => ({
              channelId: config.channelId,
              channelName: config.channelName,
              videos: a.videos.filter(v => v.channelId === config.channelId).map(toScheduleVideo),
            })),
          })),
      profileConfigs,
      profileDelayMin: scheduleDraft.profileDelayMin,
      profileDelayMax: scheduleDraft.profileDelayMax,
      tabDelayMin: scheduleDraft.tabDelayMin,
      tabDelayMax: scheduleDraft.tabDelayMax,
      commentText: pickRandomComment(),
      runMode: scheduleDraft.runMode,
    };
  };

  const getProfilesToRun = useCallback((): ProfileAssignment[] => {
    return selectedProfileIds.length > 0
      ? assignments.filter(a => selectedProfileIds.includes(a.profileId))
      : assignments;
  }, [selectedProfileIds, assignments]);

  const buildScheduleFromShuffle = useCallback((profilesToRun: ProfileAssignment[], name: string, id?: string): Schedule => {
    const scheduleId = id || genScheduleId();
    const payload = buildSchedulePayload(profilesToRun, scheduleId, name);
    return {
      id: scheduleId,
      name,
      selectedProfiles: payload.selectedProfiles,
      selectedChannels: payload.selectedChannels,
      assignmentMode: payload.assignmentMode,
      sameForAll: payload.sameForAll,
      perProfile: payload.perProfile,
      profileDelayMin: scheduleDraft.profileDelayMin,
      profileDelayMax: scheduleDraft.profileDelayMax,
      tabDelayMin: scheduleDraft.tabDelayMin,
      tabDelayMax: scheduleDraft.tabDelayMax,
      runMode: scheduleDraft.runMode,
      countdownMinutes: clampCountdownMinutes(scheduleDraft.countdownMinutes),
      scheduledTime: scheduleDraft.scheduledTime,
      repeatEnabled: false,
      repeatInterval: '6hr',
      status: 'idle',
      createdAt: Date.now(),
      lastRun: null,
      startedAt: null,
      progress: { total: profilesToRun.length, done: 0, failed: 0 },
      profileConfigs: payload.profileConfigs as Record<string, unknown>[],
      createdFrom: 'shuffle',
    };
  }, [buildSchedulePayload, scheduleDraft]);

  const afterRunStarted = useCallback((scheduleId: string, profileIds: string[]) => {
    setActiveRunId(scheduleId);
    setActiveRunProfileIds(profileIds);
    setRunning(true);
    stopPollRef.current?.();
    stopPollRef.current = pollShuffleRunUntilDone(profileIds, (stats) => {
      if (stats.total > 0 && stats.running === 0 && stats.waiting === 0) {
        setRunning(false);
        setActiveRunId(null);
        setActiveRunProfileIds([]);
        void refreshShuffleHistoryFromBackend();
        refreshShuffleSchedules();
      }
    });
  }, [refreshShuffleHistoryFromBackend, refreshShuffleSchedules]);

  const runSingleProfile = async (profileId: string) => {
    const assignment = assignments.find(a => a.profileId === profileId);
    if (!assignment || !assignment.videos.length) {
      setRunStatus({ type: 'warn', text: 'No videos assigned — shuffle first.' });
      return;
    }
    const scheduleId = 'shuffle_single_' + Date.now();
    try {
      const res = await backendFetch('/api/schedule/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule: buildSchedulePayload([assignment], scheduleId, `Shuffle: ${assignment.profileName}`),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        const msg = data?.error || data?.message || 'Run failed — is backend running?';
        void postActivityLog('error', `Shuffle single failed: ${msg}`, { source: 'shuffle' });
        setRunStatus({ type: 'error', text: msg });
        return;
      }
      setRunStatus({ type: 'success', text: `Started run for ${assignment.profileName}` });
      afterRunStarted(scheduleId, [profileId]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed';
      void postActivityLog('error', `Shuffle single error: ${msg}`, { source: 'shuffle' });
      setRunStatus({ type: 'error', text: msg });
    }
  };

  const handleRunAll = async () => {
    const profilesToRun = getProfilesToRun();

    if (profilesToRun.length === 0) {
      setRunStatus({ type: 'warn', text: 'Shuffle karo pehle — koi assignment nahi.' });
      return;
    }

    const conc = await fetchConcurrency();
    const mlxCount = profilesToRun.filter(a => profiles.find(p => p.id === a.profileId)?.browserType === 'multilogin').length;
    const runHints: string[] = [];
    if (conc && profilesToRun.length > conc.available) {
      runHints.push(`Concurrency: ${conc.running}/${conc.limit} running — server may trim to ${conc.available} slots`);
    }
    if (mlxCount > 3) {
      runHints.push(`Multilogin: ${mlxCount} profiles — batched ~3 at a time`);
    }
    if (runHints.length) {
      setRunStatus({ type: 'info', text: runHints.join(' · ') });
    }

    const scheduleId = 'shuffle_' + Date.now();
    try {
      const res = await backendFetch('/api/schedule/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schedule: buildSchedulePayload(profilesToRun, scheduleId, 'Video Shuffle Run'),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        const msg = data?.error || data?.message || 'Run failed — check backend + MoreLogin/Multilogin.';
        void postActivityLog('error', `Shuffle run failed: ${msg}`, { source: 'shuffle' });
        setRunStatus({ type: 'error', text: msg });
        return;
      }
      const parts: string[] = [`Run started (${profilesToRun.length} profiles)`];
      if ((data.skippedNoVideos || 0) > 0) parts.push(`${data.skippedNoVideos} skipped — no videos`);
      if (data.trimmed) parts.push(`${data.workersSpawned} workers (limit ${data.limit})`);
      setRunStatus({ type: 'success', text: parts.join(' · ') });
      afterRunStarted(scheduleId, profilesToRun.map(a => a.profileId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed';
      void postActivityLog('error', `Shuffle run error: ${msg}`, { source: 'shuffle' });
      setRunStatus({ type: 'error', text: msg });
      setRunning(false);
    }
  };

  const runSavedSchedule = useCallback(async (schedule: Schedule) => {
    if (firedCountdownIds.current.has(schedule.id)) return;
    firedCountdownIds.current.add(schedule.id);

    const runningSchedule: Schedule = {
      ...schedule,
      status: 'running',
      lastRun: Date.now(),
      progress: { total: schedule.selectedProfiles.length, done: 0, failed: 0 },
    };
    upsertSchedule(runningSchedule);
    refreshShuffleSchedules();

    try {
      const scheduleData = {
        ...enrichScheduleForServer(runningSchedule, profiles),
        commentText: pickRandomComment(),
      };

      const res = await backendFetch('/api/schedule/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: scheduleData }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        const msg = data?.error || data?.message || 'Schedule run failed';
        upsertSchedule({ ...runningSchedule, status: 'failed', lastRunError: msg });
        refreshShuffleSchedules();
        setRunStatus({ type: 'error', text: `"${schedule.name}": ${msg}` });
        firedCountdownIds.current.delete(schedule.id);
        return;
      }

      const parts = [`Schedule "${schedule.name}" started`];
      if (data.trimmed) parts.push(`${data.workersSpawned} workers (limit ${data.limit})`);
      setRunStatus({ type: 'success', text: parts.join(' · ') });
      afterRunStarted(schedule.id, schedule.selectedProfiles);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Run failed';
      upsertSchedule({ ...runningSchedule, status: 'failed', lastRunError: msg });
      refreshShuffleSchedules();
      setRunStatus({ type: 'error', text: msg });
      firedCountdownIds.current.delete(schedule.id);
    }
  }, [profiles, refreshShuffleSchedules, afterRunStarted]);

  useEffect(() => {
    runSavedScheduleRef.current = runSavedSchedule;
  }, [runSavedSchedule]);

  useEffect(() => {
    for (const s of shuffleSchedules) {
      if (s.status !== 'countdown' || !s.startedAt) continue;
      const remaining = countdownRemaining(s, scheduleNow);
      if (remaining <= 0 && !firedCountdownIds.current.has(s.id)) {
        void runSavedScheduleRef.current(s);
      }
    }
  }, [scheduleNow, shuffleSchedules]);

  const handleSaveSchedule = async (startCountdown: boolean) => {
    const profilesToRun = getProfilesToRun();
    if (profilesToRun.length === 0) {
      setRunStatus({ type: 'warn', text: 'Shuffle karo pehle — schedule ke liye assignment chahiye.' });
      return;
    }
    const name = scheduleDraft.name.trim() || `Shuffle ${new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const schedule = buildScheduleFromShuffle(profilesToRun, name);

    if (startCountdown) {
      schedule.runMode = 'countdown';
    } else if (scheduleDraft.runMode === 'scheduled' && scheduleDraft.scheduledTime > Date.now()) {
      schedule.runMode = 'scheduled';
      schedule.scheduledTime = scheduleDraft.scheduledTime;
    } else {
      schedule.runMode = scheduleDraft.runMode;
    }

    schedule.countdownMinutes = clampCountdownMinutes(scheduleDraft.countdownMinutes);
    schedule.scheduledTime = scheduleDraft.scheduledTime;

    const saveMode = startCountdown
      ? 'countdown'
      : schedule.runMode === 'scheduled' && schedule.scheduledTime > Date.now()
        ? 'scheduled'
        : 'idle';

    const result = await persistSchedule(schedule, profiles, saveMode);
    refreshShuffleSchedules();

    if (!result.ok) {
      setRunStatus({ type: 'error', text: result.error || 'Schedule save failed' });
      return;
    }

    firedCountdownIds.current.delete(result.schedule.id);
    const msg = startCountdown
      ? `Schedule saved — countdown ${result.schedule.countdownMinutes} min shuru`
      : result.schedule.status === 'scheduled'
        ? `Schedule saved — ${new Date(result.schedule.scheduledTime).toLocaleString()} par chalega`
        : `Schedule "${result.schedule.name}" saved — Scheduler page par bhi dikhega`;
    setRunStatus({ type: 'success', text: msg });
    if (!scheduleDraft.name.trim()) {
      setScheduleDraft(d => ({ ...d, name: result.schedule.name }));
    }
  };

  const handleCancelScheduleWait = async (scheduleId: string) => {
    await cancelServerScheduleTimer(scheduleId);
    const all = loadSchedules();
    const next = all.map(s => s.id === scheduleId ? { ...s, status: 'idle' as const, startedAt: null } : s);
    saveSchedulesLocal(next);
    await syncSchedulesToServer(next);
    firedCountdownIds.current.delete(scheduleId);
    refreshShuffleSchedules();
    setRunStatus({ type: 'info', text: 'Schedule wait cancelled' });
  };

  const pendingShuffleSchedules = useMemo(
    () => shuffleSchedules.filter(s => s.status === 'countdown' || s.status === 'scheduled'),
    [shuffleSchedules],
  );

  const filteredProfiles = useMemo(() => {
    const q = profileSearch.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [profiles, profileSearch]);
  const profilePages = Math.max(1, Math.ceil(filteredProfiles.length / profilesPerPage));
  const pagedProfiles = filteredProfiles.slice((profilePage - 1) * profilesPerPage, profilePage * profilesPerPage);
  const activeChannels = useMemo(() => channels.filter(c => c.status === 'active'), [channels]);
  const enabledIdSet = useMemo(() => {
    const ids = settings.enabledChannelIds.length ? settings.enabledChannelIds : activeChannels.map(c => c.id);
    return new Set(ids);
  }, [settings.enabledChannelIds, activeChannels]);

  const removeVideoFromAssignment = (profileId: string, index: number) => {
    setAssignments(prev => prev.map(a => a.profileId === profileId ? { ...a, videos: a.videos.filter((_, i) => i !== index) } : a));
    setIsShuffled(true);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Video Shuffle</h1>
            <p className="text-gray-500 text-sm mt-0.5">
              Unique ya same video mode · watch % {settings.watchTimeMin}–{settings.watchTimeMax} · quality {settings.videoQuality}
            </p>
            <button type="button" onClick={() => { void refreshShuffleHistoryFromBackend(); }}
              className="mt-1 text-xs text-purple-400 hover:text-purple-300 underline-offset-2 hover:underline">
              Refresh server watch history
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <button type="button" onClick={handleImport} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs">
              <Upload size={14} /> Import
            </button>
            <button type="button" onClick={handleExport} disabled={!assignments.length} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs disabled:opacity-40">
              <Download size={14} /> Export
            </button>
            <button type="button" onClick={shuffleAll} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-sm font-semibold transition-all">
              <Shuffle size={15} /> Shuffle All
            </button>
            <button type="button" onClick={shuffleSelected} disabled={selectedProfileIds.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-800 hover:bg-purple-700 disabled:opacity-40 text-white text-sm font-medium transition-all">
              <Shuffle size={15} /> Shuffle Selected ({selectedProfileIds.length})
            </button>
            <button type="button" onClick={handleSave} disabled={!isShuffled}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-semibold transition-all">
              <Save size={15} /> Apply & Save
            </button>
            <button type="button" onClick={handleReset}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-all">
              <RotateCcw size={15} /> Reset
            </button>
            {running ? (
              <button type="button" onClick={handleStopRun}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-bold transition-all">
                <Square size={15} /> Stop
              </button>
            ) : (
              <button type="button" onClick={handleRunAll} disabled={assignments.length === 0 || channelConfigs.length === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-bold transition-all shadow-lg shadow-red-900/30">
                <Play size={15} /> {selectedProfileIds.length > 0 ? `Run ${selectedProfileIds.length} Selected` : 'Run All'}
              </button>
            )}
          </div>
        </div>

        {runStatus && (
          <div className={`mb-3 flex items-center justify-between gap-2 text-xs rounded-lg px-3 py-2 border ${
            runStatus.type === 'error' ? 'text-red-300 bg-red-900/20 border-red-700/30'
            : runStatus.type === 'warn' ? 'text-amber-300 bg-amber-900/20 border-amber-700/30'
            : runStatus.type === 'success' ? 'text-green-300 bg-green-900/20 border-green-700/30'
            : 'text-blue-300 bg-blue-900/20 border-blue-700/30'
          }`}>
            <span>{runStatus.text}</span>
            <button type="button" onClick={() => setRunStatus(null)} className="text-gray-400 hover:text-white">✕</button>
          </div>
        )}
        {concurrency && (
          <div className="mb-3 flex items-center gap-2 text-xs text-amber-300/90 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} />
            Concurrency: {concurrency.running}/{concurrency.limit} running · {concurrency.available} slots free
          </div>
        )}

        {/* Pool Stats */}
        <div className="grid grid-cols-4 gap-3">
          <div className="border border-blue-700/30 bg-blue-900/10 rounded-xl p-3">
            <div className="text-xl font-bold text-blue-400">{totalPool}</div>
            <div className="text-xs text-gray-500">Total Video Pool</div>
          </div>
          <div className="border border-green-700/30 bg-green-900/10 rounded-xl p-3">
            <div className="text-xl font-bold text-green-400">{totalAssigned}</div>
            <div className="text-xs text-gray-500">Assigned</div>
          </div>
          <div className={`border rounded-xl p-3 ${sameVideoActive ? 'border-blue-700/30 bg-blue-900/10' : hasOverlap ? 'border-red-700/30 bg-red-900/10' : 'border-green-700/30 bg-green-900/10'}`}>
            <div className={`text-xl font-bold ${sameVideoActive ? 'text-blue-400' : hasOverlap ? 'text-red-400' : 'text-green-400'}`}>
              {sameVideoActive ? '🔗 Same' : hasOverlap ? '⚠️ Overlap' : '✅ Unique'}
            </div>
            <div className="text-xs text-gray-500">{sameVideoActive ? 'Same Video Mode' : 'Assignment Mode'}</div>
          </div>
          <div className="border border-purple-700/30 bg-purple-900/10 rounded-xl p-3">
            <div className="text-xl font-bold text-purple-400">{profiles.length}</div>
            <div className="text-xs text-gray-500">Profiles</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Live Progress — filtered to current shuffle run only (no overlap with scheduler) */}
        <LiveProgressPanel
          compact
          profiles={profiles}
          filterProfileIds={
            recycleStatus?.enabled
              ? recycleStatus.slots.filter(s => s.enabled).map(s => s.currentProfileId)
              : running && activeRunProfileIds.length > 0
                ? activeRunProfileIds
                : undefined
          }
          runLabel={recycleStatus?.enabled ? '24/7 Loop Progress' : running ? 'Shuffle Run Progress' : undefined}
          hideWhenIdle={!running && !recycleStatus?.enabled}
          showRecycleControls
          onStartRecycle={handleStartLoop}
          onStopRecycle={handleStopLoop}
          recycleLoopBusy={loopBusy}
          canStartRecycle={loopProfileIds.length > 0 && channelConfigs.length > 0}
          onRefreshProfiles={onRefreshProfiles}
        />

        {/* 24/7 Auto Loop */}
        <div className="bg-gray-900 border border-emerald-800/50 rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-white font-semibold flex items-center gap-2">
                <RefreshCw size={18} className="text-emerald-400" />
                24/7 Auto Loop
              </h2>
              <p className="text-xs text-gray-500 mt-1">
                Task complete → cooldown → delete → recreate → shuffle → run (automatic, no manual step)
              </p>
            </div>
            <div className="flex items-center gap-2">
              {recycleStatus?.enabled ? (
                <span className="text-xs text-emerald-400 font-medium">● RUNNING · {recycleStatus.activeSlots} slot(s)</span>
              ) : (
                <span className="text-xs text-gray-500">● Stopped</span>
              )}
              {recycleStatus?.enabled ? (
                <button type="button" disabled={loopBusy} onClick={() => void handleStopLoop()}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-bold">
                  <Square size={14} /> Stop 24/7
                </button>
              ) : (
                <button type="button" disabled={loopBusy || loopProfileIds.length === 0}
                  onClick={() => void handleStartLoop()}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-bold">
                  <Play size={14} /> Start 24/7
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Cooldown min (minutes)</label>
              <input type="number" min={1} max={1440} value={cooldownMin} disabled={!!recycleStatus?.enabled}
                onChange={(e) => setCooldownMin(Math.max(1, Number(e.target.value) || 1))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm disabled:opacity-50" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Cooldown max (minutes)</label>
              <input type="number" min={1} max={1440} value={cooldownMax} disabled={!!recycleStatus?.enabled}
                onChange={(e) => setCooldownMax(Math.max(cooldownMin, Number(e.target.value) || cooldownMin))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm disabled:opacity-50" />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Active profiles to run</label>
              <input type="number" min={1} max={Math.max(1, loopProfileIds.length)} value={Math.min(activeLoopLimit, Math.max(1, loopProfileIds.length || 1))} disabled={!!recycleStatus?.enabled}
                onChange={(e) => setActiveLoopLimit(Math.max(1, Math.min(loopProfileIds.length || 1, Number(e.target.value) || 1)))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm disabled:opacity-50" />
            </div>
            <div className="flex items-end">
              <p className="text-xs text-gray-500 pb-2">
                Sirf first {Math.min(activeLoopLimit, loopProfileIds.length || activeLoopLimit)} selected profile(s) run honge. Extra selected profiles queue/refill nahi honge.
              </p>
            </div>
          </div>

          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-gray-400">Profiles in loop ({loopProfileIds.length} selected)</label>
              {!recycleStatus?.enabled && (
                <div className="flex gap-2">
                  <button type="button" className="text-xs text-emerald-400 hover:text-emerald-300"
                    onClick={() => setLoopProfileIds(profiles.map(p => p.id))}>Select all</button>
                  <button type="button" className="text-xs text-gray-500 hover:text-gray-300"
                    onClick={() => setLoopProfileIds([])}>Clear</button>
                  {selectedProfileIds.length > 0 && (
                    <button type="button" className="text-xs text-blue-400 hover:text-blue-300"
                      onClick={() => setLoopProfileIds([...selectedProfileIds])}>Use shuffle selection</button>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2 max-h-28 overflow-y-auto">
              {profiles.map(p => {
                const on = loopProfileIds.includes(p.id);
                const slot = recycleStatus?.slots.find(s => s.currentProfileId === p.id || s.profileName === p.name);
                return (
                  <button key={p.id} type="button" disabled={!!recycleStatus?.enabled}
                    onClick={() => toggleLoopProfile(p.id)}
                    className={`px-2.5 py-1 rounded-lg text-xs border transition-all disabled:cursor-default ${
                      slot?.status === 'running' ? 'border-green-500 bg-green-900/30 text-green-300'
                        : slot?.status === 'cooldown' ? 'border-amber-500 bg-amber-900/20 text-amber-300'
                        : slot?.status === 'recreating' ? 'border-purple-500 bg-purple-900/20 text-purple-300'
                        : slot?.status === 'paused' ? 'border-blue-500 bg-blue-900/20 text-blue-300'
                        : slot?.status === 'needs_attention' ? 'border-red-500 bg-red-900/20 text-red-300'
                        : on ? 'border-emerald-600 bg-emerald-900/20 text-emerald-300'
                        : 'border-gray-700 bg-gray-800 text-gray-500'
                    }`}>
                    {p.name}
                    {slot ? ` · ${recycleStatusLabel(slot.status)}` : on ? ' ✓' : ''}
                  </button>
                );
              })}
            </div>
          </div>

          {recycleStatus?.enabled && recycleStatus.slots.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left py-2 pr-2">Profile</th>
                    <th className="text-left py-2 pr-2">Status</th>
                    <th className="text-left py-2 pr-2">Cycle</th>
                    <th className="text-left py-2 pr-2">Next</th>
                    <th className="text-left py-2">Videos</th>
                  </tr>
                </thead>
                <tbody>
                  {recycleStatus.slots.filter(s => s.enabled).map(s => (
                    <tr key={s.slotId} className="border-b border-gray-800/50 text-gray-300">
                      <td className="py-2 pr-2 font-medium text-white">{s.profileName}</td>
                      <td className="py-2 pr-2">{recycleStatusLabel(s.status)}</td>
                      <td className="py-2 pr-2">#{s.cycleCount}</td>
                      <td className="py-2 pr-2">
                        {s.status === 'cooldown' ? formatCooldownRemaining(s.cooldownUntil, scheduleNow) : '—'}
                      </td>
                      <td className="py-2">{s.videoCount || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {recycleStatus.slots.some(s => s.lastError) && (
                <p className="text-xs text-red-400 mt-2">
                  Error: {recycleStatus.slots.filter(s => s.lastError).map(s => `${s.profileName}: ${s.lastError}`).join(' · ')}
                </p>
              )}
            </div>
          )}
        </div>

        {poolExhaustedNotice.length > 0 && (
          <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-3 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-yellow-400 text-sm font-medium">
                <AlertTriangle size={14} /> Shuffle notice ({poolExhaustedNotice.length})
              </div>
              <button type="button" onClick={() => setPoolExhaustedNotice([])} className="text-xs text-yellow-500 hover:text-yellow-300">Dismiss</button>
            </div>
            {poolExhaustedNotice.slice(0, 5).map((n, i) => <p key={i} className="text-xs text-yellow-300/70 ml-5">{n}</p>)}
            {poolExhaustedNotice.length > 5 && <p className="text-xs text-yellow-500/60 ml-5">+{poolExhaustedNotice.length - 5} more</p>}
          </div>
        )}

        {/* Playback & Assignment Mode */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-4">Playback & Assignment</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div>
              <label className="text-xs text-gray-400 block mb-2">Video assignment mode</label>
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => setSettings(s => normalizeShuffleSettings({ ...s, assignmentMode: 'unique' }))}
                  className={`flex-1 px-3 py-2 rounded-xl border text-xs font-medium transition-all ${settings.assignmentMode === 'unique' ? 'border-purple-500 bg-purple-900/30 text-purple-300' : 'border-gray-700 bg-gray-800 text-gray-400'}`}>
                  Unique per profile
                </button>
                <button type="button"
                  onClick={() => setSettings(s => normalizeShuffleSettings({ ...s, assignmentMode: 'same-all' }))}
                  className={`flex-1 px-3 py-2 rounded-xl border text-xs font-medium transition-all ${settings.assignmentMode === 'same-all' ? 'border-blue-500 bg-blue-900/30 text-blue-300' : 'border-gray-700 bg-gray-800 text-gray-400'}`}>
                  Same video — all profiles
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {settings.assignmentMode === 'same-all'
                  ? `Har enabled channel se 1 video — sab profiles par same (${channelConfigs.length} channel = ${channelConfigs.length} video). Har profile ka watch % alag.`
                  : 'Har profile ko alag video — same run me overlap nahi.'}
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-2">Watch % range (har profile alag %)</label>
              <div className="flex items-center gap-3">
                <input type="number" min={1} max={100} value={settings.watchTimeMin}
                  onChange={(e) => setSettings(s => ({ ...s, ...clampWatchRange(Number(e.target.value), s.watchTimeMax) }))}
                  className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                <span className="text-gray-500">to</span>
                <input type="number" min={1} max={100} value={settings.watchTimeMax}
                  onChange={(e) => setSettings(s => ({ ...s, ...clampWatchRange(s.watchTimeMin, Number(e.target.value)) }))}
                  className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                <span className="text-xs text-gray-500">% of video length</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">Example: 80–100% — Profile A 87%, Profile B 94% (alag timing)</p>
            </div>
            <div className="lg:col-span-2">
              <label className="text-xs text-gray-400 block mb-2">Video quality (agent 3-pass autoplay OFF verify karega)</label>
              <div className="flex flex-wrap gap-2">
                {QUALITY_OPTIONS.map(q => (
                  <button key={q} type="button"
                    onClick={() => setSettings(s => ({ ...s, videoQuality: q }))}
                    className={`px-3 py-1.5 rounded-lg border text-xs transition-all ${settings.videoQuality === q ? 'border-purple-500 bg-purple-900/30 text-purple-300' : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
            <div className="lg:col-span-2 border-t border-gray-800 pt-4">
              <label className="text-xs text-gray-400 block mb-2 font-medium text-amber-300/90">Ads Settings</label>
              <div className="grid sm:grid-cols-3 gap-4">
                <label className="flex items-center gap-2 text-sm text-gray-400">
                  <input type="checkbox" checked={settings.adSkipEnabled}
                    onChange={e => setSettings(s => ({ ...s, adSkipEnabled: e.target.checked }))}
                    className="rounded border-gray-600" />
                  Skip ads enabled
                </label>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Pre-roll: skip after (seconds)</label>
                  <input type="number" min={0} max={120} value={settings.adSkipAfterSec}
                    onChange={e => setSettings(s => ({ ...s, adSkipAfterSec: Math.max(0, Number(e.target.value) || 0) }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Mid-roll: wait before skip (seconds)</label>
                  <input type="number" min={0} max={120} value={settings.midRollAdWaitSec}
                    onChange={e => setSettings(s => ({ ...s, midRollAdWaitSec: Math.max(0, Number(e.target.value) || 0) }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                </div>
              </div>
              <p className="text-xs text-gray-600 mt-2">Pre-roll = video se pehle ad · Mid-roll = beech me ad · Skip button aane ke baad itni der wait</p>
            </div>
            {settings.assignmentMode === 'same-all' && channelConfigs.length > 0 && (
              <div className="lg:col-span-2 border-t border-gray-800 pt-4">
                <label className="text-xs text-gray-400 block mb-3">Same mode — video select karo (har channel ke liye)</label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {channelConfigs.map(config => {
                    const vids = getVideos(config.channelId);
                    const current = sameModePicks[config.channelId] || 'random';
                    return (
                      <div key={config.channelId} className="bg-gray-800 rounded-xl p-3 border border-gray-700">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-white text-xs font-medium">{config.channelName}</span>
                          <span className="text-gray-500 text-xs">{vids.length} videos</span>
                        </div>
                        <select
                          value={current}
                          onChange={(e) => setSameModePick(config.channelId, e.target.value)}
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white"
                        >
                          <option value="random">🎲 Random shuffle</option>
                          {vids.map(v => (
                            <option key={v.video_id} value={v.video_id}>{v.title}</option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Save as Schedule */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <h2 className="text-white font-semibold flex items-center gap-2">
                <Calendar size={16} className="text-purple-400" /> Save as Schedule
              </h2>
              <p className="text-xs text-gray-500 mt-1">Scheduler page par bhi dikhega · countdown min 1 minute</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs text-gray-400 block mb-1">Schedule name</label>
              <input
                value={scheduleDraft.name}
                onChange={(e) => setScheduleDraft(d => ({ ...d, name: e.target.value }))}
                placeholder={`Shuffle ${new Date().toLocaleDateString()}`}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Run mode</label>
              <div className="flex gap-2">
                {(['manual', 'countdown', 'scheduled'] as const).map(mode => (
                  <button key={mode} type="button"
                    onClick={() => setScheduleDraft(d => ({ ...d, runMode: mode }))}
                    className={`flex-1 px-2 py-2 rounded-lg border text-xs capitalize transition-all ${scheduleDraft.runMode === mode ? 'border-purple-500 bg-purple-900/30 text-purple-300' : 'border-gray-700 bg-gray-800 text-gray-400'}`}>
                    {mode === 'manual' ? 'Manual' : mode === 'countdown' ? 'Countdown' : 'Fixed time'}
                  </button>
                ))}
              </div>
            </div>
            {scheduleDraft.runMode === 'countdown' && (
              <div>
                <label className="text-xs text-gray-400 block mb-1">Countdown (minutes, min 1)</label>
                <input type="number" min={1} max={10080} value={scheduleDraft.countdownMinutes}
                  onChange={(e) => setScheduleDraft(d => ({ ...d, countdownMinutes: clampCountdownMinutes(Number(e.target.value)) }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
            )}
            {scheduleDraft.runMode === 'scheduled' && (
              <div>
                <label className="text-xs text-gray-400 block mb-1">Fixed run time</label>
                <input type="datetime-local"
                  value={scheduleDraft.scheduledTime ? new Date(scheduleDraft.scheduledTime).toISOString().slice(0, 16) : ''}
                  onChange={(e) => setScheduleDraft(d => ({ ...d, scheduledTime: new Date(e.target.value).getTime() }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
            )}
            <div>
              <label className="text-xs text-gray-400 block mb-1">Profile delay (sec)</label>
              <div className="flex gap-2">
                <input type="number" min={0} value={scheduleDraft.profileDelayMin}
                  onChange={(e) => setScheduleDraft(d => ({ ...d, profileDelayMin: Number(e.target.value) }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white" />
                <span className="text-gray-500 self-center">–</span>
                <input type="number" min={0} value={scheduleDraft.profileDelayMax}
                  onChange={(e) => setScheduleDraft(d => ({ ...d, profileDelayMax: Number(e.target.value) }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-1">Video delay (sec)</label>
              <div className="flex gap-2">
                <input type="number" min={0} value={scheduleDraft.tabDelayMin}
                  onChange={(e) => setScheduleDraft(d => ({ ...d, tabDelayMin: Number(e.target.value) }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white" />
                <span className="text-gray-500 self-center">–</span>
                <input type="number" min={0} value={scheduleDraft.tabDelayMax}
                  onChange={(e) => setScheduleDraft(d => ({ ...d, tabDelayMax: Number(e.target.value) }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white" />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            <button type="button" onClick={() => void handleSaveSchedule(false)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium">
              <Save size={14} /> Save Schedule
            </button>
            <button type="button" onClick={() => void handleSaveSchedule(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-yellow-700 hover:bg-yellow-600 text-white text-sm font-medium">
              <Timer size={14} /> Save + Start Countdown
            </button>
          </div>

          {pendingShuffleSchedules.length > 0 && (
            <div className="border-t border-gray-800 pt-4 space-y-2">
              <p className="text-xs text-gray-400 font-medium">Waiting schedules (from shuffle)</p>
              {pendingShuffleSchedules.map(s => {
                const cd = countdownRemaining(s, scheduleNow);
                return (
                  <div key={s.id} className="flex items-center justify-between gap-3 bg-gray-800 rounded-xl px-3 py-2 border border-gray-700">
                    <div className="min-w-0">
                      <p className="text-white text-xs font-medium truncate">{s.name}</p>
                      <p className="text-gray-500 text-xs">
                        {s.status === 'countdown' && (
                          <span className="text-yellow-400 font-mono">{formatCountdown(cd)}</span>
                        )}
                        {s.status === 'scheduled' && (
                          <span className="text-purple-400">{new Date(s.scheduledTime).toLocaleString()}</span>
                        )}
                        {' · '}{(s.selectedProfiles?.length ?? 0)} profiles
                      </p>
                    </div>
                    <button type="button" onClick={() => void handleCancelScheduleWait(s.id)}
                      className="text-xs text-gray-400 hover:text-red-400 flex-shrink-0">Cancel</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Profile Selection */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-white font-semibold">Select Profiles to Shuffle</h2>
            <div className="flex gap-2">
              <button onClick={() => setSelectedProfileIds(profiles.map(p => p.id))}
                className="text-xs text-purple-400 hover:text-purple-300">Select All</button>
              <button onClick={() => setSelectedProfileIds([])}
                className="text-xs text-gray-400 hover:text-gray-300">Deselect All</button>
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-3">Shuffle All = saare profiles. Selected = Shuffle Selected + Run filter.</p>
          <input value={profileSearch} onChange={(e) => { setProfileSearch(e.target.value); setProfilePage(1); }}
            placeholder="Search profiles…" className="w-full max-w-xs mb-3 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-white" />
          <div className="flex flex-wrap gap-2">
            {pagedProfiles.map(p => {
              const isSelected = selectedProfileIds.includes(p.id);
              return (
                <button key={p.id} onClick={() => setSelectedProfileIds(prev => prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${isSelected ? 'border-purple-500 bg-purple-900/30 text-purple-300' : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
                  <div className={`w-2 h-2 rounded-full ${isSelected ? 'bg-purple-400' : 'bg-gray-600'}`} />
                  {p.name}
                </button>
              );
            })}
          </div>
          {profilePages > 1 && (
            <div className="flex justify-center gap-2 mt-3 text-xs text-gray-500">
              <button type="button" disabled={profilePage <= 1} onClick={() => setProfilePage(p => p - 1)}>Prev</button>
              <span>{profilePage}/{profilePages}</span>
              <button type="button" disabled={profilePage >= profilePages} onClick={() => setProfilePage(p => p + 1)}>Next</button>
            </div>
          )}
        </div>

        {/* Channel Settings */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <h2 className="text-white font-semibold">Channel Settings</h2>
            <button type="button" onClick={selectFixedChannels} className="text-xs text-amber-400 flex items-center gap-1">
              <Pin size={12} /> Fixed channels
            </button>
          </div>
          {activeChannels.length === 0 ? (
            <p className="text-gray-500 text-sm">No active channels.</p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {activeChannels.map(ch => {
                const enabled = enabledIdSet.has(ch.id);
                const config = channelConfigs.find(c => c.channelId === ch.id);
                const total = getVideos(ch.id).length;
                return (
                  <div key={ch.id} className={`bg-gray-800 rounded-xl p-4 border ${enabled ? 'border-purple-700/50' : 'border-gray-700 opacity-60'}`}>
                    <label className="flex items-center gap-2 mb-3 cursor-pointer">
                      <input type="checkbox" checked={enabled} onChange={(e) => setChannelEnabled(ch.id, e.target.checked)} />
                      <span className="text-white text-sm font-medium">{ch.channel_name}</span>
                      <span className="text-xs text-gray-500 ml-auto">{total} videos</span>
                    </label>
                    {enabled && config && total > 0 && (
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <label className="text-xs text-gray-400">Min</label>
                          <input type="number" value={config.minPerProfile} min={0} max={total}
                            onChange={(e) => updateChannelConfig(ch.id, { minPerProfile: Number(e.target.value) })}
                            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                        </div>
                        <span className="text-gray-500 mt-4">—</span>
                        <div className="flex-1">
                          <label className="text-xs text-gray-400">Max</label>
                          <input type="number" value={config.maxPerProfile} min={0} max={total}
                            onChange={(e) => updateChannelConfig(ch.id, { maxPerProfile: Number(e.target.value) })}
                            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Profile Grid */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <h2 className="text-white font-semibold mb-4">Profile Assignments</h2>
          {assignments.length === 0 ? (
            <div className="text-center py-12 text-gray-600">
              <Shuffle size={40} className="mx-auto mb-3 opacity-30" />
              <p>Click "Shuffle All" to assign videos to profiles</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {assignments.map(a => {
                const profile = profiles.find(p => p.id === a.profileId);
                const historyCount = watchedCountsByProfile[a.profileId] ?? watchHistory.filter(h => h.profileId === a.profileId).length;
                const totalAvailable = channelConfigs.reduce((sum, c) => sum + c.totalVideos, 0);
                const watchPercent = totalAvailable > 0 ? Math.round((historyCount / totalAvailable) * 100) : 0;
                return (
                  <div key={a.profileId}
                    className="bg-gray-800 border border-gray-700 rounded-xl p-3 hover:border-purple-600/50 transition-all group">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-xs font-bold">{(profile?.name || 'P').charAt(0)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-xs font-medium truncate">{profile?.name || a.profileName}</p>
                        <p className="text-xs text-gray-500">{a.videos.length} assigned • {historyCount}/{totalAvailable} watched</p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); runSingleProfile(a.profileId); }}
                        className="bg-green-700 hover:bg-green-600 text-white px-2 py-1 rounded text-xs transition-all">
                        <Play size={10} className="inline" /> Run
                      </button>
                      <button type="button" onClick={() => reshuffleSingle(a.profileId)}
                        className="bg-purple-800 hover:bg-purple-700 text-white px-2 py-1 rounded text-xs">
                        <Shuffle size={10} className="inline" />
                      </button>
                      <button type="button" onClick={() => setDetailProfile(a.profileId)}
                        className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded text-xs transition-all">
                        <Eye size={11} className="inline mr-0.5" /> Detail
                      </button>
                      <button type="button" onClick={() => { void resetProfileHistory(a.profileId); }}
                        className="opacity-0 group-hover:opacity-100 text-xs text-gray-500 hover:text-red-400 transition-all" title="Clear local + server watch history">↺</button>
                    </div>
                    {/* Watch Progress Bar */}
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${watchPercent >= 80 ? 'bg-red-500' : watchPercent >= 50 ? 'bg-yellow-500' : 'bg-green-500'}`} style={{ width: `${watchPercent}%` }} />
                      </div>
                      <span className={`text-xs font-medium ${watchPercent >= 80 ? 'text-red-400' : watchPercent >= 50 ? 'text-yellow-400' : 'text-green-400'}`}>{watchPercent}%</span>
                    </div>
                    <div className="space-y-0.5">
                      {a.videos.slice(0, 4).map((v, i) => (
                        <div key={i} className="flex items-center gap-1 text-xs">
                          <span className="text-gray-600 w-3">{i + 1}.</span>
                          <span className="text-gray-400 truncate">{v.title}</span>
                        </div>
                      ))}
                      {a.videos.length > 4 && <p className="text-xs text-gray-600 ml-4">+{a.videos.length - 4} more</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Detail Modal */}
      {detailProfile && (() => {
        const detailAssignment = assignments.find(a => a.profileId === detailProfile);
        if (!detailAssignment) return null;
        return (
        <DetailModal
          assignment={detailAssignment}
          profile={profiles.find(p => p.id === detailProfile)}
          watchHistory={watchHistory.filter(h => h.profileId === detailProfile)}
          serverNormSet={new Set((serverHist[detailProfile] || []).map(r => r.norm))}
          mergedWatchedCount={watchedCountsByProfile[detailProfile] ?? watchHistory.filter(h => h.profileId === detailProfile).length}
          onRemove={(index) => removeVideoFromAssignment(detailProfile, index)}
          onClose={() => setDetailProfile(null)} />
        );
      })()}
    </div>
  );
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DETAIL MODAL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function DetailModal({ assignment, profile, watchHistory, serverNormSet, mergedWatchedCount, onRemove, onClose }: {
  assignment: ProfileAssignment;
  profile: Profile | undefined;
  watchHistory: WatchHistory[];
  serverNormSet: Set<string>;
  mergedWatchedCount: number;
  onRemove: (index: number) => void;
  onClose: () => void;
}) {
  if (!assignment) return null;

  // Group videos by channel
  const byChannel = new Map<string, typeof assignment.videos>();
  for (const v of assignment.videos) {
    const key = v.channelName;
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key)!.push(v);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-white font-bold text-lg">{profile?.name || 'Profile'}</h2>
            <p className="text-gray-500 text-xs">{assignment.videos.length} videos assigned • {mergedWatchedCount} watched (local + server)</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {[...byChannel.entries()].map(([channelName, videos]) => (
            <div key={channelName}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-5 h-5 rounded bg-red-700 flex items-center justify-center"><span className="text-white" style={{ fontSize: 8 }}>YT</span></div>
                <span className="text-white text-sm font-medium">{channelName}</span>
                <span className="text-xs text-gray-500">({videos.length} videos)</span>
              </div>
              <div className="space-y-1 ml-7">
                {videos.map((v, i) => {
                  const wasWatched =
                    watchHistory.some(h => h.videoId === v.videoId) ||
                    serverNormSet.has(normalizeWatchTitle(v.title));
                  return (
                    <div key={i} className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg ${wasWatched ? 'bg-green-900/20 border border-green-800/30' : 'bg-gray-800'}`}>
                      <span className="text-gray-500 w-4">{i + 1}.</span>
                      <span className={`flex-1 truncate ${wasWatched ? 'text-green-400' : 'text-gray-300'}`}>{v.title}</span>
                      {wasWatched && <CheckCircle size={10} className="text-green-400 flex-shrink-0" />}
                      <button type="button" onClick={() => onRemove(i)} className="text-red-400 text-xs">✕</button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="px-6 py-3 border-t border-gray-800">
          <button onClick={onClose} className="w-full bg-gray-800 hover:bg-gray-700 text-white py-2 rounded-xl text-sm font-medium transition-all">Close</button>
        </div>
      </div>
    </div>
  );
}
