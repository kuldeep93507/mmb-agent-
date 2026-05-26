import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Trash2, Download, Search, RefreshCw, Pause, Play, AlertCircle, Info } from 'lucide-react';
import type { Profile, LogEntry, LogLevel, LogSource } from '../types';
import {
  fetchActivityLogs,
  clearActivityLogs,
  LOG_SOURCE_LABELS,
} from '../utils/logsApi';

interface LogsPageProps {
  profiles: Profile[];
  onClear?: () => void;
}

const LEVEL_CONFIG: Record<LogLevel, { label: string; color: string; badge: string; dot: string; ring: string }> = {
  info: { label: 'INFO', color: 'text-blue-300', badge: 'bg-blue-950/50 border-blue-700/40', dot: 'bg-blue-500', ring: 'border-blue-900/30' },
  warn: { label: 'WARN', color: 'text-amber-300', badge: 'bg-amber-950/40 border-amber-700/40', dot: 'bg-amber-500', ring: 'border-amber-900/40' },
  error: { label: 'ERROR', color: 'text-red-300', badge: 'bg-red-950/50 border-red-700/40', dot: 'bg-red-500', ring: 'border-red-900/40' },
  success: { label: 'OK', color: 'text-emerald-300', badge: 'bg-emerald-950/40 border-emerald-700/40', dot: 'bg-emerald-500', ring: 'border-emerald-900/30' },
};

const SOURCE_COLORS: Record<LogSource, string> = {
  worker: 'text-cyan-400',
  scheduler: 'text-orange-400',
  shuffle: 'text-purple-400',
  profile: 'text-pink-400',
  backlink: 'text-teal-400',
  manual: 'text-indigo-400',
  settings: 'text-gray-400',
  system: 'text-gray-500',
  'yt-agent': 'text-red-400',
};

const SOURCES: (LogSource | 'all')[] = [
  'all', 'worker', 'scheduler', 'shuffle', 'backlink', 'profile', 'manual', 'settings', 'system',
];

/** Worker info spam — hidden in "Important" view */
const WORKER_NOISE = [
  /^\[Autoplay\]/i,
  /^\[Quality\]/i,
  /^Duration:/i,
  /^Waiting for ads/i,
  /^Waiting \d+s before next video/i,
  /^\[Traffic\]/i,
  /^\[QA\]/i,
  /^Profile watch \d+%/i,
  /^\[AdSkip\]/i,
  /^Page visibility/i,
  /^Smooth scroll/i,
  /^Human mouse/i,
];

function isNoisyWorkerLog(entry: LogEntry): boolean {
  if (entry.source !== 'worker') return false;
  if (entry.level === 'error' || entry.level === 'warn') return false;
  return WORKER_NOISE.some((re) => re.test(entry.message));
}

function safeLevel(level: string): LogLevel {
  if (level === 'warn' || level === 'error' || level === 'success' || level === 'info') return level;
  return 'info';
}

function formatLogTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function headlineForLog(log: LogEntry): string {
  const m = log.message;
  if (/^Started schedule/i.test(m) || /Run started/i.test(m)) return 'Run started';
  if (/^Stopped schedule/i.test(m) || /Stop all/i.test(m)) return 'Run stopped';
  if (/^Schedule.*failed/i.test(m) || log.level === 'error') return 'Problem';
  if (/Finished:/i.test(m) || /complete/i.test(m)) return 'Video done';
  if (/Now watching:/i.test(m) || /^Video \d+\/\d+:/i.test(m)) return 'Watching';
  if (/^Shuffle/i.test(m)) return 'Shuffle';
  if (/profile/i.test(m) && /creat/i.test(m)) return 'Profile created';
  if (/proxy/i.test(m)) return 'Proxy';
  if (log.level === 'success') return 'Success';
  if (log.level === 'warn') return 'Warning';
  return LOG_SOURCE_LABELS[log.source || 'system'] || 'Activity';
}

