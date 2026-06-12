import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Radio } from 'lucide-react';
import { fetchActivityLogs } from '../../utils/logsApi';
import type { LogEntry, LogLevel } from '../../types';

interface Props {
  active: boolean;
  startedAt?: string;
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'text-blue-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
  success: 'text-emerald-300',
};

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}

export default function MastermindLogsPanel({ active, startedAt }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinceRef = useRef<number>(0);

  const poll = useCallback(async () => {
    setLoading(true);
    try {
      const since = startedAt ? Date.parse(startedAt) - 60000 : sinceRef.current;
      const res = await fetchActivityLogs({
        source: 'mastermind',
        limit: 120,
        since: since > 0 ? since : undefined,
      });
      const workerRes = active
        ? await fetchActivityLogs({ source: 'worker', limit: 40, since: since > 0 ? since : undefined })
        : { entries: [] as LogEntry[] };
      const merged = [...res.entries, ...workerRes.entries]
        .filter(e => e.message?.toLowerCase().includes('mastermind') || e.source === 'mastermind' || (active && e.source === 'worker'))
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      const seen = new Set<string>();
      const deduped = merged.filter(e => {
        const key = e.id || `${e.timestamp}-${e.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setEntries(deduped.slice(0, 80));
      if (deduped.length) sinceRef.current = Math.min(...deduped.map(e => e.timestamp ?? Date.now()));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Logs load failed');
    } finally {
      setLoading(false);
    }
  }, [active, startedAt]);

  useEffect(() => {
    void poll();
    const ms = active ? 5000 : 15000;
    const id = setInterval(() => { void poll(); }, ms);
    return () => clearInterval(id);
  }, [poll, active]);

  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-950/50">
        <p className="text-xs font-semibold text-gray-300 flex items-center gap-2">
          <Radio size={14} className={active ? 'text-emerald-400 animate-pulse' : 'text-gray-500'} />
          ③ Logs & Live
          {active && <span className="text-[10px] text-emerald-400 font-bold">POLLING</span>}
        </p>
        <button type="button" onClick={() => void poll()} disabled={loading}
          className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 px-2 py-1 rounded border border-gray-700">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {error && <p className="text-xs text-red-400 px-4 py-2">{error}</p>}
      <div className="max-h-72 overflow-y-auto divide-y divide-gray-800/80">
        {entries.length === 0 ? (
          <p className="text-xs text-gray-600 px-4 py-6 text-center">
            {active ? 'Real Run start karo — mastermind + worker logs yahan dikhenge' : 'Abhi koi mastermind log nahi'}
          </p>
        ) : (
          entries.map(e => (
            <div key={e.id || `${e.timestamp}-${e.message?.slice(0, 20)}`} className="px-4 py-2 text-[11px] font-mono flex gap-2">
              <span className="text-gray-600 shrink-0">{formatTime(e.timestamp)}</span>
              <span className={`shrink-0 uppercase font-bold w-12 ${LEVEL_CLASS[e.level] ?? 'text-gray-400'}`}>
                {(e.level || 'info').slice(0, 4)}
              </span>
              <span className="text-gray-500 shrink-0 w-16 truncate">{e.source ?? '—'}</span>
              <span className="text-gray-300 break-all">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
