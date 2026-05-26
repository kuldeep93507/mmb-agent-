import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Activity, Loader, CheckCircle, XCircle, Clock, Tv, Square, LayoutGrid, Play, RefreshCw } from 'lucide-react';
import { backendFetch } from '../services/backendOrigin';
import type { Profile } from '../types';
import {
  fetchRecycleStatus,
  stopRecycleLoop,
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
}

interface WorkerStats {
  total: number;
  running: number;
  done: number;
  error: number;
  waiting: number;
}

interface LiveProgressPanelProps {
  compact?: boolean;
  /** Resolve profile names on worker rows */
  profiles?: Profile[];
  /** When false, always show idle card (dashboard). When true, hide if idle (analytics embed). */
  hideWhenIdle?: boolean;
  /** Show only workers for these profiles (e.g. current shuffle run) */
  filterProfileIds?: string[];
  /** Header label when filtered to a specific run */
  runLabel?: string;
  /** Show Start/Stop 24/7 controls in header */
  showRecycleControls?: boolean;
  onStartRecycle?: () => void | Promise<void>;
  onStopRecycle?: () => void | Promise<void>;
  recycleLoopBusy?: boolean;
  canStartRecycle?: boolean;
  /** Refresh profile list when recycle recreates profiles (new IDs) */
  onRefreshProfiles?: () => void;
}

const ACTIVE_WORKER_STATUSES = new Set([
  'running', 'watching', 'searching', 'waiting', 'starting', 'connecting',
]);

const RECYCLE_ACTIVE_STATUSES = new Set(['running', 'cooldown', 'recreating', 'queued', 'error']);

function slotToRow(slot: RecycleSlotStatus): DisplayRow {
  const statusMap: Record<string, string> = {
    running: 'running',
    cooldown: 'cooldown',
    recreating: 'recreating',
    queued: 'waiting',
    error: 'error',
    idle: 'waiting',
    stopped: 'stopped',
  };
  return {
    rowKey: `slot-${slot.slotId}`,
    profileId: slot.currentProfileId,
    displayName: slot.profileName,
    status: statusMap[slot.status] || slot.status,
    currentVideo: slot.status === 'running' ? `${slot.videoCount} videos queued` : null,
    progress: slot.status === 'running' ? '…' : slot.status === 'cooldown' ? '⏸' : '—',
    retries: 0,
    logs: slot.lastError
      ? [{ time: new Date().toISOString(), level: 'error', message: slot.lastError }]
      : [],
    results: null,
    uptime: 0,
    source: 'recycle',
    slotId: slot.slotId,
    recycleStatus: slot.status,
    cooldownUntil: slot.cooldownUntil,
    cycleCount: slot.cycleCount,
    lastError: slot.lastError,
  };
}

