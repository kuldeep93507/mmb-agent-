import {
  LayoutDashboard, Users, Settings, Tv, Calendar, Gamepad2, BarChart3,
  MessageSquare, Shuffle, Link, MonitorPlay, Zap, FileText,
  Cpu, Mail, Server, Shield, RefreshCw,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { backendFetch } from '../services/backendOrigin';

const NAV_ITEMS = [
  { group: 'MAIN', items: [
    { id: 'dashboard',    label: 'Dashboard',     icon: LayoutDashboard },
    { id: 'scheduler',    label: 'Scheduler',     icon: Calendar },
    { id: 'profiles',     label: 'Profiles',      icon: Users },
    { id: 'video-shuffle',label: 'Video Shuffle', icon: Shuffle },
  ]},
  { group: 'AUTOMATION', items: [
    { id: 'analytics',    label: 'Analytics',     icon: BarChart3 },
    { id: 'engagement',   label: 'Engagement',    icon: Zap },
    { id: 'recycle',      label: 'Recycle Control',icon: RefreshCw },
    { id: 'channels',     label: 'Channels',      icon: Tv },
    { id: 'backlinks',    label: 'Backlinks',     icon: Link },
    { id: 'comments',     label: 'Comments',      icon: MessageSquare },
    { id: 'monitor',      label: 'Live Monitor',  icon: MonitorPlay },
  ]},
  { group: 'SYSTEM', items: [
    { id: 'manual',       label: 'Manual Control',icon: Gamepad2 },
    { id: 'jobs',         label: 'Job Queue',     icon: Cpu },
    { id: 'gmail-setup',  label: 'Gmail Setup',   icon: Mail },
    { id: 'proxy',        label: 'Proxy Settings',icon: Shield },
    { id: 'logs',         label: 'Activity Logs', icon: FileText },
    { id: 'settings',     label: 'Settings',      icon: Settings },
  ]},
];

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  runningCount: number;
  pendingJobs: number;
  activeChannels?: number;
}

