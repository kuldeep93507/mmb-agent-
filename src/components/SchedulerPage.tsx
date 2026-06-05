import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Plus, Play, Trash2, Clock, Users, Tv, Square, CheckCircle, XCircle, Loader, Timer, Calendar,
  RotateCcw, Copy, Search, Download, Upload, Pin, AlertTriangle,
} from 'lucide-react';
import type { Profile } from '../types';
import type { Channel, Video } from '../store/useChannelStore';
import LiveProgressPanel from './LiveProgressPanel';
import { backendFetch } from '../services/backendOrigin';
import { postActivityLog } from '../utils/logsApi';
import { profileConfigsForSchedule } from '../utils/profileConfigsForSchedule';
import { mergeShuffleSettingsIntoProfileConfigs } from '../utils/shuffleSettingsForSchedule';
import { PERMANENT_CHANNEL_IDS } from '../data/defaultChannels';
import {
  fetchSchedulesFromServer,
  syncSchedulesToServer,
  setServerScheduleTimer,
  cancelServerScheduleTimer,
  fetchConcurrency,
  fetchScheduleProgress,
} from '../utils/scheduleApi';
import { notifyScheduleComplete, notifyScheduleError } from '../services/notifications';
import { shouldNotifyBrowser } from '../utils/notificationPrefs';
import Step2Videos from './scheduler/Step2Videos';
import ShuffleRunSettingsPanel from './ShuffleRunSettingsPanel';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
interface Schedule {
  id: string;
  name: string;
  selectedProfiles: string[];
  selectedChannels: number[];
  assignmentMode: 'same-all' | 'per-profile';
  sameForAll: { channelId: number; channelName: string; videos: { mode: 'title' | 'url'; value: string; title?: string; url?: string }[] }[];
  perProfile: { profileId: string; channelSelections: { channelId: number; channelName: string; videos: { mode: 'title' | 'url'; value: string; title?: string; url?: string }[] }[] }[];
  profileDelayMin: number;
  profileDelayMax: number;
  tabDelayMin: number;
  tabDelayMax: number;
  runMode: 'manual' | 'countdown' | 'scheduled';
  countdownMinutes: number;
  scheduledTime: number; // timestamp
  repeatEnabled: boolean;
  repeatInterval: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'scheduled' | 'countdown';
  createdAt: number;
  lastRun: number | null;
  startedAt: number | null;
  progress: { total: number; done: number; failed: number };
  profileConfigs?: Record<string, unknown>[];
  lastRunError?: string;
  lastRunMessage?: string;
  /** Passed to server payload when running a schedule (not persisted on Schedule) */
  commentText?: string;
}

interface SchedulerPageProps {
  profiles: Profile[];
  channels: Channel[];
  getVideos: (channelId: number, filter?: string) => Video[];
}

const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function loadSchedules(): Schedule[] {
  try { const d = localStorage.getItem('mmb_schedules_v2'); return d ? JSON.parse(d) : []; } catch { return []; }
}
function saveSchedulesLocal(s: Schedule[]) {
  try { localStorage.setItem('mmb_schedules_v2', JSON.stringify(s)); } catch {}
}

function enrichScheduleForServer(schedule: Schedule, profiles: Profile[]): Schedule {
  return {
    ...schedule,
    profileConfigs: mergeShuffleSettingsIntoProfileConfigs(
      profileConfigsForSchedule(schedule.selectedProfiles, profiles),
    ),
  };
}

