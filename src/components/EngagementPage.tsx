import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ThumbsUp, Play,
  RefreshCw, XCircle, Clock, Zap,
  ChevronDown, AlertTriangle, Film, BarChart2, Mail,
} from 'lucide-react';
import ChannelVideoPicker, { type PickableVideo } from './shared/ChannelVideoPicker';
import { videoTargetsFromPickable, pickableFromVideoTargets } from '../utils/pickableVideoAdapters';
import type { Profile } from '../types';
import type { AutoSync, Channel, ChannelStatus, Video } from '../store/useChannelStore';
import { getGmailProfileIds, getAllGmailProfiles } from '../utils/gmailProfileStore';
import {
  startEngagement, fetchEngagementStatus, cancelEngagement, clearEngagementJobs,
  type EngagementQueueStatus, type EngagementJobStatus, type VideoTarget,
} from '../utils/engagementApi';
import { useDisabledTrafficSources } from '../hooks/useDisabledTrafficSources';
import { AdControlSettings } from './shared/AdControlSettings';
import { TRAFFIC_SOURCES } from '../utils/runSettingsShared';

// ── helpers ───────────────────────────────────────────────────────────────────
function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getCommentTemplates(): { id: string; text: string }[] {
  try {
    const d = localStorage.getItem('mmb_comments');
    const parsed = d ? JSON.parse(d) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

const STATUS_CFG: Record<string, { label: string; color: string; dot: string }> = {
  pending:   { label: 'Pending',   color: 'text-yellow-400', dot: 'bg-yellow-400' },
  running:   { label: 'Running',   color: 'text-blue-400',   dot: 'bg-blue-400 animate-pulse' },
  done:      { label: 'Done',      color: 'text-green-400',  dot: 'bg-green-400' },
  partial:   { label: 'Partial',   color: 'text-amber-400',  dot: 'bg-amber-400' },
  failed:    { label: 'Failed',    color: 'text-red-400',    dot: 'bg-red-400' },
  cancelled: { label: 'Cancelled', color: 'text-gray-500',   dot: 'bg-gray-500' },
};

const QUALITY_OPTIONS = ['auto', '144p', '240p', '360p', '480p', '720p', '1080p'] as const;
type VideoQuality = typeof QUALITY_OPTIONS[number];
type Source =
  | 'notification'
  | 'search'
  | 'direct'
  | 'homepage'
  | 'google'
  | 'bing'
  | 'channel_discovery';

const ENGAGEMENT_SOURCE_OPTIONS: { id: Source; label: string }[] = [
  { id: 'notification', label: '🔔 Notification' },
  { id: 'search', label: '🔍 YouTube' },
  { id: 'homepage', label: '🏠 Homepage' },
  { id: 'google', label: '🌐 Google' },
  { id: 'bing', label: '🔷 Bing' },
  { id: 'channel_discovery', label: '📺 Channel Disc' },
  { id: 'direct', label: '🔗 Direct' },
];

interface ProfileOverride {
  source:           Source;
  like:             boolean;
  dislike:          boolean;
  subscribe:        boolean;
  bell:             boolean;
  comment:          boolean;
  commentLike:      boolean;
  descriptionLinks: boolean;
  // Per-profile settings (user decides from tool — Rule: jo tool se set karo wahi use ho)
  quality:          VideoQuality;
  watchMin:         number;   // per-profile watch % RANGE min (e.g. 80)
  watchMax:         number;   // per-profile watch % RANGE max (e.g. 100)
  volMin:           number;   // per-profile volume % RANGE min
  volMax:           number;   // per-profile volume % RANGE max
  seekEnabled:      boolean;
  adSkip:           boolean;
  adClick:          boolean;
}

const ACTION_COLS: { key: 'like' | 'dislike' | 'subscribe' | 'bell' | 'comment' | 'commentLike' | 'descriptionLinks'; emoji: string; label: string; color: string }[] = [
  { key: 'like',             emoji: '👍', label: 'Like',    color: 'text-green-400'  },
  { key: 'dislike',          emoji: '👎', label: 'Dislike', color: 'text-red-400'    },
  { key: 'subscribe',        emoji: '📺', label: 'Sub',     color: 'text-blue-400'   },
  { key: 'bell',             emoji: '🔔', label: 'Bell',    color: 'text-yellow-400' },
  { key: 'comment',          emoji: '💬', label: 'Comment', color: 'text-purple-400' },
  { key: 'commentLike',      emoji: '💬👍', label: 'CmtLike', color: 'text-pink-400' },
  { key: 'descriptionLinks', emoji: '🔗', label: 'Links',   color: 'text-orange-400' },
];

// ── Presets ────────────────────────────────────────────────────────────────────
type PresetName = 'aggressive' | 'natural' | 'minimal' | 'custom';

const PRESETS: Record<Exclude<PresetName, 'custom'>, { like: number; dislike: number; subscribe: number; bell: number; comment: number; commentLike: number }> = {
  aggressive: { like: 90, dislike: 10, subscribe: 50, bell: 50, comment: 40, commentLike: 50 },
  natural:    { like: 70, dislike: 5,  subscribe: 30, bell: 30, comment: 20, commentLike: 30 },
  minimal:    { like: 40, dislike: 0,  subscribe: 10, bell: 0,  comment: 5,  commentLike: 10 },
};

// ── Tab type ──────────────────────────────────────────────────────────────────
type SettingsTab = 'engagement' | 'playback' | 'traffic';
type ControlMode = 'same' | 'perprofile';

interface Props {
  profiles:       Profile[];
  channels?:      Channel[];
  getVideos?:     (channelId: number, filter?: string) => Video[];
  addManualVideo?: (url: string, title: string) => Video | null;
  addChannel?:    (channelId: string, autoSync?: AutoSync, status?: ChannelStatus) => Promise<Channel | null>;
  setActiveTab?:  (tab: string) => void;
}

export default function EngagementPage({
  profiles,
  channels = [],
  getVideos,
  addManualVideo,
  addChannel,
  setActiveTab,
}: Props) {
  const { isEnabled, disabledList } = useDisabledTrafficSources();
  const enabledSourceOptions = useMemo(
    () => ENGAGEMENT_SOURCE_OPTIONS.filter((s) => isEnabled(s.id)),
    [isEnabled, disabledList],
  );

  // ── UI State ─────────────────────────────────────────────────────────────────
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('engagement');
  const [controlMode, setControlMode] = useState<ControlMode>('same');
  const [activePreset, setActivePreset] = useState<PresetName>('natural');

  // ── Video Queue ──────────────────────────────────────────────────────────────
  const [videoQueue, setVideoQueue]         = useState<VideoTarget[]>([]);

  // ── Global % settings ────────────────────────────────────────────────────────
  const [likePct,            setLikePct]            = useState(70);
  const [dislikePct,         setDislikePct]         = useState(5);
  const [subscribePct,       setSubscribePct]       = useState(30);
  const [bellPct,            setBellPct]            = useState(30);
  const [commentPct,         setCommentPct]         = useState(20);
  const [commentLikePct,     setCommentLikePct]     = useState(30);
  const [descDefault,        setDescDefault]        = useState(false);
  const [descExpandEnabled,  setDescExpandEnabled]  = useState(true);
  const [volumePct,          setVolumePct]          = useState(75);
  const [volumeMin,          setVolumeMin]          = useState(10);
  const [volumeMax,          setVolumeMax]          = useState(100);
  const [seekEnabled,        setSeekEnabled]        = useState(true);
  const [seekDirection,      setSeekDirection]      = useState<'forward' | 'backward' | 'both'>('forward');
  const [pauseProbabilityPct,setPauseProbabilityPct]= useState(12);
  const [watchPctMin,        setWatchPctMin]        = useState(80);
  const [watchPctMax,        setWatchPctMax]        = useState(100);
  const [adSkipEnabled,      setAdSkipEnabled]      = useState(true);
  const [adSkipMaxSec,       setAdSkipMaxSec]       = useState(60);
  const [midRollAdWaitSec,   setMidRollAdWaitSec]   = useState(10);
  const [adClickEnabled,     setAdClickEnabled]     = useState(false);
  const [adClickDelayMinSec, setAdClickDelayMinSec] = useState(10);
  const [adClickDelayMaxSec, setAdClickDelayMaxSec] = useState(15);
  const [adClickVisitSec,    setAdClickVisitSec]    = useState(20);
  const [videosPerProfile,   setVideosPerProfile]   = useState(1);
  const [videoQuality,       setVideoQuality]       = useState<VideoQuality>('auto');
  const [activeLaunchLimit,  setActiveLaunchLimit]  = useState(20);
  const [startGapMinSec,     setStartGapMinSec]     = useState(10);
  const [startGapMaxSec,     setStartGapMaxSec]     = useState(25);
  const [srcNotif,           setSrcNotif]           = useState(20);
  const [srcSearch,          setSrcSearch]          = useState(30);
  const [srcHome,            setSrcHome]            = useState(20);
  const [srcGoogle,          setSrcGoogle]          = useState(12);
  const [srcBing,            setSrcBing]            = useState(8);
  const [srcChannelDisc,     setSrcChannelDisc]     = useState(10);
  const [captionsEnabled,    setCaptionsEnabled]    = useState(false);
  const [playbackSpeed,      setPlaybackSpeed]      = useState('1x');
  const [naturalScrollCurves,setNaturalScrollCurves]= useState(true);
  const [uniqueTypingPersonality,setUniqueTypingPersonality] = useState(true);

  // ── Per-profile overrides ─────────────────────────────────────────────────────
  const [profileOverrides, setProfileOverrides] = useState<Record<string, ProfileOverride>>({});
  const [selectedIds,      setSelectedIds]      = useState<Set<string>>(new Set());

  // ── Queue status ──────────────────────────────────────────────────────────────
  const [queueStatus,  setQueueStatus]  = useState<EngagementQueueStatus | null>(null);
  const [expandedJob,  setExpandedJob]  = useState<string | null>(null);
  const [launching,    setLaunching]    = useState(false);
  const [launchMsg,    setLaunchMsg]    = useState('');
  const [queueExpanded, setQueueExpanded] = useState(false);
  const pendingPresetRef = useRef<PresetName | null>(null);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const gmailIds      = getGmailProfileIds();
  const gmailMeta     = getAllGmailProfiles();
  const gmailProfiles = profiles.filter(p => gmailIds.includes(p.id));
  const srcDirect = Math.max(0, 100 - srcNotif - srcSearch - srcHome - srcGoogle - srcBing - srcChannelDisc);

  // ── Preset apply ─────────────────────────────────────────────────────────────
  function applyPreset(name: PresetName) {
    setActivePreset(name);
    if (name === 'custom') return;
    const p = PRESETS[name];
    setLikePct(p.like);
    setDislikePct(p.dislike);
    setSubscribePct(p.subscribe);
    setBellPct(p.bell);
    setCommentPct(p.comment);
    setCommentLikePct(p.commentLike);
    pendingPresetRef.current = name;
  }

  useEffect(() => {
    if (pendingPresetRef.current && pendingPresetRef.current !== 'custom') {
      pendingPresetRef.current = null;
      applyGlobalPct();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [likePct, dislikePct, subscribePct, bellPct, commentPct, commentLikePct]);

  /** Deterministic pct slot — 70% like + 1 profile => like ON (no silent random OFF). */
  function pctSlotOn(pct: number, profileIndex: number, profileCount: number): boolean {
    if (pct <= 0) return false;
    if (pct >= 100) return true;
    // Single profile test: slider > 0 means action ON (no silent skip)
    if (profileCount === 1) return true;
    const slot = ((profileIndex + 0.5) / Math.max(1, profileCount)) * 100;
    return slot < pct;
  }

  // ── Helper: build a default override for a profile ───────────────────────────
  function makeDefault(profileIndex = 0, profileCount = 1): ProfileOverride {
    const roll = rand(1, 100);
    const source: Source = (() => {
      let r = roll;
      if (r <= srcNotif)  return 'notification';
      r -= srcNotif;
      if (r <= srcSearch) return 'search';
      r -= srcSearch;
      if (r <= srcHome)   return 'homepage';
      r -= srcHome;
      if (r <= srcGoogle) return 'google';
      r -= srcGoogle;
      if (r <= srcBing)   return 'bing';
      r -= srcBing;
      if (r <= srcChannelDisc) return 'channel_discovery';
      return 'direct';
    })();
    const count = Math.max(1, profileCount);
    return {
      source,
      like:             pctSlotOn(likePct, profileIndex, count),
      dislike:          pctSlotOn(dislikePct, profileIndex, count),
      subscribe:        pctSlotOn(subscribePct, profileIndex, count),
      bell:             pctSlotOn(bellPct, profileIndex, count),
      comment:          pctSlotOn(commentPct, profileIndex, count),
      commentLike:      pctSlotOn(commentLikePct, profileIndex, count),
      descriptionLinks: descDefault,
      // Per-profile defaults from global settings (user can override per-profile)
      quality:     videoQuality,
      watchMin:    watchPctMin,
      watchMax:    watchPctMax,
      volMin:      volumeMin,
      volMax:      volumeMax,
      seekEnabled: seekEnabled,
      adSkip:      adSkipEnabled,
      adClick:     adClickEnabled,
    };
  }

  // Init overrides + selection when profiles list changes
  useEffect(() => {
    setSelectedIds(new Set(gmailProfiles.map(p => p.id)));
    setProfileOverrides(prev => {
      const next = { ...prev };
      gmailProfiles.forEach((p, i) => {
        if (!next[p.id]) next[p.id] = makeDefault(i, gmailProfiles.length);
      });
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.length]);

  function applyGlobalPct() {
    const sel = gmailProfiles.filter(p => selectedIds.has(p.id));
    setProfileOverrides(prev => {
      const next = { ...prev };
      sel.forEach((p, i) => {
        next[p.id] = makeDefault(i, sel.length);
      });
      return next;
    });
  }

  function setOverride<K extends keyof ProfileOverride>(id: string, key: K, val: ProfileOverride[K]) {
    setProfileOverrides(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? makeDefault()), [key]: val },
    }));
  }

  function toggleColAll(key: keyof Omit<ProfileOverride, 'source'>) {
    const sel = gmailProfiles.filter(p => selectedIds.has(p.id));
    const allOn = sel.length > 0 && sel.every(p => profileOverrides[p.id]?.[key] ?? false);
    setProfileOverrides(prev => {
      const next = { ...prev };
      sel.forEach(p => { next[p.id] = { ...(next[p.id] ?? makeDefault()), [key]: !allOn }; });
      return next;
    });
  }

  /** Force-set a column to a specific value across all selected profiles. */
  function setColAll(key: keyof Omit<ProfileOverride, 'source'>, value: boolean) {
    const sel = gmailProfiles.filter(p => selectedIds.has(p.id));
    setProfileOverrides(prev => {
      const next = { ...prev };
      sel.forEach(p => { next[p.id] = { ...(next[p.id] ?? makeDefault()), [key]: value }; });
      return next;
    });
  }

  function colAllChecked(key: keyof Omit<ProfileOverride, 'source'>): boolean {
    const sel = gmailProfiles.filter(p => selectedIds.has(p.id));
    return sel.length > 0 && sel.every(p => profileOverrides[p.id]?.[key] ?? false);
  }

  const syncPickableVideos = (videos: PickableVideo[]) => {
    setVideoQueue(prev => videoTargetsFromPickable(videos, prev));
  };

  const setVideoTraffic = (index: number, trafficSource: string) => {
    setVideoQueue(prev => prev.map((v, i) => (
      i === index ? { ...v, trafficSource: trafficSource || undefined } : v
    )));
  };

  // ── Poll queue ────────────────────────────────────────────────────────────────
  const pollStatus = useCallback(async () => {
    const s = await fetchEngagementStatus();
    if (s) setQueueStatus(s);
  }, []);

  useEffect(() => {
    pollStatus();
    const iv = setInterval(pollStatus, 3000);
    return () => clearInterval(iv);
  }, [pollStatus]);

  // ── Build payload ─────────────────────────────────────────────────────────────
  function buildProfiles() {
    const allSelected = gmailProfiles.filter(p => selectedIds.has(p.id));
    const sel = allSelected.slice(0, Math.max(1, activeLaunchLimit));
    if (!sel.length || !videoQueue.length) return [];
    const templates = getCommentTemplates();
    let cumulativeDelayMs = 0;

    return sel.map((p, i) => {
      const ov = profileOverrides[p.id] ?? makeDefault(i, sel.length);
      const gmailReady = !!(gmailMeta[p.id]?.email?.trim());
      const commentText =
        ov.comment && templates.length > 0
          ? templates[rand(0, templates.length - 1)].text
          : '';
      // Rule: jo tool se set karo wahi use ho — per-profile RANGE, random within it
      const profileWatchPct = rand(ov.watchMin ?? watchPctMin, ov.watchMax ?? watchPctMax);
      const profileQuality  = ov.quality   ?? videoQuality;
      const profileVolume   = rand(ov.volMin ?? volumeMin, ov.volMax ?? volumeMax);
      const profileSeek     = ov.seekEnabled ?? seekEnabled;
      const profileAdSkip   = ov.adSkip    ?? adSkipEnabled;
      const profileAdClick  = ov.adClick   ?? adClickEnabled;
      if (i > 0) cumulativeDelayMs += rand(startGapMinSec, Math.max(startGapMinSec, startGapMaxSec)) * 1000;
      const delayMs = cumulativeDelayMs;
      return {
        profileId:   p.id,
        profileName: p.name || p.id,
        browserType: p.browserType || 'morelogin',
        source:      ov.source,
        delayMs,
        actions: {
          like:              ov.like,
          dislike:           ov.dislike,
          subscribe:         ov.subscribe,
          bell:              ov.bell,
          comment:           ov.comment,
          commentText,
          descriptionLinks:  ov.descriptionLinks,
          descriptionExpand: descExpandEnabled,
          volumePct:         profileVolume,
          volumeMin:         volumeMin,
          volumeMax:         volumeMax,
          commentLikeEnabled: ov.commentLike,
          commentLikePct:     ov.commentLike ? commentLikePct : 0,
          seekEnabled:       profileSeek,
          seekDirection,
          pauseProbability:  pauseProbabilityPct / 100,
          adSkipEnabled:     profileAdSkip,
          adClick:           profileAdClick,
          adSkipDelaySec:    adSkipMaxSec,
          adSkipDelayMaxSec: adSkipMaxSec,
          adSkipMaxSec,
          adClickEnabled:    profileAdClick,
          adClickDelayMinSec,
          adClickDelayMaxSec,
          adClickVisitSec,
          videoQuality:      profileQuality,
          // Gmail profiles on this page — trust login, backend must not DOM-detect
          gmailLoggedIn:     true,
          gmailReady:        gmailReady,
          gmailEmail:        gmailMeta[p.id]?.email || null,
          // Extra playback settings
          captionsEnabled:         captionsEnabled,
          captionsToggle:          captionsEnabled,
          playbackSpeed:           playbackSpeed,
          speedChange:             playbackSpeed !== '1x',
          speedChangeEnabled:      playbackSpeed !== '1x',
          naturalScrollCurves:     naturalScrollCurves,
          uniqueTypingPersonality: uniqueTypingPersonality,
        },
        videos:   videoQueue.slice(0, Math.max(1, videosPerProfile)),
        watchPct: profileWatchPct,
        adClickEnabled: profileAdClick,
        adSkipMaxSec,
        adClickVisitSec,
        adClickDelayMinSec,
        adClickDelayMaxSec,
      };
    });
  }

  async function handleLaunch() {
    if (!videoQueue.length)  { setLaunchMsg('❌ Add at least one video first'); return; }
    if (!selectedIds.size)   { setLaunchMsg('❌ Select at least one Gmail profile'); return; }
    setLaunching(true);
    setLaunchMsg('');
    try {
      const result = await startEngagement({
        profiles: buildProfiles(),
        watchPct: rand(watchPctMin, watchPctMax),
        adSkipEnabled,
        adSkipDelaySec: adSkipMaxSec,
        adSkipDelayMaxSec: adSkipMaxSec,
        adSkipMaxSec,
        adClickEnabled,
        adClickDelayMinSec,
        adClickDelayMaxSec,
        adClickVisitSec,
        videoQuality,
        maxConcurrent: Math.max(1, activeLaunchLimit),
      });
      setLaunching(false);
      if (result.code === 0) {
        setLaunchMsg(`✅ ${result.jobIds?.length ?? 0} jobs queued!`);
        void pollStatus();
      } else {
        setLaunchMsg(`❌ ${result.message}`);
      }
    } catch (err) {
      setLaunching(false);
      setLaunchMsg(`❌ ${err instanceof Error ? err.message : 'Network error — backend reachable?'}`);
    }
  }

  const selectedProfiles = gmailProfiles.filter(p => selectedIds.has(p.id));
  const launchProfiles = selectedProfiles.slice(0, Math.max(1, activeLaunchLimit));

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-5 pb-32">

        {/* ═══ HEADER ═══ */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div style={{
              width: 44, height: 44, borderRadius: 13, flexShrink: 0,
              background: 'var(--mmb-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 8px 22px var(--mmb-accent-glow)',
            }}>
              <Zap size={22} color="#fff" />
            </div>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <span className="mmb-gradient-text">Engagement Engine</span>
              </h1>
              <p className="text-gray-500 text-sm mt-0.5">
                Gmail profiles → channel link paste karo → har profile ka apna action pattern chalega
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {setActiveTab && (
              <button onClick={() => setActiveTab('analytics')}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-900/30 border border-blue-700/40 text-blue-400 text-xs font-medium hover:bg-blue-900/50 transition-all">
                <BarChart2 size={13} /> Analytics →
              </button>
            )}
            {queueStatus && (queueStatus.pending > 0 || queueStatus.running > 0) && (
              <button onClick={() => void cancelEngagement().then(pollStatus)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-900/30 border border-red-700/40 text-red-400 text-xs font-medium hover:bg-red-900/50">
                <XCircle size={13} /> Cancel All
              </button>
            )}
          </div>
        </div>

        {/* ═══ VIDEO QUEUE — multi-channel picker ═══ */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            <Film size={15} className="text-red-400" /> Video Queue
            {videoQueue.length > 0 && (
              <span className="text-xs text-gray-500 font-normal">— {videoQueue.length} video{videoQueue.length !== 1 ? 's' : ''}</span>
            )}
          </h2>
          {getVideos ? (
            <ChannelVideoPicker
              channels={channels}
              getVideos={getVideos}
              videos={pickableFromVideoTargets(videoQueue)}
              onChange={syncPickableVideos}
            />
          ) : (
            <p className="text-xs text-gray-600">Channels load ho rahe hain…</p>
          )}
          {videoQueue.length > 0 && (
            <div className="space-y-2 border-t border-gray-800 pt-3">
              <p className="text-[10px] text-gray-500 font-medium">Per-video traffic (khali = profile default)</p>
              {videoQueue.map((v, i) => (
                <div key={`${v.url}-${i}`} className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400 truncate flex-1 min-w-0" title={v.title}>{v.title}</span>
                  <select
                    value={v.trafficSource ?? ''}
                    onChange={e => setVideoTraffic(i, e.target.value)}
                    className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-2 py-1 text-[11px] max-w-[140px]"
                  >
                    <option value="">— profile —</option>
                    {TRAFFIC_SOURCES.filter(t => t.id !== 'random').map(t => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-gray-600">Profile-level traffic 🌐 Traffic tab · Har video ka alag source upar set kar sakte ho.</p>
        </div>

        {/* ═══ CONTROL MODE TOGGLE (modern segmented control) ═══ */}
        <div className="flex items-center gap-3 px-1 flex-wrap">
          <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Control Mode:</span>
          <div style={{
            display: 'inline-flex', padding: 4, borderRadius: 12, gap: 4,
            background: 'var(--mmb-surface2)', border: '1px solid var(--mmb-border)',
          }}>
            {([
              { id: 'same' as const,       label: 'Same for All',       hint: 'sab profiles ek jaisa' },
              { id: 'perprofile' as const, label: 'Per Profile Custom', hint: 'har profile alag' },
            ]).map(opt => {
              const active = controlMode === opt.id;
              return (
                <button key={opt.id} onClick={() => setControlMode(opt.id)} title={opt.hint}
                  style={{
                    padding: '7px 16px', borderRadius: 9, fontSize: 12, fontWeight: 650,
                    border: 'none', cursor: 'pointer', transition: 'all .18s',
                    background: active ? 'var(--mmb-grad)' : 'transparent',
                    color: active ? '#fff' : 'var(--mmb-muted)',
                    boxShadow: active ? '0 4px 14px var(--mmb-accent-glow)' : 'none',
                  }}>
                  {opt.label}
                </button>
              );
            })}
          </div>
          <span className="text-[11px] text-gray-500">
            {controlMode === 'same' ? 'Sabhi selected profiles pe ek hi setting' : 'Neeche table mein har profile ki apni setting'}
          </span>
        </div>

        {/* ═══ TABBED SETTINGS (always visible — volume + traffic) ═══ */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-gray-800 px-5 pt-3">
              {([
                { id: 'engagement' as const, label: '👍 Engagement' },
                { id: 'playback' as const, label: '▶ Playback' },
                { id: 'traffic' as const, label: '🌐 Traffic Source' },
              ]).map(tab => (
                <button key={tab.id} onClick={() => setActiveSettingsTab(tab.id)}
                  className="px-5 py-3 text-sm font-semibold transition-all rounded-t-lg"
                  style={{
                    border: 'none',
                    borderBottom: activeSettingsTab === tab.id ? '2px solid transparent' : '2px solid transparent',
                    borderImage: activeSettingsTab === tab.id ? 'var(--mmb-grad) 1' : 'none',
                    color: activeSettingsTab === tab.id ? 'var(--mmb-text)' : 'var(--mmb-muted)',
                    background: activeSettingsTab === tab.id ? 'var(--mmb-grad-soft)' : 'transparent',
                    cursor: 'pointer',
                  }}>
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ─── TAB: Engagement ─── */}
            {activeSettingsTab === 'engagement' && (
              <div className="p-5 space-y-5">
                {/* ── Bulk Action Buttons (apply to all selected profiles) ── */}
                <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                    <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                      ⚡ Bulk Actions
                      <span className="text-[10px] text-gray-500 font-normal">— click to enable on ALL selected profiles</span>
                    </h3>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          ACTION_COLS.forEach(col => setColAll(col.key, true));
                        }}
                        className="text-[10px] text-green-400 hover:text-green-300 border border-green-700/30 px-2.5 py-1 rounded-lg font-semibold"
                      >
                        ✓ Enable All
                      </button>
                      <button
                        onClick={() => {
                          ACTION_COLS.forEach(col => setColAll(col.key, false));
                        }}
                        className="text-[10px] text-red-400 hover:text-red-300 border border-red-700/30 px-2.5 py-1 rounded-lg font-semibold"
                      >
                        ✕ Disable All
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    {ACTION_COLS.map(col => {
                      const allOn = colAllChecked(col.key);
                      return (
                        <div key={col.key} className="bg-gray-900/50 border border-gray-700/40 rounded-lg p-2.5 space-y-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-base">{col.emoji}</span>
                            <span className={`text-[11px] font-medium ${col.color}`}>{col.label}</span>
                          </div>
                          <div className="grid grid-cols-2 gap-1">
                            <button
                              onClick={() => setColAll(col.key, true)}
                              title={`Enable ${col.label} on all selected profiles`}
                              className={`px-2 py-1 rounded text-[10px] font-semibold transition-all ${
                                allOn
                                  ? 'bg-green-600/30 text-green-300 border border-green-600/50'
                                  : 'bg-gray-800 text-gray-500 border border-gray-700 hover:border-green-700/40 hover:text-green-400'
                              }`}
                            >
                              All ON
                            </button>
                            <button
                              onClick={() => setColAll(col.key, false)}
                              title={`Disable ${col.label} on all selected profiles`}
                              className={`px-2 py-1 rounded text-[10px] font-semibold transition-all ${
                                !allOn && gmailProfiles.filter(p => selectedIds.has(p.id)).every(p => !(profileOverrides[p.id]?.[col.key]))
                                  ? 'bg-red-600/30 text-red-300 border border-red-600/50'
                                  : 'bg-gray-800 text-gray-500 border border-gray-700 hover:border-red-700/40 hover:text-red-400'
                              }`}
                            >
                              All OFF
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <p className="text-[10px] text-gray-600 mt-3">
                    💡 Per-profile control: neeche table mein har profile ka individual checkbox toggle karo. Yeh buttons sirf bulk shortcut hain — final decision per-profile checkbox mein reflect hoga.
                  </p>
                </div>

                <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-4 space-y-3">
                  <h3 className="text-white font-semibold text-sm">💬👍 Comment like — chance %</h3>
                  <p className="text-[10px] text-gray-500">Kisi aur ke comment pe like. Profile ON + yeh % decide karega try hoga ya nahi.</p>
                  <div className="flex items-center gap-3">
                    <input type="range" min={0} max={100} step={5} value={commentLikePct}
                      onChange={e => setCommentLikePct(Number(e.target.value))}
                      className="flex-1 accent-pink-500" />
                    <span className="text-pink-300 text-sm font-mono w-10 text-right">{commentLikePct}%</span>
                  </div>
                </div>
              </div>
            )}

            {/* ─── TAB: Playback ─── */}
            {activeSettingsTab === 'playback' && (
              <div className="p-5">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {/* Watch Time */}
                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
                    <h4 className="text-white text-sm font-semibold">⏱ Watch Duration</h4>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-10">Min</span>
                      <input type="range" min={10} max={100} step={5} value={watchPctMin} onChange={e => { const v = Number(e.target.value); setWatchPctMin(v); if (v > watchPctMax) setWatchPctMax(v); }} className="flex-1 accent-teal-500" />
                      <span className="text-white text-xs font-mono w-10 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded text-center">{watchPctMin}%</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-10">Max</span>
                      <input type="range" min={10} max={100} step={5} value={watchPctMax} onChange={e => { const v = Number(e.target.value); setWatchPctMax(v); if (v < watchPctMin) setWatchPctMin(v); }} className="flex-1 accent-teal-500" />
                      <span className="text-white text-xs font-mono w-10 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded text-center">{watchPctMax}%</span>
                    </div>
                    <p className="text-[10px] text-gray-600">Each profile gets random % between min–max</p>
                  </div>

                  {/* Quality & Volume */}
                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
                    <h4 className="text-white text-sm font-semibold">🎬 Quality & Volume</h4>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-14">Quality</span>
                      <select value={videoQuality} onChange={e => setVideoQuality(e.target.value as VideoQuality)}
                        className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none">
                        {QUALITY_OPTIONS.map(q => <option key={q} value={q}>{q === 'auto' ? 'Auto' : q}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-14">Vol min</span>
                      <input type="range" min={0} max={100} step={5} value={volumeMin}
                        onChange={e => { const v = Number(e.target.value); setVolumeMin(v); if (v > volumeMax) setVolumeMax(v); }}
                        className="flex-1 accent-cyan-500" />
                      <span className="text-white text-xs font-mono w-10 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded text-center">{volumeMin}%</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-14">Vol max</span>
                      <input type="range" min={0} max={100} step={5} value={volumeMax}
                        onChange={e => { const v = Number(e.target.value); setVolumeMax(v); if (v < volumeMin) setVolumeMin(v); }}
                        className="flex-1 accent-cyan-500" />
                      <span className="text-white text-xs font-mono w-10 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded text-center">{volumeMax}%</span>
                    </div>
                    <p className="text-[10px] text-gray-600">Random volume per session between min–max (fallback target {volumePct}%)</p>
                  </div>

                  {/* Behavior */}
                  <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 space-y-3">
                    <h4 className="text-white text-sm font-semibold">🧠 Behavior</h4>
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">⏭ Seek (j/l keys)</span>
                        <button onClick={() => setSeekEnabled(v => !v)} className={`relative w-9 h-5 rounded-full transition-all ${seekEnabled ? 'bg-cyan-500' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${seekEnabled ? 'left-4' : 'left-0.5'}`} />
                        </button>
                      </div>
                      {seekEnabled && (
                        <div className="flex gap-1.5 pl-3">
                          {(['forward', 'backward', 'both'] as const).map(d => (
                            <button key={d} onClick={() => setSeekDirection(d)} className={`px-2 py-1 rounded-lg text-[10px] border transition-all ${seekDirection === d ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300' : 'border-gray-700 bg-gray-800 text-gray-500'}`}>
                              {d === 'forward' ? '→' : d === 'backward' ? '←' : '↔'} {d}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">📄 Desc expand</span>
                        <button onClick={() => setDescExpandEnabled(v => !v)} className={`relative w-9 h-5 rounded-full transition-all ${descExpandEnabled ? 'bg-amber-500' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${descExpandEnabled ? 'left-4' : 'left-0.5'}`} />
                        </button>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">🔗 Desc links</span>
                        <button onClick={() => setDescDefault(v => !v)} className={`relative w-9 h-5 rounded-full transition-all ${descDefault ? 'bg-orange-500' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${descDefault ? 'left-4' : 'left-0.5'}`} />
                        </button>
                      </div>
                      <div className="col-span-full border-t border-gray-800 pt-3 mt-1">
                        <AdControlSettings
                          compact
                          showPerProfileHint
                          values={{
                            adSkipEnabled,
                            adSkipMaxSec,
                            midRollAdWaitSec,
                            adClickEnabled,
                            adClickDelayMinSec,
                            adClickDelayMaxSec,
                            adClickVisitSec,
                          }}
                          onChange={(patch) => {
                            if (patch.adSkipEnabled !== undefined) setAdSkipEnabled(patch.adSkipEnabled);
                            if (patch.adSkipMaxSec !== undefined) setAdSkipMaxSec(patch.adSkipMaxSec);
                            if (patch.midRollAdWaitSec !== undefined) setMidRollAdWaitSec(patch.midRollAdWaitSec);
                            if (patch.adClickEnabled !== undefined) setAdClickEnabled(patch.adClickEnabled);
                            if (patch.adClickDelayMinSec !== undefined) setAdClickDelayMinSec(patch.adClickDelayMinSec);
                            if (patch.adClickDelayMaxSec !== undefined) setAdClickDelayMaxSec(patch.adClickDelayMaxSec);
                            if (patch.adClickVisitSec !== undefined) setAdClickVisitSec(patch.adClickVisitSec);
                          }}
                        />
                        <label className="text-xs text-gray-500 block mt-3 mb-1">Videos per profile (sequential)</label>
                        <input type="number" min={1} max={10} value={videosPerProfile}
                          onChange={e => setVideosPerProfile(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                          className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm" />
                      </div>
                      <div className="flex items-center gap-3 pt-1">
                        <span className="text-xs text-gray-400 flex-1">⏸ Pause %</span>
                        <input type="range" min={0} max={50} step={2} value={pauseProbabilityPct} onChange={e => setPauseProbabilityPct(Number(e.target.value))} className="w-24 accent-gray-400" />
                        <span className="text-white text-xs font-mono w-8 text-right">{pauseProbabilityPct}%</span>
                      </div>
                      {/* Captions */}
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-xs text-gray-300">📝 Captions (CC)</span>
                        <button onClick={() => setCaptionsEnabled(v => !v)} className={`relative w-9 h-5 rounded-full transition-all ${captionsEnabled ? 'bg-indigo-500' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${captionsEnabled ? 'left-4' : 'left-0.5'}`} />
                        </button>
                      </div>
                      {/* Playback Speed */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">⚡ Speed</span>
                        <select value={playbackSpeed} onChange={e => setPlaybackSpeed(e.target.value)}
                          className="bg-gray-800 border border-gray-700 text-gray-200 rounded px-2 py-0.5 text-xs focus:outline-none">
                          {['0.75x','1x','1.25x','1.5x','1.75x','2x'].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                      {/* Natural Scroll */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">🖱 Natural scroll</span>
                        <button onClick={() => setNaturalScrollCurves(v => !v)} className={`relative w-9 h-5 rounded-full transition-all ${naturalScrollCurves ? 'bg-teal-500' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${naturalScrollCurves ? 'left-4' : 'left-0.5'}`} />
                        </button>
                      </div>
                      {/* Unique Typing */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">⌨️ Unique typing</span>
                        <button onClick={() => setUniqueTypingPersonality(v => !v)} className={`relative w-9 h-5 rounded-full transition-all ${uniqueTypingPersonality ? 'bg-violet-500' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${uniqueTypingPersonality ? 'left-4' : 'left-0.5'}`} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ─── TAB: Traffic Source ─── */}
            {activeSettingsTab === 'traffic' && (
              <div className="p-5">
                <div className="max-w-lg space-y-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs text-gray-400 font-semibold uppercase tracking-wider">Traffic Source Distribution</h3>
                    <span className="text-[10px] text-gray-500">Must total 100%</span>
                  </div>
                  {disabledList.length > 0 && (
                    <p className="text-[10px] text-amber-400/90 p-2 rounded-lg bg-amber-950/20 border border-amber-800/30">
                      Settings me band: {disabledList.join(', ')} — sliders hide, backend auto-skip karega.
                    </p>
                  )}
                  <div className="space-y-4">
                    {[
                      { id: 'notification', label: '🔔 Notification', value: srcNotif, set: setSrcNotif, color: 'accent-yellow-500' },
                      { id: 'search', label: '🔍 YouTube Search', value: srcSearch, set: setSrcSearch, color: 'accent-blue-500' },
                      { id: 'homepage', label: '🏠 Homepage', value: srcHome, set: setSrcHome, color: 'accent-green-500' },
                      { id: 'google', label: '🌐 Google Search', value: srcGoogle, set: setSrcGoogle, color: 'accent-red-400' },
                      { id: 'bing', label: '🔷 Bing Search', value: srcBing, set: setSrcBing, color: 'accent-purple-400' },
                      { id: 'channel_discovery', label: '📺 Channel Discovery', value: srcChannelDisc, set: setSrcChannelDisc, color: 'accent-orange-400' },
                    ].filter(s => isEnabled(s.id)).map(s => (
                      <div key={s.id} className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-300 font-medium">{s.label}</span>
                          <span className="text-white text-xs font-mono bg-gray-800 border border-gray-700 px-2 py-0.5 rounded">{s.value}%</span>
                        </div>
                        <input type="range" min={0} max={100} step={5} value={s.value} onChange={e => s.set(Number(e.target.value))} className={`w-full h-1.5 rounded-full appearance-none bg-gray-700 ${s.color}`} />
                      </div>
                    ))}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300 font-medium">🔗 Direct URL</span>
                        <span className="text-gray-400 text-xs font-mono bg-gray-800 border border-gray-700 px-2 py-0.5 rounded">{srcDirect}%</span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-gray-700"><div className="h-full rounded-full bg-gray-500 transition-all" style={{ width: `${srcDirect}%` }} /></div>
                      <p className="text-[10px] text-gray-600">Auto-calculated: 100 - (Notif + YT Search + Home + Google + Bing + Channel Disc)</p>
                    </div>
                  </div>
                  {srcNotif + srcSearch + srcHome > 100 && (
                    <p className="text-yellow-500 text-[10px] flex items-center gap-1"><AlertTriangle size={10} /> Total &gt; 100% — Direct = 0%</p>
                  )}
                  <div className="p-3 rounded-xl bg-blue-900/10 border border-blue-800/30">
                    <p className="text-[10px] text-blue-400/80 leading-relaxed">💡 Diversified traffic looks natural. Avoid 100% from one source.</p>
                  </div>
                </div>
              </div>
            )}
          </div>

        {/* ═══ PROFILE TABLE ═══ */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
            <h2 className="text-white font-semibold text-sm flex items-center gap-2">
              <span className="w-4 h-4 rounded-full text-[9px] font-black text-white flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg,#EA4335 25%,#FBBC05 50%,#34A853 75%,#4285F4 100%)' }}>G</span>
              Gmail Profiles ({selectedProfiles.length}/{gmailProfiles.length})
            </h2>
            <div className="flex items-center gap-3">
              {controlMode === 'same' && <button onClick={applyGlobalPct} className="text-xs text-blue-400 hover:text-blue-300">↺ Re-randomize</button>}
              <button onClick={() => setSelectedIds(new Set(gmailProfiles.map(p => p.id)))} className="text-xs text-gray-400 hover:text-white">All</button>
              <button onClick={() => setSelectedIds(new Set())} className="text-xs text-gray-400 hover:text-white">None</button>
            </div>
          </div>

          {gmailProfiles.length === 0 ? (
            <div className="py-10 text-center space-y-3">
              <AlertTriangle size={28} className="text-yellow-500 mx-auto" />
              <p className="text-gray-400 text-sm font-medium">No Gmail profiles found</p>
              <p className="text-gray-600 text-xs">Add Gmail credentials in the Gmail Setup page first</p>
              {setActiveTab && (
                <button onClick={() => setActiveTab('gmail-setup')} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-700/40 border border-blue-600/40 text-blue-300 text-xs font-medium hover:bg-blue-700/60 transition-all">
                  <Mail size={13} /> Gmail Setup →
                </button>
              )}
            </div>
          ) : controlMode === 'same' ? (
            /* Same for All: Simple selection table (no per-profile toggles) */
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-800/60 border-b border-gray-700/50">
                    <th className="px-3 py-2.5 text-left w-8" />
                    <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Profile</th>
                    <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Email</th>
                    <th className="px-3 py-2.5 text-center text-gray-500 font-medium">Source</th>
                    <th className="px-3 py-2.5 text-center text-gray-500 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/40">
                  {gmailProfiles.map(p => {
                    const meta = gmailMeta[p.id];
                    const isSel = selectedIds.has(p.id);
                    const ov = profileOverrides[p.id];
                    return (
                      <tr key={p.id} className={`transition-all hover:bg-gray-800/30 ${isSel ? '' : 'opacity-40'}`}>
                        <td className="px-3 py-2.5">
                          <input type="checkbox" checked={isSel} onChange={() => setSelectedIds(prev => { const next = new Set(prev); next.has(p.id) ? next.delete(p.id) : next.add(p.id); return next; })} className="accent-red-500 cursor-pointer" />
                        </td>
                        <td className="px-3 py-2.5 text-white font-medium truncate max-w-[120px]">{p.name}</td>
                        <td className="px-3 py-2.5 max-w-[160px]"><span className="truncate block text-red-300/70 font-mono">{meta?.email || '—'}</span></td>
                        <td className="px-2 py-2.5 text-center">
                          <select value={enabledSourceOptions.some(s => s.id === (ov?.source || 'direct')) ? (ov?.source || 'direct') : (enabledSourceOptions[0]?.id ?? 'direct')} onChange={e => setOverride(p.id, 'source', e.target.value as Source)}
                            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-1.5 py-1 text-[10px] focus:outline-none cursor-pointer">
                            {enabledSourceOptions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <span className={`text-[10px] font-semibold ${p.status === 'running' ? 'text-green-400' : 'text-gray-500'}`}>
                            {p.status === 'running' ? '● Ready' : '○ ' + p.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            /* Per Profile: Full toggle table */
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-800/60 border-b border-gray-700/50">
                    <th className="px-3 py-2.5 text-left w-8" />
                    <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Profile</th>
                    <th className="px-3 py-2.5 text-center text-gray-500 font-medium">Source</th>
                    {ACTION_COLS.map(col => (
                      <th key={col.key} className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[44px]">
                        <button title={`Toggle all ${col.label}`} onClick={() => toggleColAll(col.key)}
                          className={`flex items-center justify-center gap-0.5 mx-auto px-1.5 py-0.5 rounded transition-all ${colAllChecked(col.key) ? 'text-white bg-gray-700 ring-1 ring-gray-500' : 'text-gray-600 hover:text-gray-400'}`}>
                          <span>{col.emoji}</span><ChevronDown size={8} />
                        </button>
                      </th>
                    ))}
                    <th className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[70px]">🎬 Quality</th>
                    <th className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[64px]">⏱ Watch%</th>
                    <th className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[56px]">🔊 Vol%</th>
                    <th className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[44px]">⏭ Seek</th>
                    <th className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[44px]">⏭ Skip</th>
                    <th className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[44px]">🖱 Click</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/40">
                  {gmailProfiles.map(p => {
                    const isSel = selectedIds.has(p.id);
                    const ov = profileOverrides[p.id];
                    return (
                      <tr key={p.id} className={`transition-all hover:bg-gray-800/30 ${isSel ? '' : 'opacity-40'}`}>
                        <td className="px-3 py-2.5"><input type="checkbox" checked={isSel} onChange={() => setSelectedIds(prev => { const next = new Set(prev); next.has(p.id) ? next.delete(p.id) : next.add(p.id); return next; })} className="accent-red-500 cursor-pointer" /></td>
                        <td className="px-3 py-2.5 text-white font-medium truncate max-w-[120px]">{p.name}</td>
                        <td className="px-2 py-2.5 text-center">
                          <select value={enabledSourceOptions.some(s => s.id === (ov?.source || 'direct')) ? (ov?.source || 'direct') : (enabledSourceOptions[0]?.id ?? 'direct')} onChange={e => setOverride(p.id, 'source', e.target.value as Source)}
                            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-1.5 py-1 text-[10px] focus:outline-none cursor-pointer">
                            {enabledSourceOptions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                        </td>
                        {ACTION_COLS.map(col => (
                          <td key={col.key} className="px-2 py-2.5 text-center">
                            <input type="checkbox" checked={ov?.[col.key] ?? false} onChange={e => setOverride(p.id, col.key, e.target.checked)} className="accent-red-500 cursor-pointer w-3.5 h-3.5" />
                          </td>
                        ))}
                        {/* Per-profile: Quality */}
                        <td className="px-1 py-2 text-center">
                          <select value={ov?.quality ?? videoQuality} onChange={e => setOverride(p.id, 'quality', e.target.value as VideoQuality)}
                            className="bg-gray-800 border border-gray-700 text-gray-300 rounded px-1 py-0.5 text-[10px] focus:outline-none w-full cursor-pointer">
                            {QUALITY_OPTIONS.map(q => <option key={q} value={q}>{q}</option>)}
                          </select>
                        </td>
                        {/* Per-profile: Watch % RANGE (min–max, random within) */}
                        <td className="px-1 py-2 text-center">
                          <div className="flex items-center justify-center gap-0.5">
                            <input type="number" min={10} max={100} step={5} title="Watch % minimum"
                              value={ov?.watchMin ?? watchPctMin}
                              onChange={e => { const v = Math.max(10, Math.min(100, Number(e.target.value))); setOverride(p.id, 'watchMin', v); if (v > (ov?.watchMax ?? watchPctMax)) setOverride(p.id, 'watchMax', v); }}
                              className="w-10 bg-gray-800 border border-gray-700 text-white text-[10px] text-center rounded px-1 py-0.5 focus:outline-none" />
                            <span className="text-[9px] text-gray-600">–</span>
                            <input type="number" min={10} max={100} step={5} title="Watch % maximum"
                              value={ov?.watchMax ?? watchPctMax}
                              onChange={e => { const v = Math.max(10, Math.min(100, Number(e.target.value))); setOverride(p.id, 'watchMax', v); if (v < (ov?.watchMin ?? watchPctMin)) setOverride(p.id, 'watchMin', v); }}
                              className="w-10 bg-gray-800 border border-gray-700 text-white text-[10px] text-center rounded px-1 py-0.5 focus:outline-none" />
                            <span className="text-[9px] text-gray-600 ml-0.5">%</span>
                          </div>
                        </td>
                        {/* Per-profile: Volume % RANGE (min–max, random within) */}
                        <td className="px-1 py-2 text-center">
                          <div className="flex items-center justify-center gap-0.5">
                            <input type="number" min={0} max={100} step={5} title="Volume % minimum"
                              value={ov?.volMin ?? volumeMin}
                              onChange={e => { const v = Math.max(0, Math.min(100, Number(e.target.value))); setOverride(p.id, 'volMin', v); if (v > (ov?.volMax ?? volumeMax)) setOverride(p.id, 'volMax', v); }}
                              className="w-10 bg-gray-800 border border-gray-700 text-white text-[10px] text-center rounded px-1 py-0.5 focus:outline-none" />
                            <span className="text-[9px] text-gray-600">–</span>
                            <input type="number" min={0} max={100} step={5} title="Volume % maximum"
                              value={ov?.volMax ?? volumeMax}
                              onChange={e => { const v = Math.max(0, Math.min(100, Number(e.target.value))); setOverride(p.id, 'volMax', v); if (v < (ov?.volMin ?? volumeMin)) setOverride(p.id, 'volMin', v); }}
                              className="w-10 bg-gray-800 border border-gray-700 text-white text-[10px] text-center rounded px-1 py-0.5 focus:outline-none" />
                            <span className="text-[9px] text-gray-600 ml-0.5">%</span>
                          </div>
                        </td>
                        {/* Per-profile: Seek toggle */}
                        <td className="px-2 py-2.5 text-center">
                          <input type="checkbox" checked={ov?.seekEnabled ?? seekEnabled} onChange={e => setOverride(p.id, 'seekEnabled', e.target.checked)} className="accent-cyan-500 cursor-pointer w-3.5 h-3.5" />
                        </td>
                        {/* Per-profile: Ad skip toggle */}
                        <td className="px-2 py-2.5 text-center">
                          <input type="checkbox" checked={ov?.adSkip ?? adSkipEnabled} onChange={e => setOverride(p.id, 'adSkip', e.target.checked)} className="accent-blue-500 cursor-pointer w-3.5 h-3.5" />
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <input type="checkbox" checked={ov?.adClick ?? adClickEnabled} onChange={e => setOverride(p.id, 'adClick', e.target.checked)} className="accent-amber-500 cursor-pointer w-3.5 h-3.5" title="1 ad click per video" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="px-5 py-2 border-t border-gray-800">
            <p className="text-[10px] text-gray-600">
              {controlMode === 'same' ? 'ℹ️ Settings upar se apply hongi sab selected profiles pe equally.' : 'ℹ️ Har profile ka individually toggle karo — unique engagement pattern.'}
            </p>
          </div>
        </div>

        {/* ═══ QUEUE STATUS (Collapsible) ═══ */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <button onClick={() => setQueueExpanded(v => !v)} className="w-full px-5 py-3 flex items-center justify-between hover:bg-gray-800/20 transition-all">
            <div className="flex items-center gap-3">
              <h2 className="text-white font-semibold text-sm flex items-center gap-2">
                <Clock size={15} className="text-blue-400" /> Queue Status
                {queueStatus && queueStatus.running > 0 && <span className="inline-flex h-2 w-2 rounded-full bg-blue-400 animate-ping" />}
              </h2>
              {queueStatus && (
                <div className="flex items-center gap-2">
                  {queueStatus.done > 0 && <span className="text-[11px] text-green-400">{queueStatus.done} done</span>}
                  {(queueStatus.partial ?? 0) > 0 && <span className="text-[11px] text-amber-400">{queueStatus.partial} partial</span>}
                  {queueStatus.failed > 0 && <span className="text-[11px] text-red-400">{queueStatus.failed} failed</span>}
                  {queueStatus.running > 0 && <span className="text-[11px] text-blue-400">{queueStatus.running} running</span>}
                  {queueStatus.pending > 0 && <span className="text-[11px] text-yellow-400">{queueStatus.pending} pending</span>}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {queueStatus && queueStatus.total > 0 && (
                <button onClick={(e) => { e.stopPropagation(); void clearEngagementJobs().then(pollStatus); }} className="text-[10px] text-gray-600 hover:text-gray-400">Clear</button>
              )}
              <span className="text-gray-500 text-xs">{queueExpanded ? '▲' : '▼'}</span>
            </div>
          </button>

          {queueExpanded && (
            <div className="border-t border-gray-800 px-5 py-4 space-y-2 max-h-[400px] overflow-y-auto">
              {(!queueStatus || queueStatus.total === 0) ? (
                <div className="flex flex-col items-center py-6 text-gray-600">
                  <Clock size={24} className="mb-2 opacity-30" />
                  <p className="text-xs">No jobs yet — launch to see activity</p>
                </div>
              ) : (queueStatus.jobs ?? []).map((job: EngagementJobStatus) => {
                const cfg = STATUS_CFG[job.status] ?? STATUS_CFG.pending;
                const isOpen = job.status === 'running' || expandedJob === job.id;
                return (
                  <div key={job.id} className={`border rounded-xl overflow-hidden transition-colors ${job.status === 'running' ? 'bg-blue-950/20 border-blue-800/40' : job.status === 'failed' ? 'bg-red-950/20 border-red-800/40' : job.status === 'partial' ? 'bg-amber-950/20 border-amber-800/40' : job.status === 'done' ? 'bg-green-950/10 border-green-900/30' : 'bg-gray-800/50 border-gray-700/60'}`}>
                    <div className="flex items-center gap-3 px-4 py-2.5 cursor-pointer" onClick={() => setExpandedJob(isOpen && job.status !== 'running' ? null : job.id)}>
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
                      <span className="text-white text-xs font-medium flex-1 truncate">{job.profileName}</span>
                      <span className="text-[10px] text-gray-500 bg-gray-800/80 px-1.5 py-0.5 rounded flex-shrink-0">
                        {job.source === 'notification' ? '🔔'
                          : job.source === 'search'   ? '🔍'
                          : job.source === 'homepage' ? '🏠'
                          : job.source === 'google'   ? '🌐'
                          : job.source === 'bing'     ? '🔷'
                          : '🔗'}
                      </span>
                      <span className="text-[10px] flex gap-0.5 flex-shrink-0">
                        {job.actions?.like && <span>👍</span>}{job.actions?.subscribe && <span>📺</span>}{job.actions?.comment && <span>💬</span>}
                      </span>
                      <span className={`text-xs font-semibold flex-shrink-0 ${cfg.color}`}>
                        {cfg.label}
                        {(job.videosOk != null || job.videosFailed != null) && job.status !== 'running' && job.status !== 'pending' && (
                          <span className="text-gray-500 font-normal ml-1">
                            ({job.videosOk ?? 0}✓/{job.videosFailed ?? 0}✗)
                          </span>
                        )}
                      </span>
                    </div>
                    {isOpen && (
                      <div className="border-t border-gray-700/40 px-4 py-3 space-y-1 bg-black/20">
                        {job.error && <p className="text-red-400 text-xs bg-red-950/30 px-2 py-1 rounded mb-2 font-mono">❌ {job.error}</p>}
                        {(job.log ?? []).length === 0 ? (
                          <p className="text-gray-600 text-xs italic">Waiting for first log...</p>
                        ) : (job.log ?? []).map((l, i) => (
                          <p key={i} className={`text-xs font-mono flex gap-2 ${i === (job.log ?? []).length - 1 && job.status === 'running' ? 'text-blue-300' : 'text-gray-400'}`}>
                            <span className="text-gray-600 flex-shrink-0">{new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                            <span>{l.msg}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>

      {/* ═══ STICKY LAUNCH BAR ═══ */}
      <div className="sticky bottom-0 z-50 bg-gray-950/95 backdrop-blur-md border-t border-gray-800 px-6 py-4">
        <div className="max-w-[1440px] mx-auto flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-5">
            <div className="text-sm text-gray-300">
              🚀 <span className="text-white font-bold">{launchProfiles.length} profiles</span> × <span className="text-white font-bold">{videoQueue.length} video{videoQueue.length !== 1 ? 's' : ''}</span>
              {videoQueue.length > 0 && launchProfiles.length > 0 && <span className="text-red-400 font-bold ml-1">= {launchProfiles.length} sessions</span>}
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>Gap: <span className="text-gray-300">{startGapMinSec}-{startGapMaxSec}s</span></span>
              <span>Max: <span className="text-gray-300">{activeLaunchLimit}</span></span>
              <span>Watch: <span className="text-gray-300">{watchPctMin}-{watchPctMax}%</span></span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Launch config */}
            <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-1.5">
              <span className="text-[10px] text-gray-500">Max:</span>
              <input type="number" min={1} max={Math.max(1, selectedProfiles.length)} value={Math.min(activeLaunchLimit, Math.max(1, selectedProfiles.length || 1))}
                onChange={(e) => setActiveLaunchLimit(Math.max(1, Number(e.target.value) || 1))}
                className="w-10 bg-transparent text-white text-xs text-center focus:outline-none" />
            </div>
            <button onClick={() => void handleLaunch()} disabled={launching || !videoQueue.length || !launchProfiles.length}
              className="flex items-center gap-2 px-8 py-3 rounded-xl text-white text-sm font-bold transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: 'var(--mmb-grad)', backgroundSize: '160% 160%',
                boxShadow: '0 8px 24px var(--mmb-accent-glow)', border: 'none',
                letterSpacing: '.02em',
              }}>
              {launching ? <><RefreshCw size={15} className="animate-spin" /> Launching…</> : <><Zap size={15} /> LAUNCH ENGAGEMENT</>}
            </button>
          </div>
        </div>
        {launchMsg && (
          <p className={`text-xs text-center mt-2 font-medium ${launchMsg.startsWith('✅') ? 'text-green-400' : 'text-red-400'}`}>{launchMsg}</p>
        )}
      </div>
    </div>
  );
}
