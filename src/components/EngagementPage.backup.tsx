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
}

const ACTION_COLS: { key: keyof Omit<ProfileOverride, 'source'>; emoji: string; label: string; color: string }[] = [
  { key: 'like',             emoji: '👍', label: 'Like',    color: 'text-green-400'  },
  { key: 'dislike',          emoji: '👎', label: 'Dislike', color: 'text-red-400'    },
  { key: 'subscribe',        emoji: '📺', label: 'Sub',     color: 'text-blue-400'   },
  { key: 'bell',             emoji: '🔔', label: 'Bell',    color: 'text-yellow-400' },
  { key: 'comment',          emoji: '💬', label: 'Comment', color: 'text-purple-400' },
  { key: 'descriptionLinks', emoji: '🔗', label: 'Links',   color: 'text-orange-400' },
];

interface Props {
  profiles:      Profile[];
  channels?:     Channel[];
  getVideos?:    (channelId: number, filter?: string) => Video[];
  setActiveTab?: (tab: string) => void;
}

export default function EngagementPage({ profiles, channels = [], getVideos, setActiveTab }: Props) {

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
  const [videoQuality,       setVideoQuality]       = useState<VideoQuality>('auto');
  const [activeLaunchLimit,  setActiveLaunchLimit]  = useState(20);
  const [startGapMinSec,     setStartGapMinSec]     = useState(10);
  const [startGapMaxSec,     setStartGapMaxSec]     = useState(25);
  const [srcNotif,           setSrcNotif]           = useState(20);
  const [srcSearch,          setSrcSearch]          = useState(30);
  const [srcHome,            setSrcHome]            = useState(30);

  // ── Per-profile overrides ─────────────────────────────────────────────────────
  const [profileOverrides, setProfileOverrides] = useState<Record<string, ProfileOverride>>({});
  const [selectedIds,      setSelectedIds]      = useState<Set<string>>(new Set());

  // ── Queue status ──────────────────────────────────────────────────────────────
  const [queueStatus,  setQueueStatus]  = useState<EngagementQueueStatus | null>(null);
  const [expandedJob,  setExpandedJob]  = useState<string | null>(null);
  const [launching,    setLaunching]    = useState(false);
  const [launchMsg,    setLaunchMsg]    = useState('');

  // ── Derived ──────────────────────────────────────────────────────────────────
  const gmailIds      = getGmailProfileIds();
  const gmailMeta     = getAllGmailProfiles();
  const gmailProfiles = profiles.filter(p => gmailIds.includes(p.id));
  const activeChannels = useMemo(() => channels.filter(c => c.status === 'active'), [channels]);
  const srcDirect = Math.max(0, 100 - srcNotif - srcSearch - srcHome);

  // ── Helper: build a default override for a profile ───────────────────────────
  // NOTE: captures current slider state at call time — fine for event handlers
  function makeDefault(): ProfileOverride {
    const roll = rand(1, 100);
    const source: Source =
      roll <= srcNotif                          ? 'notification' :
      roll <= srcNotif + srcSearch              ? 'search' :
      roll <= srcNotif + srcSearch + srcHome    ? 'homepage' :
      'direct';
    return {
      source,
      like:             Math.random() * 100 < likePct,
      dislike:          Math.random() * 100 < dislikePct,
      subscribe:        Math.random() * 100 < subscribePct,
      bell:             Math.random() * 100 < bellPct,
      comment:          Math.random() * 100 < commentPct,
      descriptionLinks: descDefault,
    };
  }

  // Init overrides + selection when profiles list changes
  useEffect(() => {
    setSelectedIds(new Set(gmailProfiles.map(p => p.id)));
    setProfileOverrides(prev => {
      const next = { ...prev };
      gmailProfiles.forEach(p => { if (!next[p.id]) next[p.id] = makeDefault(); });
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles.length]);

  function applyGlobalPct() {
    setProfileOverrides(prev => {
      const next = { ...prev };
      gmailProfiles.forEach(p => {
        if (selectedIds.has(p.id)) next[p.id] = makeDefault();
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

  // Bulk toggle a column for all selected profiles
  function toggleColAll(key: keyof Omit<ProfileOverride, 'source'>) {
    const sel = gmailProfiles.filter(p => selectedIds.has(p.id));
    const allOn = sel.length > 0 && sel.every(p => profileOverrides[p.id]?.[key] ?? false);
    setProfileOverrides(prev => {
      const next = { ...prev };
      sel.forEach(p => { next[p.id] = { ...(next[p.id] ?? makeDefault()), [key]: !allOn }; });
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
      const ov = profileOverrides[p.id] ?? makeDefault();
      const commentText =
        ov.comment && templates.length > 0
          ? templates[rand(0, templates.length - 1)].text
          : '';
      // Random watch% between min-max per profile (human-like variation)
      const profileWatchPct = rand(watchPctMin, watchPctMax);
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
          volumePct,
          commentLikePct,
          seekEnabled,
          seekDirection,
          pauseProbability:  pauseProbabilityPct / 100,
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
    const result = await startEngagement({
      profiles: buildProfiles(),
      watchPct: rand(watchPctMin, watchPctMax), // default fallback
      adSkipEnabled,
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
  }

  const selectedProfiles = gmailProfiles.filter(p => selectedIds.has(p.id));
  const launchProfiles = selectedProfiles.slice(0, Math.max(1, activeLaunchLimit));

  // ─────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">

      {/* ── Header ── */}
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
            <button
              onClick={() => setActiveTab('analytics')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-900/30 border border-blue-700/40 text-blue-400 text-xs font-medium hover:bg-blue-900/50 transition-all"
            >
              <BarChart2 size={13} /> View Analytics →
            </button>
          )}
          {queueStatus && (queueStatus.pending > 0 || queueStatus.running > 0) && (
            <button
              onClick={() => void cancelEngagement().then(pollStatus)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-900/30 border border-red-700/40 text-red-400 text-xs font-medium hover:bg-red-900/50"
            >
              <XCircle size={13} /> Cancel All
            </button>
          )}
        </div>
      </div>

      {/* ── Section 1: Video Queue ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            <Film size={15} className="text-red-400" />
            Video Queue
            {videoQueue.length > 0 && (
              <span className="text-xs text-gray-500 font-normal">
                — {videoQueue.length} video{videoQueue.length !== 1 ? 's' : ''} ·&nbsp;
                {videoQueue.length} tab{videoQueue.length !== 1 ? 's' : ''} per profile
              </span>
            )}
          </h2>
          <button
            onClick={() => setPickerOpen(o => !o)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
              pickerOpen
                ? 'bg-red-900/30 border-red-600/40 text-red-400'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'
            }`}
          >
            <Plus size={12} /> Add Video
            {pickerOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        </div>

        {/* Queue chips */}
        {videoQueue.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {videoQueue.map((v, idx) => {
              const videoId = v.url.match(/[?&]v=([^&]+)/)?.[1] ?? '';
              return (
                <div
                  key={idx}
                  className="flex items-center gap-2 px-2 py-1.5 bg-gray-800/70 border border-gray-700/60 rounded-xl"
                >
                  <div className="flex items-center justify-center text-xs text-gray-600 font-mono w-4 flex-shrink-0">
                    {idx + 1}
                  </div>
                  {videoId && (
                    <img
                      src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
                      alt=""
                      className="w-14 h-8 object-cover rounded flex-shrink-0"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs text-white font-medium truncate max-w-[150px]">
                      {v.title || v.url}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate max-w-[150px]">{v.channelName || '—'}</p>
                  </div>
                  <button
                    onClick={() => setVideoQueue(prev => prev.filter((_, i) => i !== idx))}
                    className="text-gray-600 hover:text-red-400 flex-shrink-0"
                  >
                    <XCircle size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {videoQueue.length === 0 && !pickerOpen && (
          <p className="text-xs text-gray-600 text-center py-3">
            Koi video nahi — "Add Video" click karo aur channel se video chunno
          </p>
        )}

        {/* ── Inline Picker ── */}
        {pickerOpen && (
          <div className="border border-gray-700/60 rounded-xl overflow-hidden">
            {/* Channel row + Shuffle */}
            <div className="flex items-center gap-2 p-3 bg-gray-800/40 border-b border-gray-700/50">
              <Tv size={13} className="text-gray-500 flex-shrink-0" />
              <select
                value={pickerChannelId ?? ''}
                onChange={e => {
                  setPickerChannelId(e.target.value ? Number(e.target.value) : null);
                  setPickerSearch('');
                }}
                className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-gray-500"
              >
                <option value="">— Channel select karo —</option>
                {activeChannels.map(ch => (
                  <option key={ch.id} value={ch.id}>
                    {ch.channel_name} ({getVideos ? getVideos(ch.id).length : 0} videos)
                  </option>
                ))}
              </select>
              <button
                onClick={shuffleAdd}
                disabled={!pickerChannelId}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-700/40 border border-purple-600/40 text-purple-300 text-xs font-medium disabled:opacity-30 hover:bg-purple-700/60 transition-all flex-shrink-0"
              >
                <Shuffle size={12} /> Shuffle
              </button>
            </div>

            {pickerChannelId && (
              <>
                {/* Search */}
                <div className="px-3 py-2 bg-gray-800/20 border-b border-gray-700/40">
                  <div className="relative">
                    <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                    <input
                      type="text" placeholder="Title search..."
                      value={pickerSearch}
                      onChange={e => setPickerSearch(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-lg pl-7 pr-3 py-1.5 text-xs focus:outline-none focus:border-gray-500"
                    />
                  </div>
                </div>

                {/* Video list */}
                <div className="max-h-52 overflow-y-auto divide-y divide-gray-800/60">
                  {pickerVideos.length === 0 ? (
                    <p className="text-center text-gray-600 text-xs py-5">Koi enabled video nahi mili</p>
                  ) : pickerVideos.map(video => {
                    const ch    = activeChannels.find(c => c.id === pickerChannelId);
                    const added = videoQueue.some(q => q.url === video.url);
                    return (
                      <div
                        key={video.video_id}
                        onClick={() => !added && addToQueue(video, ch?.channel_name ?? '')}
                        className={`flex items-center gap-3 px-3 py-2.5 group transition-all ${
                          added ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-gray-800/50'
                        }`}
                      >
                        <div className="w-16 h-9 rounded bg-gray-800 overflow-hidden flex-shrink-0">
                          <img
                            src={video.thumbnail || `https://i.ytimg.com/vi/${video.video_id}/mqdefault.jpg`}
                            alt="" className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-gray-200 font-medium truncate">{video.title}</p>
                          <p className="text-[10px] text-gray-600 flex items-center gap-2 mt-0.5">
                            {video.views > 0    && <span>👁 {video.views.toLocaleString()}</span>}
                            {video.duration > 0 && (
                              <span>⏱ {Math.floor(video.duration / 60)}:{String(video.duration % 60).padStart(2, '0')}</span>
                            )}
                          </p>
                        </div>
                        {added
                          ? <span className="text-green-500 text-[10px] flex-shrink-0">✓ Added</span>
                          : <Plus size={13} className="text-gray-600 group-hover:text-gray-300 flex-shrink-0" />
                        }
                      </div>
                    );
                  })}
                </div>

                <div className="px-3 py-1.5 bg-gray-800/20 border-t border-gray-700/40">
                  <p className="text-[10px] text-gray-600">
                    {pickerVideos.length} video(s) · click to add · "Shuffle" for random pick
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Section 2: Settings two-column ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

        {/* Left: Engagement Settings */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold text-sm flex items-center gap-2">
              <ThumbsUp size={15} className="text-green-400" /> Engagement Settings
            </h2>
            <button
              onClick={applyGlobalPct}
              className="text-[10px] text-blue-400 hover:text-blue-300 border border-blue-700/30 px-2 py-0.5 rounded"
            >
              Apply % → All
            </button>
          </div>

          {/* Like */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">👍 Like</span>
            <input type="range" min={0} max={100} step={5} value={likePct}
              onChange={e => setLikePct(Number(e.target.value))} className="flex-1 accent-green-500" />
            <span className="text-white text-xs font-mono w-8 text-right">{likePct}%</span>
          </div>
          {/* Dislike */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">👎 Dislike</span>
            <input type="range" min={0} max={100} step={5} value={dislikePct}
              onChange={e => setDislikePct(Number(e.target.value))} className="flex-1 accent-red-500" />
            <span className="text-white text-xs font-mono w-8 text-right">{dislikePct}%</span>
          </div>
          {/* Subscribe */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">📺 Subscribe</span>
            <input type="range" min={0} max={100} step={5} value={subscribePct}
              onChange={e => setSubscribePct(Number(e.target.value))} className="flex-1 accent-blue-500" />
            <span className="text-white text-xs font-mono w-8 text-right">{subscribePct}%</span>
          </div>
          {/* Bell */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">🔔 Bell</span>
            <input type="range" min={0} max={100} step={5} value={bellPct}
              onChange={e => setBellPct(Number(e.target.value))} className="flex-1 accent-yellow-500" />
            <span className="text-white text-xs font-mono w-8 text-right">{bellPct}%</span>
          </div>
          {/* Comment */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">💬 Comment</span>
            <input type="range" min={0} max={100} step={5} value={commentPct}
              onChange={e => setCommentPct(Number(e.target.value))} className="flex-1 accent-purple-500" />
            <span className="text-white text-xs font-mono w-8 text-right">{commentPct}%</span>
          </div>
          {/* Comment Like */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">👍💬 Cmt Like</span>
            <input type="range" min={0} max={100} step={5} value={commentLikePct}
              onChange={e => setCommentLikePct(Number(e.target.value))} className="flex-1 accent-pink-500" />
            <span className="text-white text-xs font-mono w-8 text-right">{commentLikePct}%</span>
          </div>
          {/* Volume */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">🔊 Volume</span>
            <input type="range" min={20} max={100} step={5} value={volumePct}
              onChange={e => setVolumePct(Number(e.target.value))} className="flex-1 accent-teal-500" />
            <span className="text-white text-xs font-mono w-8 text-right">{volumePct}%</span>
          </div>
          {/* Pause probability */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0">⏸ Pause prob</span>
            <input type="range" min={0} max={50} step={2} value={pauseProbabilityPct}
              onChange={e => setPauseProbabilityPct(Number(e.target.value))} className="flex-1 accent-gray-400" />
            <span className="text-white text-xs font-mono w-8 text-right">{pauseProbabilityPct}%</span>
          </div>

          <div className="border-t border-gray-800 pt-3 space-y-3">
            {/* Seek controls */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <SkipForward size={13} className="text-cyan-400" />
                  <span className="text-xs text-gray-300">Seek (j/l keys)</span>
                </div>
                <button
                  onClick={() => setSeekEnabled(v => !v)}
                  className={`relative w-10 h-5 rounded-full transition-all ${seekEnabled ? 'bg-cyan-500' : 'bg-gray-700'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${seekEnabled ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
              {seekEnabled && (
                <div className="flex gap-1.5 pl-5">
                  {(['forward', 'backward', 'both'] as const).map(d => (
                    <button key={d} onClick={() => setSeekDirection(d)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] border transition-all ${seekDirection === d ? 'border-cyan-500 bg-cyan-900/30 text-cyan-300' : 'border-gray-700 bg-gray-800 text-gray-500 hover:border-gray-600'}`}>
                      {d === 'forward' ? '→ Forward' : d === 'backward' ? '← Backward' : '↔ Both'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Description expand */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ChevronDown size={13} className="text-amber-400" />
                <span className="text-xs text-gray-300">Description expand</span>
              </div>
              <button
                onClick={() => setDescExpandEnabled(v => !v)}
                className={`relative w-10 h-5 rounded-full transition-all ${descExpandEnabled ? 'bg-amber-500' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${descExpandEnabled ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>

            {/* Description links */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Link size={13} className="text-orange-400" />
                <span className="text-xs text-gray-300">Description links open</span>
              </div>
              <button
                onClick={() => setDescDefault(v => !v)}
                className={`relative w-10 h-5 rounded-full transition-all ${descDefault ? 'bg-orange-500' : 'bg-gray-700'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${descDefault ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>

            {/* Ads skip */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <SkipForward size={13} className="text-blue-400" />
                  <span className="text-xs text-gray-300">Skip ads automatically</span>
                </div>
                <button
                  onClick={() => setAdSkipEnabled(v => !v)}
                  className={`relative w-10 h-5 rounded-full transition-all ${adSkipEnabled ? 'bg-blue-500' : 'bg-gray-700'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${adSkipEnabled ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
              {!adSkipEnabled && (
                <p className="text-[10px] text-yellow-500/80 pl-5">
                  ⏳ Ads naturally finish hone ka wait karega (max ~2 min per ad)
                </p>
              )}
              {adSkipEnabled && (
                <p className="text-[10px] text-blue-400/70 pl-5">
                  ⚡ Skip button dikhte hi click karta hai (max 10 attempts)
                </p>
              )}
            </div>

            {/* Video quality */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Play size={13} className="text-purple-400" />
                <span className="text-xs text-gray-300">Video quality</span>
              </div>
              <select
                value={videoQuality}
                onChange={e => setVideoQuality(e.target.value as VideoQuality)}
                className="bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none"
              >
                {QUALITY_OPTIONS.map(q => <option key={q} value={q}>{q === 'auto' ? 'Auto' : q}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Right: Timing & Traffic */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            <Clock size={15} className="text-blue-400" /> Timing & Traffic
          </h2>

          {/* Watch % — min/max range, random per profile */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">⏱ Watch % (random per profile)</span>
              <span className="text-white text-xs font-mono bg-gray-800 px-2 py-0.5 rounded">
                {watchPctMin}–{watchPctMax}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-6">Min</span>
              <input type="range" min={10} max={100} step={5} value={watchPctMin}
                onChange={e => {
                  const v = Number(e.target.value);
                  setWatchPctMin(v);
                  if (v > watchPctMax) setWatchPctMax(v);
                }} className="flex-1 accent-blue-500" />
              <span className="text-blue-400 text-xs font-mono w-8 text-right">{watchPctMin}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-500 w-6">Max</span>
              <input type="range" min={10} max={100} step={5} value={watchPctMax}
                onChange={e => {
                  const v = Number(e.target.value);
                  setWatchPctMax(v);
                  if (v < watchPctMin) setWatchPctMin(v);
                }} className="flex-1 accent-green-500" />
              <span className="text-green-400 text-xs font-mono w-8 text-right">{watchPctMax}%</span>
            </div>
            <p className="text-[10px] text-gray-600">Each profile gets a random % between min–max</p>
          </div>

          <div className="border-t border-gray-800 pt-3 space-y-3">
            <p className="text-xs text-gray-500">Traffic source mix</p>

            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-32 flex-shrink-0">🔔 Notification</span>
              <input type="range" min={0} max={100} step={5} value={srcNotif}
                onChange={e => setSrcNotif(Number(e.target.value))} className="flex-1 accent-red-500" />
              <span className="text-white text-xs font-mono w-8 text-right">{srcNotif}%</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-32 flex-shrink-0">🔍 Search</span>
              <input type="range" min={0} max={100} step={5} value={srcSearch}
                onChange={e => setSrcSearch(Number(e.target.value))} className="flex-1 accent-blue-500" />
              <span className="text-white text-xs font-mono w-8 text-right">{srcSearch}%</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-32 flex-shrink-0">🏠 Homepage</span>
              <input type="range" min={0} max={100} step={5} value={srcHome}
                onChange={e => setSrcHome(Number(e.target.value))} className="flex-1 accent-green-500" />
              <span className="text-white text-xs font-mono w-8 text-right">{srcHome}%</span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-32 flex-shrink-0">🔗 Direct URL</span>
              <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gray-500 rounded-full transition-all"
                  style={{ width: `${srcDirect}%` }}
                />
              </div>
              <span className="text-gray-400 text-xs font-mono w-8 text-right">{srcDirect}%</span>
            </div>

            {srcNotif + srcSearch + srcHome > 100 && (
              <p className="text-yellow-500 text-[10px] flex items-center gap-1">
                <AlertTriangle size={10} /> Total &gt; 100% — Direct = 0%
              </p>
            )}
          </div>

          {/* Preview */}
          {videoQueue.length > 0 && selectedProfiles.length > 0 && (
            <div className="mt-2 pt-3 border-t border-gray-800 grid grid-cols-2 gap-2 text-xs">
              <div className="bg-gray-800/50 rounded-lg px-3 py-2">
                <span className="text-gray-500 block">Profiles</span>
                <p className="text-white font-semibold">{selectedProfiles.length}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg px-3 py-2">
                <span className="text-gray-500 block">Tabs/profile</span>
                <p className="text-white font-semibold">{videoQueue.length}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg px-3 py-2">
                <span className="text-gray-500 block">Spread over</span>
                <p className="text-white font-semibold">~{Math.round(selectedProfiles.length * 3)} min</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg px-3 py-2">
                <span className="text-gray-500 block">Total jobs</span>
                <p className="text-yellow-400 font-semibold">{selectedProfiles.length}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Section 3: Profile Table ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            <span
              className="w-4 h-4 rounded-full text-[9px] font-black text-white flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg,#EA4335 25%,#FBBC05 50%,#34A853 75%,#4285F4 100%)' }}
            >G</span>
            Gmail Profiles ({selectedProfiles.length}/{gmailProfiles.length})
          </h2>
          <div className="flex items-center gap-3">
            <button onClick={applyGlobalPct}
              className="text-xs text-blue-400 hover:text-blue-300">↺ Re-randomize</button>
            <button onClick={() => setSelectedIds(new Set(gmailProfiles.map(p => p.id)))}
              className="text-xs text-gray-400 hover:text-white">All</button>
            <button onClick={() => setSelectedIds(new Set())}
              className="text-xs text-gray-400 hover:text-white">None</button>
          </div>
        </div>

        {gmailProfiles.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <AlertTriangle size={28} className="text-yellow-500 mx-auto" />
            <p className="text-gray-400 text-sm font-medium">Koi Gmail profile nahi hai</p>
            <p className="text-gray-600 text-xs">
              Pehle Gmail Setup page mein profiles ka email + password bharo aur login karo
            </p>
            {setActiveTab && (
              <button
                onClick={() => setActiveTab('gmail-setup')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-700/40 border border-blue-600/40 text-blue-300 text-xs font-medium hover:bg-blue-700/60 transition-all"
              >
                <Mail size={13} /> Gmail Setup page pe jao →
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-800/60 border-b border-gray-700/50">
                  <th className="px-3 py-2.5 text-left w-8" />
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Profile</th>
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Email</th>
                  <th className="px-3 py-2.5 text-center text-gray-500 font-medium">Source</th>
                  {ACTION_COLS.map(col => (
                    <th key={col.key} className="px-2 py-2.5 text-center text-gray-500 font-medium min-w-[44px]">
                      <button
                        title={`Toggle all ${col.label}`}
                        onClick={() => toggleColAll(col.key)}
                        className={`flex items-center justify-center gap-0.5 mx-auto px-1.5 py-0.5 rounded transition-all ${
                          colAllChecked(col.key)
                            ? 'text-white bg-gray-700 ring-1 ring-gray-500'
                            : 'text-gray-600 hover:text-gray-400'
                        }`}
                      >
                        <span>{col.emoji}</span>
                        <ChevronDown size={8} />
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/40">
                {gmailProfiles.map(p => {
                  const meta  = gmailMeta[p.id];
                  const isSel = selectedIds.has(p.id);
                  const ov    = profileOverrides[p.id];
                  return (
                    <tr key={p.id}
                      className={`transition-all hover:bg-gray-800/30 ${isSel ? '' : 'opacity-40'}`}
                    >
                      {/* Select */}
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox" checked={isSel}
                          onChange={() => setSelectedIds(prev => {
                            const next = new Set(prev);
                            next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                            return next;
                          })}
                          className="accent-red-500 cursor-pointer"
                        />
                      </td>
                      {/* Name */}
                      <td className="px-3 py-2.5 text-white font-medium max-w-[120px]">
                        <span className="truncate block">{p.name}</span>
                      </td>
                      {/* Email */}
                      <td className="px-3 py-2.5 max-w-[160px]">
                        <span className="truncate block text-red-300/70 font-mono">
                          {meta?.email || '—'}
                        </span>
                      </td>
                      {/* Source */}
                      <td className="px-2 py-2.5 text-center">
                        <select
                          value={ov?.source || 'direct'}
                          onChange={e => setOverride(p.id, 'source', e.target.value as Source)}
                          className="bg-gray-800 border border-gray-700 text-gray-300 rounded-lg px-1.5 py-1 text-[10px] focus:outline-none cursor-pointer"
                        >
                          <option value="notification">🔔 Notif</option>
                          <option value="search">🔍 Search</option>
                          <option value="homepage">🏠 Home</option>
                          <option value="direct">🔗 Direct</option>
                        </select>
                      </td>
                      {/* Action checkboxes */}
                      {ACTION_COLS.map(col => (
                        <td key={col.key} className="px-2 py-2.5 text-center">
                          <input
                            type="checkbox"
                            checked={ov?.[col.key] ?? false}
                            onChange={e => setOverride(p.id, col.key, e.target.checked)}
                            className="accent-red-500 cursor-pointer w-3.5 h-3.5"
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Launch Control ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <h2 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Clock size={15} className="text-yellow-400" /> Launch Control</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Profiles to open now</label>
            <input type="number" min={1} max={Math.max(1, selectedProfiles.length)} value={Math.min(activeLaunchLimit, Math.max(1, selectedProfiles.length || 1))}
              onChange={(e) => setActiveLaunchLimit(Math.max(1, Math.min(selectedProfiles.length || 1, Number(e.target.value) || 1)))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm" />
            <p className="text-[10px] text-gray-600 mt-1">Extra selected profiles queue/refill nahi honge.</p>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Start gap min (sec)</label>
            <input type="number" min={0} max={600} value={startGapMinSec}
              onChange={(e) => setStartGapMinSec(Math.max(0, Number(e.target.value) || 0))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Start gap max (sec)</label>
            <input type="number" min={startGapMinSec} max={900} value={startGapMaxSec}
              onChange={(e) => setStartGapMaxSec(Math.max(startGapMinSec, Number(e.target.value) || startGapMinSec))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm" />
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-3">Example: 10 selected, profiles to open = 3 → sirf 3 jobs start honge; 4th auto-start nahi hoga.</p>
      </div>

      {/* ── Launch ── */}
      <div className="space-y-2">
        <button
          onClick={() => void handleLaunch()}
          disabled={launching || !videoQueue.length || !launchProfiles.length}
          className="w-full py-3.5 rounded-2xl bg-gradient-to-r from-red-600 to-red-500 text-white font-bold text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:from-red-500 hover:to-red-400 transition-all shadow-lg shadow-red-900/30 flex items-center justify-center gap-2"
        >
          {launching
            ? <><RefreshCw size={15} className="animate-spin" /> Launching…</>
            : <>
                <Zap size={15} />
                Start Engagement — {launchProfiles.length}/{selectedProfiles.length} profiles
                {videoQueue.length > 0 && ` × ${videoQueue.length} video${videoQueue.length > 1 ? 's' : ''}`}
              </>
          }
        </button>
        {launchMsg && (
          <p className={`text-sm text-center font-medium ${launchMsg.startsWith('✅') ? 'text-green-400' : 'text-red-400'}`}>
            {launchMsg}
          </p>
        )}
      </div>

      {/* ── Queue Status — always visible ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            <Clock size={15} className="text-blue-400" /> Live Activity
            {/* Live pulse when something is running */}
            {queueStatus && queueStatus.running > 0 && (
              <span className="inline-flex h-2 w-2 rounded-full bg-blue-400 animate-ping" />
            )}
          </h2>
          <div className="flex items-center gap-3 flex-wrap">
            {queueStatus && ([
              { label: 'Pending', val: queueStatus.pending, color: 'text-yellow-400' },
              { label: 'Running', val: queueStatus.running, color: 'text-blue-400'   },
              { label: 'Done',    val: queueStatus.done,    color: 'text-green-400'  },
              { label: 'Failed',  val: queueStatus.failed,  color: 'text-red-400'    },
            ] as const).map(({ label, val, color }) => val > 0 && (
              <span key={label} className={`text-xs font-medium ${color}`}>{val} {label}</span>
            ))}
            <button
              onClick={() => void pollStatus()}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 ml-1"
              title="Refresh"
            >
              <RefreshCw size={11} /> Refresh
            </button>
            {queueStatus && queueStatus.total > 0 && (
              <button
                onClick={() => void clearEngagementJobs().then(pollStatus)}
                className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-400"
              >
                <Trash2 size={11} /> Clear done
              </button>
            )}
          </div>
        </div>

        {/* Empty state */}
        {(!queueStatus || queueStatus.total === 0) ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-600">
            <Clock size={28} className="mb-2 opacity-30" />
            <p className="text-xs">No jobs yet — launch engagement to see live activity here</p>
            <p className="text-[10px] mt-1 opacity-60">Polling every 3s · Server: {queueStatus ? '🟢 connected' : '🔴 connecting...'}</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
            {(queueStatus.jobs ?? []).map((job: EngagementJobStatus) => {
              const cfg    = STATUS_CFG[job.status] ?? STATUS_CFG.pending;
              // Auto-expand running jobs; manual toggle for others
              const isOpen = job.status === 'running' || expandedJob === job.id;
              const delayMin = Math.round((job.scheduledAt - Date.now()) / 60000);
              return (
                <div key={job.id}
                  className={`border rounded-xl overflow-hidden transition-colors ${
                    job.status === 'running'
                      ? 'bg-blue-950/20 border-blue-800/40'
                      : job.status === 'failed'
                      ? 'bg-red-950/20 border-red-800/40'
                      : job.status === 'done'
                      ? 'bg-green-950/10 border-green-900/30'
                      : 'bg-gray-800/50 border-gray-700/60'
                  }`}
                >
                  {/* Header row */}
                  <div
                    className="flex items-center gap-3 px-4 py-2.5 cursor-pointer"
                    onClick={() => setExpandedJob(isOpen && job.status !== 'running' ? null : job.id)}
                  >
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
                    <span className="text-white text-xs font-medium flex-1 truncate">{job.profileName}</span>

                    {(job.videoCount ?? 1) > 1 && (
                      <span className="text-[10px] text-gray-500 flex-shrink-0">📹 {job.videoCount}</span>
                    )}
                    <span className="text-[10px] text-gray-500 bg-gray-800/80 px-1.5 py-0.5 rounded flex-shrink-0">
                      {job.source === 'notification' ? '🔔' : job.source === 'search' ? '🔍' : job.source === 'homepage' ? '🏠' : '🔗'} {job.source}
                    </span>
                    <span className="text-[10px] flex gap-0.5 flex-shrink-0">
                      {job.actions?.like             && <span title="Like">👍</span>}
                      {job.actions?.dislike          && <span title="Dislike">👎</span>}
                      {job.actions?.subscribe        && <span title="Subscribe">📺</span>}
                      {job.actions?.bell             && <span title="Bell">🔔</span>}
                      {job.actions?.comment          && <span title="Comment">💬</span>}
                      {job.actions?.descriptionLinks && <span title="Links">🔗</span>}
                    </span>
                    <span className={`text-xs font-semibold flex-shrink-0 ${cfg.color}`}>{cfg.label}</span>
                    {job.status === 'pending' && delayMin > 0 && (
                      <span className="text-[10px] text-gray-600 flex-shrink-0">in {delayMin}m</span>
                    )}
                    {job.status !== 'running'
                      ? (isOpen
                          ? <ChevronUp size={13} className="text-gray-500 flex-shrink-0" />
                          : <ChevronDown size={13} className="text-gray-500 flex-shrink-0" />)
                      : null
                    }
                  </div>

                  {/* Log section — auto-open for running, toggle for others */}
                  {isOpen && (
                    <div className="border-t border-gray-700/40 px-4 py-3 space-y-1 bg-black/20">
                      {job.error && (
                        <p className="text-red-400 text-xs bg-red-950/30 px-2 py-1 rounded mb-2 font-mono">
                          ❌ {job.error}
                        </p>
                      )}
                      {(job.log ?? []).length === 0 ? (
                        <p className="text-gray-600 text-xs italic">Waiting for first log entry...</p>
                      ) : (
                        <>
                          {(job.log ?? []).map((l, i) => {
                            const isLast = i === (job.log ?? []).length - 1;
                            return (
                              <p key={i} className={`text-xs font-mono flex gap-2 ${isLast && job.status === 'running' ? 'text-blue-300' : 'text-gray-400'}`}>
                                <span className="text-gray-600 flex-shrink-0">
                                  {new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                                <span>{l.msg}</span>
                              </p>
                            );
                          })}
                          {job.status === 'running' && (
                            <p className="text-blue-500 text-[10px] font-mono animate-pulse pt-1">▌ running...</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