function formatCountdown(ms: number) {
  if (ms <= 0) return '00:00:00';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatRunAt(ts: number) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN COMPONENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function SchedulerPage({ profiles, channels, getVideos }: SchedulerPageProps) {
  const [schedules, setSchedules] = useState<Schedule[]>(() => loadSchedules());
  const [serverSynced, setServerSynced] = useState(false);
  const schedulesRef = useRef(schedules);
  useEffect(() => { schedulesRef.current = schedules; }, [schedules]);
  const handleRunRef = useRef<(id: string) => Promise<void>>(async () => {});
  const pollingScheduleIds = useRef<Set<string>>(new Set());
  const [view, setView] = useState<'list' | 'create'>('list');
  const [editId, setEditId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [concurrency, setConcurrency] = useState<{ limit: number; running: number; available: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const remote = await fetchSchedulesFromServer();
      if (cancelled) return;
      if (remote && remote.length > 0) {
        const list = remote as Schedule[];
        setSchedules(list);
        saveSchedulesLocal(list);
        for (const s of list) {
          if (s.status === 'scheduled' && s.scheduledTime > Date.now()) {
            void setServerScheduleTimer(enrichScheduleForServer(s, profiles));
          }
        }
      } else if (schedules.length > 0) {
        void syncSchedulesToServer(schedules);
      }
      setServerSynced(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial hydrate once
  }, []);

  useEffect(() => {
    if (!serverSynced) return;
    saveSchedulesLocal(schedules);
    const t = window.setTimeout(() => { void syncSchedulesToServer(schedules); }, 800);
    return () => clearTimeout(t);
  }, [schedules, serverSynced]);

  useEffect(() => {
    const load = () => { void fetchConcurrency().then(setConcurrency); };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const pollStatus = useCallback((id: string, profileIds: string[]) => {
    const repeatDelayMs: Record<string, number> = {
      '1hr': 60 * 60 * 1000,
      '3hr': 3 * 60 * 60 * 1000,
      '6hr': 6 * 60 * 60 * 1000,
      '12hr': 12 * 60 * 60 * 1000,
      '24hr': 24 * 60 * 60 * 1000,
    };
    const interval = setInterval(async () => {
      try {
        const stats = await fetchScheduleProgress(profileIds);
        if (!stats) return;
        const active = stats.running + stats.waiting;
        if (active === 0 && stats.total > 0) {
          clearInterval(interval);
          const scheduleName = schedulesRef.current.find(s => s.id === id)?.name || 'Schedule';
          if (shouldNotifyBrowser('onScheduleComplete')) {
            notifyScheduleComplete(scheduleName);
          }
          setSchedules(prev => prev.map(s => s.id === id ? {
            ...s,
            status: 'completed',
            progress: { total: stats.total, done: stats.done, failed: stats.error },
            lastRunError: undefined,
          } : s));

          const currentSchedule = schedulesRef.current.find(s => s.id === id);
          if (currentSchedule?.repeatEnabled && currentSchedule.repeatInterval) {
            const delay = repeatDelayMs[currentSchedule.repeatInterval] ?? repeatDelayMs['6hr'];
            window.setTimeout(() => { void handleRunRef.current(id); }, delay);
          }
        } else if (active > 0 || stats.done > 0) {
          setSchedules(prev => prev.map(s => s.id === id ? {
            ...s,
            progress: { total: stats.total, done: stats.done, failed: stats.error },
          } : s));
        }
      } catch { /* transient */ }
    }, 5000);
    window.setTimeout(() => clearInterval(interval), 24 * 60 * 60 * 1000);
  }, []);

  // Live clock (updates every second for countdown timers)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const handleRun = useCallback(async (id: string) => {
    const schedule = schedules.find(s => s.id === id);
    if (!schedule) return;

    const conc = await fetchConcurrency();
    if (conc && schedule.selectedProfiles.length > conc.available) {
      const proceed = window.confirm(
        `Concurrency limit: ${conc.limit} max, ${conc.running} running, ${conc.available} slots free.\n` +
        `You selected ${schedule.selectedProfiles.length} profiles — server will trim to ${conc.available}.\n\nContinue?`,
      );
      if (!proceed) return;
    }

    setSchedules(prev => prev.map(s => s.id === id ? {
      ...s, status: 'running', lastRun: Date.now(), lastRunError: undefined, lastRunMessage: undefined,
      progress: { total: s.selectedProfiles.length, done: 0, failed: 0 },
    } : s));

    try {
      const profileConfigs = mergeShuffleSettingsIntoProfileConfigs(
        profileConfigsForSchedule(schedule.selectedProfiles, profiles),
      );

      let commentText = '';
      try {
        const comments = JSON.parse(localStorage.getItem('mmb_comments') || '[]');
        if (comments.length > 0) commentText = comments[Math.floor(Math.random() * comments.length)].text;
      } catch {}

      const scheduleData = enrichScheduleForServer({
        ...schedule,
        profileConfigs,
        commentText,
        sameForAll: schedule.sameForAll.map(cs => ({
          ...cs,
          channelName: channels.find(c => c.id === cs.channelId)?.channel_name || cs.channelName || '',
        })),
        perProfile: schedule.perProfile.map(pa => ({
          ...pa,
          channelSelections: pa.channelSelections.map(cs => ({
            ...cs,
            channelName: channels.find(c => c.id === cs.channelId)?.channel_name || cs.channelName || '',
          })),
        })),
      }, profiles);

      const res = await backendFetch('/api/schedule/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: scheduleData }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        const err = data.error || `HTTP ${res.status}`;
        void postActivityLog('error', `Scheduler "${schedule.name}" failed: ${err}`, { source: 'scheduler' });
        if (shouldNotifyBrowser('onScheduleError')) notifyScheduleError(schedule.name, err);
        setSchedules(prev => prev.map(s => s.id === id ? { ...s, status: 'failed', lastRunError: err } : s));
        return;
      }
      let msg = data.message || 'Started';
      if (data.trimmed) msg += ` (trimmed to ${data.workersSpawned} — limit ${data.limit})`;
      if (data.skippedNoVideos > 0) msg += ` · ${data.skippedNoVideos} profile(s) skipped (no videos)`;
      setSchedules(prev => prev.map(s => s.id === id ? { ...s, lastRunMessage: msg, profileConfigs } : s));
    } catch (e) {
      const err = e instanceof Error ? e.message : 'Network error';
      void postActivityLog('error', `Scheduler "${schedule.name}" network error: ${err}`, { source: 'scheduler' });
      if (shouldNotifyBrowser('onScheduleError')) notifyScheduleError(schedule.name, err);
      setSchedules(prev => prev.map(s => s.id === id ? { ...s, status: 'failed', lastRunError: err } : s));
      return;
    }

    pollStatus(id, schedule.selectedProfiles);
  }, [schedules, channels, pollStatus, profiles]);

  useEffect(() => {
    handleRunRef.current = handleRun;
  }, [handleRun]);

  // Auto-run countdown schedules (client-side). Fixed time uses server timer.
  useEffect(() => {
    const toRun = schedules.filter(s => {
      if (s.status === 'countdown' && s.startedAt) {
        const runAt = s.startedAt + s.countdownMinutes * 60000;
        return now >= runAt;
      }
      return false;
    });
    if (toRun.length > 0) {
      toRun.forEach(s => { void handleRunRef.current(s.id); });
    }
  }, [now, schedules]);

  // When server starts a scheduled run, sync UI to running
  useEffect(() => {
    const t = setInterval(async () => {
      const list = schedulesRef.current;
      const due = list.filter(s => s.status === 'scheduled' && s.scheduledTime > 0 && s.scheduledTime <= Date.now());
      for (const s of due) {
        const stats = await fetchScheduleProgress(s.selectedProfiles);
        if (!stats || stats.total === 0) continue;
        const active = stats.running + stats.waiting;
        if (active > 0) {
          setSchedules(prev => prev.map(x => x.id === s.id ? {
            ...x,
            status: 'running',
            lastRun: Date.now(),
            progress: { total: stats.total, done: stats.done, failed: stats.error },
          } : x));
          if (!pollingScheduleIds.current.has(s.id)) {
            pollingScheduleIds.current.add(s.id);
            pollStatus(s.id, s.selectedProfiles);
          }
        } else if (stats.done + stats.error >= stats.total) {
          setSchedules(prev => prev.map(x => x.id === s.id ? {
            ...x,
            status: 'completed',
            progress: { total: stats.total, done: stats.done, failed: stats.error },
          } : x));
        }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [pollStatus]);

  const handleStop = async (id: string) => {
    try {
      await backendFetch('/api/schedule/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleId: id }),
      });
    } catch {}
    void cancelServerScheduleTimer(id);
    pollingScheduleIds.current.delete(id);
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, status: 'idle' } : s));
  };

  const handleDelete = (id: string) => {
    const s = schedules.find(x => x.id === id);
    if (!s) return;
    if (!window.confirm(`Delete schedule "${s.name || 'Unnamed'}"?`)) return;
    void cancelServerScheduleTimer(id);
    setSchedules(prev => prev.filter(x => x.id !== id));
  };

  const handleDuplicate = (id: string) => {
    const s = schedules.find(x => x.id === id);
    if (!s) return;
    const copy: Schedule = {
      ...JSON.parse(JSON.stringify(s)),
      id: genId(),
      name: `${s.name || 'Schedule'} (copy)`,
      status: 'idle',
      startedAt: null,
      lastRun: null,
      lastRunError: undefined,
      lastRunMessage: undefined,
      progress: { total: 0, done: 0, failed: 0 },
      createdAt: Date.now(),
    };
    setSchedules(prev => [...prev, copy]);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(schedules, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mmb-schedules-${new Date().toISOString().slice(0, 10)}.json`;
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
        const text = await file.text();
        const parsed = JSON.parse(text);
        const list = Array.isArray(parsed) ? parsed : parsed.schedules;
        if (!Array.isArray(list)) throw new Error('Invalid format');
        setSchedules(list as Schedule[]);
      } catch {
        window.alert('Import failed — use a valid schedules JSON export.');
      }
    };
    input.click();
  };

  const handleCancelWait = (id: string) => {
    void cancelServerScheduleTimer(id);
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, status: 'idle', startedAt: null } : s));
  };

  const handleStartCountdown = (id: string) => {
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, status: 'countdown', startedAt: Date.now() } : s));
  };

  const handleCancelCountdown = handleCancelWait;

  return (
    <div className="flex flex-col h-full">
      {view === 'list' && (
        <ScheduleList
          schedules={schedules}
          profiles={profiles}
          channels={channels}
          now={now}
          concurrency={concurrency}
          onCreate={() => { setEditId(null); setView('create'); }}
          onEdit={(id) => { setEditId(id); setView('create'); }}
          onRun={handleRun}
          onStop={handleStop}
          onDelete={handleDelete}
          onDuplicate={handleDuplicate}
          onExport={handleExport}
          onImport={handleImport}
          onStartCountdown={handleStartCountdown}
          onCancelCountdown={handleCancelCountdown}
        />
      )}
      {view === 'create' && (
        <CreateSchedule
          profiles={profiles}
          channels={channels}
          getVideos={getVideos}
          existing={editId ? schedules.find(s => s.id === editId) || null : null}
          onSave={async (schedule) => {
            let finalStatus: Schedule['status'] = 'idle';
            let startedAt: number | null = schedule.startedAt;
            if (schedule.runMode === 'scheduled' && schedule.scheduledTime > Date.now()) {
              finalStatus = 'scheduled';
              startedAt = null;
            } else if (schedule.runMode === 'countdown' && schedule.countdownMinutes > 0) {
              finalStatus = 'countdown';
              startedAt = Date.now();
            } else {
              startedAt = null;
            }
            const countdownMinutes = clampCountdownMinutes(schedule.countdownMinutes);
            const savedSchedule = enrichScheduleForServer({
              ...schedule,
              countdownMinutes,
              status: finalStatus,
              startedAt,
            }, profiles);
            setSchedules(prev => {
              const exists = prev.find(s => s.id === savedSchedule.id);
              return exists ? prev.map(s => s.id === savedSchedule.id ? savedSchedule : s) : [...prev, savedSchedule];
            });
            if (savedSchedule.runMode === 'scheduled' && savedSchedule.scheduledTime > Date.now()) {
              const ok = await setServerScheduleTimer(savedSchedule);
              if (!ok) window.alert('Saved locally but server timer failed — keep app open or retry.');
            } else {
              void cancelServerScheduleTimer(savedSchedule.id);
            }
            setView('list');
          }}
          onBack={() => setView('list')}
        />
      )}
    </div>
  );
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCHEDULE LIST VIEW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ScheduleList({ schedules, profiles, channels, now, concurrency, onCreate, onEdit, onRun, onStop, onDelete, onDuplicate, onExport, onImport, onStartCountdown, onCancelCountdown }: {
  schedules: Schedule[]; profiles: Profile[]; channels: Channel[]; now: number;
  concurrency: { limit: number; running: number; available: number } | null;
  onCreate: () => void; onEdit: (id: string) => void; onRun: (id: string) => void;
  onStop: (id: string) => void; onDelete: (id: string) => void;
  onDuplicate: (id: string) => void; onExport: () => void; onImport: () => void;
  onStartCountdown: (id: string) => void; onCancelCountdown: (id: string) => void;
}) {
  const running = schedules.filter(s => s.status === 'running').length;
  const scheduled = schedules.filter(s => s.status === 'countdown' || s.status === 'scheduled').length;
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'created' | 'status'>('created');
  const [page, setPage] = useState(1);
  const perPage = 10;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = schedules;
    if (q) list = list.filter(s => (s.name || '').toLowerCase().includes(q) || s.id.includes(q));
    list = [...list].sort((a, b) => {
      if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
      if (sortBy === 'status') return a.status.localeCompare(b.status);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    return list;
  }, [schedules, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const paged = filtered.slice((page - 1) * perPage, page * perPage);
  useEffect(() => { setPage(1); }, [search, sortBy]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Scheduler</h1>
            <p className="text-gray-500 text-sm mt-0.5">{schedules.length} schedules • {running} running • {scheduled} waiting</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onImport} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs">
              <Upload size={14} /> Import
            </button>
            <button type="button" onClick={onExport} disabled={!schedules.length} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs disabled:opacity-40">
              <Download size={14} /> Export
            </button>
            <button onClick={onCreate} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold shadow-lg shadow-red-900/30 transition-all">
              <Plus size={15} /> New Schedule
            </button>
          </div>
        </div>

        {concurrency && (
          <div className="mb-3 flex items-center gap-2 text-xs text-amber-300/90 bg-amber-900/20 border border-amber-700/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} />
            Concurrency: {concurrency.running}/{concurrency.limit} running · {concurrency.available} slots free (Settings → max concurrent)
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search schedules…"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
          </div>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
            <option value="created">Newest</option>
            <option value="name">Name</option>
            <option value="status">Status</option>
          </select>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-4 gap-3">
          <div className="border border-blue-700/30 bg-blue-900/10 rounded-xl p-3 text-center">
            <div className="text-xl font-bold text-blue-400">{schedules.length}</div>
            <div className="text-xs text-gray-500">Total</div>
          </div>
          <div className="border border-green-700/30 bg-green-900/10 rounded-xl p-3 text-center">
            <div className="text-xl font-bold text-green-400">{running}</div>
            <div className="text-xs text-gray-500">Running</div>
          </div>
          <div className="border border-purple-700/30 bg-purple-900/10 rounded-xl p-3 text-center">
            <div className="text-xl font-bold text-purple-400">{scheduled}</div>
            <div className="text-xs text-gray-500">Waiting</div>
          </div>
          <div className="border border-orange-700/30 bg-orange-900/10 rounded-xl p-3 text-center">
            <div className="text-xl font-bold text-orange-400">{profiles.length}</div>
            <div className="text-xs text-gray-500">Profiles</div>
          </div>
        </div>
      </div>

      {/* Schedule Cards + Panels — all in one scrollable area */}
      <div className="flex-1 overflow-y-auto">
        {/* Run settings (watch %, quality, ad skip) — shared with Shuffle */}
        <div className="px-6 pt-4">
          <ShuffleRunSettingsPanel compact />
        </div>

        {/* Live Progress Panel */}
        <div className="px-6 pt-4">
          <LiveProgressPanel showMonitorActions />
        </div>

        <div className="p-6">
        {schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <Calendar size={48} className="text-gray-700 mb-4" />
            <h3 className="text-gray-400 font-semibold text-lg mb-2">No Schedules Yet</h3>
            <p className="text-gray-600 text-sm mb-6">Create a schedule to automate YouTube watching</p>
            <button onClick={onCreate} className="flex items-center gap-2 px-6 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all">
              <Plus size={16} /> Create First Schedule
            </button>
          </div>
        ) : (
          <>
          <div className="space-y-4">
            {paged.map(s => (
              <ScheduleCard key={s.id} schedule={s} profiles={profiles} channels={channels} now={now}
                onEdit={() => onEdit(s.id)} onRun={() => onRun(s.id)} onStop={() => onStop(s.id)}
                onDelete={() => onDelete(s.id)} onDuplicate={() => onDuplicate(s.id)}
                onStartCountdown={() => onStartCountdown(s.id)}
                onCancelCountdown={() => onCancelCountdown(s.id)} />
            ))}
          </div>
          {filtered.length > perPage && (
            <div className="flex justify-center items-center gap-4 pt-4 text-sm">
              <button type="button" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 disabled:opacity-40 hover:bg-gray-700">Prev</button>
              <span className="text-gray-500">{page} / {totalPages}</span>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                className="px-3 py-1.5 rounded-lg bg-gray-800 text-gray-300 disabled:opacity-40 hover:bg-gray-700">Next</button>
            </div>
          )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCHEDULE CARD (with live timer)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ScheduleCard({ schedule: s, profiles: _profiles, channels: _channels, now, onEdit, onRun, onStop, onDelete, onDuplicate, onStartCountdown, onCancelCountdown }: {
  schedule: Schedule; profiles: Profile[]; channels: Channel[]; now: number;
  onEdit: () => void; onRun: () => void; onStop: () => void; onDelete: () => void;
  onDuplicate: () => void; onStartCountdown: () => void; onCancelCountdown: () => void;
}) {
  const countdownRemaining = s.status === 'countdown' && s.startedAt
    ? Math.max(0, (s.startedAt + s.countdownMinutes * 60000) - now)
    : 0;

  const scheduledRemaining = s.status === 'scheduled' && s.scheduledTime
    ? Math.max(0, s.scheduledTime - now)
    : 0;

  const statusConfig: Record<string, { color: string; bg: string; label: string; icon: typeof Clock }> = {
    idle: { color: 'text-gray-400', bg: 'bg-gray-800 border-gray-700', label: 'Ready', icon: Clock },
    running: { color: 'text-green-400', bg: 'bg-green-900/20 border-green-700/30', label: 'Running', icon: Loader },
    completed: { color: 'text-blue-400', bg: 'bg-blue-900/20 border-blue-700/30', label: 'Completed', icon: CheckCircle },
    failed: { color: 'text-red-400', bg: 'bg-red-900/20 border-red-700/30', label: 'Failed', icon: XCircle },
    scheduled: { color: 'text-purple-400', bg: 'bg-purple-900/20 border-purple-700/30', label: 'Scheduled', icon: Calendar },
    countdown: { color: 'text-yellow-400', bg: 'bg-yellow-900/20 border-yellow-700/30', label: 'Countdown', icon: Timer },
  };

  const st = statusConfig[s.status] || statusConfig.idle;
  const StatusIcon = st.icon;
  const totalVideos = s.assignmentMode === 'same-all'
    ? s.sameForAll.reduce((sum, cs) => sum + cs.videos.length, 0)
    : s.perProfile.reduce((sum, pa) => sum + pa.channelSelections.reduce((s2, cs) => s2 + cs.videos.length, 0), 0);

  return (
    <div className={`border rounded-2xl p-5 transition-all ${st.bg}`}>
      <div className="flex items-start gap-4">
        {/* Status Icon */}
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.status === 'running' ? 'bg-green-600 animate-pulse' : s.status === 'countdown' ? 'bg-yellow-600 animate-pulse' : s.status === 'scheduled' ? 'bg-purple-600 animate-pulse' : 'bg-gray-800'}`}>
          <StatusIcon size={18} className="text-white" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-white font-bold text-lg">{s.name || 'Unnamed'}</h3>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.color} ${st.bg} border`}>{st.label}</span>
          </div>

          <div className="flex items-center gap-4 text-sm text-gray-400 mb-2">
            <span className="flex items-center gap-1"><Users size={12} /> {s.selectedProfiles.length} profiles</span>
            <span className="flex items-center gap-1"><Tv size={12} /> {s.selectedChannels.length} channels</span>
            <span className="flex items-center gap-1"><Play size={12} /> {totalVideos} videos</span>
            <span className="flex items-center gap-1"><Clock size={12} /> {s.profileDelayMin}-{s.profileDelayMax}s delay</span>
          </div>

          {/* Countdown Timer */}
          {s.status === 'countdown' && (
            <div className="flex flex-col gap-1 mt-2">
              <div className="flex items-center gap-3">
                <div className="bg-yellow-900/40 border border-yellow-600/40 rounded-xl px-4 py-2">
                  <span className="text-yellow-400 font-mono text-2xl font-bold">{formatCountdown(countdownRemaining)}</span>
                </div>
                <span className="text-yellow-400 text-xs">Runs at {formatRunAt((s.startedAt || now) + s.countdownMinutes * 60000)}</span>
              </div>
            </div>
          )}

          {/* Scheduled Timer */}
          {s.status === 'scheduled' && s.scheduledTime > 0 && (
            <div className="flex flex-col gap-1 mt-2">
              <div className="flex items-center gap-3">
                <div className="bg-purple-900/40 border border-purple-600/40 rounded-xl px-4 py-2">
                  <span className="text-purple-300 font-mono text-2xl font-bold">{formatCountdown(scheduledRemaining)}</span>
                </div>
                <div className="text-xs text-purple-300/90">
                  <div>Chalega: <span className="text-purple-200 font-medium">{formatRunAt(s.scheduledTime)}</span></div>
                  {s.repeatEnabled && <div className="text-purple-400/80 mt-0.5">Repeat: {s.repeatInterval}</div>}
                </div>
              </div>
            </div>
          )}

          {/* Running Progress */}
          {s.status === 'running' && s.progress && (
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${s.progress.total > 0 ? ((s.progress.done + s.progress.failed) / s.progress.total) * 100 : 0}%` }} />
                </div>
                <span className="text-xs text-green-400 font-mono">{s.progress.done}/{s.progress.total}</span>
              </div>
              <div className="flex gap-3 text-xs">
                <span className="text-green-400">✓ {s.progress.done} done</span>
                {s.progress.failed > 0 && <span className="text-red-400">✗ {s.progress.failed} failed</span>}
                <span className="text-gray-500">{s.progress.total - s.progress.done - s.progress.failed} remaining</span>
              </div>
            </div>
          )}

          {/* Last Run */}
          {s.lastRun && s.status !== 'running' && (
            <p className="text-xs text-gray-500 mt-1">Last run: {new Date(s.lastRun).toLocaleString()}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {s.status === 'idle' && (
            <>
              <button onClick={onRun} className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-all flex items-center gap-1.5">
                <Play size={14} /> Run Now
              </button>
              {s.runMode === 'countdown' && s.countdownMinutes > 0 && (
                <button onClick={onStartCountdown} className="bg-yellow-600 hover:bg-yellow-500 text-white px-3 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5">
                  <Timer size={14} /> {s.countdownMinutes}m
                </button>
              )}
            </>
          )}
          {s.status === 'scheduled' && (
            <>
              <button onClick={onRun} className="bg-green-600 hover:bg-green-500 text-white px-3 py-2 rounded-xl text-sm font-semibold transition-all flex items-center gap-1.5">
                <Play size={14} /> Run Now
              </button>
              <button onClick={onCancelCountdown} className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-xl text-sm font-medium transition-all">
                Cancel
              </button>
            </>
          )}
          {s.status === 'countdown' && (
            <button onClick={onCancelCountdown} className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-xl text-sm font-medium transition-all">Cancel</button>
          )}
          {s.status === 'running' && (
            <button onClick={onStop} className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-all flex items-center gap-1.5">
              <Square size={14} /> Stop
            </button>
          )}
          {(s.status === 'completed' || s.status === 'failed') && (
            <button onClick={onRun} className="bg-green-700 hover:bg-green-600 text-white px-3 py-2 rounded-xl text-sm font-medium transition-all flex items-center gap-1.5">
              <RotateCcw size={14} /> Re-run
            </button>
          )}
          <button type="button" onClick={onDuplicate} title="Duplicate" className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-2 rounded-xl text-sm transition-all">
            <Copy size={14} />
          </button>
          <button onClick={onEdit} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-2 rounded-xl text-sm transition-all">Edit</button>
          <button onClick={onDelete} className="bg-red-900/30 hover:bg-red-900/50 text-red-400 px-3 py-2 rounded-xl text-sm transition-all"><Trash2 size={14} /></button>
        </div>
      </div>
    </div>
  );
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CREATE/EDIT SCHEDULE — 3 Simple Steps
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function CreateSchedule({ profiles, channels, getVideos, existing, onSave, onBack }: {
  profiles: Profile[]; channels: Channel[]; getVideos: (channelId: number, filter?: string) => Video[];
  existing: Schedule | null; onSave: (s: Schedule) => void; onBack: () => void;
}) {
  const [step, setStep] = useState(1);
  const [schedule, setSchedule] = useState<Schedule>(existing || {
    id: genId(), name: '', selectedProfiles: [], selectedChannels: [],
    assignmentMode: 'same-all', sameForAll: [], perProfile: [],
    profileDelayMin: 5, profileDelayMax: 20, tabDelayMin: 30, tabDelayMax: 120,
    runMode: 'manual', countdownMinutes: 15, scheduledTime: 0,
    repeatEnabled: false, repeatInterval: '6hr',
    status: 'idle', createdAt: Date.now(), lastRun: null, startedAt: null,
    progress: { total: 0, done: 0, failed: 0 },
  });

  const canNext = () => {
    if (step === 1) return schedule.name.trim().length > 0 && schedule.selectedProfiles.length > 0 && schedule.selectedChannels.length > 0;
    if (step === 2) {
      const hasVideos = schedule.assignmentMode === 'same-all'
        ? schedule.sameForAll.some(cs => cs.videos.length > 0)
        : schedule.perProfile.some(pa => pa.channelSelections.some(cs => cs.videos.length > 0));
      return hasVideos;
    }
    return true;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header with Steps */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center gap-3 mb-4">
          <button onClick={onBack} className="text-gray-400 hover:text-white text-sm">← Back</button>
          <span className="text-gray-600">/</span>
          <span className="text-white font-semibold">{existing ? 'Edit Schedule' : 'New Schedule'}</span>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center gap-2">
          {[
            { n: 1, label: 'Setup' },
            { n: 2, label: 'Videos' },
            { n: 3, label: 'Timer & Run' },
          ].map(({ n, label }) => (
            <div key={n} className="flex items-center gap-2">
              <button onClick={() => n < step && setStep(n)}
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-all
                  ${step === n ? 'bg-red-600 text-white' : step > n ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-500'}`}>
                {step > n ? '✓' : n}
              </button>
              <span className={`text-sm font-medium ${step === n ? 'text-white' : 'text-gray-500'}`}>{label}</span>
              {n < 3 && <div className={`w-12 h-0.5 ${step > n ? 'bg-green-600' : 'bg-gray-700'}`} />}
            </div>
          ))}
        </div>
      </div>

      {/* Step Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          {step === 1 && <Step1Setup schedule={schedule} profiles={profiles} channels={channels} onChange={setSchedule} />}
          {step === 2 && <Step2Videos schedule={schedule} profiles={profiles} channels={channels} getVideos={getVideos} onChange={(s) => setSchedule(prev => ({ ...prev, ...s }))} />}
          {step === 3 && <Step3Timer schedule={schedule} onChange={setSchedule} />}
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 py-4 border-t border-gray-800 flex justify-between flex-shrink-0">
        <button onClick={() => step > 1 ? setStep(step - 1) : onBack()}
          className="bg-gray-800 hover:bg-gray-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium transition-all">
          {step === 1 ? '← Cancel' : '← Previous'}
        </button>
        {step < 3 ? (
          <button onClick={() => setStep(step + 1)} disabled={!canNext()}
            className="bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white px-5 py-2.5 rounded-xl text-sm font-semibold transition-all">
            Next →
          </button>
        ) : (
          <button onClick={() => onSave(schedule)}
            className="bg-green-600 hover:bg-green-500 text-white px-6 py-2.5 rounded-xl text-sm font-bold transition-all shadow-lg shadow-green-900/30">
            ✓ Save Schedule
          </button>
        )}
      </div>
    </div>
  );
}

// ━━━ STEP 1: Name + Profiles + Channels ━━━
function Step1Setup({ schedule, profiles, channels, onChange }: { schedule: Schedule; profiles: Profile[]; channels: Channel[]; onChange: (s: Schedule) => void }) {
  const [profileSearch, setProfileSearch] = useState('');
  const [profilePage, setProfilePage] = useState(1);
  const profilesPerPage = 24;

  const toggleProfile = (id: string) => {
    const sel = schedule.selectedProfiles.includes(id) ? schedule.selectedProfiles.filter(p => p !== id) : [...schedule.selectedProfiles, id];
    onChange({ ...schedule, selectedProfiles: sel });
  };
  const toggleChannel = (id: number) => {
    const sel = schedule.selectedChannels.includes(id) ? schedule.selectedChannels.filter(c => c !== id) : [...schedule.selectedChannels, id];
    onChange({ ...schedule, selectedChannels: sel });
  };

  const filteredProfiles = useMemo(() => {
    const q = profileSearch.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
  }, [profiles, profileSearch]);

  const profilePages = Math.max(1, Math.ceil(filteredProfiles.length / profilesPerPage));
  const pagedProfiles = filteredProfiles.slice((profilePage - 1) * profilesPerPage, profilePage * profilesPerPage);

  const selectFixedChannels = () => {
    const fixedIds = channels.filter(c => PERMANENT_CHANNEL_IDS.includes(c.channel_id as typeof PERMANENT_CHANNEL_IDS[number])).map(c => c.id);
    const merged = [...new Set([...schedule.selectedChannels, ...fixedIds])];
    onChange({ ...schedule, selectedChannels: merged });
  };

  const mlxCount = schedule.selectedProfiles.filter(pid => {
    const p = profiles.find(x => x.id === pid);
    return p?.browserType === 'multilogin';
  }).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 text-xs text-blue-300/90 bg-blue-900/20 border border-blue-700/30 rounded-lg px-3 py-2">
        <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
        Workers auto-start browser profiles. Keep MoreLogin/Multilogin running before Run.
      </div>
      {/* Name */}
      <div>
        <label className="text-white font-semibold text-sm block mb-2">Schedule Name</label>
        <input type="text" value={schedule.name} onChange={(e) => onChange({ ...schedule, name: e.target.value })}
          placeholder="e.g. Morning Run, USA Campaign..."
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-red-500 text-sm" />
      </div>

      {/* Profiles */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-white font-semibold text-sm">Profiles ({schedule.selectedProfiles.length})</label>
          <button onClick={() => onChange({ ...schedule, selectedProfiles: schedule.selectedProfiles.length === profiles.length ? [] : profiles.map(p => p.id) })}
            className="text-xs text-red-400 hover:text-red-300">{schedule.selectedProfiles.length === profiles.length ? 'Deselect All' : 'Select All'}</button>
        </div>
        {mlxCount > 3 && (
          <p className="text-xs text-amber-300 mb-2">Multilogin: {mlxCount} profiles — batched starts (~3 at a time).</p>
        )}
        <div className="flex gap-2 mb-2">
          <input value={profileSearch} onChange={(e) => { setProfileSearch(e.target.value); setProfilePage(1); }}
            placeholder="Search profiles…" className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white" />
        </div>
        <div className="grid grid-cols-3 gap-2 max-h-48 overflow-y-auto">
          {pagedProfiles.map(p => (
            <button key={p.id} onClick={() => toggleProfile(p.id)}
              className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all text-xs ${schedule.selectedProfiles.includes(p.id) ? 'border-red-500 bg-red-900/20 text-white' : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
              <div className={`w-2 h-2 rounded-full ${schedule.selectedProfiles.includes(p.id) ? 'bg-red-500' : 'bg-gray-600'}`} />
              <span className="truncate">{p.name}</span>
              <span className="text-[10px] text-gray-500">{p.status}</span>
            </button>
          ))}
        </div>
        {profilePages > 1 && (
          <div className="flex justify-center gap-2 mt-2 text-xs text-gray-500">
            <button type="button" disabled={profilePage <= 1} onClick={() => setProfilePage(p => p - 1)}>Prev</button>
            <span>{profilePage}/{profilePages}</span>
            <button type="button" disabled={profilePage >= profilePages} onClick={() => setProfilePage(p => p + 1)}>Next</button>
          </div>
        )}
      </div>

      {/* Channels */}
      <div>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <label className="text-white font-semibold text-sm">Channels ({schedule.selectedChannels.length})</label>
          <div className="flex items-center gap-2">
            <button type="button" onClick={selectFixedChannels}
              className="text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1">
              <Pin size={12} /> Fixed channels
            </button>
            <button type="button" onClick={() => onChange({ ...schedule, selectedChannels: schedule.selectedChannels.length === channels.length ? [] : channels.map(c => c.id) })}
              className="text-xs text-purple-400 hover:text-purple-300">{schedule.selectedChannels.length === channels.length ? 'Deselect All' : 'Select All'}</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {channels.map(ch => (
            <button key={ch.id} onClick={() => toggleChannel(ch.id)}
              className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all text-xs ${schedule.selectedChannels.includes(ch.id) ? 'border-purple-500 bg-purple-900/20 text-white' : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
              <div className="w-6 h-6 rounded bg-red-700 flex items-center justify-center flex-shrink-0"><span className="text-white" style={{ fontSize: 8 }}>YT</span></div>
              <span className="truncate">{ch.channel_name}</span>
            </button>
          ))}
        </div>
        {channels.length === 0 && <p className="text-gray-500 text-sm text-center py-4">No channels. Add from Channels page first.</p>}
      </div>

      {/* Delays */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
        <h3 className="text-white font-semibold text-sm mb-3">⏱️ Delays (seconds)</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs text-gray-400 block mb-1">Profile Start Delay</label>
            <div className="flex gap-2">
              <input type="number" value={schedule.profileDelayMin} onChange={(e) => onChange({ ...schedule, profileDelayMin: Number(e.target.value) })}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none" placeholder="Min" />
              <span className="text-gray-500 self-center">—</span>
              <input type="number" value={schedule.profileDelayMax} onChange={(e) => onChange({ ...schedule, profileDelayMax: Number(e.target.value) })}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none" placeholder="Max" />
            </div>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Between Videos Delay</label>
            <div className="flex gap-2">
              <input type="number" value={schedule.tabDelayMin} onChange={(e) => onChange({ ...schedule, tabDelayMin: Number(e.target.value) })}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none" placeholder="Min" />
              <span className="text-gray-500 self-center">—</span>
              <input type="number" value={schedule.tabDelayMax} onChange={(e) => onChange({ ...schedule, tabDelayMax: Number(e.target.value) })}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none" placeholder="Max" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ━━━ STEP 3: Timer & Run Mode ━━━
function clampCountdownMinutes(n: number) {
  return Math.max(1, Math.min(10080, Math.round(Number(n)) || 1));
}

function Step3Timer({ schedule, onChange }: { schedule: Schedule; onChange: (s: Schedule) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-white font-bold text-lg mb-1">⏰ When to Run</h2>
        <p className="text-gray-400 text-sm">Choose how to start this schedule</p>
      </div>

      {/* Run Mode */}
      <div className="grid grid-cols-3 gap-3">
        <button onClick={() => onChange({ ...schedule, runMode: 'manual' })}
          className={`p-4 rounded-xl border-2 text-center transition-all ${schedule.runMode === 'manual' ? 'border-red-500 bg-red-900/20' : 'border-gray-700 bg-gray-800 hover:border-gray-600'}`}>
          <div className="text-2xl mb-2">🖱️</div>
          <p className="text-white font-semibold text-sm">Manual</p>
          <p className="text-gray-500 text-xs mt-1">Click "Run Now"</p>
        </button>
        <button onClick={() => onChange({ ...schedule, runMode: 'countdown' })}
          className={`p-4 rounded-xl border-2 text-center transition-all ${schedule.runMode === 'countdown' ? 'border-yellow-500 bg-yellow-900/20' : 'border-gray-700 bg-gray-800 hover:border-gray-600'}`}>
          <div className="text-2xl mb-2">⏱️</div>
          <p className="text-white font-semibold text-sm">Countdown</p>
          <p className="text-gray-500 text-xs mt-1">Run after X minutes</p>
        </button>
        <button onClick={() => onChange({ ...schedule, runMode: 'scheduled' })}
          className={`p-4 rounded-xl border-2 text-center transition-all ${schedule.runMode === 'scheduled' ? 'border-purple-500 bg-purple-900/20' : 'border-gray-700 bg-gray-800 hover:border-gray-600'}`}>
          <div className="text-2xl mb-2">📅</div>
          <p className="text-white font-semibold text-sm">Scheduled</p>
          <p className="text-gray-500 text-xs mt-1">Run at specific time</p>
        </button>
      </div>

      {/* Countdown Options */}
      {schedule.runMode === 'countdown' && (
        <div className="bg-yellow-900/20 border border-yellow-700/30 rounded-xl p-4">
          <label className="text-yellow-400 font-semibold text-sm block mb-3">⏱️ Run after how many minutes? (min 1)</label>
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {[1, 5, 15, 30, 60, 120, 180, 360].map(min => (
              <button key={min} type="button" onClick={() => onChange({ ...schedule, countdownMinutes: min })}
                className={`py-2.5 rounded-xl border text-sm font-medium transition-all ${schedule.countdownMinutes === min ? 'border-yellow-500 bg-yellow-600 text-white' : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'}`}>
                {min < 60 ? `${min}m` : `${min / 60}h`}
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-gray-400">Custom:</span>
            <input type="number" min={1} max={10080} step={1} value={schedule.countdownMinutes}
              onChange={(e) => onChange({ ...schedule, countdownMinutes: clampCountdownMinutes(Number(e.target.value)) })}
              className="w-20 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none" />
            <span className="text-xs text-gray-400">minutes</span>
          </div>
          <p className="text-xs text-yellow-300/70 mt-2">Save karte hi countdown shuru ho jayega — live timer list mein dikhega.</p>
        </div>
      )}

      {/* Scheduled Options */}
      {schedule.runMode === 'scheduled' && (
        <div className="bg-purple-900/20 border border-purple-700/30 rounded-xl p-4">
          <label className="text-purple-400 font-semibold text-sm block mb-3">📅 Run at specific time</label>
          
          {/* Quick Time Buttons */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            {[
              { label: '1 min', ms: 60 * 1000 },
              { label: '5 min', ms: 5 * 60 * 1000 },
              { label: '15 min', ms: 15 * 60 * 1000 },
              { label: '1 hour', ms: 60 * 60 * 1000 },
              { label: '3 hours', ms: 3 * 60 * 60 * 1000 },
              { label: '6 hours', ms: 6 * 60 * 60 * 1000 },
              { label: 'Tomorrow 9am', ms: 0 },
            ].map(({ label, ms }) => (
              <button key={label} onClick={() => {
                if (ms > 0) {
                  onChange({ ...schedule, scheduledTime: Date.now() + ms });
                } else {
                  const tomorrow = new Date();
                  tomorrow.setDate(tomorrow.getDate() + 1);
                  tomorrow.setHours(9, 0, 0, 0);
                  onChange({ ...schedule, scheduledTime: tomorrow.getTime() });
                }
              }}
                className="py-2 rounded-xl border border-gray-700 bg-gray-800 text-gray-300 text-xs font-medium hover:border-purple-500 transition-all">
                {label}
              </button>
            ))}
          </div>

          {/* Date Time Picker */}
          <input type="datetime-local"
            value={schedule.scheduledTime ? new Date(schedule.scheduledTime).toISOString().slice(0, 16) : ''}
            onChange={(e) => onChange({ ...schedule, scheduledTime: new Date(e.target.value).getTime() })}
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-purple-500" />
          
          {schedule.scheduledTime > 0 && (
            <p className="text-xs text-purple-300 mt-2">
              📅 Will run at: {new Date(schedule.scheduledTime).toLocaleString()}
              {schedule.scheduledTime > Date.now() && ` (in ${Math.round((schedule.scheduledTime - Date.now()) / 60000)} min)`}
            </p>
          )}
          <p className="text-xs text-purple-300/70 mt-2">Save karte hi server timer set ho jayega — kitna time baki hai card pe dikhega (backend chalu hona chahiye).</p>
        </div>
      )}

      {/* Repeat */}
      <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => onChange({ ...schedule, repeatEnabled: !schedule.repeatEnabled })}
            className={`w-10 h-6 rounded-full relative transition-all ${schedule.repeatEnabled ? 'bg-green-600' : 'bg-gray-700'}`}>
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${schedule.repeatEnabled ? 'left-5' : 'left-1'}`} />
          </button>
          <span className="text-white text-sm font-medium">Repeat after completion</span>
        </div>
        {schedule.repeatEnabled && (
          <div className="grid grid-cols-5 gap-2">
            {['1hr', '3hr', '6hr', '12hr', '24hr'].map(interval => (
              <button key={interval} onClick={() => onChange({ ...schedule, repeatInterval: interval })}
                className={`py-2 rounded-xl border text-xs font-medium transition-all ${schedule.repeatInterval === interval ? 'border-green-500 bg-green-900/30 text-green-400' : 'border-gray-700 bg-gray-900 text-gray-400'}`}>
                {interval}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-white font-semibold text-sm mb-2">📋 Summary</h3>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex justify-between"><span className="text-gray-400">Profiles:</span><span className="text-white">{schedule.selectedProfiles.length}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Channels:</span><span className="text-white">{schedule.selectedChannels.length}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Videos:</span><span className="text-white">{
            schedule.assignmentMode === 'same-all'
              ? schedule.sameForAll.reduce((sum, cs) => sum + cs.videos.length, 0)
              : schedule.perProfile.reduce((sum, pa) => sum + pa.channelSelections.reduce((s2, cs) => s2 + cs.videos.length, 0), 0)
          }</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Assignment:</span><span className="text-white capitalize">{schedule.assignmentMode.replace('-', ' ')}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Run Mode:</span><span className="text-white capitalize">{schedule.runMode}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Profile Delay:</span><span className="text-white">{schedule.profileDelayMin}-{schedule.profileDelayMax}s</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Video Delay:</span><span className="text-white">{schedule.tabDelayMin}-{schedule.tabDelayMax}s</span></div>
        </div>
      </div>
    </div>
  );
}
