import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  TrendingUp,
  Eye,
  Clock,
  Users,
  Calendar,
  ThumbsUp,
  Bell,
  MessageSquare,
  Download,
  AlertCircle,
  Search,
  Megaphone,
  Route,
  Activity,
  Zap,
} from 'lucide-react';
import type { Profile } from '../types';
import RateLimitDashboard from './RateLimitDashboard';
import {
  fetchAnalytics,
  exportAnalyticsJson,
  formatWatchTime,
  type AnalyticsResponse,
  type AnalyticsTimeFilter,
} from '../utils/analyticsApi';

interface AnalyticsPageProps {
  profiles:      Profile[];
  setActiveTab?: (tab: string) => void;
}

type ProfileSortKey = 'name' | 'views' | 'watchTime' | 'likes';

const FILTER_LABELS: Record<AnalyticsTimeFilter, string> = {
  today: '📅 Aaj',
  yesterday: '⏪ Kal',
  '7d': '📊 7 Din',
  '30d': '📈 30 Din',
  all: '🌐 All Time',
};

const PAGE_SIZE = 20;

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    view: 'View',
    watchTime: 'Watch time',
    like: 'Like',
    subscribe: 'Subscribe',
    comment: 'Comment',
    session: 'Session',
    ads_total: 'Ad shown',
    ads_skipped: 'Ad skipped',
    ads_watched_full: 'Ad watched',
    ad_watch_time: 'Ad watch time',
    'traffic_youtube-search': 'Traffic: YouTube',
    traffic_google: 'Traffic: Google',
    traffic_bing: 'Traffic: Bing',
    traffic_direct: 'Traffic: Direct',
    'traffic_direct-fallback': 'Traffic: Direct',
    'traffic_channel-page': 'Traffic: Channel',
    traffic_backlink: 'Traffic: Backlink',
    'traffic_backlink-direct-fallback': 'Traffic: Backlink (direct fallback)',
  };
  return map[action] || action;
}

