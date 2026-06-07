import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ThumbsUp, Link, Play,
  RefreshCw, XCircle, Clock, Zap, Plus, Trash2,
  ChevronDown, ChevronUp, AlertTriangle, Shuffle, Tv,
  Search, SkipForward, Film, BarChart2, Mail,
} from 'lucide-react';
import type { Profile } from '../types';
import type { Channel, Video } from '../store/useChannelStore';
import { getGmailProfileIds, getAllGmailProfiles } from '../utils/gmailProfileStore';
import {
  startEngagement, fetchEngagementStatus, cancelEngagement, clearEngagementJobs,
  type EngagementQueueStatus, type EngagementJobStatus, type VideoTarget,
} from '../utils/engagementApi';

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
type Source = 'notification' | 'search' | 'direct' | 'homepage';

interface ProfileOverride {
  source:           Source;
  like:             boolean;
  dislike:          boolean;
  subscribe:        boolean;
  bell:             boolean;
  comment:          boolean;
  descriptionLinks: boolean;
  // Per-profile settings (user decides from tool — Rule: jo tool se set karo wahi use ho)
  quality:          VideoQuality;
  watchPct:         number;   // exact watch % (e.g. 80)
  volumePct:        number;   // volume level per profile
  seekEnabled:      boolean;
  adSkip:           boolean;
}

const ACTION_COLS: { key: 'like' | 'dislike' | 'subscribe' | 'bell' | 'comment' | 'descriptionLinks'; emoji: string; label: string; color: string }[] = [
  { key: 'like',             emoji: '👍', label: 'Like',    color: 'text-green-400'  },
  { key: 'dislike',          emoji: '👎', label: 'Dislike', color: 'text-red-400'    },
  { key: 'subscribe',        emoji: '📺', label: 'Sub',     color: 'text-blue-400'   },
  { key: 'bell',             emoji: '🔔', label: 'Bell',    color: 'text-yellow-400' },
  { key: 'comment',          emoji: '💬', label: 'Comment', color: 'text-purple-400' },
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
  profiles:      Profile[];
  channels?:     Channel[];
  getVideos?:    (channelId: number, filter?: string) => Video[];
  setActiveTab?: (tab: string) => void;
}

