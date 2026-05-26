import { useState, useEffect, useCallback } from 'react';
import { Heart, Bell, MessageSquare, RefreshCw } from 'lucide-react';
import type { Profile } from '../types';
import {
  fetchAnalytics,
  getProfileEngagementConfig,
  resetTodayEngagement,
  type ProfileAnalytics,
} from '../utils/analyticsApi';

interface RateLimitDashboardProps {
  profiles: Profile[];
}

export default function RateLimitDashboard({ profiles }: RateLimitDashboardProps) {
  const [perProfile, setPerProfile] = useState<Record<string, ProfileAnalytics>>({});
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const data = await fetchAnalytics('today');
    setPerProfile(data?.perProfile || {});
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh, profiles]);

  const resetAll = async () => {
    if (!window.confirm("Reset today's like/subscribe/comment counts on the server?")) return;
    setResetting(true);
    const ok = await resetTodayEngagement();
    if (ok) await refresh();
    setResetting(false);
  };

  const engagementProfiles = profiles.filter((p) => {
    const c = getProfileEngagementConfig(p.id);
    return c.likeEnabled || c.subscribeEnabled || c.commentEnabled;
  });

  const totalLikes = Object.values(perProfile).reduce((s, p) => s + (p.likes || 0), 0);
  const totalSubs = Object.values(perProfile).reduce((s, p) => s + (p.subscribes || 0), 0);
  const totalComments = Object.values(perProfile).reduce((s, p) => s + (p.comments || 0), 0);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white font-semibold flex items-center gap-2">
          📊 Rate Limits (Today)
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700/40 font-normal">Coming Soon — tracking only</span>
          {loading && <span className="text-xs text-yellow-400 font-normal">syncing…</span>}
        </h2>
        <button
          type="button"
          onClick={resetAll}
          disabled={resetting}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-all disabled:opacity-50"
        >
          <RefreshCw size={11} className={resetting ? 'animate-spin' : ''} /> Reset Counts
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-red-900/20 border border-red-800/30 rounded-xl p-3 text-center">
          <Heart size={16} className="text-red-400 mx-auto mb-1" />
          <div className="text-xl font-bold text-red-400">{totalLikes}</div>
          <div className="text-xs text-gray-500">Likes Today</div>
        </div>
        <div className="bg-blue-900/20 border border-blue-800/30 rounded-xl p-3 text-center">
          <Bell size={16} className="text-blue-400 mx-auto mb-1" />
          <div className="text-xl font-bold text-blue-400">{totalSubs}</div>
          <div className="text-xs text-gray-500">Subscribes Today</div>
        </div>
        <div className="bg-green-900/20 border border-green-800/30 rounded-xl p-3 text-center">
          <MessageSquare size={16} className="text-green-400 mx-auto mb-1" />
          <div className="text-xl font-bold text-green-400">{totalComments}</div>
          <div className="text-xs text-gray-500">Comments Today</div>
        </div>
      </div>

      <div className="space-y-2 max-h-60 overflow-y-auto">
        {engagementProfiles.length === 0 ? (
          <p className="text-center text-gray-600 text-sm py-4">
            No engagement enabled. Enable Like/Subscribe/Comment in Profile Settings.
          </p>
        ) : (
          engagementProfiles.slice(0, 20).map((p) => {
            const count = perProfile[p.id] || { likes: 0, subscribes: 0, comments: 0, views: 0, watchTime: 0 };
            const caps = getProfileEngagementConfig(p.id);
            return (
              <div key={p.id} className="bg-gray-800/50 rounded-xl px-4 py-3">
                <span className="text-white text-xs font-medium block mb-2 truncate">{p.name}</span>
                <div className="grid grid-cols-3 gap-3">
                  {caps.likeEnabled && (
                    <CapBar label="👍 Likes" used={count.likes || 0} cap={caps.likeDailyCap} />
                  )}
                  {caps.subscribeEnabled && (
                    <CapBar label="🔔 Subs" used={count.subscribes || 0} cap={caps.subscribeDailyCap} />
                  )}
                  {caps.commentEnabled && (
                    <CapBar label="💬 Comments" used={count.comments || 0} cap={caps.commentDailyCap} />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
      <p className="text-xs text-gray-600 mt-3 text-center">
        Midnight reset (server) • Caps in Profile Settings • Daily cap enforcement — <span className="text-amber-500/80">Coming Soon</span>
      </p>
    </div>
  );
}

function CapBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const atCap = used >= cap;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-gray-400">{label}</span>
        <span className={atCap ? 'text-red-400' : 'text-green-400'}>
          {used}/{cap}
        </span>
      </div>
      <div className="h-1.5 bg-gray-700 rounded-full">
        <div
          className={`h-full rounded-full ${atCap ? 'bg-red-500' : 'bg-green-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