export default function LiveProgressPanel({
  compact = false,
  profiles = [],
  hideWhenIdle = false,
  filterProfileIds,
  runLabel,
  showRecycleControls = true,
  onStartRecycle,
  onStopRecycle,
  recycleLoopBusy = false,
  canStartRecycle = false,
  onRefreshProfiles,
}: LiveProgressPanelProps) {
  const [workers, setWorkers] = useState<WorkerStatus[]>([]);
  const [stats, setStats] = useState<WorkerStats>({ total: 0, running: 0, done: 0, error: 0, waiting: 0 });
  const [recycleStatus, setRecycleStatus] = useState<RecycleStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [loopBusyLocal, setLoopBusyLocal] = useState(false);
  const refreshedProfileIdsRef = useRef<Set<string>>(new Set());

  const filterSet = useMemo(
    () => (filterProfileIds?.length ? new Set(filterProfileIds) : null),
    [filterProfileIds],
  );

  // 1s tick for cooldown countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll workers every 3 seconds
  useEffect(() => {
    const fetchWorkers = async () => {
      try {
        const res = await backendFetch('/api/workers');
        if (res.ok) {
          const data = await res.json();
          setWorkers(data.workers || []);
          setStats(data.stats || { total: 0, running: 0, done: 0, error: 0, waiting: 0 });
          setIsActive(data.stats?.running > 0 || data.stats?.waiting > 0);
        }
      } catch {}
    };
    fetchWorkers();
    const interval = setInterval(fetchWorkers, 3000);
    return () => clearInterval(interval);
  }, []);

  // Poll recycle status
  useEffect(() => {
    const poll = () => { void fetchRecycleStatus().then(setRecycleStatus); };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, []);

  const profileName = useCallback((profileId: string, fallback?: string) =>
    profiles.find((p) => p.id === profileId)?.name || fallback || `Profile-${profileId.slice(-4)}`,
  [profiles]);

  // Refresh profiles when recycle assigns new profile IDs
  useEffect(() => {
    if (!recycleStatus?.enabled || !onRefreshProfiles) return;
    const profileIds = new Set(profiles.map((p) => p.id));
    for (const slot of recycleStatus.slots) {
      if (!slot.enabled || !slot.currentProfileId) continue;
      if (!profileIds.has(slot.currentProfileId) && !refreshedProfileIdsRef.current.has(slot.currentProfileId)) {
        refreshedProfileIdsRef.current.add(slot.currentProfileId);
        onRefreshProfiles();
        break;
      }
      if (slot.profileIdChangedAt && Date.now() - slot.profileIdChangedAt < 60000) {
        if (!refreshedProfileIdsRef.current.has(`${slot.slotId}-${slot.currentProfileId}`)) {
          refreshedProfileIdsRef.current.add(`${slot.slotId}-${slot.currentProfileId}`);
          onRefreshProfiles();
          break;
        }
      }
    }
  }, [recycleStatus, profiles, onRefreshProfiles]);

  const mergedRows = useMemo((): DisplayRow[] => {
    const workerById = new Map(workers.map((w) => [w.profileId, w]));
    const usedWorkerIds = new Set<string>();
    const rows: DisplayRow[] = [];

    const enabledSlots = (recycleStatus?.slots || []).filter((s) => s.enabled);

    for (const slot of enabledSlots) {
      const worker = workerById.get(slot.currentProfileId);
      const workerActive = !!(worker && ACTIVE_WORKER_STATUSES.has(worker.status));

      if (workerActive) {
        usedWorkerIds.add(worker!.profileId);
        rows.push({
          ...worker!,
          rowKey: worker!.profileId,
          displayName: profileName(worker!.profileId, slot.profileName),
          source: 'worker',
          slotId: slot.slotId,
          recycleStatus: 'running',
          cooldownUntil: null,
          cycleCount: slot.cycleCount,
          lastError: slot.lastError,
        });
      } else if (RECYCLE_ACTIVE_STATUSES.has(slot.status)) {
        rows.push(slotToRow(slot));
      } else if (slot.status === 'idle' || slot.status === 'queued') {
        rows.push(slotToRow(slot));
      }
    }

    for (const w of workers) {
      if (!usedWorkerIds.has(w.profileId)) {
        const stillActive = ACTIVE_WORKER_STATUSES.has(w.status);
        rows.push({
          ...w,
          rowKey: w.profileId,
          displayName: profileName(w.profileId),
          source: 'worker',
          recycleStatus: stillActive ? 'running' : undefined,
        });
      }
    }

    return rows;
  }, [workers, recycleStatus, profileName]);

  const visibleRows = useMemo(() => {
    if (!filterSet) return mergedRows;
    return mergedRows.filter((r) => filterSet.has(r.profileId));
  }, [mergedRows, filterSet]);

  const visibleStats = useMemo((): WorkerStats => {
    if (!filterSet) return stats;
    let running = 0;
    let done = 0;
    let error = 0;
    let waiting = 0;
    for (const w of visibleRows) {
      if (w.status === 'done') done++;
      else if (w.status === 'error' || w.status === 'crashed') error++;
      else if (w.status === 'waiting' || w.status === 'cooldown' || w.status === 'queued') waiting++;
      else running++;
    }
    return { total: visibleRows.length, running, done, error, waiting };
  }, [stats, filterSet, visibleRows]);

  const recycleActive = !!(recycleStatus?.enabled && recycleStatus.slots.some((s) => s.enabled));

  const stopWorker = async (profileId: string) => {
    try {
      await backendFetch(`/api/workers/stop/${profileId}`, { method: 'POST' });
    } catch {}
  };

  const stopAll = async () => {
    try {
      await backendFetch('/api/schedule/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    } catch {}
  };

  const handleStopRecycle = async () => {
    setLoopBusyLocal(true);
    try {
      if (onStopRecycle) await onStopRecycle();
      else await stopRecycleLoop();
      setRecycleStatus(await fetchRecycleStatus());
    } finally {
      setLoopBusyLocal(false);
    }
  };

  const handleStartRecycle = async () => {
    if (!onStartRecycle) return;
    setLoopBusyLocal(true);
    try {
      await onStartRecycle();
      setRecycleStatus(await fetchRecycleStatus());
    } finally {
      setLoopBusyLocal(false);
    }
  };

  const arrangeAll = async () => {
    const ids = displayRows
      .filter(w => ACTIVE_WORKER_STATUSES.has(w.status))
      .map(w => w.profileId);
    if (!ids.length) return;
    try {
      await backendFetch('/api/manual/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds: ids, command: 'arrangeWindows' }),
      });
    } catch {}
  };

  const formatUptime = (ms: number) => {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    if (hr > 0) return `${hr}h ${min % 60}m`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
  };

  const displayStats = filterSet ? visibleStats : stats;
  const displayRows = filterSet ? visibleRows : mergedRows;
  const displayActive = filterSet
    ? (visibleStats.running > 0 || visibleStats.waiting > 0 || recycleActive)
    : (isActive || recycleActive);

  const loopBusy = recycleLoopBusy || loopBusyLocal;

  const overallProgress = displayStats.total > 0
    ? Math.round(((displayStats.done + displayStats.error) / displayStats.total) * 100)
    : 0;

  const showPanel = displayActive || displayRows.length > 0 || recycleActive;

  if (!showPanel) {
    if (hideWhenIdle) return null;
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <div className="flex items-center gap-3">
          <Activity size={18} className="text-gray-600" />
          <div>
            <h3 className="text-gray-400 font-medium text-sm">Live Progress</h3>
            <p className="text-gray-600 text-xs">No active tasks. Start a schedule, shuffle, or 24/7 loop to see progress here.</p>
          </div>
        </div>
      </div>
    );
  }

  const headerLabel = runLabel || (recycleActive ? '24/7 Loop Progress' : 'Live Progress');

  return (
    <div className={`bg-gray-900 border ${displayActive ? 'border-green-700/40' : 'border-gray-800'} rounded-2xl p-5 ${displayActive ? 'ring-1 ring-green-500/20' : ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${displayActive ? 'bg-green-600 animate-pulse' : recycleActive ? 'bg-emerald-800' : 'bg-gray-700'}`}>
            {recycleActive && !displayStats.running ? (
              <RefreshCw size={16} className="text-white" />
            ) : (
              <Activity size={16} className="text-white" />
            )}
          </div>
          <div>
            <h3 className="text-white font-semibold text-sm flex items-center gap-2">
              {headerLabel}
              {displayActive && <span className="text-xs text-green-400 animate-pulse">● RUNNING</span>}
              {recycleActive && !displayStats.running && (
                <span className="text-xs text-emerald-400">● 24/7 ACTIVE</span>
              )}
            </h3>
            <p className="text-gray-500 text-xs">
              {displayStats.total} workers • {displayStats.running} active • {displayStats.done} done
              {recycleActive && ` • ${recycleStatus!.activeSlots} recycle slot(s)`}
              {filterSet && ` · ${filterProfileIds!.length} profiles in this run`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showRecycleControls && recycleActive && (
            <button
              type="button"
              disabled={loopBusy}
              onClick={() => void handleStopRecycle()}
              className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
            >
              <Square size={12} /> Stop 24/7
            </button>
          )}
          {showRecycleControls && !recycleActive && onStartRecycle && canStartRecycle && (
            <button
              type="button"
              disabled={loopBusy}
              onClick={() => void handleStartRecycle()}
              className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1"
            >
              <Play size={12} /> Start 24/7
            </button>
          )}
          {displayStats.running > 0 && (
            <>
              <button type="button" onClick={arrangeAll} className="bg-purple-600/30 hover:bg-purple-600/50 border border-purple-600/40 text-purple-300 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1">
                <LayoutGrid size={12} /> Arrange All
              </button>
              <button onClick={stopAll} className="bg-red-600 hover:bg-red-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1">
                <Square size={12} /> Stop All
              </button>
            </>
          )}
        </div>
      </div>

      {/* Overall Progress Bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-gray-400">Overall Progress</span>
          <span className="text-xs font-mono text-white">{overallProgress}% ({displayStats.done + displayStats.error}/{displayStats.total})</span>
        </div>
        <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-500 relative" style={{ width: `${overallProgress}%`, background: 'linear-gradient(90deg, #22c55e, #16a34a)' }}>
            {displayActive && <div className="absolute inset-0 bg-white/20 animate-pulse rounded-full" />}
          </div>
        </div>
        <div className="flex gap-4 mt-1.5 text-xs flex-wrap">
          <span className="text-green-400">✓ {displayStats.done} done</span>
          <span className="text-yellow-400">⏳ {displayStats.running} running</span>
          <span className="text-blue-400">⏸ {displayStats.waiting} waiting</span>
          {displayStats.error > 0 && <span className="text-red-400">✗ {displayStats.error} failed</span>}
        </div>
      </div>

      {/* Per-Worker / Recycle Rows */}
      <div className={`space-y-2 overflow-y-auto ${compact ? 'max-h-60' : 'max-h-80'}`}>
        {displayRows.length === 0 && filterSet && (
          <p className="text-xs text-gray-500 py-2">Workers starting… (filtered to this run only)</p>
        )}
        {displayRows.map(w => {
          const [done, total] = (w.progress || '0/0').split('/').map(Number);
          const workerPercent = total > 0 ? Math.round((done / total) * 100) : 0;
          const isRunning = ACTIVE_WORKER_STATUSES.has(w.status);
          const isCooldown = w.status === 'cooldown';
          const isRecreating = w.status === 'recreating';
          const isDone = w.status === 'done';
          const isError = w.status === 'error' || w.status === 'crashed';
          const isExpanded = expanded === w.rowKey;
          const cooldownText = isCooldown && w.cooldownUntil
            ? formatCooldownRemaining(w.cooldownUntil, now)
            : null;

          return (
            <div key={w.rowKey} className={`rounded-xl border transition-all ${isRunning ? 'border-green-700/40 bg-green-900/10' : isCooldown ? 'border-amber-700/40 bg-amber-900/10' : isRecreating ? 'border-purple-700/40 bg-purple-900/10' : isDone ? 'border-blue-700/30 bg-blue-900/5' : isError ? 'border-red-700/30 bg-red-900/5' : 'border-gray-700 bg-gray-800/50'}`}>
              <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer" onClick={() => setExpanded(isExpanded ? null : w.rowKey)}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${isRunning ? 'bg-green-600' : isCooldown ? 'bg-amber-600' : isRecreating ? 'bg-purple-600' : isDone ? 'bg-blue-600' : isError ? 'bg-red-600' : 'bg-gray-600'}`}>
                  {isRunning && <Loader size={12} className="text-white animate-spin" />}
                  {isCooldown && <Clock size={12} className="text-white" />}
                  {isRecreating && <RefreshCw size={12} className="text-white animate-spin" />}
                  {isDone && <CheckCircle size={12} className="text-white" />}
                  {isError && <XCircle size={12} className="text-white" />}
                  {!isRunning && !isDone && !isError && !isCooldown && !isRecreating && <Clock size={12} className="text-white" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white text-xs font-medium truncate">{w.displayName}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${isRunning ? 'bg-green-900/50 text-green-400' : isCooldown ? 'bg-amber-900/50 text-amber-400' : isRecreating ? 'bg-purple-900/50 text-purple-400' : isDone ? 'bg-blue-900/50 text-blue-400' : isError ? 'bg-red-900/50 text-red-400' : 'bg-gray-700 text-gray-400'}`}>
                      {w.recycleStatus ? recycleStatusLabel(w.recycleStatus) : w.status}
                    </span>
                    {typeof w.cycleCount === 'number' && w.cycleCount > 0 && (
                      <span className="text-[10px] text-gray-500">cycle #{w.cycleCount}</span>
                    )}
                  </div>
                  {isCooldown && cooldownText && cooldownText !== '—' && (
                    <p className="text-xs text-amber-300 mt-0.5 flex items-center gap-1">
                      <Clock size={10} className="flex-shrink-0" />
                      Next run in {cooldownText}
                    </p>
                  )}
                  {isRecreating && (
                    <p className="text-xs text-purple-300 mt-0.5">Recreating profile…</p>
                  )}
                  {w.currentVideo && isRunning && (
                    <p className="text-xs text-gray-400 truncate mt-0.5 flex items-center gap-1">
                      <Tv size={10} className="text-red-400 flex-shrink-0" />
                      {w.currentVideo}
                    </p>
                  )}
                  {w.lastError && isError && (
                    <p className="text-xs text-red-400 truncate mt-0.5">{w.lastError}</p>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {!isCooldown && !isRecreating && (
                    <>
                      <div className="w-20">
                        <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all ${isDone ? 'bg-blue-500' : isError ? 'bg-red-500' : 'bg-green-500'}`} style={{ width: `${workerPercent}%` }} />
                        </div>
                      </div>
                      <span className="text-xs font-mono text-gray-300 w-10 text-right">{w.progress || '0/0'}</span>
                    </>
                  )}
                  {w.uptime > 0 && (
                    <span className="text-xs text-gray-500 w-12 text-right">{formatUptime(w.uptime)}</span>
                  )}
                  {isRunning && w.source === 'worker' && (
                    <button onClick={(e) => { e.stopPropagation(); stopWorker(w.profileId); }}
                      className="text-red-400 hover:text-red-300 p-1 rounded transition-all">
                      <Square size={10} />
                    </button>
                  )}
                </div>
              </div>

              {isExpanded && (
                <div className="px-3 pb-3 border-t border-gray-700/50 mt-1 pt-2">
                  <div className="space-y-0.5 max-h-32 overflow-y-auto">
                    {(w.logs || []).slice(-10).map((log, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span className="text-gray-600 flex-shrink-0 w-14">{new Date(log.time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full mt-1.5 ${log.level === 'error' ? 'bg-red-500' : log.level === 'success' ? 'bg-green-500' : log.level === 'warn' ? 'bg-yellow-500' : 'bg-gray-500'}`} />
                        <span className={`${log.level === 'error' ? 'text-red-400' : log.level === 'success' ? 'text-green-400' : 'text-gray-400'}`}>{log.message}</span>
                      </div>
                    ))}
                    {(!w.logs || w.logs.length === 0) && <p className="text-gray-600 text-xs">No logs yet</p>}
                  </div>
                  {w.results && (
                    <div className="flex gap-3 mt-2 pt-2 border-t border-gray-700/50 text-xs">
                      <span className="text-green-400">✓ {w.results.watched} watched</span>
                      <span className="text-red-400">✗ {w.results.failed} failed</span>
                      {w.results.skipped > 0 && <span className="text-yellow-400">⏭ {w.results.skipped} skipped</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
