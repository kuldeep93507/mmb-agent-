import {
  LayoutDashboard, Users, Settings, FileText, Cpu, Server, Tv, Calendar, Gamepad2, BarChart3, MessageSquare, Shuffle, Link, PanelLeftClose, PanelLeftOpen, MonitorPlay, Zap, Mail,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { backendFetch } from '../services/backendOrigin';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'monitor', label: 'Live Monitor', icon: MonitorPlay },
  { id: 'profiles', label: 'Profiles', icon: Users },
  { id: 'channels', label: 'Channels', icon: Tv },
  { id: 'engagement', label: 'Engagement', icon: Zap },
  { id: 'video-shuffle', label: 'Video Shuffle', icon: Shuffle },
  { id: 'backlinks', label: 'Backlinks', icon: Link },
  { id: 'scheduler', label: 'Scheduler', icon: Calendar },
  { id: 'manual', label: 'Manual Control', icon: Gamepad2 },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'comments', label: 'Comments', icon: MessageSquare },
  { id: 'jobs', label: 'Job Queue', icon: Cpu },
  { id: 'gmail-setup', label: 'Gmail Setup', icon: Mail },
  { id: 'logs', label: 'Activity Logs', icon: FileText },
  { id: 'settings', label: 'Settings', icon: Settings },
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

  // Real health check every 30 seconds
  useEffect(() => {
    const check = async () => {
      // Check backend
      try {
        const res = await backendFetch('/api/health', { signal: AbortSignal.timeout(3000) });
        setBackendStatus(res.ok ? 'running' : 'down');
      } catch {
        setBackendStatus('down');
      }
      // Check Multilogin — ping local launcher (no cloud auth needed)
      // api.multilogin.com can be down but launcher can still work
      try {
        const provider = (import.meta.env.VITE_BROWSER_PROVIDER || 'multilogin').toLowerCase();
        const res = await backendFetch(`/api/providers/ping?provider=${provider}`, {
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        setMultiloginStatus(data.code === 0 ? 'connected' : 'disconnected');
      } catch {
        setMultiloginStatus('disconnected');
      }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`${collapsed ? 'w-16' : 'w-64'} bg-gray-950 border-r border-gray-800 flex flex-col h-full transition-all duration-300`}>
      {/* Logo + Toggle */}
      <div className={`${collapsed ? 'px-3' : 'px-6'} py-5 border-b border-gray-800`}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 via-red-500 to-orange-500 flex items-center justify-center shadow-lg shadow-red-900/60 flex-shrink-0 relative overflow-hidden">
            {/* Animated glow ring */}
            <div className="absolute inset-0 rounded-xl border border-white/20 animate-pulse" />
            <span className="text-white font-black text-sm tracking-tight relative z-10">MMB</span>
          </div>
          {!collapsed && (
            <div className="flex-1">
              <div className="text-white font-bold text-sm leading-tight tracking-wide">MMB AGENT</div>
              <div className="text-gray-500 text-xs">Co-founder Kuldeep</div>
            </div>
          )}
        </div>
      </div>

      {/* Toggle Button */}
      <button onClick={() => setCollapsed(!collapsed)}
        className={`${collapsed ? 'mx-auto' : 'mx-3'} mt-2 mb-1 flex items-center justify-center gap-2 px-2 py-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-all`}>
        {collapsed ? <PanelLeftOpen size={16} /> : <><PanelLeftClose size={14} /><span className="text-xs">Collapse</span></>}
      </button>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-2 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            title={collapsed ? label : undefined}
            className={`w-full flex items-center gap-3 ${collapsed ? 'justify-center px-2' : 'px-3'} py-2.5 rounded-xl text-sm font-medium transition-all duration-150 relative group
              ${activeTab === id
                ? 'bg-red-600/20 text-red-400 border border-red-600/30'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent'
              }`}
          >
            <Icon size={16} className={`flex-shrink-0 ${activeTab === id ? 'text-red-400' : 'text-gray-500 group-hover:text-gray-300'}`} />
            {!collapsed && <span>{label}</span>}
            {!collapsed && id === 'monitor' && runningCount > 0 && (
              <span className="ml-auto text-xs bg-green-600/30 text-green-400 border border-green-600/30 px-1.5 py-0.5 rounded-full animate-pulse">
                {runningCount}
              </span>
            )}
            {!collapsed && id === 'profiles' && runningCount > 0 && (
              <span className="ml-auto text-xs bg-green-600/30 text-green-400 border border-green-600/30 px-1.5 py-0.5 rounded-full">
                {runningCount}
              </span>
            )}
            {!collapsed && id === 'channels' && activeChannels > 0 && (
              <span className="ml-auto text-xs bg-blue-600/30 text-blue-400 border border-blue-600/30 px-1.5 py-0.5 rounded-full">
                {activeChannels}
              </span>
            )}
            {!collapsed && id === 'jobs' && pendingJobs > 0 && (
              <span className="ml-auto text-xs bg-yellow-600/30 text-yellow-400 border border-yellow-600/30 px-1.5 py-0.5 rounded-full">
                {pendingJobs}
              </span>
            )}
            {/* Tooltip for collapsed mode */}
            {collapsed && (
              <div className="absolute left-full ml-2 px-2 py-1 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50">
                {label}
              </div>
            )}
          </button>
        ))}
      </nav>

      {/* Bottom Status */}
      {!collapsed ? (
        <div className="px-4 py-4 border-t border-gray-800">
          <div className="bg-gray-900 rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Server size={12} className="text-gray-500" />
              <span className="text-gray-500 text-xs">System Status</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${multiloginStatus === 'connected' ? 'bg-green-500 animate-pulse' : multiloginStatus === 'checking' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-gray-400 text-xs">
                Browser: {multiloginStatus === 'connected' ? 'Connected' : multiloginStatus === 'checking' ? 'Checking...' : 'Disconnected'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${backendStatus === 'running' ? 'bg-blue-500 animate-pulse' : backendStatus === 'checking' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`} />
              <span className="text-gray-400 text-xs">
                Backend: {backendStatus === 'running' ? 'Running' : backendStatus === 'checking' ? 'Checking...' : 'Down ⚠️'}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="px-2 py-3 border-t border-gray-800 flex flex-col items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${multiloginStatus === 'connected' ? 'bg-green-500 animate-pulse' : multiloginStatus === 'checking' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`} title={`Browser: ${multiloginStatus}`} />
          <div className={`w-2 h-2 rounded-full ${backendStatus === 'running' ? 'bg-blue-500 animate-pulse' : 'bg-red-500'}`} title={`Backend: ${backendStatus}`} />
        </div>
      )}
    </aside>
  );
}
