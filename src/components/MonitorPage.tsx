import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Activity, Clock, Tv, Square,
  LayoutGrid, Play, RefreshCw, Pause, SkipForward, AlertCircle,
} from 'lucide-react';
import { backendFetch } from '../services/backendOrigin';
import type { Profile } from '../types';
import {
  fetchRecycleStatus,
  stopRecycleLoop,
  pauseRecycleLoop,
  resumeRecycleLoop,
  formatCooldownRemaining,
  recycleStatusLabel,
  type RecycleStatus,
  type RecycleSlotStatus,
} from '../utils/recycleApi';

interface WorkerStatus {
  profileId: string;
  status: string;
  currentVideo: string | null;
  progress: string;
  retries: number;
  logs: { time: string; level: string; message: string }[];
  results: { watched: number; failed: number; skipped: number } | null;
  uptime: number;
}

interface DisplayRow extends WorkerStatus {
  rowKey: string;
  displayName: string;
  source: 'worker' | 'recycle';
  slotId?: string;
  recycleStatus?: string;
  cooldownUntil?: number | null;
  cycleCount?: number;
  lastError?: string | null;
  isPaused?: boolean;
}

const ACTIVE_STATUSES = new Set(['running', 'watching', 'searching', 'waiting', 'starting', 'connecting']);
const RECYCLE_ACTIVE = new Set(['running', 'cooldown', 'recreating', 'queued', 'error', 'idle']);

function slotToRow(slot: RecycleSlotStatus): DisplayRow {
  const statusMap: Record<string, string> = {
    running: 'running', cooldown: 'cooldown', recreating: 'recreating',
    queued: 'waiting', error: 'error', idle: 'waiting', stopped: 'stopped',
  };
  return {
    rowKey: `slot-${slot.slotId}`,
    profileId: slot.currentProfileId,
    displayName: slot.profileName,
    status: statusMap[slot.status] || slot.status,
    currentVideo: slot.status === 'running' ? `${slot.videoCount} videos queued` : null,
    progress: '—', retries: 0,
    logs: slot.lastError ? [{ time: new Date().toISOString(), level: 'error', message: slot.lastError }] : [],
    results: null, uptime: 0,
    source: 'recycle',
    slotId: slot.slotId,
    recycleStatus: slot.status,
    cooldownUntil: slot.cooldownUntil,
    cycleCount: slot.cycleCount,
    lastError: slot.lastError,
    isPaused: slot.isPaused,
  };
}

interface MonitorPageProps {
  profiles?: Profile[];
  onRefreshProfiles?: () => void;
  onStartRecycle?: () => Promise<unknown>;
  canStartRecycle?: boolean;
}

