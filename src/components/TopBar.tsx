import { useEffect, useState } from 'react';
import { Activity, Bell, Sun, Moon, Download, RefreshCw } from 'lucide-react';
import type { Profile, LogEntry } from '../types';
import { checkForUpdates, initAppVersion, runUpdate, type UpdateStatus } from '../services/updateChecker';
import { requestNotificationPermission } from '../services/notifications';
import { useTheme } from '../contexts/ThemeContext';

interface TopBarProps {
  profiles: Profile[];
  logs: LogEntry[];
  activeTab: string;
  newVideoCount?: number;
}

const PAGE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  scheduler: 'Scheduler',
  profiles: 'Profiles',
  'video-shuffle': 'Video Shuffle',
  analytics: 'Analytics',
  engagement: 'Engagement',
  channels: 'Channels',
  backlinks: 'Backlinks',
  recycle: 'Recycle Loop',
  manual: 'Manual Control',
  comments: 'Comments',
  monitor: 'Live Monitor',
  jobs: 'Job Queue',
  'gmail-setup': 'Gmail Setup',
  logs: 'Activity Logs',
  settings: 'Settings',
};

export default function TopBar({ profiles, logs, activeTab, newVideoCount = 0 }: TopBarProps) {
  const [time, setTime] = useState(new Date());
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(Notification.permission === 'granted');
  const { isDark, toggleTheme } = useTheme();

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    initAppVersion();
    checkForUpdates().then(setUpdateStatus).catch(() => {});
    requestNotificationPermission().then(setNotifEnabled);
  }, []);

  const handleUpdate = async () => {
    setUpdating(true);
    const result = await runUpdate(updateStatus?.downloadUrl);
    if (result.success) {
      if (result.mode === 'download') alert('✅ ' + result.message);
      else { setUpdateStatus(prev => prev ? { ...prev, hasUpdate: false } : null); alert('✅ Update complete! Restart to apply.'); }
    } else { alert('❌ Update failed: ' + result.message); }
    setUpdating(false);
  };

  const handleNotifToggle = async () => {
    const granted = await requestNotificationPermission();
    setNotifEnabled(granted);
    if (granted) new Notification('🔔 Notifications Enabled', { body: 'You will receive alerts for schedule completion and errors.' });
  };

  const running = profiles.filter(p => p.status === 'running').length;
  const lastLog = logs[0];
  const pageLabel = PAGE_LABELS[activeTab] || activeTab;

  return (
    <div style={{
      background: 'var(--mmb-surface)',
      borderBottom: '1px solid var(--mmb-border)',
      flexShrink: 0,
      position: 'relative',
      zIndex: 5,
    }}>
      {/* Update Banner */}
      {updateStatus?.hasUpdate && (
        <div style={{
          background: 'linear-gradient(90deg, #1e1b4b, #1e3a5f)',
          borderBottom: '1px solid #3730a3',
          padding: '6px 20px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Download size={13} style={{ color: '#818cf8' }} />
          <div style={{ flex: 1 }}>
            <span style={{ color: '#c7d2fe', fontSize: 12 }}>
              🔄 <strong>MMB AGENT</strong> Update available: <strong>v{updateStatus.latestVersion}</strong> (current: v{updateStatus.currentVersion})
            </span>
          </div>
          <button onClick={handleUpdate} disabled={updating} style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: '#4f46e5', color: '#fff', border: 'none',
            borderRadius: 6, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
            <RefreshCw size={11} style={updating ? { animation: 'spin 1s linear infinite' } : {}} />
            {updating ? 'Opening…' : updateStatus.mode === 'download' ? 'Download' : 'Update Now'}
          </button>
        </div>
      )}

      {/* Main Bar */}
      <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 12 }}>
        {/* Page title */}
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--mmb-text)' }}>{pageLabel}</span>
        <div style={{ width: 1, height: 16, background: 'var(--mmb-border)', margin: '0 4px' }} />

        {/* Live log ticker */}
        {lastLog && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', minWidth: 0, maxWidth: 480 }}>
            <div style={{
              width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
              background: lastLog.level === 'error' ? '#ef4444' : lastLog.level === 'warn' ? '#f59e0b' : lastLog.level === 'success' ? '#22c55e' : '#6366f1',
            }} />
            <span style={{ fontSize: 11, color: 'var(--mmb-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={lastLog.message}>
              {lastLog.message.length > 80 ? lastLog.message.slice(0, 80) + '…' : lastLog.message}
            </span>
          </div>
        )}

        {/* Right side controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0 }}>
          {/* New videos alert */}
          {newVideoCount > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'var(--mmb-red-bg)', color: 'var(--mmb-red)',
              border: '1px solid currentColor', borderRadius: 8,
              padding: '4px 10px', fontSize: 12, fontWeight: 600,
            }}>
              <Bell size={12} />
              {newVideoCount} new video{newVideoCount > 1 ? 's' : ''}
            </div>
          )}

          {/* Running count */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            background: running > 0 ? 'var(--mmb-green-bg)' : 'var(--mmb-surface2)',
            color: running > 0 ? 'var(--mmb-green)' : 'var(--mmb-muted)',
            borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 600,
          }}>
            <Activity size={12} />
            {running} running
          </div>

          {/* Notification toggle */}
          <button onClick={handleNotifToggle} title={notifEnabled ? 'Notifications ON' : 'Notifications OFF'} style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: notifEnabled ? 'var(--mmb-green-bg)' : 'var(--mmb-surface2)',
            color: notifEnabled ? 'var(--mmb-green)' : 'var(--mmb-muted)',
            border: 'none', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            transition: 'all .15s',
          }}>
            <Bell size={12} />
            {notifEnabled ? 'ON' : 'OFF'}
          </button>

          {/* Date + time */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--mmb-surface2)', borderRadius: 8,
            padding: '5px 12px', fontSize: 12, color: 'var(--mmb-text2)',
            border: '1px solid var(--mmb-border)',
          }}>
            <span>{time.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span style={{ color: 'var(--mmb-border2)' }}>·</span>
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--mmb-accent)' }}>
              {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title={isDark ? 'Switch to Light' : 'Switch to Dark'}
            style={{
              width: 36, height: 36, borderRadius: 8,
              background: 'var(--mmb-surface2)',
              border: '1px solid var(--mmb-border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', color: 'var(--mmb-muted)',
              transition: 'all .15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--mmb-accent)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--mmb-muted)')}
          >
            {isDark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