export default function LogsPage({ profiles, onClear }: LogsPageProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Record<LogLevel, number>>({ info: 0, warn: 0, error: 0, success: 0 });
  const [filter, setFilter] = useState<LogLevel | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<LogSource | 'all'>('all');
  const [profileFilter, setProfileFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'important' | 'all'>('important');
  const [autoScroll, setAutoScroll] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const prevTopId = useRef<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchActivityLogs({
        limit: 500,
        level: filter,
        source: sourceFilter,
        profileId: profileFilter || undefined,
        search: search || undefined,
      });
      setEntries(data.entries);
      setTotal(data.total);
      if (data.stats) setStats(data.stats);
      setFetchError('');
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filter, sourceFilter, profileFilter, search]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  const displayEntries = useMemo(() => {
    let list = entries;
    if (viewMode === 'important') {
      list = list.filter((e) => !isNoisyWorkerLog(e));
    }
    return list;
  }, [entries, viewMode]);

  useEffect(() => {
    if (!autoScroll || !logsContainerRef.current || displayEntries.length === 0) return;
    const topId = displayEntries[0]?.id;
    if (topId && topId !== prevTopId.current) {
      prevTopId.current = topId;
      logsContainerRef.current.scrollTop = 0;
    }
  }, [displayEntries, autoScroll]);

  const hiddenNoiseCount = useMemo(
    () => entries.filter(isNoisyWorkerLog).length,
    [entries],
  );

  const handleClear = async () => {
    if (!window.confirm('Saari activity logs server se delete karni hain?')) return;
    const result = await clearActivityLogs();
    if (!result.ok) {
      setFetchError(result.error || 'Clear failed — Settings page kholo ek baar (API token sync)');
      return;
    }
    onClear?.();
    setEntries([]);
    setTotal(0);
    setStats({ info: 0, warn: 0, error: 0, success: 0 });
    await refresh();
  };

  const exportLogs = (format: 'txt' | 'json') => {
    const logsToExport = displayEntries;
    if (format === 'json') {
      const blob = new Blob([JSON.stringify(logsToExport, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mmb-activity-logs-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
      return;
    }

    const text = logsToExport.map((l) => {
      const src = l.source ? LOG_SOURCE_LABELS[l.source] : '—';
      return `[${formatLogTime(l.timestamp)}] [${l.level.toUpperCase()}] [${src}] ${l.profileName ? `[${l.profileName}] ` : ''}${l.message}`;
    }).join('\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mmb-activity-logs-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Activity Logs</h1>
            <p className="text-gray-500 text-sm mt-0.5 max-w-xl">
              Yahan sab important events dikhte hain — schedule start/stop, shuffle, profile actions, worker errors.
              Technical worker spam default mein chhupa hota hai.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-xs ${fetchError ? 'border-red-700/40 text-red-400' : 'border-gray-700 text-gray-400'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${fetchError ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`} />
              {fetchError || 'Live · 4s refresh'}
            </div>
            <button type="button" onClick={() => void refresh()} className="p-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-white" title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button type="button" onClick={() => exportLogs('txt')} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 text-sm">
              <Download size={14} /> TXT
            </button>
            <button type="button" onClick={() => exportLogs('json')} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 text-sm">
              <Download size={14} /> JSON
            </button>
            <button type="button" onClick={() => void handleClear()} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-900/30 border border-red-700/30 text-red-400 hover:bg-red-900/50 text-sm">
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-center">
            <div className="text-lg font-bold text-white">{total}</div>
            <div className="text-[10px] text-gray-500 uppercase">Total stored</div>
          </div>
          {(['success', 'info', 'warn', 'error'] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setFilter(filter === l ? 'all' : l)}
              className={`rounded-xl px-3 py-2 text-center border transition-all ${filter === l ? LEVEL_CONFIG[l].badge : 'bg-gray-900 border-gray-800 hover:border-gray-700'}`}
            >
              <div className={`text-lg font-bold ${LEVEL_CONFIG[l].color}`}>{stats[l]}</div>
              <div className="text-[10px] text-gray-500 uppercase">{LEVEL_CONFIG[l].label}</div>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-xl border border-gray-700 overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setViewMode('important')}
              className={`px-3 py-1.5 ${viewMode === 'important' ? 'bg-purple-900/40 text-purple-300' : 'bg-gray-800 text-gray-500'}`}
            >
              Important
            </button>
            <button
              type="button"
              onClick={() => setViewMode('all')}
              className={`px-3 py-1.5 ${viewMode === 'all' ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-500'}`}
            >
              All logs
            </button>
          </div>

          {(['all', 'success', 'info', 'warn', 'error'] as const).map((l) => {
            const conf = l === 'all' ? null : LEVEL_CONFIG[l];
            return (
              <button
                key={l}
                type="button"
                onClick={() => setFilter(l)}
                className={`px-3 py-1.5 rounded-xl border text-xs font-medium uppercase transition-all
                  ${filter === l
                    ? l === 'all' ? 'bg-gray-700 border-gray-600 text-white' : `${conf!.badge} ${conf!.color}`
                    : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'}`}
              >
                {l === 'all' ? 'All levels' : l}
              </button>
            );
          })}

          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as LogSource | 'all')}
            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-xl px-3 py-1.5 text-xs"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All sources' : LOG_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>

          <select
            value={profileFilter}
            onChange={(e) => setProfileFilter(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-xl px-3 py-1.5 text-xs max-w-[180px]"
          >
            <option value="">All profiles</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <div className="relative ml-auto min-w-[180px]">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Search message..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-gray-500"
            />
          </div>
        </div>

        {viewMode === 'important' && hiddenNoiseCount > 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-gray-500 bg-gray-900/80 border border-gray-800 rounded-lg px-3 py-2">
            <Info size={13} className="text-purple-400 flex-shrink-0" />
            {hiddenNoiseCount} technical worker lines hidden (autoplay, quality, ads…) — &quot;All logs&quot; dabao poora detail ke liye
          </div>
        )}
      </div>

      <div ref={logsContainerRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading && entries.length === 0 ? (
          <div className="text-center py-16 text-gray-600">Loading logs…</div>
        ) : displayEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 px-4">
            <AlertCircle size={40} className="text-gray-700 mb-3" />
            <h3 className="text-gray-400 font-semibold text-base mb-2">Koi log nahi mila</h3>
            <p className="text-gray-600 text-sm text-center max-w-md">
              Schedule chalao, Video Shuffle run karo, ya profile create karo — events yahan dikhenge.
              {viewMode === 'important' && ' Agar sirf technical detail chahiye to "All logs" try karo.'}
            </p>
          </div>
        ) : (
          displayEntries.map((log) => {
            const level = safeLevel(log.level);
            const conf = LEVEL_CONFIG[level];
            const src = log.source || 'system';
            const srcLabel = LOG_SOURCE_LABELS[src] || src;
            const srcColor = SOURCE_COLORS[src] || 'text-gray-500';
            const headline = headlineForLog(log);

            return (
              <div
                key={log.id}
                className={`rounded-xl border px-4 py-3 transition-all hover:bg-gray-900/40 ${conf.ring} ${
                  level === 'error' ? 'bg-red-950/15' :
                  level === 'warn' ? 'bg-amber-950/10' :
                  level === 'success' ? 'bg-emerald-950/10' :
                  'bg-gray-900/30 border-gray-800/80'
                }`}
              >
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-shrink-0 w-[52px] text-right">
                    <div className="text-[11px] text-gray-500 font-mono">{formatLogTime(log.timestamp)}</div>
                    <div className="text-[10px] text-gray-600">{formatRelative(log.timestamp, now)}</div>
                  </div>

                  <span className={`flex-shrink-0 px-2 py-0.5 rounded-md text-[10px] font-bold border ${conf.badge} ${conf.color}`}>
                    {conf.label}
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <span className="text-white text-sm font-medium">{headline}</span>
                      <span className={`text-[10px] uppercase tracking-wide ${srcColor}`}>{srcLabel}</span>
                      {log.profileName && (
                        <span className="text-[10px] text-purple-400 bg-purple-950/40 border border-purple-800/40 px-1.5 py-0.5 rounded">
                          {log.profileName}
                        </span>
                      )}
                    </div>
                    <p className={`text-sm leading-relaxed break-words ${
                      level === 'error' ? 'text-red-200/90' :
                      level === 'warn' ? 'text-amber-200/90' :
                      level === 'success' ? 'text-emerald-200/90' :
                      'text-gray-400'
                    }`}>
                      {log.message}
                    </p>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-6 py-2 border-t border-gray-800 bg-gray-950/50 flex-shrink-0 text-xs text-gray-600 flex items-center gap-4 flex-wrap">
        <span>Newest upar · server max 2000 entries</span>
        <button
          type="button"
          onClick={() => setAutoScroll((v) => !v)}
          className="flex items-center gap-1 hover:text-gray-400"
        >
          {autoScroll ? <Pause size={12} /> : <Play size={12} />}
          New logs scroll top: {autoScroll ? 'On' : 'Off'}
        </button>
        <span className="ml-auto">{displayEntries.length} shown{viewMode === 'important' && hiddenNoiseCount ? ` · ${hiddenNoiseCount} hidden` : ''}</span>
      </div>
    </div>
  );
}