export default function EngagementPage({ profiles, channels = [], getVideos, setActiveTab }: Props) {

  // ── UI State ─────────────────────────────────────────────────────────────────
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>('engagement');
  const [controlMode, setControlMode] = useState<ControlMode>('same');
  const [activePreset, setActivePreset] = useState<PresetName>('natural');

  // ── Video Queue ──────────────────────────────────────────────────────────────
  const [videoQueue, setVideoQueue]         = useState<VideoTarget[]>([]);
  const [pickerOpen, setPickerOpen]         = useState(false);
  const [pickerChannelId, setPickerChannelId] = useState<number | null>(null);
  const [pickerSearch, setPickerSearch]     = useState('');

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
  const [seekEnabled,        setSeekEnabled]        = useState(true);
  const [seekDirection,      setSeekDirection]      = useState<'forward' | 'backward' | 'both'>('forward');
  const [pauseProbabilityPct,setPauseProbabilityPct]= useState(12);
  const [watchPctMin,        setWatchPctMin]        = useState(80);
  const [watchPctMax,        setWatchPctMax]        = useState(100);
  const [adSkipEnabled,      setAdSkipEnabled]      = useState(true);
  const [adSkipDelaySec,     setAdSkipDelaySec]     = useState(10);
  const [adSkipDelayMaxSec,  setAdSkipDelayMaxSec]  = useState(14);
  const [videoQuality,       setVideoQuality]       = useState<VideoQuality>('auto');
  const [activeLaunchLimit,  setActiveLaunchLimit]  = useState(20);
  const [startGapMinSec,     setStartGapMinSec]     = useState(10);
  const [startGapMaxSec,     setStartGapMaxSec]     = useState(25);
  const [srcNotif,           setSrcNotif]           = useState(20);
  const [srcSearch,          setSrcSearch]          = useState(30);
  const [srcHome,            setSrcHome]            = useState(30);
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

  // ── Derived ──────────────────────────────────────────────────────────────────
  const gmailIds      = getGmailProfileIds();
  const gmailMeta     = getAllGmailProfiles();
  const gmailProfiles = profiles.filter(p => gmailIds.includes(p.id));
  const activeChannels = useMemo(() => channels.filter(c => c.status === 'active'), [channels]);
  const srcDirect = Math.max(0, 100 - srcNotif - srcSearch - srcHome);

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
    // Refresh per-profile toggles from new percentages
    setTimeout(() => applyGlobalPct(), 0);
  }

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
    const source: Source =
      roll <= srcNotif                          ? 'notification' :
      roll <= srcNotif + srcSearch              ? 'search' :
      roll <= srcNotif + srcSearch + srcHome    ? 'homepage' :
      'direct';
    const count = Math.max(1, profileCount);
    return {
      source,
      like:             pctSlotOn(likePct, profileIndex, count),
      dislike:          pctSlotOn(dislikePct, profileIndex, count),
      subscribe:        pctSlotOn(subscribePct, profileIndex, count),
      bell:             pctSlotOn(bellPct, profileIndex, count),
      comment:          pctSlotOn(commentPct, profileIndex, count),
      descriptionLinks: descDefault,
      // Per-profile defaults from global settings (user can override per-profile)
      quality:     videoQuality,
      watchPct:    rand(watchPctMin, watchPctMax),
      volumePct:   volumePct,
      seekEnabled: seekEnabled,
      adSkip:      adSkipEnabled,
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

  // ── Picker logic ─────────────────────────────────────────────────────────────
  const pickerVideos = useMemo(() => {
    if (!pickerChannelId || !getVideos) return [];
    const vids = getVideos(pickerChannelId);
    const q = pickerSearch.trim().toLowerCase();
    return q ? vids.filter(v => v.title.toLowerCase().includes(q)) : vids;
  }, [pickerChannelId, getVideos, pickerSearch]);

  function addToQueue(video: Video, channelName: string) {
    setVideoQueue(prev => [...prev, { url: video.url, title: video.title, channelName }]);
    setPickerOpen(false);
    setPickerChannelId(null);
    setPickerSearch('');
  }

  function shuffleAdd() {
    if (!pickerChannelId || !getVideos) return;
    const vids = getVideos(pickerChannelId);
    if (!vids.length) return;
    const ch = activeChannels.find(c => c.id === pickerChannelId);
    addToQueue(vids[Math.floor(Math.random() * vids.length)], ch?.channel_name ?? '');
  }

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
      // Rule: jo tool se set karo wahi use ho — per-profile values, not global random
      const profileWatchPct = ov.watchPct ?? rand(watchPctMin, watchPctMax);
      const profileQuality  = ov.quality   ?? videoQuality;
      const profileVolume   = ov.volumePct ?? volumePct;
      const profileSeek     = ov.seekEnabled ?? seekEnabled;
      const profileAdSkip   = ov.adSkip    ?? adSkipEnabled;
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
          commentLikePct,
          seekEnabled:       profileSeek,
          seekDirection,
          pauseProbability:  pauseProbabilityPct / 100,
          adSkipEnabled:     profileAdSkip,
          adSkipDelaySec,
          adSkipDelayMaxSec,
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
        videos:   videoQueue,
        watchPct: profileWatchPct,
      };
    });
  }

  async function handleLaunch() {
    if (!videoQueue.length)  { setLaunchMsg('❌ Pehle koi video add karo'); return; }
    if (!selectedIds.size)   { setLaunchMsg('❌ Koi Gmail profile select nahi'); return; }
    setLaunching(true);
    setLaunchMsg('');
    try {
      const result = await startEngagement({
        profiles: buildProfiles(),
        watchPct: rand(watchPctMin, watchPctMax),
        adSkipEnabled,
        adSkipDelaySec,
        adSkipDelayMaxSec,
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
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Zap size={22} className="text-yellow-400" /> Engagement Engine
            </h1>
            <p className="text-gray-500 text-sm mt-1">
              Gmail profiles → YouTube → like / comment / subscribe — human-like staggered timing
            </p>
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

        {/* ═══ VIDEO QUEUE ═══ */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold text-sm flex items-center gap-2">
              <Film size={15} className="text-red-400" /> Video Queue
              {videoQueue.length > 0 && <span className="text-xs text-gray-500 font-normal">— {videoQueue.length} video{videoQueue.length !== 1 ? 's' : ''}</span>}
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setPickerOpen(o => !o)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${pickerOpen ? 'bg-red-900/30 border-red-600/40 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'}`}>
                <Plus size={12} /> Add Video {pickerOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </button>
              {videoQueue.length > 0 && (
                <button onClick={() => setVideoQueue([])} className="text-xs text-gray-600 hover:text-red-400 transition-all">Clear all</button>
              )}
            </div>
          </div>

          {/* Queue chips horizontal */}
          {videoQueue.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {videoQueue.map((v, idx) => {
                const videoId = v.url.match(/[?&]v=([^&]+)/)?.[1] ?? '';
                return (
                  <div key={idx} className="flex items-center gap-2 px-3 py-2 bg-gray-800/70 border border-gray-700/60 rounded-xl min-w-[240px] flex-shrink-0 hover:border-gray-600 transition-all">
                    <span className="text-xs text-gray-600 font-mono w-4 flex-shrink-0">#{idx + 1}</span>
                    {videoId && <img src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`} alt="" className="w-14 h-8 object-cover rounded flex-shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-white font-medium truncate">{v.title || v.url}</p>
                      <p className="text-[10px] text-gray-500 truncate">{v.channelName || '—'}</p>
                    </div>
                    <button onClick={() => setVideoQueue(prev => prev.filter((_, i) => i !== idx))} className="text-gray-600 hover:text-red-400 flex-shrink-0">
                      <XCircle size={13} />
                    </button>
                  </div>
                );
              })}
              {/* Add placeholder */}
              <div onClick={() => setPickerOpen(true)} className="flex items-center justify-center px-6 py-2 border-2 border-dashed border-gray-700/60 rounded-xl min-w-[100px] flex-shrink-0 hover:border-red-700/40 transition-all cursor-pointer group">
                <span className="text-gray-600 text-xs group-hover:text-red-400">＋ Add</span>
              </div>
            </div>
          )}

          {videoQueue.length === 0 && !pickerOpen && (
            <p className="text-xs text-gray-600 text-center py-3">Koi video nahi — "Add Video" click karo aur channel se video chunno</p>
          )}

          {/* Inline Picker */}
          {pickerOpen && (
            <div className="border border-gray-700/60 rounded-xl overflow-hidden">
              <div className="flex items-center gap-2 p-3 bg-gray-800/40 border-b border-gray-700/50">
                <Tv size={13} className="text-gray-500 flex-shrink-0" />
                <select value={pickerChannelId ?? ''} onChange={e => { setPickerChannelId(e.target.value ? Number(e.target.value) : null); setPickerSearch(''); }}
                  className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-gray-500">
                  <option value="">— Channel select karo —</option>
                  {activeChannels.map(ch => <option key={ch.id} value={ch.id}>{ch.channel_name} ({getVideos ? getVideos(ch.id).length : 0} videos)</option>)}
                </select>
                <button onClick={shuffleAdd} disabled={!pickerChannelId}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-700/40 border border-purple-600/40 text-purple-300 text-xs font-medium disabled:opacity-30 hover:bg-purple-700/60 transition-all flex-shrink-0">
                  <Shuffle size={12} /> Shuffle
                </button>
              </div>
              {pickerChannelId && (
                <>
                  <div className="px-3 py-2 bg-gray-800/20 border-b border-gray-700/40">
                    <div className="relative">
                      <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                      <input type="text" placeholder="Title search..." value={pickerSearch} onChange={e => setPickerSearch(e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-lg pl-7 pr-3 py-1.5 text-xs focus:outline-none focus:border-gray-500" />
                    </div>
                  </div>
                  <div className="max-h-52 overflow-y-auto divide-y divide-gray-800/60">
                    {pickerVideos.length === 0 ? (
                      <p className="text-center text-gray-600 text-xs py-5">Koi enabled video nahi mili</p>
                    ) : pickerVideos.map(video => {
                      const ch = activeChannels.find(c => c.id === pickerChannelId);
                      const added = videoQueue.some(q => q.url === video.url);
                      return (
                        <div key={video.video_id} onClick={() => !added && addToQueue(video, ch?.channel_name ?? '')}
                          className={`flex items-center gap-3 px-3 py-2.5 group transition-all ${added ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-800/50'}`}>
                          <div className="w-16 h-9 rounded bg-gray-800 overflow-hidden flex-shrink-0">
                            <img src={video.thumbnail || `https://i.ytimg.com/vi/${video.video_id}/mqdefault.jpg`} alt="" className="w-full h-full object-cover" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-gray-200 font-medium truncate">{video.title}</p>
                            <p className="text-[10px] text-gray-600 flex items-center gap-2 mt-0.5">
                              {video.views > 0 && <span>👁 {video.views.toLocaleString()}</span>}
                              {video.duration > 0 && <span>⏱ {Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, '0')}</span>}
                            </p>
                          </div>
                          {added ? <span className="text-green-500 text-[10px] flex-shrink-0">✓ Added</span> : <Plus size={13} className="text-gray-600 group-hover:text-gray-300 flex-shrink-0" />}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* ═══ CONTROL MODE TOGGLE ═══ */}
        <div className="flex items-center gap-3 px-1">
          <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Control:</span>
          <button onClick={() => setControlMode('same')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all ${controlMode === 'same' ? 'bg-red-600/15 border-red-500 text-red-300' : 'bg-gray-800/50 border-gray-700 text-gray-500'}`}>
            ● Same for All
          </button>
          <button onClick={() => setControlMode('perprofile')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all ${controlMode === 'perprofile' ? 'bg-red-600/15 border-red-500 text-red-300' : 'bg-gray-800/50 border-gray-700 text-gray-500'}`}>
            ○ Per Profile Custom
          </button>
          <span className="text-[10px] text-gray-600 ml-2">← ek source of truth, no conflict</span>
        </div>

        {/* ═══ TABBED SETTINGS (Same for All mode) ═══ */}
        {controlMode === 'same' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-gray-800 px-5 pt-3">
              {([
                { id: 'engagement' as const, label: '👍 Engagement' },
                { id: 'playback' as const, label: '▶ Playback' },
                { id: 'traffic' as const, label: '🌐 Traffic Source' },
              ]).map(tab => (
                <button key={tab.id} onClick={() => setActiveSettingsTab(tab.id)}
                  className={`px-5 py-3 text-sm font-semibold transition-all rounded-t-lg ${activeSettingsTab === tab.id ? 'border-b-2 border-red-500 text-white bg-red-500/5' : 'border-b-2 border-transparent text-gray-500 hover:text-gray-300'}`}>
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
                      <span className="text-xs text-gray-400 w-14">Volume</span>
                      <input type="range" min={20} max={100} step={5} value={volumePct} onChange={e => setVolumePct(Number(e.target.value))} className="flex-1 accent-cyan-500" />
                      <span className="text-white text-xs font-mono w-10 bg-gray-800 border border-gray-700 px-1.5 py-0.5 rounded text-center">{volumePct}%</span>
                    </div>
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
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-300">⏩ Skip ads</span>
                        <button onClick={() => setAdSkipEnabled(v => !v)} className={`relative w-9 h-5 rounded-full transition-all ${adSkipEnabled ? 'bg-blue-500' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${adSkipEnabled ? 'left-4' : 'left-0.5'}`} />
                        </button>
                      </div>
                      {adSkipEnabled && (
                        <div className="pl-3 space-y-2 border-l-2 border-blue-700/40">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 w-8">Min</span>
                            <input type="range" min={1} max={30} value={adSkipDelaySec} onChange={e => setAdSkipDelaySec(Number(e.target.value))} className="flex-1 h-1 accent-blue-500" />
                            <span className="text-[10px] text-white font-mono w-6">{adSkipDelaySec}s</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 w-8">Max</span>
                            <input type="range" min={1} max={30} value={adSkipDelayMaxSec} onChange={e => setAdSkipDelayMaxSec(Number(e.target.value))} className="flex-1 h-1 accent-blue-500" />
                            <span className="text-[10px] text-white font-mono w-6">{adSkipDelayMaxSec}s</span>
                          </div>
                          <p className="text-[9px] text-gray-600">Random {adSkipDelaySec}-{adSkipDelayMaxSec}s delay before "Skip Ad" click</p>
                        </div>
                      )}
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
                  <div className="space-y-4">
                    {[
                      { label: '🔔 Notification', value: srcNotif, set: setSrcNotif, color: 'accent-yellow-500' },
                      { label: '🔍 YouTube Search', value: srcSearch, set: setSrcSearch, color: 'accent-blue-500' },
                      { label: '🏠 Homepage', value: srcHome, set: setSrcHome, color: 'accent-green-500' },
                    ].map(s => (
                      <div key={s.label} className="space-y-1.5">
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
                      <p className="text-[10px] text-gray-600">Auto-calculated: 100 - (Notif + Search + Home)</p>
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
        )}

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
              <p className="text-gray-400 text-sm font-medium">Koi Gmail profile nahi hai</p>
              <p className="text-gray-600 text-xs">Pehle Gmail Setup page mein profiles ka email bharo</p>
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
                          <select value={ov?.source || 'direct'} onChange={e => setOverride(p.id, 'source', e.target.value as Source)}
                            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-1.5 py-1 text-[10px] focus:outline-none cursor-pointer">
                            <option value="notification">🔔 Notif</option>
                            <option value="search">🔍 Search</option>
                            <option value="homepage">🏠 Home</option>
                            <option value="direct">🔗 Direct</option>
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
                    <th className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[44px]">🚫 Ad</th>
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
                          <select value={ov?.source || 'direct'} onChange={e => setOverride(p.id, 'source', e.target.value as Source)}
                            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-1.5 py-1 text-[10px] focus:outline-none cursor-pointer">
                            <option value="notification">🔔</option><option value="search">🔍</option><option value="homepage">🏠</option><option value="direct">🔗</option>
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
                        {/* Per-profile: Watch % */}
                        <td className="px-1 py-2 text-center">
                          <input type="number" min={10} max={100} step={5}
                            value={ov?.watchPct ?? rand(watchPctMin, watchPctMax)}
                            onChange={e => setOverride(p.id, 'watchPct', Math.max(10, Math.min(100, Number(e.target.value))))}
                            className="w-12 bg-gray-800 border border-gray-700 text-white text-[10px] text-center rounded px-1 py-0.5 focus:outline-none" />
                          <span className="text-[9px] text-gray-600 ml-0.5">%</span>
                        </td>
                        {/* Per-profile: Volume % */}
                        <td className="px-1 py-2 text-center">
                          <input type="number" min={20} max={100} step={5}
                            value={ov?.volumePct ?? volumePct}
                            onChange={e => setOverride(p.id, 'volumePct', Math.max(20, Math.min(100, Number(e.target.value))))}
                            className="w-12 bg-gray-800 border border-gray-700 text-white text-[10px] text-center rounded px-1 py-0.5 focus:outline-none" />
                          <span className="text-[9px] text-gray-600 ml-0.5">%</span>
                        </td>
                        {/* Per-profile: Seek toggle */}
                        <td className="px-2 py-2.5 text-center">
                          <input type="checkbox" checked={ov?.seekEnabled ?? seekEnabled} onChange={e => setOverride(p.id, 'seekEnabled', e.target.checked)} className="accent-cyan-500 cursor-pointer w-3.5 h-3.5" />
                        </td>
                        {/* Per-profile: Ad skip toggle */}
                        <td className="px-2 py-2.5 text-center">
                          <input type="checkbox" checked={ov?.adSkip ?? adSkipEnabled} onChange={e => setOverride(p.id, 'adSkip', e.target.checked)} className="accent-blue-500 cursor-pointer w-3.5 h-3.5" />
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
                        {job.source === 'notification' ? '🔔' : job.source === 'search' ? '🔍' : job.source === 'homepage' ? '🏠' : '🔗'}
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
              className="flex items-center gap-2 px-7 py-3 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-bold shadow-lg shadow-red-900/40 transition-all hover:scale-[1.02] active:scale-95">
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