export default function AnalyticsPage({ profiles, setActiveTab }: AnalyticsPageProps) {
  const [timeFilter, setTimeFilter] = useState<AnalyticsTimeFilter>('today');
  const [liveData, setLiveData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileSearch, setProfileSearch] = useState('');
  const [sortKey, setSortKey] = useState<ProfileSortKey>('views');
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchAnalytics(timeFilter);
    if (data) {
      setLiveData(data);
      setError(null);
    } else {
      setError('Analytics server se connect nahi ho paya. Backend chal raha hai?');
    }
    setLoading(false);
  }, [timeFilter]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [timeFilter, profileSearch, sortKey]);

  const profileById = useMemo(() => {
    const m = new Map<string, Profile>();
    profiles.forEach((p) => m.set(p.id, p));
    return m;
  }, [profiles]);

  const profileRows = useMemo(() => {
    const ids = new Set([
      ...profiles.map((p) => p.id),
      ...Object.keys(liveData?.perProfile || {}),
    ]);
    const rows = [...ids].map((id) => {
      const p = profileById.get(id);
      const stats = liveData?.perProfile?.[id] || {
        views: 0,
        watchTime: 0,
        likes: 0,
        subscribes: 0,
        comments: 0,
      };
      return {
        id,
        name: p?.name || `${id.slice(0, 12)}… (removed)`,
        os: p?.os || '—',
        status: p?.status || 'idle',
        orphan: !p,
        ...stats,
      };
    });
    const q = profileSearch.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      : rows;
    filtered.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      return (b[sortKey] as number) - (a[sortKey] as number);
    });
    return filtered;
  }, [profiles, liveData, profileById, profileSearch, sortKey]);

  const pageCount = Math.max(1, Math.ceil(profileRows.length / PAGE_SIZE));
  const pagedRows = profileRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const trend = liveData?.dailyTrend || [];
  const maxTrendViews = Math.max(1, ...trend.map((d) => d.views));

  const trafficTotal =
    (liveData?.trafficYouTube || 0) +
    (liveData?.trafficGoogle || 0) +
    (liveData?.trafficBing || 0) +
    (liveData?.trafficDirect || 0) +
    (liveData?.trafficDirectFallback || 0) +
    (liveData?.trafficChannel || 0) +
    (liveData?.trafficBacklink || 0) +
    (liveData?.trafficBacklinkFallback || 0);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Analytics</h1>
            <p className="text-gray-500 text-sm mt-0.5">Watch time, engagement, ads & traffic — server-backed</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex gap-1.5">
              {(Object.keys(FILTER_LABELS) as AnalyticsTimeFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setTimeFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    timeFilter === f
                      ? 'bg-red-600 text-white shadow-lg shadow-red-600/20'
                      : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                  }`}
                >
                  {FILTER_LABELS[f]}
                </button>
              ))}
            </div>
            {setActiveTab && (
              <button
                type="button"
                onClick={() => setActiveTab('engagement')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-yellow-900/30 border border-yellow-700/40 text-yellow-400 hover:bg-yellow-900/50 transition-all"
              >
                <Zap size={13} /> Engagement →
              </button>
            )}
            {liveData && (
              <button
                type="button"
                onClick={() => exportAnalyticsJson(liveData, timeFilter)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700"
              >
                <Download size={14} /> Export
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <Calendar size={14} className="text-gray-500" />
          <span className="text-xs text-gray-500">
            Showing: <span className="text-white font-medium">{FILTER_LABELS[timeFilter]}</span>
          </span>
          {loading && <span className="text-xs text-yellow-400 animate-pulse">Refreshing…</span>}
          {!loading && liveData && (
            <span className="text-xs text-green-500">● Synced</span>
          )}
        </div>
        {error && (
          <div className="mt-2 flex items-center gap-2 text-amber-400 text-xs">
            <AlertCircle size={14} />
            {error}
            <button type="button" onClick={load} className="underline hover:text-amber-300">
              Retry
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {[
            { label: 'Views', value: liveData?.totalViews ?? 0, icon: Eye, color: 'text-green-400', bg: 'border-green-700/30 bg-green-900/10' },
            { label: 'Watch Time', value: formatWatchTime(liveData?.totalWatchTime ?? 0), icon: Clock, color: 'text-blue-400', bg: 'border-blue-700/30 bg-blue-900/10' },
            { label: 'Sessions', value: liveData?.totalSessions ?? 0, icon: Users, color: 'text-purple-400', bg: 'border-purple-700/30 bg-purple-900/10' },
            { label: 'Likes', value: liveData?.totalLikes ?? 0, icon: ThumbsUp, color: 'text-red-400', bg: 'border-red-700/30 bg-red-900/10' },
            { label: 'Subscribes', value: liveData?.totalSubscribes ?? 0, icon: Bell, color: 'text-yellow-400', bg: 'border-yellow-700/30 bg-yellow-900/10' },
            { label: 'Comments', value: liveData?.totalComments ?? 0, icon: MessageSquare, color: 'text-orange-400', bg: 'border-orange-700/30 bg-orange-900/10' },
          ].map((s) => (
            <div key={s.label} className={`border rounded-2xl p-4 ${s.bg}`}>
              <s.icon size={20} className={`${s.color} mb-2`} />
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-gray-500 text-xs mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {(liveData?.totalAds ?? 0) > 0 || (liveData?.adWatchTime ?? 0) > 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
              <Megaphone size={16} className="text-amber-400" /> Ads
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatMini label="Total ads" value={liveData?.totalAds ?? 0} />
              <StatMini label="Skipped" value={liveData?.adsSkipped ?? 0} />
              <StatMini label="Watched full" value={liveData?.adsWatchedFull ?? 0} />
              <StatMini label="Ad watch time" value={formatWatchTime(liveData?.adWatchTime ?? 0)} />
            </div>
          </div>
        ) : null}

        {trafficTotal > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
              <Route size={16} className="text-cyan-400" /> Traffic sources
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
              <TrafficBar label="YouTube" count={liveData?.trafficYouTube ?? 0} total={trafficTotal} color="bg-red-500" />
              <TrafficBar label="Google" count={liveData?.trafficGoogle ?? 0} total={trafficTotal} color="bg-blue-500" />
              <TrafficBar label="Bing" count={liveData?.trafficBing ?? 0} total={trafficTotal} color="bg-teal-500" />
              <TrafficBar label="Direct" count={liveData?.trafficDirect ?? 0} total={trafficTotal} color="bg-gray-400" />
              <TrafficBar label="Search failed→URL" count={liveData?.trafficDirectFallback ?? 0} total={trafficTotal} color="bg-amber-600" />
              <TrafficBar label="Channel" count={liveData?.trafficChannel ?? 0} total={trafficTotal} color="bg-purple-500" />
              <TrafficBar label="Backlink" count={liveData?.trafficBacklink ?? 0} total={trafficTotal} color="bg-orange-500" />
              <TrafficBar label="Backlink fallback" count={liveData?.trafficBacklinkFallback ?? 0} total={trafficTotal} color="bg-amber-800" />
            </div>
          </div>
        )}

        {trend.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
              <TrendingUp size={16} className="text-green-400" /> Daily views
            </h2>
            <div className="flex items-end gap-1 h-32">
              {trend.slice(-14).map((d) => (
                <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <div
                    className="w-full bg-green-600/80 rounded-t"
                    style={{ height: `${Math.max(4, (d.views / maxTrendViews) * 100)}%` }}
                    title={`${d.date}: ${d.views} views, ${formatWatchTime(d.watchTime)}`}
                  />
                  <span className="text-[9px] text-gray-600 truncate w-full text-center">
                    {d.date.slice(5)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Users size={16} className="text-blue-400" /> Per-profile ({profileRows.length})
            </h2>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type="text"
                  placeholder="Search profile…"
                  value={profileSearch}
                  onChange={(e) => setProfileSearch(e.target.value)}
                  className="pl-8 pr-3 py-1.5 text-xs bg-gray-800 border border-gray-700 rounded-lg text-white w-40"
                />
              </div>
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as ProfileSortKey)}
                className="text-xs bg-gray-800 border border-gray-700 rounded-lg text-white px-2 py-1.5"
              >
                <option value="views">Sort: views</option>
                <option value="watchTime">Sort: watch time</option>
                <option value="likes">Sort: likes</option>
                <option value="name">Sort: name</option>
              </select>
            </div>
          </div>
          <div className="space-y-2">
            {pagedRows.map((r) => (
              <div
                key={r.id}
                className={`flex items-center gap-3 rounded-xl px-4 py-2.5 ${
                  r.orphan ? 'bg-amber-900/10 border border-amber-800/30' : 'bg-gray-800/50'
                }`}
              >
                <div
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    r.status === 'running' ? 'bg-green-500' : 'bg-gray-600'
                  }`}
                />
                <span className="text-white text-sm font-medium flex-1 truncate">{r.name}</span>
                <span className="text-xs text-gray-500 hidden sm:inline">{r.os}</span>
                <span className="text-green-400 text-xs font-bold">{r.views} views</span>
                <span className="text-blue-400 text-xs">{formatWatchTime(r.watchTime)}</span>
                <span className="text-red-400 text-xs">❤{r.likes}</span>
                <span className="text-yellow-400 text-xs">🔔{r.subscribes}</span>
                <span className="text-orange-400 text-xs">💬{r.comments}</span>
              </div>
            ))}
            {profileRows.length === 0 && (
              <p className="text-center text-gray-600 text-sm py-4">No data for this period.</p>
            )}
          </div>
          {pageCount > 1 && (
            <div className="flex justify-center gap-2 mt-4">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 text-xs rounded bg-gray-800 text-gray-400 disabled:opacity-40"
              >
                Prev
              </button>
              <span className="text-xs text-gray-500 self-center">
                {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 text-xs rounded bg-gray-800 text-gray-400 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>

        {(liveData?.recentActivity?.length ?? 0) > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
            <h2 className="text-white font-semibold mb-4 flex items-center gap-2">
              <Activity size={16} className="text-pink-400" /> Recent activity
            </h2>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {liveData!.recentActivity!.slice(-30).reverse().map((e, i) => (
                <div key={`${e.time}-${i}`} className="flex items-center gap-2 text-xs py-1 border-b border-gray-800/50">
                  <span className="text-gray-600 w-36 shrink-0">
                    {new Date(e.time).toLocaleString()}
                  </span>
                  <span className="text-gray-400 truncate flex-1">
                    {profileById.get(e.profileId)?.name || e.profileId.slice(0, 10)}
                  </span>
                  <span className="text-white">{actionLabel(e.action)}</span>
                  {e.value != null && e.value > 0 && (
                    <span className="text-gray-500">+{e.value}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <RateLimitDashboard profiles={profiles} />
      </div>
    </div>
  );
}

function StatMini({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-gray-800/50 rounded-xl p-3">
      <div className="text-lg font-bold text-white">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function TrafficBar({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-400">{label}</span>
        <span className="text-white">{count}</span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-gray-600">{pct}%</span>
    </div>
  );
}
