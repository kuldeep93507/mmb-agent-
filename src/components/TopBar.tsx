import { useEffect, useState } from 'react';
import { Activity, Wifi, RefreshCw, Bell, Download } from 'lucide-react';
import type { Profile, LogEntry } from '../types';
import { checkForUpdates, runUpdate, type UpdateStatus } from '../services/updateChecker';
import { requestNotificationPermission } from '../services/notifications';

interface TopBarProps {
  profiles: Profile[];
  logs: LogEntry[];
  activeTab: string;
  newVideoCount?: number;
}

export default function TopBar({ profiles, logs, activeTab, newVideoCount = 0 }: TopBarProps) {
  const [time, setTime] = useState(new Date());
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(Notification.permission === 'granted');

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Check for updates on mount
  useEffect(() => {
    checkForUpdates().then(setUpdateStatus).catch(() => {});
    // Request notification permission
    requestNotificationPermission().then(setNotifEnabled);
  }, []);

  const handleUpdate = async () => {
    setUpdating(true);
    const result = await runUpdate();
    if (result.success) {
      setUpdateStatus(prev => prev ? { ...prev, hasUpdate: false } : null);
      alert('✅ Update complete! Restart the tool to apply changes.');
    } else {
      alert('❌ Update failed: ' + result.message);
    }
    setUpdating(false);
  };

  const handleNotifToggle = async () => {
    const granted = await requestNotificationPermission();
    setNotifEnabled(granted);
    if (granted) {
      new Notification('🔔 Notifications Enabled', { body: 'You will receive alerts for schedule completion and errors.' });
    }
  };

  const running = profiles.filter(p => p.status === 'running').length;
  const lastLog = logs[0];

  return (
    <div className="bg-gray-950 border-b border-gray-800 flex-shrink-0">
      {/* Update Banner */}
      {updateStatus?.hasUpdate && (
        <div className="bg-gradient-to-r from-blue-900/50 to-purple-900/50 border-b border-blue-700/30 px-5 py-2 flex items-center gap-3">
          <Download size={14} className="text-blue-400" />
          <div className="flex-1">
            <span className="text-blue-300 text-xs">
              🔄 <strong>MMB AGENT</strong> Update available: <strong>v{updateStatus.latestVersion}</strong> (current: v{updateStatus.currentVersion})
            </span>
            {updateStatus.changelog.length > 0 && (
              <div className="flex gap-2 mt-0.5">
                {updateStatus.changelog.slice(0, 3).map((log, i) => (
                  <span key={i} className="text-xs bg-blue-900/50 text-blue-400 px-1.5 py-0.5 rounded">• {log}</span>
                ))}
                {updateStatus.changelog.length > 3 && <span className="text-xs text-blue-500">+{updateStatus.changelog.length - 3} more</span>}
              </div>
            )}
          </div>
          <button onClick={handleUpdate} disabled={updating}
            className="flex items-center gap-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1 rounded-lg text-xs font-medium transition-all">
            <RefreshCw size={11} className={updating ? 'animate-spin' : ''} />
            {updating ? 'Updating...' : 'Update Now'}
          </button>
        </div>
      )}

      {/* Main TopBar */}
      <div className="h-12 flex items-center px-5 gap-4">
        {/* Page title */}
        <h2 className="text-gray-300 font-medium text-sm">{activeTab.charAt(0).toUpperCase() + activeTab.slice(1).replace('-', ' ')}</h2>

        <div className="w-px h-4 bg-gray-800" />

        {/* Live activity ticker */}
        {lastLog && (
          <div className="flex-1 flex items-center gap-2 overflow-hidden">
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <div className={`w-1.5 h-1.5 rounded-full animate-pulse
                ${lastLog.level === 'error' ? 'bg-red-500' :
                  lastLog.level === 'warn' ? 'bg-yellow-500' :
                  lastLog.level === 'success' ? 'bg-green-500' : 'bg-blue-500'}`} />
              <span className="text-gray-600 text-xs">Latest:</span>
            </div>
            <span className="text-gray-400 text-xs truncate">{lastLog.message}</span>
          </div>
        )}

        {/* Right side */}
        <div className="flex items-center gap-3 ml-auto flex-shrink-0">
          {/* New video notification bell */}
          {newVideoCount > 0 && (
            <div className="relative flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-900/30 border border-red-600/40 text-red-300 text-xs font-medium animate-pulse">
              <Bell size={12} className="text-red-400" />
              <span>{newVideoCount} new video{newVideoCount > 1 ? 's' : ''}</span>
              <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                {newVideoCount}
              </span>
            </div>
          )}

          {/* Notification toggle */}
          <button onClick={handleNotifToggle}
            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-all ${notifEnabled ? 'bg-green-900/30 text-green-400 border border-green-700/30' : 'bg-gray-800 text-gray-500 border border-gray-700'}`}>
            <Bell size={11} />
            {notifEnabled ? 'ON' : 'OFF'}
          </button>

          {/* Date — Day, Date Month Year */}
          <div className="flex items-center gap-1 bg-gray-800/50 px-2 py-1 rounded-lg">
            <span className="text-gray-400 text-xs">
              {time.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </div>

          {/* Running indicator */}
          <div className="flex items-center gap-1.5">
            <Activity size={12} className="text-green-500" />
            <span className="text-gray-500 text-xs">{running} active</span>
          </div>

          {/* Network status */}
          <div className="flex items-center gap-1.5">
            <Wifi size={12} className="text-blue-400" />
            <span className="text-gray-500 text-xs">us.smartproxy.net:3120</span>
          </div>

          <div className="w-px h-4 bg-gray-800" />

          {/* Time */}
          <span className="text-gray-600 text-xs font-mono">
            {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>
      </div>
    </div>
  );
}
