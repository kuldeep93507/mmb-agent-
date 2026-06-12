import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Shuffle, Save, RotateCcw, Play, Eye, AlertTriangle, CheckCircle, Download, Upload, Pin, Square,
  Calendar, Timer, RefreshCw, Link,
} from 'lucide-react';
import type { Profile } from '../types';
import { inferProxyTypeFromProfile } from '../utils/profileAdapter';
import type { AutoSync, Channel, ChannelStatus, Video } from '../store/useChannelStore';
import { parseYoutubeVideoLines, isLikelyChannelUrl } from '../utils/youtubeUrlParse';
import { resolveChannelInput } from '../services/youtubeApi';
import LiveProgressPanel from './LiveProgressPanel';
import ProfilePickerPanel from './shared/ProfilePickerPanel';
import ChannelVideoPicker, { type PickableVideo } from './shared/ChannelVideoPicker';
import { pickableFromSameModePicks, sameModePicksFromPickable } from '../utils/pickableVideoAdapters';
import { backendFetch } from '../services/backendOrigin';
import { postActivityLog } from '../utils/logsApi';
import { profileConfigsForSchedule } from '../utils/profileConfigsForSchedule';
import { loadShuffleRunSettings } from '../utils/shuffleSettingsForSchedule';
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
import { useDisabledTrafficSources } from '../hooks/useDisabledTrafficSources';
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
import { AdControlSettings } from './shared/AdControlSettings';
import { mapRunSettingsToProfileFields } from '../utils/runSettingsShared';

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
  videos: {
    channelId: number;
    channelName: string;
    videoId: string;
    title: string;
    url: string;
    trafficSource?: string;
  }[];
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

type LiveWorkerRow = { profileId: string; status: string; currentVideo?: string };

const BUSY_WORKER_STATUSES = new Set([
  'watching', 'running', 'starting', 'connecting', 'waiting', 'queued', 'cooldown',
]);
const BUSY_RECYCLE_STATUSES = new Set(['running', 'recreating', 'starting']);

function getBusyProfileIds(
  workers: LiveWorkerRow[],
  recycle: RecycleStatus | null,
): Set<string> {
  const ids = new Set<string>();
  for (const w of workers) {
    if (w.profileId && BUSY_WORKER_STATUSES.has(w.status)) ids.add(w.profileId);
  }
  if (recycle?.enabled) {
    for (const slot of recycle.slots) {
      if (!slot.enabled) continue;
      if (BUSY_RECYCLE_STATUSES.has(slot.status) && slot.currentProfileId) {
        ids.add(slot.currentProfileId);
      }
    }
  }
  return ids;
}

