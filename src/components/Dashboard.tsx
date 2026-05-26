import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Users, Play, Globe, BarChart3, Activity, TrendingUp, Calendar, Shuffle, Link2,
  Settings, RefreshCw, AlertTriangle, Eye, Clock, Zap,
} from 'lucide-react';
import type { Profile } from '../types';
import RateLimitDashboard from './RateLimitDashboard';
import { backendFetch } from '../services/backendOrigin';
import {
  fetchBackendHealth,
  fetchConcurrency,
  fetchAnalytics,
  formatWatchTime,
  type BackendHealth,
} from '../utils/dashboardApi';
import { stopScheduleRun } from '../utils/shuffleApi';

interface WorkerRow {
  profileId: string;
  status: string;
  currentVideo: string | null;
  progress: string;
}

interface DashboardProps {
  profiles: Profile[];
  setActiveTab: (tab: string) => void;
}

const LIVE_PROFILE_STATUSES = new Set(['running', 'starting']);
const LIVE_WORKER_STATUSES = new Set([
  'running', 'watching', 'searching', 'waiting', 'starting', 'connecting',
]);

function isWorkerLive(status: string): boolean {
  return LIVE_WORKER_STATUSES.has(status);
}

export default function Dashboard({ profiles, setActiveTab }: DashboardProps) {
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [workerStats, setWorkerStats] = useState({ total: 0, running: 0, done: 0, error: 0, waiting: 0 });
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [concurrency, setConcurrency] = useState<{ limit: number; running: number; available: number } | null>(null);
  const [todayAnalytics, setTodayAnalytics] = useState<Awaited<ReturnType<typeof fetchAnalytics>>>(null);
  const [fetchError, setFetchError] = useState('');
  const [stopping, setStopping] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [workersRes, healthData, conc, analytics] = await Promise.all([
        backendFetch('/api/workers'),
        fetchBackendHealth(),
        fetchConcurrency(),
        fetchAnalytics('today'),
      ]);

      if (!workersRes.ok) throw new Error(`Workers API ${workersRes.status}`);
      const wData = await workersRes.json();
      setWorkers(wData.workers || []);
      setWorkerStats(wData.stats || { total: 0, running: 0, done: 0, error: 0, waiting: 0 });
      setHealth(healthData);
      setConcurrency(conc);
      setTodayAnalytics(analytics);
      setFetchError('');
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const liveWorkerCount = workers.filter((w) => isWorkerLive(w.status)).length;
  const manualRunning = profiles.filter((p) => LIVE_PROFILE_STATUSES.has(p.status)).length;
  const now = Date.now();
  const proxyExpired = profiles.filter((p) => p.proxy.expiresAt > 0 && p.proxy.expiresAt < now).length;
  const proxyExpiringSoon = profiles.filter(
    (p) => p.proxy.expiresAt > now && p.proxy.expiresAt < now + 2 * 60 * 60 * 1000,
  ).length;
  const uniqueStates = new Set(profiles.map((p) => p.proxy.state).filter(Boolean)).size;

  const activeRows = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; os: string; status: string; detail: string; source: 'worker' | 'profile' }>();

    for (const w of workers) {
      if (!isWorkerLive(w.status) && w.status !== 'done') continue;
      const p = profiles.find((x) => x.id === w.profileId);
      byId.set(w.profileId, {
        id: w.profileId,
        name: p?.name || `Profile-${w.profileId.slice(-4)}`,
        os: p?.os || '—',
        status: w.status,
        detail: w.currentVideo ? `🎬 ${w.currentVideo}` : w.progress ? `Progress ${w.progress}` : '',
        source: 'worker',
      });
    }

    for (const p of profiles) {
      if (!LIVE_PROFILE_STATUSES.has(p.status)) continue;
      if (byId.has(p.id)) continue;
      byId.set(p.id, {
        id: p.id,
        name: p.name,
        os: p.os,
        status: p.status,
        detail: p.currentAction || '',
        source: 'profile',
      });
    }

    return [...byId.values()].slice(0, 10);
  }, [workers, profiles]);

  const recentActivity = (todayAnalytics?.recentActivity || []).slice(-8).reverse();

  const handleStopAll = async () => {
    setStopping(true);
    await stopScheduleRun('');
    await refresh();
    setStopping(false);
  };

  const stats = [
    {
      label: 'Total Profiles',
      value: profiles.length,
      icon: Users,
      color: 'blue',
      sub: `${uniqueStates} US states`,
      subColor: 'text-blue-300',
    },
    {
      label: 'Live Activity',
      value: Math.max(liveWorkerCount, manualRunning),
      icon: Play,
      color: 'green',
      sub: liveWorkerCount > 0 ? `${liveWorkerCount} workers` : manualRunning ? `${manualRunning} manual` : 'Idle',
      subColor: 'text-green-400',
    },
    {
      label: "Today's Views",
      value: todayAnalytics?.totalViews ?? '—',
      icon: Eye,
      color: 'emerald',
      sub: `${todayAnalytics?.totalSessions ?? 0} sessions`,
      subColor: 'text-gray-400',
    },
    {
      label: 'Watch Time Today',
      value: todayAnalytics ? formatWatchTime(todayAnalytics.totalWatchTime) : '—',
      icon: Clock,
      color: 'purple',
      sub: `❤${todayAnalytics?.totalLikes ?? 0} 🔔${todayAnalytics?.totalSubscribes ?? 0}`,
      subColor: 'text-gray-400',
    },
    {
      label: 'Worker Slots',
      value: concurrency ? `${concurrency.running}/${concurrency.limit}` : '—',
      icon: Zap,
      color: 'yellow',
      sub: concurrency ? `${concurrency.available} free` : 'Settings → limits',
      subColor: 'text-yellow-400',
    },
    {
      label: 'Proxy Alerts',
      value: proxyExpired + proxyExpiringSoon,
      icon: Globe,
      color: proxyExpired > 0 ? 'red' : 'yellow',
      sub: proxyExpired > 0 ? `${proxyExpired} expired` : proxyExpiringSoon ? `${proxyExpiringSoon} expiring` : 'All OK',
      subColor: proxyExpired > 0 ? 'text-red-400' : 'text-gray-400',
    },
  ];

  const colorMap: Record<string, string> = {
    blue: 'from-blue-500/20 to-blue-600/10 border-blue-500/30 text-blue-400',
    green: 'from-green-500/20 to-green-600/10 border-green-500/30 text-green-400',
    purple: 'from-purple-500/20 to-purple-600/10 border-purple-500/30 text-purple-400',
    yellow: 'from-yellow-500/20 to-yellow-600/10 border-yellow-500/30 text-yellow-400',
    emerald: 'from-emerald-500/20 to-emerald-600/10 border-emerald-500/30 text-emerald-400',
    red: 'from-red-500/20 to-red-600/10 border-red-500/30 text-red-400',
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Workers, analytics & profiles — server-backed overview</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm ${fetchError ? 'border-red-700/40 bg-red-900/20 text-red-400' : 'border-gray-700 bg-gray-800 text-gray-300'}`}>
            <div className={`w-2 h-2 rounded-full ${fetchError ? 'bg-red-500' : 'bg-green-500 animate-pulse'}`} />
            {fetchError || 'Live sync'}
          </div>
          <button type="button" onClick={refresh} className="p-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-white" title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        {[
          { tab: 'scheduler', label: 'Scheduler', icon: Calendar },
          { tab: 'video-shuffle', label: 'Shuffle', icon: Shuffle },
          { tab: 'backlinks', label: 'Backlinks', icon: Link2 },
          { tab: 'profiles', label: 'Profiles', icon: Users },
          { tab: 'analytics', label: 'Analytics', icon: BarChart3 },
          { tab: 'settings', label: 'Settings', icon: Settings },
        ].map(({ tab, label, icon: Icon }) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 text-xs hover:border-gray-500 hover:text-white"
          >
            <Icon size={14} /> {label}
          </button>
        ))}
        {(liveWorkerCount > 0 || workerStats.waiting > 0) && (
          <button
            type="button"
            onClick={handleStopAll}
            disabled={stopping}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-red-600/80 text-white text-xs font-medium disabled:opacity-50"
          >
            {stopping ? 'Stopping…' : 'Stop all runs'}
          </button>
        )}
      </div>

      {/* Backend health strip */}
      {health && (
        <div className="flex flex-wrap gap-4 text-xs bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <span className="text-green-400">● API {health.status}</span>
          <span className="text-gray-400">Active schedules: <span className="text-white">{health.schedules}</span></span>
          <span className="text-gray-400">CDP agents: <span className="text-white">{health.agents}</span></span>
          <span className="text-gray-400">
            Workers: <span className="text-white">{workerStats.running} run</span> / {workerStats.waiting} wait / {workerStats.done} done
          </span>
        </div>
      )}

      {(proxyExpired > 0 || proxyExpiringSoon > 0) && (
        <div className="flex items-center gap-2 bg-amber-900/20 border border-amber-700/40 rounded-xl px-4 py-3 text-sm text-amber-200">
          <AlertTriangle size={16} className="shrink-0" />
          {proxyExpired > 0 && <span>{proxyExpired} profile(s) with expired proxy — renew on Profiles page.</span>}
          {proxyExpiringSoon > 0 && <span>{proxyExpiringSoon} expiring within 2h.</span>}
          <button type="button" onClick={() => setActiveTab('profiles')} className="ml-auto text-xs underline">
            Profiles →
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {stats.map(({ label, value, icon: Icon, color, sub, subColor }) => (
          <div key={label} className={`bg-gradient-to-br ${colorMap[color]} border rounded-2xl p-5`}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-gray-400 text-xs font-medium uppercase tracking-wider">{label}</p>
                <p className="text-3xl font-bold text-white mt-1">{value}</p>
                <p className={`text-xs mt-1 ${subColor}`}>{sub}</p>
              </div>
              <Icon size={20} className="opacity-80" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Activity size={16} className="text-green-400" /> Live activity
            </h2>
            <button type="button" onClick={() => setActiveTab('profiles')} className="text-xs text-gray-500 hover:text-gray-300">
              Profiles →
            </button>
          </div>
          {activeRows.length === 0 ? (
            <div className="text-center py-8 text-gray-600 text-sm">
              No active workers or running profiles. Start Scheduler or Shuffle.
            </div>
          ) : (
            <div className="space-y-2">
              {activeRows.map((r) => (
                <div key={r.id} className="flex items-center gap-3 bg-gray-800/50 rounded-xl px-3 py-2.5">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${isWorkerLive(r.status) || r.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-white text-xs font-medium truncate">{r.name}</span>
                      <span className="text-[10px] text-gray-500">{r.os}</span>
                      <span className="text-[10px] text-gray-600">{r.source === 'worker' ? 'schedule' : 'manual'}</span>
                    </div>
                    {r.detail && <p className="text-xs text-gray-500 truncate">{r.detail}</p>}
                  </div>
                  <span className="text-[10px] text-gray-400 capitalize">{r.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <TrendingUp size={16} className="text-blue-400" /> Recent activity (today)
            </h2>
            <button type="button" onClick={() => setActiveTab('analytics')} className="text-xs text-gray-500 hover:text-gray-300">
              Analytics →
            </button>
          </div>
          {recentActivity.length === 0 ? (
            <div className="text-center py-8 text-gray-600 text-sm">No tracked activity today yet.</div>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {recentActivity.map((e, i) => {
                const name = profiles.find((p) => p.id === e.profileId)?.name || e.profileId.slice(0, 8);
                return (
                  <div key={`${e.time}-${i}`} className="flex gap-2 text-xs py-1 border-b border-gray-800/50">
                    <span className="text-gray-600 shrink-0 w-16">{new Date(e.time).toLocaleTimeString()}</span>
                    <span className="text-gray-400 truncate w-24">{name}</span>
                    <span className="text-white flex-1 truncate">{e.action.replace('traffic_', '').replace(/_/g, ' ')}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold text-sm">Engagement limits (today)</h2>
          <button type="button" onClick={() => setActiveTab('analytics')} className="text-xs text-gray-500 hover:text-gray-300">
            Full analytics →
          </button>
        </div>
        <RateLimitDashboard profiles={profiles} />
      </div>
    </div>
  );
}