export default function Sidebar({ activeTab, setActiveTab, runningCount, pendingJobs, activeChannels = 0 }: SidebarProps) {
  const [multiloginStatus, setMultiloginStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [backendStatus, setBackendStatus] = useState<'checking' | 'running' | 'down'>('checking');
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await backendFetch('/api/health', { signal: AbortSignal.timeout(8000) });
        setBackendStatus(res.ok ? 'running' : 'down');
      } catch { setBackendStatus('down'); }
      try {
        let provider = 'multilogin';
        try {
          const settingsRes = await backendFetch('/api/settings', { signal: AbortSignal.timeout(5000) });
          if (settingsRes.ok) {
            const d = await settingsRes.json();
            if (d?.settings?.browserProvider) provider = String(d.settings.browserProvider).toLowerCase();
          }
        } catch { /* use default */ }
        const res = await backendFetch(`/api/providers/ping?provider=${provider}`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        setMultiloginStatus(data.code === 0 ? 'connected' : 'disconnected');
      } catch { setMultiloginStatus('disconnected'); }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  const totalProfiles = 50; // fixed fleet size

  const getBadge = (id: string) => {
    if (id === 'monitor' && runningCount > 0) return { count: runningCount, color: 'green' };
    if (id === 'profiles' && runningCount > 0) return { count: runningCount, color: 'green' };
    if (id === 'channels' && activeChannels > 0) return { count: activeChannels, color: 'blue' };
    if (id === 'jobs' && pendingJobs > 0) return { count: pendingJobs, color: 'yellow' };
    return null;
  };

  return (
    <aside
      style={{
        width: collapsed ? '64px' : '220px',
        background: 'var(--mmb-surface)',
        borderRight: '1px solid var(--mmb-border)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        transition: 'width 0.25s cubic-bezier(.4,0,.2,1)',
        flexShrink: 0,
        boxShadow: '2px 0 8px rgba(0,0,0,.05)',
        zIndex: 10,
      }}
    >
      {/* Logo */}
      <div style={{ padding: collapsed ? '16px 12px' : '16px 16px', borderBottom: '1px solid var(--mmb-border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            background: 'linear-gradient(135deg, #4f46e5, #7c3aed)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 12px rgba(79,70,229,.35)',
          }}>
            <span style={{ color: '#fff', fontWeight: 900, fontSize: 11, letterSpacing: '-.5px' }}>MMB</span>
          </div>
          {!collapsed && (
            <div>
              <div style={{ color: 'var(--mmb-text)', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}>MMB AGENT</div>
              <div style={{ color: 'var(--mmb-muted)', fontSize: 11 }}>24/7 PRO</div>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 8px', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {NAV_ITEMS.map(({ group, items }) => (
          <div key={group} style={{ marginBottom: 4 }}>
            {!collapsed && (
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '.08em',
                color: 'var(--mmb-muted)', padding: '10px 8px 4px',
                textTransform: 'uppercase',
              }}>
                {group}
              </div>
            )}
            {items.map(({ id, label, icon: Icon }) => {
              const isActive = activeTab === id;
              const badge = getBadge(id);
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  title={collapsed ? label : undefined}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: collapsed ? '8px 0' : '8px 10px',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    borderRadius: 8,
                    border: 'none',
                    borderLeft: isActive ? '3px solid var(--mmb-accent)' : '3px solid transparent',
                    background: isActive ? 'var(--mmb-accent-bg)' : 'transparent',
                    color: isActive ? 'var(--mmb-accent)' : 'var(--mmb-muted)',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 500,
                    transition: 'all .15s',
                    marginBottom: 1,
                    position: 'relative',
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.background = 'var(--mmb-surface2)';
                      (e.currentTarget as HTMLButtonElement).style.color = 'var(--mmb-text)';
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                      (e.currentTarget as HTMLButtonElement).style.color = 'var(--mmb-muted)';
                    }
                  }}
                >
                  <Icon size={15} style={{ flexShrink: 0 }} />
                  {!collapsed && <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>}
                  {!collapsed && badge && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                      background: badge.color === 'green' ? 'var(--mmb-green-bg)' : badge.color === 'blue' ? 'var(--mmb-blue-bg)' : 'var(--mmb-yellow-bg)',
                      color: badge.color === 'green' ? 'var(--mmb-green)' : badge.color === 'blue' ? 'var(--mmb-blue)' : 'var(--mmb-yellow)',
                    }}>
                      {badge.count}
                    </span>
                  )}
                  {/* Collapsed tooltip */}
                  {collapsed && (
                    <div style={{
                      position: 'absolute', left: '100%', marginLeft: 8,
                      padding: '4px 10px', borderRadius: 6, fontSize: 12,
                      background: 'var(--mmb-text)', color: 'var(--mmb-surface)',
                      whiteSpace: 'nowrap', pointerEvents: 'none',
                      opacity: 0, transition: 'opacity .15s', zIndex: 50,
                    }}
                    className="sidebar-tooltip">
                      {label}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      {!collapsed ? (
        <div style={{ padding: '12px', borderTop: '1px solid var(--mmb-border)', flexShrink: 0 }}>
          {/* Workers progress bar */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--mmb-muted)', fontWeight: 500 }}>Workers Active</span>
              <span style={{ fontSize: 11, color: 'var(--mmb-accent)', fontWeight: 700 }}>{runningCount}/{totalProfiles}</span>
            </div>
            <div style={{ height: 4, background: 'var(--mmb-border)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 99,
                background: 'linear-gradient(90deg, var(--mmb-accent), #7c3aed)',
                width: `${(runningCount / totalProfiles) * 100}%`,
                transition: 'width .4s ease',
              }} />
            </div>
          </div>
          {/* Status dots */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: backendStatus === 'running' ? '#22c55e' : backendStatus === 'checking' ? '#f59e0b' : '#ef4444',
                boxShadow: backendStatus === 'running' ? '0 0 4px #22c55e' : 'none',
              }} />
              <span style={{ color: 'var(--mmb-muted)' }}>
                API: {backendStatus === 'running' ? 'Online' : backendStatus === 'checking' ? 'Checking...' : 'Offline'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: multiloginStatus === 'connected' ? '#22c55e' : multiloginStatus === 'checking' ? '#f59e0b' : '#ef4444',
                boxShadow: multiloginStatus === 'connected' ? '0 0 4px #22c55e' : 'none',
              }} />
              <span style={{ color: 'var(--mmb-muted)' }}>
                Browser: {multiloginStatus === 'connected' ? 'Ready' : multiloginStatus === 'checking' ? 'Checking...' : 'Offline'}
              </span>
            </div>
          </div>
          {/* Collapse button */}
          <button
            onClick={() => setCollapsed(true)}
            style={{
              marginTop: 10, width: '100%', padding: '5px', borderRadius: 6,
              border: '1px solid var(--mmb-border)', background: 'transparent',
              color: 'var(--mmb-muted)', fontSize: 11, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            }}
          >
            <Server size={11} />
            Collapse
          </button>
        </div>
      ) : (
        <div style={{ padding: '10px 0', borderTop: '1px solid var(--mmb-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: backendStatus === 'running' ? '#22c55e' : '#ef4444',
          }} title={`API: ${backendStatus}`} />
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: multiloginStatus === 'connected' ? '#22c55e' : '#ef4444',
          }} title={`Browser: ${multiloginStatus}`} />
          <button onClick={() => setCollapsed(false)} style={{
            background: 'transparent', border: 'none', color: 'var(--mmb-muted)',
            cursor: 'pointer', padding: 4, borderRadius: 4,
          }} title="Expand sidebar">
            <Server size={14} />
          </button>
        </div>
      )}
    </aside>
  );
}