interface VideoShufflePageProps {
  profiles: Profile[];
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
  addManualVideo?: (url: string, title: string) => Video | null;
  addChannel?: (channelId: string, autoSync?: AutoSync, status?: ChannelStatus) => Promise<Channel | null>;
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

/** Per-profile overrides — agar set hai to global setting override hogi, warna global use hogi */
interface PerProfileOverride {
  quality?: ShuffleVideoQuality;
  watchTimeMin?: number;   // exact % min
  watchTimeMax?: number;   // exact % max
  volumePct?: number;
  seekEnabled?: boolean;
  adSkip?: boolean;
  adClick?: boolean;
  captions?: boolean;
  like?: boolean;
  dislike?: boolean;
  subscribe?: boolean;
  bell?: boolean;
  comment?: boolean;
  commentLike?: boolean;
  descriptionLinks?: boolean;
}
type PlaybackSpeed = '0.75x' | '1x' | '1.25x' | '1.5x' | '1.75x' | '2x';
const SPEED_OPTIONS: PlaybackSpeed[] = ['0.75x', '1x', '1.25x', '1.5x', '1.75x', '2x'];
type TrafficSource =
  | 'direct'
  | 'search'
  | 'suggested'
  | 'homepage'
  | 'notification'
  | 'google'
  | 'bing'
  | 'channel_discovery'
  | 'random';

interface ActionToggles {
  like: boolean;
  dislike: boolean;
  subscribe: boolean;
  bell: boolean;
  comment: boolean;
  commentLike: boolean;
  descriptionLinks: boolean;
  scroll: boolean;
  qualityChange: boolean;
  captionsToggle: boolean;
}

const DEFAULT_ACTION_TOGGLES: ActionToggles = {
  like: true,
  dislike: false,
  subscribe: true,
  bell: false,
  comment: false,
  commentLike: false,
  descriptionLinks: false,
  scroll: true,
  qualityChange: true,
  captionsToggle: false,
};

function ToggleSwitch({ checked, onChange, id, label }: { checked: boolean; onChange: () => void; id: string; label: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition ${checked ? 'bg-emerald-500' : 'bg-slate-600'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

interface ShuffleSettings {
  channelConfigs: ChannelConfig[];
  enabledChannelIds: number[];
  assignmentMode: AssignmentMode;
  watchTimeMin: number;
  watchTimeMax: number;
  videoQuality: ShuffleVideoQuality;
  sameModeManualPicks: Record<number, string | string[]>;
  adSkipEnabled: boolean;
  adSkipAfterSec: number;
  adSkipMaxSec: number;
  midRollAdWaitSec: number;
  adClickEnabled: boolean;
  adClickDelayMinSec: number;
  adClickDelayMaxSec: number;
  adClickVisitSec: number;
  videosPerProfile: number;
  commentLikePct: number;
  // Human behaviour settings
  volumePct: number;              // legacy target / fallback
  volumeMin: number;
  volumeMax: number;
  seekEnabled: boolean;           // seek with j/l keys during watch
  seekDirection: 'forward' | 'backward' | 'both';
  descriptionExpand: boolean;     // expand video description
  descriptionLinks: boolean;      // click links in description
  descriptionLinkUrl: string;      // UI: which link to open (domain match in desc)
  descriptionLinkVisitSec: number;  // external site dwell time (default 120s)
  pauseProbability: number;       // legacy — sent as 0.05 when pause off
  uniqueTypingPersonality: boolean;
  naturalScrollCurves: boolean;
  playbackSpeed: PlaybackSpeed;
  captionsEnabled: boolean;
  trafficSource: TrafficSource;
  actionToggles: ActionToggles;
}

const DEFAULT_SHUFFLE_SETTINGS: ShuffleSettings = {
  channelConfigs: [],
  enabledChannelIds: [],
  assignmentMode: 'unique',
  watchTimeMin: 90,
  watchTimeMax: 100,
  videoQuality: 'auto',
  sameModeManualPicks: {},
  adSkipEnabled: true,
  adSkipAfterSec: 14,
  adSkipMaxSec: 60,
  midRollAdWaitSec: 10,
  adClickEnabled: false,
  adClickDelayMinSec: 10,
  adClickDelayMaxSec: 15,
  adClickVisitSec: 20,
  videosPerProfile: 1,
  commentLikePct: 100,
  volumePct: 75,
  volumeMin: 10,
  volumeMax: 100,
  seekEnabled: true,
  seekDirection: 'forward',
  descriptionExpand: true,
  descriptionLinks: false,
  descriptionLinkUrl: 'https://hamstercombocard.com',
  descriptionLinkVisitSec: 120,
  pauseProbability: 5,
  uniqueTypingPersonality: true,
  naturalScrollCurves: true,
  playbackSpeed: '1x',
  captionsEnabled: false,
  trafficSource: 'direct',
  actionToggles: { ...DEFAULT_ACTION_TOGGLES },
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
  const sameModeManualPicks: Record<number, string | string[]> = {};
  if (picksRaw && typeof picksRaw === 'object') {
    for (const [key, val] of Object.entries(picksRaw)) {
      if (typeof val === 'string') sameModeManualPicks[Number(key)] = val;
      else if (Array.isArray(val)) sameModeManualPicks[Number(key)] = val.filter(Boolean).map(String);
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
    adSkipAfterSec: Number.isFinite(Number(merged.adSkipAfterSec)) ? Math.max(5, Math.min(300, Number(merged.adSkipAfterSec))) : 14,
    adSkipMaxSec: Number.isFinite(Number(merged.adSkipMaxSec))
      ? Math.max(5, Math.min(300, Number(merged.adSkipMaxSec)))
      : Number.isFinite(Number(merged.adSkipAfterSec))
        ? Math.max(5, Math.min(300, Number(merged.adSkipAfterSec)))
        : 60,
    midRollAdWaitSec: Number.isFinite(Number(merged.midRollAdWaitSec)) ? Math.max(0, Math.min(120, Number(merged.midRollAdWaitSec))) : 10,
    adClickEnabled: merged.adClickEnabled === true,
    adClickDelayMinSec: Number.isFinite(Number(merged.adClickDelayMinSec)) ? Math.max(5, Number(merged.adClickDelayMinSec)) : 10,
    adClickDelayMaxSec: Number.isFinite(Number(merged.adClickDelayMaxSec)) ? Math.max(5, Number(merged.adClickDelayMaxSec)) : 15,
    adClickVisitSec: Number.isFinite(Number(merged.adClickVisitSec)) ? Math.max(1, Number(merged.adClickVisitSec)) : 20,
    videosPerProfile: Number.isFinite(Number(merged.videosPerProfile)) ? Math.max(1, Math.min(10, Number(merged.videosPerProfile))) : 1,
    commentLikePct: Number.isFinite(Number(merged.commentLikePct)) ? Math.max(1, Math.min(100, Number(merged.commentLikePct))) : 100,
    volumePct: Number.isFinite(Number(merged.volumePct)) ? Math.max(0, Math.min(100, Number(merged.volumePct))) : 75,
    volumeMin: Number.isFinite(Number(merged.volumeMin)) ? Math.max(0, Math.min(100, Number(merged.volumeMin))) : 10,
    volumeMax: Number.isFinite(Number(merged.volumeMax)) ? Math.max(0, Math.min(100, Number(merged.volumeMax))) : 100,
    seekEnabled: merged.seekEnabled !== false,
    seekDirection: (['forward', 'backward', 'both'] as const).includes(merged.seekDirection as 'forward' | 'backward' | 'both')
      ? (merged.seekDirection as 'forward' | 'backward' | 'both') : 'forward',
    descriptionExpand: merged.descriptionExpand !== false,
    descriptionLinks: merged.descriptionLinks === true,
    descriptionLinkUrl: typeof merged.descriptionLinkUrl === 'string' ? merged.descriptionLinkUrl.trim() : '',
    descriptionLinkVisitSec: Number.isFinite(Number(merged.descriptionLinkVisitSec))
      ? Math.max(30, Math.min(600, Number(merged.descriptionLinkVisitSec))) : 120,
    pauseProbability: Number.isFinite(Number(merged.pauseProbability)) ? Math.max(0, Math.min(100, Number(merged.pauseProbability))) : 5,
    uniqueTypingPersonality: merged.uniqueTypingPersonality !== false,
    naturalScrollCurves: merged.naturalScrollCurves !== false,
    playbackSpeed: SPEED_OPTIONS.includes(merged.playbackSpeed as PlaybackSpeed)
      ? (merged.playbackSpeed as PlaybackSpeed) : '1x',
    captionsEnabled: merged.captionsEnabled === true,
    trafficSource: ([
      'direct', 'search', 'suggested', 'homepage', 'notification', 'google', 'bing', 'channel_discovery', 'random',
    ] as const).includes(merged.trafficSource as TrafficSource)
      ? (merged.trafficSource as TrafficSource) : 'direct',
    actionToggles: {
      ...DEFAULT_ACTION_TOGGLES,
      ...(merged.actionToggles && typeof merged.actionToggles === 'object' ? merged.actionToggles : {}),
    },
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
export default function VideoShufflePage({
  profiles,
  channels,
  getVideos,
  addManualVideo,
  addChannel,
  onRefreshProfiles,
}: VideoShufflePageProps) {
  const { isEnabled: isLoopSrcOn, disabledList: loopDisabledSources } = useDisabledTrafficSources();
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
  const [perProfileOverrides, setPerProfileOverrides] = useState<Record<string, PerProfileOverride>>({});
  const [showPerProfilePanel, setShowPerProfilePanel] = useState(false);
  const [poolExhaustedNotice, setPoolExhaustedNotice] = useState<string[]>([]);
  const [pasteLinks, setPasteLinks] = useState('');
  const [pasteMsg, setPasteMsg] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [runStatus, setRunStatus] = useState<{ type: 'info' | 'warn' | 'error' | 'success'; text: string } | null>(null);
  const [serverSynced, setServerSynced] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(DEFAULT_SCHEDULE_DRAFT);
  const [shuffleSchedules, setShuffleSchedules] = useState<Schedule[]>(() => loadShuffleSchedules());
  const [scheduleNow, setScheduleNow] = useState(Date.now());
  const [recycleStatus, setRecycleStatus] = useState<RecycleStatus | null>(null);
  const [loopProfileIds, setLoopProfileIds] = useState<string[]>([]);
  const [activeLoopLimit, setActiveLoopLimit] = useState(20);
  const [cooldownMin, setCooldownMin] = useState(10);
  const [cooldownMax, setCooldownMax] = useState(30);
  const [loopBusy, setLoopBusy] = useState(false);
  // 24/7 Loop traffic source mix (% per source) — global default for all loop profiles
  const [loopSrcNotif, setLoopSrcNotif] = useState(20);
  const [loopSrcSearch, setLoopSrcSearch] = useState(30);
  const [loopSrcHome,   setLoopSrcHome]   = useState(20);
  const [loopSrcGoogle, setLoopSrcGoogle] = useState(12);
  const [loopSrcBing,   setLoopSrcBing]   = useState(8);
  const [loopSrcChannelDisc, setLoopSrcChannelDisc] = useState(10);
  const [liveWorkers, setLiveWorkers] = useState<LiveWorkerRow[]>([]);
  const stopPollRef = useRef<(() => void) | null>(null);
  const runSavedScheduleRef = useRef<(s: Schedule) => Promise<void>>(async () => {});
  const firedCountdownIds = useRef<Set<string>>(new Set());
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
        settings: {
          ...settings,
          // 24/7 loop traffic source mix — backend RecycleEngine reads these
          srcNotificationPct: loopSrcNotif,
          srcSearchPct:       loopSrcSearch,
          srcHomepagePct:     loopSrcHome,
          srcGooglePct:       loopSrcGoogle,
          srcBingPct:         loopSrcBing,
          srcChannelDiscPct:  loopSrcChannelDisc,
        } as unknown as Record<string, unknown>,
        recycleConfig: {
          enabled:             recycleStatus?.enabled ?? false,
          profileIds:          loopProfileIds,
          activeProfileLimit:  activeLoopLimit,
          cooldownMinMinutes:  cooldownMin,
          cooldownMaxMinutes:  cooldownMax,
          srcNotificationPct:  loopSrcNotif,
          srcSearchPct:        loopSrcSearch,
          srcHomepagePct:      loopSrcHome,
          srcGooglePct:        loopSrcGoogle,
          srcBingPct:          loopSrcBing,
          srcChannelDiscPct:   loopSrcChannelDisc,
        },
      });
    }, 800);
    return () => clearTimeout(t);
  }, [assignments, channelConfigs, settings, loopProfileIds, activeLoopLimit, cooldownMin, cooldownMax, loopSrcNotif, loopSrcSearch, loopSrcHome, loopSrcGoogle, loopSrcBing, loopSrcChannelDisc, serverSynced, recycleStatus?.enabled]);

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
      const rc = remote?.recycleConfig as { profileIds?: string[]; activeProfileLimit?: number; cooldownMinMinutes?: number; cooldownMaxMinutes?: number; srcNotificationPct?: number; srcSearchPct?: number; srcHomepagePct?: number; srcGooglePct?: number; srcBingPct?: number; srcChannelDiscPct?: number } | undefined;
      if (rc?.profileIds?.length) setLoopProfileIds(rc.profileIds.filter((id) => profiles.some((p) => p.id === id)));
      if (typeof rc?.activeProfileLimit === 'number') setActiveLoopLimit(Math.max(1, rc.activeProfileLimit));
      if (typeof rc?.cooldownMinMinutes === 'number') setCooldownMin(rc.cooldownMinMinutes);
      if (typeof rc?.cooldownMaxMinutes === 'number') setCooldownMax(rc.cooldownMaxMinutes);
      if (typeof rc?.srcNotificationPct === 'number') setLoopSrcNotif(rc.srcNotificationPct);
      if (typeof rc?.srcSearchPct === 'number') setLoopSrcSearch(rc.srcSearchPct);
      if (typeof rc?.srcHomepagePct === 'number') setLoopSrcHome(rc.srcHomepagePct);
      if (typeof rc?.srcGooglePct === 'number') setLoopSrcGoogle(rc.srcGooglePct);
      if (typeof rc?.srcBingPct   === 'number') setLoopSrcBing(rc.srcBingPct);
      if (typeof rc?.srcChannelDiscPct === 'number') setLoopSrcChannelDisc(rc.srcChannelDiscPct);
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

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await backendFetch('/api/workers');
        const data = await res.json();
        if (Array.isArray(data?.workers)) {
          setLiveWorkers(data.workers.map((w: LiveWorkerRow) => ({
            profileId: w.profileId,
            status: w.status,
            currentVideo: w.currentVideo,
          })));
        }
      } catch { /* ignore */ }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, []);

  const busyProfileIds = useMemo(
    () => getBusyProfileIds(liveWorkers, recycleStatus),
    [liveWorkers, recycleStatus],
  );

  useEffect(() => {
    setSelectedProfileIds(prev => prev.filter(id => !busyProfileIds.has(id)));
  }, [busyProfileIds]);

  const toggleLoopProfile = (id: string) => {
    setLoopProfileIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleStartLoop = async () => {
    if (loopProfileIds.length === 0) {
      setRunStatus({ type: 'warn', text: '24/7 loop: select at least 1 profile first' });
      return;
    }
    if (channelConfigs.length === 0) {
      setRunStatus({ type: 'warn', text: '24/7 loop: enable at least one channel first' });
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
      // Pass action toggles so 24/7 loop uses them
      actionToggles: settings.actionToggles,
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

    const normalizePick = (raw: string | string[] | undefined): string[] | null => {
      if (raw == null || raw === 'random') return null;
      if (Array.isArray(raw)) return raw.filter(Boolean);
      if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
      return null;
    };

    for (const config of channelConfigs) {
      const allChannelVideos = getVideos(config.channelId);
      if (allChannelVideos.length === 0) continue;

      const manualIds = normalizePick(
        sameModePicks[config.channelId] ?? sameModePicks[Number(config.channelId) as unknown as number],
      );
      if (manualIds && manualIds.length > 0) {
        let added = 0;
        for (const vid of manualIds) {
          const fixed = allChannelVideos.find(v => v.video_id === vid);
          if (fixed) {
            shared.push({
              channelId: config.channelId,
              channelName: config.channelName,
              videoId: fixed.video_id,
              title: fixed.title,
              url: fixed.url,
            });
            added++;
          }
        }
        if (added > 0) continue;
        notices.push(`"${config.channelName}": manual picks missing — random pick used`);
      }

      const min = Math.max(1, config.minPerProfile || 1);
      const max = Math.max(min, config.maxPerProfile || min);
      const count = Math.floor(Math.random() * (max - min + 1)) + min;

      const unwatched = allChannelVideos.filter(v =>
        !profiles.some(p => videoIsWatched(p.id, v, watchHistory, serverHist)),
      );
      if (unwatched.length === 0 && allChannelVideos.length > 0) {
        notices.push(`"${config.channelName}": pool exhausted — random repeat`);
      }
      const pickFrom = unwatched.length ? unwatched : allChannelVideos;
      const shuffled = [...pickFrom].sort(() => Math.random() - 0.5);
      const picked = shuffled.slice(0, Math.min(count, shuffled.length));
      for (const video of picked) {
        shared.push({
          channelId: config.channelId,
          channelName: config.channelName,
          videoId: video.video_id,
          title: video.title,
          url: video.url,
        });
      }
    }

    return shared;
  }, [channelConfigs, getVideos, profiles, watchHistory, serverHist, sameModePicks]);

  const shuffleAll = useCallback(() => {
    const notices: string[] = [];
    const availableProfiles = profiles.filter(p => !busyProfileIds.has(p.id));
    if (availableProfiles.length === 0) {
      setRunStatus({ type: 'warn', text: 'Sab profiles active hain — shuffle ke liye koi free profile nahi.' });
      return;
    }
    if (availableProfiles.length < profiles.length) {
      notices.push(`${profiles.length - availableProfiles.length} active profile(s) skipped`);
    }

    if (settings.assignmentMode === 'same-all') {
      const shared = pickSameVideosPerChannel(notices);
      const newAssignments = availableProfiles.map(profile => ({
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
    const newAssignments = availableProfiles.map(profile => ({
      profileId: profile.id,
      profileName: profile.name,
      videos: pickUniqueVideosForProfile(profile.id, profile.name, usedInThisRun, notices),
    }));

    setAssignments(newAssignments);
    setPoolExhaustedNotice(notices);
    setIsShuffled(true);
  }, [profiles, settings.assignmentMode, pickSameVideosPerChannel, pickUniqueVideosForProfile, busyProfileIds]);

  const shuffleSelected = useCallback(() => {
    const selectableIds = selectedProfileIds.filter(id => !busyProfileIds.has(id));
    if (selectableIds.length === 0) {
      setRunStatus({ type: 'warn', text: 'Selected profiles active hain — shuffle nahi ho sakta.' });
      return;
    }
    const notices: string[] = [];
    if (selectableIds.length < selectedProfileIds.length) {
      notices.push(`${selectedProfileIds.length - selectableIds.length} active profile(s) skipped`);
    }

    if (settings.assignmentMode === 'same-all') {
      const shared = pickSameVideosPerChannel(notices);
      const newAssignments = assignments.map(a =>
        selectableIds.includes(a.profileId)
          ? { ...a, videos: shared.map(v => ({ ...v })) }
          : a,
      );
      for (const profile of profiles.filter(p => selectableIds.includes(p.id) && !newAssignments.some(a => a.profileId === p.id))) {
        newAssignments.push({ profileId: profile.id, profileName: profile.name, videos: shared.map(v => ({ ...v })) });
      }
      setAssignments(newAssignments);
      setPoolExhaustedNotice(notices);
      setIsShuffled(true);
      return;
    }

    const existingOthers = assignments.filter(a => !selectableIds.includes(a.profileId));
    const usedInThisRun = new Set(existingOthers.flatMap(a => a.videos.map(v => v.videoId)));
    const newAssignments: ProfileAssignment[] = [...existingOthers];

    for (const profile of profiles.filter(p => selectableIds.includes(p.id))) {
      newAssignments.push({
        profileId: profile.id,
        profileName: profile.name,
        videos: pickUniqueVideosForProfile(profile.id, profile.name, usedInThisRun, notices),
      });
    }

    setAssignments(newAssignments);
    setPoolExhaustedNotice(notices);
    setIsShuffled(true);
  }, [selectedProfileIds, profiles, assignments, settings.assignmentMode, pickSameVideosPerChannel, pickUniqueVideosForProfile, busyProfileIds]);

  const reshuffleSingle = useCallback((profileId: string) => {
    if (busyProfileIds.has(profileId)) {
      setRunStatus({ type: 'warn', text: 'Ye profile abhi active hai — shuffle nahi ho sakta.' });
      return;
    }
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
  }, [assignments, channelConfigs, getVideos, watchHistory, serverHist, profiles, settings.assignmentMode, pickSameVideosPerChannel, busyProfileIds]);

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

  const handlePasteLinks = useCallback(async () => {
    const raw = pasteLinks.trim();
    if (!raw) {
      setPasteMsg('Paste a YouTube video or channel link first');
      return;
    }
    setPasteBusy(true);
    setPasteMsg('');
    let videosAdded = 0;
    let channelsAdded = 0;
    const enableIds: number[] = [];

    try {
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      for (const line of lines) {
        if (isLikelyChannelUrl(line) && addChannel) {
          const resolved = resolveChannelInput(line);
          if (!resolved) continue;
          let ch = await addChannel(resolved, 'manual', 'active');
          if (!ch) {
            ch = channels.find(c => c.channel_id === resolved) ?? null;
          }
          if (ch) {
            enableIds.push(ch.id);
            channelsAdded += 1;
          }
          continue;
        }

        for (const v of parseYoutubeVideoLines(line)) {
          const added = addManualVideo?.(v.url, v.title);
          if (added) {
            enableIds.push(added.channel_id);
            videosAdded += 1;
          } else {
            const manual = channels.find(c => c.channel_name === 'Manual Videos');
            const existing = manual ? getVideos(manual.id).find(x => x.video_id === v.videoId) : null;
            if (existing) {
              enableIds.push(existing.channel_id);
              videosAdded += 1;
            }
          }
        }
      }

      if (enableIds.length) {
        setSettings(prev => ({
          ...prev,
          enabledChannelIds: [...new Set([
            ...(prev.enabledChannelIds.length
              ? prev.enabledChannelIds
              : channels.filter(c => c.status === 'active').map(c => c.id)),
            ...enableIds,
          ])],
        }));
        setIsShuffled(false);
      }

      if (videosAdded > 0 || channelsAdded > 0) {
        setPasteLinks('');
        const parts: string[] = [];
        if (videosAdded) parts.push(`${videosAdded} video(s)`);
        if (channelsAdded) parts.push(`${channelsAdded} channel(s)`);
        setPasteMsg(`✅ Added ${parts.join(' + ')} — Shuffle All, then Run. Traffic: ${settings.trafficSource}`);
      } else {
        setPasteMsg('Valid YouTube link nahi mila');
      }
    } catch (e) {
      setPasteMsg(e instanceof Error ? e.message : 'Paste failed');
    } finally {
      setPasteBusy(false);
    }
  }, [pasteLinks, addChannel, addManualVideo, channels, getVideos, settings.trafficSource]);

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

  const applySameModeAssignments = useCallback((notices: string[] = []) => {
    const shared = pickSameVideosPerChannel(notices);
    setAssignments(prev => prev.map(a => ({ ...a, videos: shared.map(v => ({ ...v })) })));
    if (notices.length) setPoolExhaustedNotice(notices);
    setIsShuffled(true);
  }, [pickSameVideosPerChannel]);

  const buildSchedulePayload = (profilesToRun: ProfileAssignment[], scheduleId: string, name: string) => {
    const { watchTimeMin, watchTimeMax } = clampWatchRange(settings.watchTimeMin, settings.watchTimeMax);
    const maxVids = Math.max(1, settings.videosPerProfile);
    const mapVideos = (vids: ProfileAssignment['videos']) =>
      vids.slice(0, maxVids).map(v => toScheduleVideo(v));

    const rawConfigs = profileConfigsForSchedule(profilesToRun.map(a => a.profileId), profiles);
    const profileConfigs = rawConfigs.map(cfg => {
      const pov: PerProfileOverride = perProfileOverrides[cfg.profileId as string] || {};
      const pWatchMin = pov.watchTimeMin ?? watchTimeMin;
      const pWatchMax = pov.watchTimeMax ?? watchTimeMax;
      const mapped = mapRunSettingsToProfileFields({
        watchTimeMin: pWatchMin,
        watchTimeMax: Math.max(pWatchMin, pWatchMax),
        videoQuality: pov.quality ?? settings.videoQuality,
        adSkipEnabled: pov.adSkip ?? settings.adSkipEnabled,
        adSkipAfterSec: settings.adSkipMaxSec,
        adSkipMaxSec: settings.adSkipMaxSec,
        midRollAdWaitSec: settings.midRollAdWaitSec,
        adClickEnabled: pov.adClick ?? settings.adClickEnabled,
        adClickDelayMinSec: settings.adClickDelayMinSec,
        adClickDelayMaxSec: settings.adClickDelayMaxSec,
        adClickVisitSec: settings.adClickVisitSec,
        videosPerProfile: settings.videosPerProfile,
        volumePct: pov.volumePct ?? settings.volumePct,
        volumeMin: settings.volumeMin,
        volumeMax: settings.volumeMax,
        seekEnabled: pov.seekEnabled ?? settings.seekEnabled,
        seekDirection: settings.seekDirection,
        pauseProbability: settings.pauseProbability,
        uniqueTypingPersonality: settings.uniqueTypingPersonality,
        naturalScrollCurves: settings.naturalScrollCurves,
        playbackSpeed: settings.playbackSpeed,
        descriptionExpand: settings.descriptionExpand,
        trafficSource: settings.trafficSource,
        descriptionLinkUrl: settings.descriptionLinkUrl,
        descriptionLinkVisitSec: settings.descriptionLinkVisitSec,
        commentLikePct: settings.commentLikePct,
        actionToggles: {
          ...settings.actionToggles,
          like: pov.like ?? settings.actionToggles.like,
          dislike: pov.dislike ?? settings.actionToggles.dislike,
          subscribe: pov.subscribe ?? settings.actionToggles.subscribe,
          bell: pov.bell ?? settings.actionToggles.bell,
          comment: pov.comment ?? settings.actionToggles.comment,
          commentLike: pov.commentLike ?? settings.actionToggles.commentLike,
          descriptionLinks: pov.descriptionLinks ?? settings.actionToggles.descriptionLinks,
        },
        ...(settings.trafficSource === 'random' ? {
          srcNotificationPct: loopSrcNotif,
          srcSearchPct: loopSrcSearch,
          srcHomepagePct: loopSrcHome,
          srcGooglePct: loopSrcGoogle,
          srcBingPct: loopSrcBing,
          srcChannelDiscPct: loopSrcChannelDisc,
        } : {}),
      });
      return {
        ...cfg,
        ...mapped,
        humanEngagementEnabled: true,
        captionsToggle: Boolean(pov.captions ?? settings.captionsEnabled) || settings.actionToggles.captionsToggle,
        captionsEnabled: Boolean(pov.captions ?? settings.captionsEnabled) || settings.actionToggles.captionsToggle,
      };
    });

    const sameForAll = settings.assignmentMode === 'same-all' && profilesToRun[0]
      ? channelConfigs.map(config => ({
          channelId: config.channelId,
          channelName: config.channelName,
          videos: mapVideos(profilesToRun[0].videos.filter(v => v.channelId === config.channelId)),
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
              videos: mapVideos(a.videos.filter(v => v.channelId === config.channelId)),
            })),
          })),
      profileConfigs,
      profileDelayMin: scheduleDraft.profileDelayMin,
      profileDelayMax: scheduleDraft.profileDelayMax,
      tabDelayMin: scheduleDraft.tabDelayMin,
      tabDelayMax: scheduleDraft.tabDelayMax,
      commentText: pickRandomComment(),
      runMode: scheduleDraft.runMode,
      // Gap 2: Organic mode — Orchestrator 24h weighted scheduling (from ShuffleRunSettings)
      organicMode: loadShuffleRunSettings().organicMode,
      // Gap 3: ownChannelNames from active channels (for sidebar/related video matching)
      ownChannelNames: channels
        .filter(c => c.status === 'active')
        .map(c => c.channel_name),
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
    if (busyProfileIds.has(profileId)) {
      setRunStatus({ type: 'warn', text: 'Ye profile abhi active hai — run nahi ho sakta.' });
      return;
    }
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
    const profilesToRun = getProfilesToRun().filter(a => !busyProfileIds.has(a.profileId));

    if (profilesToRun.length === 0) {
      setRunStatus({ type: 'warn', text: busyProfileIds.size > 0
        ? 'Selected profiles active hain — run ke liye koi free profile nahi.'
        : 'Shuffle karo pehle — koi assignment nahi.' });
      return;
    }

    const skippedBusy = getProfilesToRun().length - profilesToRun.length;
    const conc = await fetchConcurrency();
    const mlxCount = profilesToRun.filter(a => profiles.find(p => p.id === a.profileId)?.browserType === 'multilogin').length;
    const runHints: string[] = [];
    if (skippedBusy > 0) {
      runHints.push(`${skippedBusy} active profile(s) skipped`);
    }
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

  const activeChannels = useMemo(() => channels.filter(c => c.status === 'active'), [channels]);
  const enabledIdSet = useMemo(() => {
    const ids = settings.enabledChannelIds.length ? settings.enabledChannelIds : activeChannels.map(c => c.id);
    return new Set(ids);
  }, [settings.enabledChannelIds, activeChannels]);

  const removeVideoFromAssignment = (profileId: string, videoId: string) => {
    setAssignments(prev => prev.map(a => a.profileId === profileId ? { ...a, videos: a.videos.filter(v => v.videoId !== videoId) } : a));
    setIsShuffled(true);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div style={{
              width: 44, height: 44, borderRadius: 13, flexShrink: 0,
              background: 'var(--mmb-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 22px var(--mmb-accent-glow)',
            }}>
              <Shuffle size={22} color="#fff" />
            </div>
            <div>
              <h1 className="text-2xl font-bold"><span className="mmb-gradient-text">Video Shuffle</span></h1>
              <p className="text-gray-500 text-sm mt-0.5">
                Kisi bhi channel ka link paste karo · traffic {settings.trafficSource} · watch {settings.watchTimeMin}–{settings.watchTimeMax}%
              </p>
              <button type="button" onClick={() => { void refreshShuffleHistoryFromBackend(); }}
                className="mt-1 text-xs text-purple-400 hover:text-purple-300 underline-offset-2 hover:underline">
                Refresh server watch history
              </button>
            </div>
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
                className="flex items-center gap-2 px-5 py-2 rounded-xl disabled:opacity-40 text-white text-sm font-bold transition-all hover:scale-[1.02] active:scale-95"
                style={{ background: 'var(--mmb-grad)', boxShadow: '0 8px 22px var(--mmb-accent-glow)', border: 'none' }}>
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

        {/* Paste any YouTube link — any channel */}
        <div className="mb-4 rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-emerald-300 flex items-center gap-2">
              <Link size={14} /> Paste link — kisi bhi channel ka video / channel
            </h3>
            <span className="text-[10px] text-gray-500">
              Traffic ab: <span className="text-emerald-400 font-mono">{settings.trafficSource}</span> (neeche change karo)
            </span>
          </div>
          <textarea
            value={pasteLinks}
            onChange={e => setPasteLinks(e.target.value)}
            placeholder={'https://youtube.com/watch?v=...\nhttps://youtube.com/@ChannelName'}
            rows={2}
            className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-emerald-600/50 resize-y"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => void handlePasteLinks()}
              disabled={pasteBusy || !pasteLinks.trim()}
              className="px-3 py-1.5 rounded-lg bg-emerald-700/50 border border-emerald-600/40 text-emerald-200 text-xs font-medium disabled:opacity-40 hover:bg-emerald-700/70"
            >
              {pasteBusy ? 'Adding…' : 'Add to pool'}
            </button>
            <span className="text-[10px] text-gray-500">
              Search · Google · Bing · Channel page · Direct — sab traffic source buttons neeche hain
            </span>
            {pasteMsg && <span className="text-[10px] text-gray-400">{pasteMsg}</span>}
          </div>
        </div>

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
              ? recycleStatus.slots.filter(s => s.enabled && s.currentProfileId).map(s => s.currentProfileId as string)
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
                Kitne profiles 24/7 loop me chalenge (max parallel cap: {concurrency?.limit ?? 20}). Loop band karke badlo, phir dubara start.
              </p>
            </div>
          </div>

          {/* ── Traffic Source Mix (24/7 loop) ─────────────────────────────── */}
          <div className="mb-4 bg-gray-800/30 border border-gray-700/50 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs text-gray-300 font-semibold">🌐 Traffic Source Mix (% — must total 100)</label>
              <span className="text-[10px] text-gray-500">
                Direct = {Math.max(0, 100 - loopSrcNotif - loopSrcSearch - loopSrcHome - loopSrcGoogle - loopSrcBing - loopSrcChannelDisc)}%
              </span>
            </div>
            {loopDisabledSources.length > 0 && (
              <p className="text-[10px] text-amber-400/90 mb-2">Settings me band sources hide — backend unhe skip karega.</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {isLoopSrcOn('notification') && <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-gray-400">🔔 Notification</span>
                  <span className="text-[10px] text-yellow-400 font-mono">{loopSrcNotif}%</span>
                </div>
                <input type="range" min={0} max={100} step={5} value={loopSrcNotif}
                  disabled={!!recycleStatus?.enabled}
                  onChange={(e) => setLoopSrcNotif(Number(e.target.value))}
                  className="w-full accent-yellow-500 disabled:opacity-50" />
              </div>}
              {isLoopSrcOn('search') && <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-gray-400">🔍 Search</span>
                  <span className="text-[10px] text-blue-400 font-mono">{loopSrcSearch}%</span>
                </div>
                <input type="range" min={0} max={100} step={5} value={loopSrcSearch}
                  disabled={!!recycleStatus?.enabled}
                  onChange={(e) => setLoopSrcSearch(Number(e.target.value))}
                  className="w-full accent-blue-500 disabled:opacity-50" />
              </div>}
              {isLoopSrcOn('homepage') && <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-gray-400">🏠 Homepage</span>
                  <span className="text-[10px] text-green-400 font-mono">{loopSrcHome}%</span>
                </div>
                <input type="range" min={0} max={100} step={5} value={loopSrcHome}
                  disabled={!!recycleStatus?.enabled}
                  onChange={(e) => setLoopSrcHome(Number(e.target.value))}
                  className="w-full accent-green-500 disabled:opacity-50" />
              </div>}
              {/* Google Search */}
              {isLoopSrcOn('google') && <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 w-32 shrink-0">🌐 Google</span>
                <input
                  type="range" min={0} max={60} value={loopSrcGoogle}
                  onChange={e => setLoopSrcGoogle(Number(e.target.value))}
                  className="flex-1 h-1.5 accent-red-400"
                />
                <span className="text-xs text-white w-8 text-right">{loopSrcGoogle}%</span>
              </div>}
              {/* Bing Search */}
              {isLoopSrcOn('bing') && <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 w-32 shrink-0">🔷 Bing</span>
                <input
                  type="range" min={0} max={40} value={loopSrcBing}
                  onChange={e => setLoopSrcBing(Number(e.target.value))}
                  className="flex-1 h-1.5 accent-purple-400"
                />
                <span className="text-xs text-white w-8 text-right">{loopSrcBing}%</span>
              </div>}
              {isLoopSrcOn('channel_discovery') && <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 w-32 shrink-0">📺 Channel Disc</span>
                <input
                  type="range" min={0} max={40} value={loopSrcChannelDisc}
                  disabled={!!recycleStatus?.enabled}
                  onChange={e => setLoopSrcChannelDisc(Number(e.target.value))}
                  className="flex-1 h-1.5 accent-orange-400 disabled:opacity-50"
                />
                <span className="text-xs text-white w-8 text-right">{loopSrcChannelDisc}%</span>
              </div>}
            </div>
            {(loopSrcNotif + loopSrcSearch + loopSrcHome + loopSrcGoogle + loopSrcBing + loopSrcChannelDisc) > 100 && (
              <p className="text-[10px] text-yellow-400 mt-2 flex items-center gap-1">
                <AlertTriangle size={10} /> Total &gt; 100% — Direct will be 0%
              </p>
            )}
            <p className="text-[10px] text-gray-600 mt-2">
              {settings.trafficSource === 'random'
                ? '🎲 Random: har profile ke liye Traffic Source Mix % se alag source pick hoga (neeche sliders).'
                : 'Loop ke har cycle me random source pick hoga is mix ke hisaab se. Per-profile override profile settings me set karo.'}
            </p>
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
                const slot = recycleStatus?.slots?.find(s => s.currentProfileId === p.id || s.profileName === p.name);
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
                  ? `Har channel se min–max videos (channel config) — sab profiles par same list. Manual pick = multiple videos add karo.`
                  : 'Har profile ko alag video — same run me overlap nahi.'}
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-400 block mb-2">Watch % (har profile ko min–max ke beech random %)</label>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Min</span>
                  <input type="number" min={1} max={100} value={settings.watchTimeMin}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 90)));
                      setSettings(s => ({ ...s, ...clampWatchRange(v, s.watchTimeMax) }));
                    }}
                    className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                </div>
                <span className="text-xs text-gray-600">—</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Max</span>
                  <input type="number" min={1} max={100} value={settings.watchTimeMax}
                    onChange={(e) => {
                      const v = Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 100)));
                      setSettings(s => ({ ...s, ...clampWatchRange(s.watchTimeMin, v) }));
                    }}
                    className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm" />
                </div>
                <span className="text-xs text-gray-500">% of video length</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">Example: 90–100 = har profile alag % (90, 91, … 100). Shuffle/24-7 run me profile card ka watch % use nahi hota.</p>
            </div>
            <div className="lg:col-span-2">
              <label className="text-xs text-gray-400 block mb-2">Video quality (changes in first 15s of playback)</label>
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

            {/* Playback speed */}
            <div className="lg:col-span-2">
              <label className="text-xs text-gray-400 block mb-2">Playback speed</label>
              <div className="inline-flex flex-wrap gap-1 rounded-lg border border-slate-700 p-1 bg-slate-800/80">
                {SPEED_OPTIONS.map(speed => (
                  <button key={speed} type="button"
                    aria-label={`Set playback speed to ${speed}`}
                    onClick={() => setSettings(s => ({ ...s, playbackSpeed: speed }))}
                    className={`px-3 py-1 rounded text-xs transition ${settings.playbackSpeed === speed ? 'bg-emerald-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}>
                    {speed}
                  </button>
                ))}
              </div>
            </div>

            {/* Captions + Traffic source */}
            <div className="flex items-center justify-between bg-gray-800/60 px-3 py-2 rounded-xl border border-gray-700/50">
              <label htmlFor="captions-toggle" className="text-xs text-gray-300">Captions (CC)</label>
              <ToggleSwitch
                id="captions-toggle"
                label="Toggle captions"
                checked={settings.captionsEnabled}
                onChange={() => setSettings(s => ({ ...s, captionsEnabled: !s.captionsEnabled }))}
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs text-gray-400 block">Traffic source</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([
                  { id: 'random' as TrafficSource, label: '🎲 Random', desc: 'Har profile/video — mix % se alag source' },
                  { id: 'direct' as TrafficSource, label: '🔗 Direct URL', desc: 'Open video URL directly' },
                  { id: 'search' as TrafficSource, label: '🔍 YT Search', desc: 'YouTube search → click video' },
                  { id: 'channel_discovery' as TrafficSource, label: '📺 Channel Disc', desc: 'Search → channel page → video' },
                  { id: 'google' as TrafficSource, label: '🌐 Google', desc: 'Google search → YouTube link' },
                  { id: 'bing' as TrafficSource, label: '🔷 Bing', desc: 'Bing search → YouTube link' },
                  { id: 'homepage' as TrafficSource, label: '🏠 Homepage', desc: 'Browse YouTube home feed' },
                  { id: 'notification' as TrafficSource, label: '🔔 Notification', desc: 'Open from notifications' },
                  { id: 'suggested' as TrafficSource, label: '💡 Suggested', desc: 'Sidebar / endscreen click' },
                ]).map(source => (
                  <button key={source.id} type="button"
                    aria-label={source.desc}
                    title={source.desc}
                    onClick={() => setSettings(s => ({ ...s, trafficSource: source.id }))}
                    className={`p-3 rounded-lg border-2 transition text-left ${settings.trafficSource === source.id ? 'border-emerald-500 bg-emerald-500/10' : 'border-gray-700 hover:border-gray-500'}`}>
                    <div className="font-medium text-xs text-white">{source.label}</div>
                    <div className="text-[10px] text-gray-500 mt-1">{source.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Engagement action toggles (replace probability sliders) */}
            <div className="lg:col-span-2 space-y-3 p-4 bg-slate-800/50 rounded-lg border border-gray-700/50">
              <h3 className="font-semibold text-xs text-white">Engagement actions</h3>
              {([
                { key: 'like' as const, label: '👍 Like video' },
                { key: 'dislike' as const, label: '👎 Dislike' },
                { key: 'subscribe' as const, label: '📺 Subscribe' },
                { key: 'bell' as const, label: '🔔 Bell notification' },
                { key: 'comment' as const, label: '💬 Comment' },
                { key: 'commentLike' as const, label: '💬👍 Comment like' },
                { key: 'descriptionLinks' as const, label: '🔗 Desc links' },
                { key: 'scroll' as const, label: '📜 Scroll activity' },
                { key: 'qualityChange' as const, label: '⚙️ Change quality' },
                { key: 'captionsToggle' as const, label: '📝 Toggle captions' },
              ]).map(action => (
                <div key={action.key} className="flex items-center justify-between">
                  <label htmlFor={`${action.key}-toggle`} className="text-xs text-gray-300">{action.label}</label>
                  <ToggleSwitch
                    id={`${action.key}-toggle`}
                    label={action.label}
                    checked={settings.actionToggles[action.key]}
                    onChange={() => setSettings(s => ({
                      ...s,
                      actionToggles: { ...s.actionToggles, [action.key]: !s.actionToggles[action.key] },
                    }))}
                  />
                </div>
              ))}
              {settings.actionToggles.commentLike && (
                <div className="flex items-center gap-3 pt-1 border-t border-gray-700/50">
                  <span className="text-xs text-gray-400 flex-1">💬👍 Comment like chance %</span>
                  <input type="range" min={1} max={100} step={5} value={settings.commentLikePct}
                    onChange={e => setSettings(s => ({ ...s, commentLikePct: Number(e.target.value) }))}
                    className="w-28 accent-purple-500" />
                  <span className="text-purple-300 text-xs font-mono w-8">{settings.commentLikePct}%</span>
                </div>
              )}
            </div>
            <div className="lg:col-span-2 border-t border-gray-800 pt-4 space-y-3">
              <label className="text-xs text-gray-400 block font-medium text-amber-300/90">Ads + multi-video</label>
              <div className="max-w-xs">
                <label className="text-xs text-gray-500 block mb-1">Videos per profile (sequential)</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.videosPerProfile}
                  onChange={e => setSettings(s => ({
                    ...s,
                    videosPerProfile: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
                  }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm"
                />
              </div>
              <AdControlSettings
                values={{
                  adSkipEnabled: settings.adSkipEnabled,
                  adSkipMaxSec: settings.adSkipMaxSec,
                  midRollAdWaitSec: settings.midRollAdWaitSec,
                  adClickEnabled: settings.adClickEnabled,
                  adClickDelayMinSec: settings.adClickDelayMinSec,
                  adClickDelayMaxSec: settings.adClickDelayMaxSec,
                  adClickVisitSec: settings.adClickVisitSec,
                }}
                onChange={(p) => setSettings(s => ({
                  ...s,
                  ...p,
                  adSkipAfterSec: p.adSkipMaxSec ?? s.adSkipMaxSec,
                }))}
              />
            </div>

            {/* ── Human Behaviour Settings ── */}
            <div className="lg:col-span-2 border-t border-gray-800 pt-4 space-y-4">
              <label className="text-xs text-gray-400 block mb-1 font-medium text-purple-300/90">Human Behaviour Settings</label>

              {/* Volume range */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 w-40 flex-shrink-0">🔊 Volume min</span>
                <input type="range" min={0} max={100} step={5} value={settings.volumeMin}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setSettings(s => ({ ...s, volumeMin: v, volumeMax: Math.max(v, s.volumeMax) }));
                  }}
                  className="flex-1 accent-teal-500" />
                <span className="text-teal-300 text-xs font-mono w-10 text-right">{settings.volumeMin}%</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-400 w-40 flex-shrink-0">🔊 Volume max</span>
                <input type="range" min={0} max={100} step={5} value={settings.volumeMax}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setSettings(s => ({ ...s, volumeMax: v, volumeMin: Math.min(v, s.volumeMin) }));
                  }}
                  className="flex-1 accent-teal-500" />
                <span className="text-teal-300 text-xs font-mono w-10 text-right">{settings.volumeMax}%</span>
              </div>

              {/* Seek */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-gray-400">⏩ Seek (j/l keys)</label>
                  <button
                    onClick={() => setSettings(s => ({ ...s, seekEnabled: !s.seekEnabled }))}
                    className={`relative w-10 h-5 rounded-full transition-all ${settings.seekEnabled ? 'bg-cyan-500' : 'bg-gray-700'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${settings.seekEnabled ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </div>
                {settings.seekEnabled && (
                  <div className="flex gap-2 pl-4">
                    {(['forward', 'backward', 'both'] as const).map(d => (
                      <button key={d}
                        onClick={() => setSettings(s => ({ ...s, seekDirection: d }))}
                        className={`px-2.5 py-1 rounded-lg text-[10px] border transition-all ${settings.seekDirection === d ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300' : 'border-gray-700 bg-gray-800 text-gray-500 hover:border-gray-600'}`}>
                        {d === 'forward' ? '→ Forward' : d === 'backward' ? '← Backward' : '↔ Both'}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Description expand + links */}
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex items-center justify-between text-xs text-gray-400 bg-gray-800/60 px-3 py-2 rounded-xl border border-gray-700/50">
                  <span>📖 Description expand</span>
                  <button
                    onClick={() => setSettings(s => ({ ...s, descriptionExpand: !s.descriptionExpand }))}
                    className={`relative w-10 h-5 rounded-full transition-all flex-shrink-0 ${settings.descriptionExpand ? 'bg-amber-500' : 'bg-gray-700'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${settings.descriptionExpand ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </label>
                <div className="relative flex items-center justify-between text-xs text-gray-400 bg-gray-800/60 px-3 py-2 rounded-xl border border-orange-500/30 opacity-90">
                  <div className="pr-2">
                    <span className="text-white/90">🔗 Description links open</span>
                    <span className="ml-2 px-1.5 py-0.5 rounded-md bg-orange-500/20 text-orange-300 text-[9px] font-semibold uppercase tracking-wide">Coming Soon</span>
                  </div>
                  <button
                    type="button"
                    disabled
                    title="Coming soon — description link click abhi fix ho raha hai"
                    className="relative w-10 h-5 rounded-full flex-shrink-0 bg-gray-700 cursor-not-allowed opacity-50"
                  >
                    <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow" />
                  </button>
                </div>
              </div>

              {settings.actionToggles.descriptionLinks && (
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-xs text-gray-400 bg-gray-800/60 px-3 py-2 rounded-xl border border-gray-700/50 block">
                    <span className="block mb-1 text-white/90">Target link URL (description mein ye link honi chahiye)</span>
                    <input
                      type="url"
                      value={settings.descriptionLinkUrl}
                      onChange={e => setSettings(s => ({ ...s, descriptionLinkUrl: e.target.value.trim() }))}
                      placeholder="https://hamstercombocard.com"
                      className="w-full mt-1 px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-white text-xs"
                    />
                  </label>
                  <label className="text-xs text-gray-400 bg-gray-800/60 px-3 py-2 rounded-xl border border-gray-700/50 block">
                    <span className="block mb-1 text-white/90">External site visit (seconds)</span>
                    <input
                      type="number"
                      min={30}
                      max={600}
                      value={settings.descriptionLinkVisitSec}
                      onChange={e => setSettings(s => ({
                        ...s,
                        descriptionLinkVisitSec: Math.max(30, Math.min(600, Number(e.target.value) || 120)),
                      }))}
                      className="w-full mt-1 px-2 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-white text-xs"
                    />
                    <p className="text-[10px] text-gray-500 mt-1">YT video link ho to poora watch hoga</p>
                  </label>
                </div>
              )}

              {/* Typing personality + Scroll curves */}
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex items-center justify-between text-xs text-gray-400 bg-gray-800/60 px-3 py-2 rounded-xl border border-gray-700/50">
                  <div>
                    <span className="text-white/90">⌨️ Unique typing personality</span>
                    <p className="text-[10px] text-gray-500 mt-0.5">Each profile+session = unique speed &amp; typo rate</p>
                  </div>
                  <button
                    onClick={() => setSettings(s => ({ ...s, uniqueTypingPersonality: !s.uniqueTypingPersonality }))}
                    className={`relative w-10 h-5 rounded-full transition-all flex-shrink-0 ml-3 ${settings.uniqueTypingPersonality ? 'bg-purple-500' : 'bg-gray-700'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${settings.uniqueTypingPersonality ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </label>
                <label className="flex items-center justify-between text-xs text-gray-400 bg-gray-800/60 px-3 py-2 rounded-xl border border-gray-700/50">
                  <div>
                    <span className="text-white/90">🌊 Natural scroll curves</span>
                    <p className="text-[10px] text-gray-500 mt-0.5">Smooth eased scroll — not instant jumps</p>
                  </div>
                  <button
                    onClick={() => setSettings(s => ({ ...s, naturalScrollCurves: !s.naturalScrollCurves }))}
                    className={`relative w-10 h-5 rounded-full transition-all flex-shrink-0 ml-3 ${settings.naturalScrollCurves ? 'bg-blue-500' : 'bg-gray-700'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${settings.naturalScrollCurves ? 'left-5' : 'left-0.5'}`} />
                  </button>
                </label>
              </div>

              {/* Autoplay status — always hardlocked OFF */}
              <div className="flex items-center gap-2 px-3 py-2 bg-green-900/20 border border-green-700/30 rounded-xl text-xs text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                Autoplay HARD-OFF — always locked, cannot be changed (required for view authenticity)
              </div>
            </div>

            {settings.assignmentMode === 'same-all' && channelConfigs.length > 0 && (
              <div className="lg:col-span-2 border-t border-gray-800 pt-4 space-y-3">
                <label className="text-xs text-gray-400 block">Same mode — multi-channel se fixed videos pick karo (khali = random min–max)</label>
                <ChannelVideoPicker
                  channels={channels}
                  getVideos={getVideos}
                  videos={pickableFromSameModePicks(sameModePicks, channels, getVideos)}
                  onChange={(picked: PickableVideo[]) => {
                    const grouped = sameModePicksFromPickable(picked);
                    setSettings(s => {
                      const prev = s.sameModeManualPicks ?? {};
                      const next: Record<number, string | string[]> = { ...prev };
                      for (const config of channelConfigs) {
                        const cid = config.channelId;
                        if (grouped[cid]?.length) next[cid] = grouped[cid];
                        else if (Array.isArray(prev[cid]) || (typeof prev[cid] === 'string' && prev[cid] !== 'random')) {
                          next[cid] = 'random';
                        }
                      }
                      for (const [cidStr, ids] of Object.entries(grouped)) {
                        if (ids.length) next[Number(cidStr)] = ids;
                      }
                      return { ...s, sameModeManualPicks: next };
                    });
                    if (settings.assignmentMode === 'same-all') applySameModeAssignments([]);
                  }}
                />
                <p className="text-[10px] text-gray-600">Har enabled channel ka min–max random tab use hoga jab tak yahan fixed video pick nahi karte.</p>
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
          <h2 className="text-white font-semibold mb-2">Select Profiles to Shuffle</h2>
          {busyProfileIds.size > 0 && (
            <div className="mb-3 flex items-center gap-2 text-xs rounded-lg px-3 py-2 border border-green-700/30 bg-green-900/20 text-green-300">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              {busyProfileIds.size} profile(s) abhi active — select nahi ho sakte
            </div>
          )}
          <p className="text-xs text-gray-500 mb-3">Shuffle All = saare free profiles · Selected = filter for Run / Shuffle Selected</p>
          <ProfilePickerPanel
            profiles={profiles}
            selectedIds={selectedProfileIds}
            onChange={setSelectedProfileIds}
            disabledIds={[...busyProfileIds]}
            disabledHint="Active"
            maxHeight="min(420px, 50vh)"
          />
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
                const isActive = busyProfileIds.has(a.profileId);
                const historyCount = watchedCountsByProfile[a.profileId] ?? watchHistory.filter(h => h.profileId === a.profileId).length;
                const totalAvailable = channelConfigs.reduce((sum, c) => sum + c.totalVideos, 0);
                const watchPercent = totalAvailable > 0 ? Math.round((historyCount / totalAvailable) * 100) : 0;
                return (
                  <div key={a.profileId}
                    className={`bg-gray-800 border rounded-xl p-3 transition-all group ${
                      isActive ? 'border-green-600/50 opacity-80' : 'border-gray-700 hover:border-purple-600/50'
                    }`}>
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        isActive ? 'bg-green-700' : 'bg-red-600'
                      }`}>{(profile?.name || 'P').charAt(0)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-xs font-medium truncate">{profile?.name || a.profileName}</p>
                        <p className="text-xs text-gray-500">
                          {isActive ? 'Active — shuffle/run band' : `${a.videos.length} assigned • ${historyCount}/${totalAvailable} watched`}
                        </p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); void runSingleProfile(a.profileId); }}
                        disabled={isActive}
                        className="bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-2 py-1 rounded text-xs transition-all">
                        <Play size={10} className="inline" /> Run
                      </button>
                      <button type="button" onClick={() => reshuffleSingle(a.profileId)}
                        disabled={isActive}
                        className="bg-purple-800 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-2 py-1 rounded text-xs">
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

        {/* ── Per-Profile Overrides Panel ── */}
        {assignments.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowPerProfilePanel(p => !p)}
              className="flex items-center gap-2 text-sm text-purple-400 hover:text-purple-300 font-medium transition-all mb-2"
            >
              <span>{showPerProfilePanel ? '▼' : '▶'}</span>
              Per-Profile Overrides
              <span className="text-xs text-gray-500 font-normal">(quality, watch%, volume, actions — global ko override karo)</span>
            </button>

            {showPerProfilePanel && (
              <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-700 text-gray-400">
                      <th className="text-left px-3 py-2 font-medium">Profile</th>
                      <th className="px-2 py-2 font-medium">🎬 Quality</th>
                      <th className="px-2 py-2 font-medium">⏱ Watch%</th>
                      <th className="px-2 py-2 font-medium">🔊 Vol%</th>
                      <th className="px-2 py-2 font-medium">👍 Like</th>
                      <th className="px-2 py-2 font-medium">👎 Dis</th>
                      <th className="px-2 py-2 font-medium">🔔 Sub</th>
                      <th className="px-2 py-2 font-medium">🔔 Bell</th>
                      <th className="px-2 py-2 font-medium">💬 Cmt</th>
                      <th className="px-2 py-2 font-medium">💬👍 CL</th>
                      <th className="px-2 py-2 font-medium">🔗 Link</th>
                      <th className="px-2 py-2 font-medium">⏭ Seek</th>
                      <th className="px-2 py-2 font-medium">🚫 AdSkip</th>
                      <th className="px-2 py-2 font-medium">🖱 AdClick</th>
                      <th className="px-2 py-2 font-medium">📝 CC</th>
                      <th className="px-2 py-2 font-medium">Reset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assignments.map(a => {
                      const profile = profiles.find(p => p.id === a.profileId);
                      const pov = perProfileOverrides[a.profileId] || {};
                      const setField = <K extends keyof PerProfileOverride>(field: K, val: PerProfileOverride[K] | undefined) => {
                        setPerProfileOverrides(prev => {
                          const cur = prev[a.profileId] || {};
                          const next = { ...cur };
                          if (val === undefined) delete next[field];
                          else (next as Record<string, unknown>)[field] = val;
                          return { ...prev, [a.profileId]: next };
                        });
                      };
                      const hasAnyOverride = Object.keys(pov).length > 0;
                      return (
                        <tr key={a.profileId} className={`border-b border-gray-800 ${hasAnyOverride ? 'bg-purple-900/10' : ''}`}>
                          {/* Profile Name */}
                          <td className="px-3 py-1.5 text-white font-medium truncate max-w-[100px]">
                            {profile?.name || a.profileName}
                            {hasAnyOverride && <span className="ml-1 text-purple-400">*</span>}
                          </td>
                          {/* Quality */}
                          <td className="px-2 py-1.5">
                            <select
                              value={pov.quality ?? ''}
                              onChange={e => setField('quality', e.target.value ? (e.target.value as ShuffleVideoQuality) : undefined)}
                              className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-1 py-0.5 text-xs focus:border-purple-500 outline-none"
                            >
                              <option value="">— global —</option>
                              {QUALITY_OPTIONS.map(q => <option key={q} value={q}>{q}</option>)}
                            </select>
                          </td>
                          {/* Watch % range */}
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                min={1} max={100}
                                placeholder={String(settings.watchTimeMin)}
                                value={pov.watchTimeMin ?? ''}
                                onChange={e => setField('watchTimeMin', e.target.value ? Number(e.target.value) : undefined)}
                                className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-1 py-0.5 text-xs w-12 focus:border-purple-500 outline-none"
                              />
                              <span className="text-gray-600">–</span>
                              <input
                                type="number"
                                min={1} max={100}
                                placeholder={String(settings.watchTimeMax)}
                                value={pov.watchTimeMax ?? ''}
                                onChange={e => setField('watchTimeMax', e.target.value ? Number(e.target.value) : undefined)}
                                className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-1 py-0.5 text-xs w-12 focus:border-purple-500 outline-none"
                              />
                            </div>
                          </td>
                          {/* Volume */}
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              min={0} max={100}
                              placeholder={String(settings.volumePct)}
                              value={pov.volumePct ?? ''}
                              onChange={e => setField('volumePct', e.target.value ? Number(e.target.value) : undefined)}
                              className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-1 py-0.5 text-xs w-14 focus:border-purple-500 outline-none"
                            />
                          </td>
                          {/* Like */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.like ?? settings.actionToggles.like}
                              onChange={e => setField('like', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Dislike */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.dislike ?? settings.actionToggles.dislike}
                              onChange={e => setField('dislike', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Subscribe */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.subscribe ?? settings.actionToggles.subscribe}
                              onChange={e => setField('subscribe', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Bell */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.bell ?? settings.actionToggles.bell}
                              onChange={e => setField('bell', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Comment */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.comment ?? settings.actionToggles.comment}
                              onChange={e => setField('comment', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Comment Like */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.commentLike ?? settings.actionToggles.commentLike}
                              onChange={e => setField('commentLike', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Description Links */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.descriptionLinks ?? settings.actionToggles.descriptionLinks}
                              onChange={e => setField('descriptionLinks', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Seek */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.seekEnabled ?? settings.seekEnabled}
                              onChange={e => setField('seekEnabled', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* AdSkip */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.adSkip ?? settings.adSkipEnabled}
                              onChange={e => setField('adSkip', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* AdClick */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.adClick ?? settings.adClickEnabled}
                              onChange={e => setField('adClick', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Captions */}
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={pov.captions ?? settings.captionsEnabled}
                              onChange={e => setField('captions', e.target.checked)}
                              className="accent-purple-500 w-3.5 h-3.5"
                            />
                          </td>
                          {/* Reset */}
                          <td className="px-2 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => setPerProfileOverrides(prev => { const n = { ...prev }; delete n[a.profileId]; return n; })}
                              disabled={!hasAnyOverride}
                              className="text-gray-500 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs"
                              title="Reset to global"
                            >↺</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="px-3 py-2 border-t border-gray-800 flex items-center justify-between">
                  <p className="text-xs text-gray-600">* = global se alag; blank = global value use hogi</p>
                  <button
                    type="button"
                    onClick={() => setPerProfileOverrides({})}
                    className="text-xs text-gray-500 hover:text-red-400 transition-all"
                  >Reset All</button>
                </div>
              </div>
            )}
          </div>
        )}
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
          onRemove={(videoId) => removeVideoFromAssignment(detailProfile, videoId)}
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
  onRemove: (videoId: string) => void;
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
                      <button type="button" onClick={() => onRemove(v.videoId)} className="text-red-400 text-xs">✕</button>
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