export default function MonitorPage({ profiles = [], onRefreshProfiles, onStartRecycle, canStartRecycle = false }: MonitorPageProps) {
  const [workers, setWorkers] = useState<WorkerStatus[]>([]);
  const [stats, setStats] = useState({ total: 0, running: 0, done: 0, error: 0, waiting: 0 });
  const [recycleStatus, setRecycleStatus] = useState<RecycleStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const refreshedRef = useRef<Set<string>>(new Set());

  // 1s tick for cooldown countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll workers every 2s
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await backendFetch('/api/workers');
        if (res.ok) {
          const data = await res.json();
          setWorkers(data.workers || []);
          setStats(data.stats || { total: 0, running: 0, done: 0, error: 0, waiting: 0 });
        }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, []);

  // Poll recycle status every 2s
  useEffect(() => {
    const poll = () => { void fetchRecycleStatus().then(s => { if (s) setRecycleStatus(s); }); };
    poll();
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, []);

  // Refresh profiles when recycle assigns new IDs
  useEffect(() => {
    if (!recycleStatus?.enabled || !onRefreshProfiles) return;
    const profileIds = new Set(profiles.map(p => p.id));
    for (const slot of recycleStatus.slots) {
      if (!slot.enabled || !slot.currentProfileId) continue;
      if (!profileIds.has(slot.currentProfileId) && !refreshedRef.current.has(slot.currentProfileId)) {
        refreshedRef.current.add(slot.currentProfileId);
        onRefreshProfiles();
        break;
      }
    }
  }, [recycleStatus, profiles, onRefreshProfiles]);

  const profileName = useCallback((id: string, fallback?: string) =>
    profiles.find(p => p.id === id)?.name || fallback || `Profile-${id.slice(-4)}`,
  [profiles]);

  const rows = useMemo((): DisplayRow[] => {
    const workerById = new Map(workers.map(w => [w.profileId, w]));
    const usedIds = new Set<string>();
    const result: DisplayRow[] = [];
    const enabledSlots = (recycleStatus?.slots || []).filter(s => s.enabled);

    for (const slot of enabledSlots) {
      const worker = workerById.get(slot.currentProfileId);
      const workerActive = !!(worker && ACTIVE_STATUSES.has(worker.status));
      if (workerActive) {
        usedIds.add(worker!.profileId);
        result.push({
          ...worker!, rowKey: worker!.profileId,
          displayName: profileName(worker!.profileId, slot.profileName),
          source: 'worker', slotId: slot.slotId, recycleStatus: 'running',
          cooldownUntil: null, cycleCount: slot.cycleCount, lastError: slot.lastError,
          isPaused: slot.isPaused,
        });
      } else if (RECYCLE_ACTIVE.has(slot.status)) {
        result.push(slotToRow(slot));
      }
    }
    for (const w of workers) {
      if (!usedIds.has(w.profileId)) {
        result.push({ ...w, rowKey: w.profileId, displayName: profileName(w.profileId), source: 'worker' });
      }
    }
    return result;
  }, [workers, recycleStatus, profileName]);

  const recycleActive = !!(recycleStatus?.enabled && recycleStatus.slots.some(s => s.enabled));
  const isPausedAll = recycleActive && recycleStatus!.slots.filter(s => s.enabled).every(s => s.isPaused);

  const runningCount = rows.filter(r => ACTIVE_STATUSES.has(r.status)).length;
  const cooldownCount = rows.filter(r => r.status === 'cooldown').length;
  const errorCount = rows.filter(r => r.status === 'error' || r.status === 'crashed').length;
  const recreatingCount = rows.filter(r => r.status === 'recreating').length;
  const doneCount = stats.done;

  const overallPct = stats.total > 0 ? Math.round(((stats.done + stats.error) / stats.total) * 100) : 0;

  const formatUptime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h${m % 60}m`;
    if (m > 0) return `${m}m${s % 60}s`;
    return `${s}s`;
  };

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally {
      setBusy(false);
      const s = await fetchRecycleStatus();
      if (s) setRecycleStatus(s);
    }
  };

  const stopWorker = async (profileId: string) => {
    await backendFetch(`/api/workers/stop/${profileId}`, { method: 'POST' }).catch(() => {});
  };

  const stopAll = async () => {
    await backendFetch('/api/schedule/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).catch(() => {});
  };

  const arrangeAll = async () => {
    const ids = rows.filter(r => ACTIVE_STATUSES.has(r.status)).map(r => r.profileId);
    if (!ids.length) return;
    await backendFetch('/api/manual/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileIds: ids, command: 'arrangeWindows' }),
    }).catch(() => {});
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">

      {/* ── Page Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${runningCount > 0 ? 'bg-green-600 animate-pulse' : recycleActive ? 'bg-emerald-800' : 'bg-gray-700'}`}>
            <Activity size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              Live Monitor
              {runningCount > 0 && <span className="text-xs text-green-400 animate-pulse font-normal">● RUNNING</span>}
              {isPausedAll && <span className="text-xs text-amber-400 font-normal">⏸ PAUSED</span>}
            </h1>
            <p className="text-gray-500 text-xs">{rows.length} profiles • Real-time view (auto-refresh 2s)</p>
          </div>
        </div>

        {/* ── Control Buttons ── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Arrange Windows */}
          {runningCount > 0 && (
            <button onClick={() => void arrangeAll()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-purple-600/20 border border-purple-600/40 text-purple-300 text-xs font-medium hover:bg-purple-600/30 transition-all">
              <LayoutGrid size={13} /> Arrange Windows
            </button>
          )}

          {/* Stop All Workers */}
          {runningCount > 0 && (
            <button onClick={() => void withBusy(stopAll)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-600/20 border border-red-600/40 text-red-300 text-xs font-medium hover:bg-red-600/30 transition-all">
              <Square size={13} /> Stop All Workers
            </button>
          )}

          {/* Pause / Resume 24/7 Loop */}
          {recycleActive && !isPausedAll && (
            <button disabled={busy} onClick={() => void withBusy(pauseRecycleLoop)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-amber-600/20 border border-amber-600/40 text-amber-300 text-xs font-medium hover:bg-amber-600/30 disabled:opacity-50 transition-all">
              <Pause size={13} /> Pause 24/7
            </button>
          )}
          {recycleActive && isPausedAll && (
            <button disabled={busy} onClick={() => void withBusy(resumeRecycleLoop)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-green-600/20 border border-green-600/40 text-green-300 text-xs font-medium hover:bg-green-600/30 disabled:opacity-50 transition-all">
              <SkipForward size={13} /> Resume 24/7
            </button>
          )}

          {/* Stop 24/7 Loop */}
          {recycleActive && (
            <button disabled={busy} onClick={() => void withBusy(() => stopRecycleLoop())}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-700/80 text-white text-xs font-medium hover:bg-red-600 disabled:opacity-50 transition-all">
              <Square size={13} /> Stop 24/7
            </button>
          )}

          {/* Start 24/7 Loop */}
          {!recycleActive && onStartRecycle && canStartRecycle && (
            <button disabled={busy} onClick={() => void withBusy(onStartRecycle!)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-500 disabled:opacity-50 transition-all">
              <Play size={13} /> Start 24/7
            </button>
          )}
        </div>
      </div>

      {/* ── Summary Stats Bar ── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Running', count: runningCount, color: 'text-green-400', bg: 'bg-green-900/20 border-green-700/30' },
          { label: 'Cooldown', count: cooldownCount, color: 'text-amber-400', bg: 'bg-amber-900/20 border-amber-700/30' },
          { label: 'Recreating', count: recreatingCount, color: 'text-purple-400', bg: 'bg-purple-900/20 border-purple-700/30' },
          { label: 'Error', count: errorCount, color: 'text-red-400', bg: 'bg-red-900/20 border-red-700/30' },
          { label: 'Done', count: doneCount, color: 'text-blue-400', bg: 'bg-blue-900/20 border-blue-700/30' },
        ].map(({ label, count, color, bg }) => (
          <div key={label} className={`${bg} border rounded-xl px-4 py-3 flex items-center justify-between`}>
            <span className="text-xs text-gray-400">{label}</span>
            <span className={`text-lg font-bold ${color}`}>{count}</span>
          </div>
        ))}
      </div>

      {/* ── Overall Progress Bar (only when non-recycle schedule running) ── */}
      {stats.total > 0 && !recycleActive && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-400">Schedule Progress</span>
            <span className="text-xs font-mono text-white">{overallPct}% ({stats.done + stats.error}/{stats.total})</span>
          </div>
          <div className="h-2.5 bg-gray-700 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${overallPct}%`, background: 'linear-gradient(90deg,#22c55e,#16a34a)' }} />
          </div>
        </div>
      )}

      {/* ── Paused Banner ── */}
      {isPausedAll && (
        <div className="flex items-center gap-3 bg-amber-900/20 border border-amber-600/40 rounded-xl px-4 py-3">
          <Pause size={16} className="text-amber-400 shrink-0" />
          <p className="text-amber-200 text-sm">
            24/7 loop <strong>paused</strong> — saare profiles freeze hain. Resume karo to immediately restart honge.
          </p>
          <button disabled={busy} onClick={() => void withBusy(resumeRecycleLoop)}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs rounded-lg disabled:opacity-50 transition-all">
            <SkipForward size={12} /> Resume Now
          </button>
        </div>
      )}

      {/* ── Empty State ── */}
      {rows.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-12 text-center">
          <Activity size={32} className="text-gray-600 mx-auto mb-3" />
          <h3 className="text-gray-400 font-medium">No active sessions</h3>
          <p className="text-gray-600 text-sm mt-1">Shuffle ya 24/7 loop start karo — sab profiles yahan dikhenge.</p>
        </div>
      )}

      {/* ── Profile Rows Table ── */}
      {rows.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-12 gap-2 px-4 py-2 border-b border-gray-800 bg-gray-800/40">
            <span className="col-span-1 text-[10px] text-gray-500 uppercase tracking-wider">#</span>
            <span className="col-span-3 text-[10px] text-gray-500 uppercase tracking-wider">Profile</span>
            <span className="col-span-2 text-[10px] text-gray-500 uppercase tracking-wider">Status</span>
            <span className="col-span-3 text-[10px] text-gray-500 uppercase tracking-wider">Current Video / Info</span>
            <span className="col-span-2 text-[10px] text-gray-500 uppercase tracking-wider">Progress</span>
            <span className="col-span-1 text-[10px] text-gray-500 uppercase tracking-wider text-right">Action</span>
          </div>

          <div className="divide-y divide-gray-800/60">
            {rows.map((row, idx) => {
              const isRunning = ACTIVE_STATUSES.has(row.status);
              const isCooldown = row.status === 'cooldown';
              const isRecreating = row.status === 'recreating';
              const isDone = row.status === 'done';
              const isError = row.status === 'error' || row.status === 'crashed';
              const isPaused = !!row.isPaused;
              const isExpanded = expanded === row.rowKey;
              const cooldownText = isCooldown && row.cooldownUntil ? formatCooldownRemaining(row.cooldownUntil, now) : null;
              const [done, total] = (row.progress || '0/0').split('/').map(Number);
              const workerPct = total > 0 ? Math.round((done / total) * 100) : 0;

              const rowBg = isRunning ? 'hover:bg-green-900/10' :
                isCooldown && isPaused ? 'hover:bg-amber-900/10 bg-amber-900/5' :
                isCooldown ? 'hover:bg-amber-900/8' :
                isRecreating ? 'hover:bg-purple-900/10' :
                isError ? 'hover:bg-red-900/8' : 'hover:bg-gray-800/30';

              const statusDot = isRunning ? 'bg-green-500 animate-pulse' :
                isCooldown && isPaused ? 'bg-amber-400' :
                isCooldown ? 'bg-amber-600' :
                isRecreating ? 'bg-purple-500 animate-spin' :
                isDone ? 'bg-blue-500' :
                isError ? 'bg-red-500' : 'bg-gray-600';

              return (
                <div key={row.rowKey}>
                  <div
                    className={`grid grid-cols-12 gap-2 px-4 py-3 cursor-pointer transition-colors ${rowBg}`}
                    onClick={() => setExpanded(isExpanded ? null : row.rowKey)}
                  >
                    {/* # */}
                    <div className="col-span-1 flex items-center">
                      <div className={`w-2 h-2 rounded-full ${statusDot}`} />
                      <span className="text-gray-600 text-xs ml-1.5">{idx + 1}</span>
                    </div>

                    {/* Profile name */}
                    <div className="col-span-3 flex items-center min-w-0">
                      <span className="text-white text-xs font-medium truncate">{row.displayName}</span>
                      {typeof row.cycleCount === 'number' && row.cycleCount > 0 && (
                        <span className="ml-1.5 text-[10px] text-gray-600 shrink-0">×{row.cycleCount}</span>
                      )}
                    </div>

                    {/* Status badge */}
                    <div className="col-span-2 flex items-center">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        isRunning ? 'bg-green-900/50 text-green-400' :
                        isCooldown && isPaused ? 'bg-amber-900/50 text-amber-300' :
                        isCooldown ? 'bg-amber-900/50 text-amber-400' :
                        isRecreating ? 'bg-purple-900/50 text-purple-400' :
                        isDone ? 'bg-blue-900/50 text-blue-400' :
                        isError ? 'bg-red-900/50 text-red-400' : 'bg-gray-700 text-gray-400'
                      }`}>
                        {isPaused && isCooldown ? '⏸ Paused' : row.recycleStatus ? recycleStatusLabel(row.recycleStatus) : row.status}
                      </span>
                    </div>

                    {/* Current video / info */}
                    <div className="col-span-3 flex items-center min-w-0">
                      {isRunning && row.currentVideo && (
                        <p className="text-xs text-gray-400 truncate flex items-center gap-1">
                          <Tv size={10} className="text-red-400 shrink-0" />
                          {row.currentVideo}
                        </p>
                      )}
                      {isCooldown && cooldownText && cooldownText !== '—' && !isPaused && (
                        <p className="text-xs text-amber-300 flex items-center gap-1">
                          <Clock size={10} className="shrink-0" /> {cooldownText}
                        </p>
                      )}
                      {isPaused && (
                        <p className="text-xs text-amber-400 flex items-center gap-1">
                          <Pause size={10} className="shrink-0" /> Loop paused
                        </p>
                      )}
                      {isRecreating && (
                        <p className="text-xs text-purple-300 flex items-center gap-1">
                          <RefreshCw size={10} className="shrink-0 animate-spin" /> Recreating…
                        </p>
                      )}
                      {isError && row.lastError && (
                        <p className="text-xs text-red-400 truncate flex items-center gap-1">
                          <AlertCircle size={10} className="shrink-0" />
                          {row.lastError}
                        </p>
                      )}
                    </div>

                    {/* Progress bar */}
                    <div className="col-span-2 flex items-center gap-2">
                      {!isCooldown && !isRecreating && (
                        <>
                          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${isDone ? 'bg-blue-500' : isError ? 'bg-red-500' : 'bg-green-500'}`}
                              style={{ width: `${workerPct}%` }} />
                          </div>
                          <span className="text-[10px] font-mono text-gray-400 shrink-0">{row.progress || '0/0'}</span>
                        </>
                      )}
                      {row.uptime > 0 && (
                        <span className="text-[10px] text-gray-600">{formatUptime(row.uptime)}</span>
                      )}
                    </div>

                    {/* Action: stop individual worker */}
                    <div className="col-span-1 flex items-center justify-end">
                      {isRunning && row.source === 'worker' && (
                        <button
                          onClick={e => { e.stopPropagation(); void stopWorker(row.profileId); }}
                          title="Stop this worker"
                          className="p-1 rounded text-red-500 hover:text-red-300 hover:bg-red-900/20 transition-all">
                          <Square size={11} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded: logs */}
                  {isExpanded && (
                    <div className="px-4 pb-3 pt-2 bg-gray-900/60 border-t border-gray-800/50">
                      <p className="text-[10px] text-gray-500 mb-1.5 uppercase tracking-wider">Recent logs</p>
                      <div className="space-y-0.5 max-h-40 overflow-y-auto">
                        {(row.logs || []).slice(-15).map((log, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs py-0.5">
                            <span className="text-gray-600 shrink-0 w-16 font-mono text-[10px]">
                              {new Date(log.time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                            <span className={`shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${log.level === 'error' ? 'bg-red-500' : log.level === 'success' ? 'bg-green-500' : log.level === 'warn' ? 'bg-yellow-500' : 'bg-gray-600'}`} />
                            <span className={`${log.level === 'error' ? 'text-red-400' : log.level === 'success' ? 'text-green-400' : log.level === 'warn' ? 'text-yellow-400' : 'text-gray-400'}`}>
                              {log.message}
                            </span>
                          </div>
                        ))}
                        {(!row.logs || row.logs.length === 0) && (
                          <p className="text-gray-600 text-xs">No logs yet</p>
                        )}
                      </div>
                      {row.results && (
                        <div className="flex gap-4 mt-2 pt-2 border-t border-gray-800/50 text-xs">
                          <span className="text-green-400">✓ {row.results.watched} watched</span>
                          <span className="text-red-400">✗ {row.results.failed} failed</span>
                          {row.results.skipped > 0 && <span className="text-yellow-400">⏭ {row.results.skipped} skipped</span>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
