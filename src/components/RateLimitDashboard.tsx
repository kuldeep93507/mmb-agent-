import { useState, useEffect, useCallback } from 'react';
import { Heart, Bell, MessageSquare, RefreshCw } from 'lucide-react';
import type { Profile } from '../types';
import {
  fetchAnalytics,
  getProfileEngagementConfig,
  resetTodayEngagement,
  type ProfileAnalytics,
} from '../utils/analyticsApi';
import { Card, CardHeader, Btn, Badge } from './ui';

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
    <Card>
      <CardHeader
        title="Engagement Rate Limits (Today)"
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {loading && <Badge color="yellow">syncing</Badge>}
            <Badge color="green">Live · 15s</Badge>
            <Btn size="sm" onClick={resetAll} disabled={resetting} icon={<RefreshCw size={11}/>}>
              Reset Counts
            </Btn>
          </div>
        }
      />
      <div style={{ padding: '14px 16px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 16 }}>
          {[
            { icon: Heart, label: 'Likes', val: totalLikes, color: 'var(--mmb-red)', bg: 'var(--mmb-red-bg)' },
            { icon: Bell, label: 'Subscribes', val: totalSubs, color: 'var(--mmb-blue)', bg: 'var(--mmb-blue-bg)' },
            { icon: MessageSquare, label: 'Comments', val: totalComments, color: 'var(--mmb-green)', bg: 'var(--mmb-green-bg)' },
          ].map(({ icon: Icon, label, val, color, bg }) => (
            <div key={label} style={{ background: bg, borderRadius: 10, padding: 14, textAlign: 'center' }}>
              <Icon size={16} style={{ color, margin: '0 auto 6px', display: 'block' }}/>
              <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{val}</div>
              <div style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 4 }}>{label} today</div>
            </div>
          ))}
        </div>

        <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {engagementProfiles.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--mmb-muted)', fontSize: 13, padding: '20px 0' }}>
              No engagement enabled. Enable Like/Subscribe/Comment in Profile Settings.
            </p>
          ) : (
            engagementProfiles.slice(0, 20).map((p) => {
              const count = perProfile[p.id] || { likes: 0, subscribes: 0, comments: 0, views: 0, watchTime: 0 };
              const caps = getProfileEngagementConfig(p.id);
              return (
                <div key={p.id} style={{
                  background: 'var(--mmb-surface2)', borderRadius: 10, padding: '12px 14px',
                  border: '1px solid var(--mmb-border)',
                }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--mmb-text)', display: 'block', marginBottom: 8 }}>{p.name}</span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                    {caps.likeEnabled && <CapBar label="Likes" used={count.likes || 0} cap={caps.likeDailyCap}/>}
                    {caps.subscribeEnabled && <CapBar label="Subscribes" used={count.subscribes || 0} cap={caps.subscribeDailyCap}/>}
                    {caps.commentEnabled && <CapBar label="Comments" used={count.comments || 0} cap={caps.commentDailyCap}/>}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <p style={{ fontSize: 11, color: 'var(--mmb-muted)', marginTop: 12, textAlign: 'center' }}>
          Counts from live analytics · Caps set in Profile Settings · Resets at midnight (server)
        </p>
      </div>
    </Card>
  );
}

function CapBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const atCap = used >= cap;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
        <span style={{ color: 'var(--mmb-muted)' }}>{label}</span>
        <span style={{ color: atCap ? 'var(--mmb-red)' : 'var(--mmb-green)', fontWeight: 600 }}>{used}/{cap}</span>
      </div>
      <div style={{ height: 6, background: 'var(--mmb-border)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 99, width: `${pct}%`,
          background: atCap ? 'var(--mmb-red)' : 'var(--mmb-green)', transition: 'width .3s',
        }}/>
      </div>
    </div>
  );
}
