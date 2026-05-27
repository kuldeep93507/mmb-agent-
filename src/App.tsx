import { useEffect, useState, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import Dashboard from './components/Dashboard';
import ProfilesPage from './components/ProfilesPage';
import ChannelsPage from './components/ChannelsPage';
import JobQueuePage from './components/JobQueuePage';
import LogsPage from './components/LogsPage';
import SettingsPage from './components/SettingsPage';
import SchedulerPage from './components/SchedulerPage';
import ManualControlPage from './components/ManualControlPage';
import AnalyticsPage from './components/AnalyticsPage';
import CommentTemplatesPage from './components/CommentTemplatesPage';
import VideoShufflePage from './components/VideoShufflePage';
import BacklinkPoolPage from './components/BacklinkPoolPage';
import MonitorPage from './components/MonitorPage';
import EngagementPage from './components/EngagementPage';
import GmailSetupPage from './components/GmailSetupPage';
import SplashScreen from './components/SplashScreen';
import { useStore } from './store/useStore';
import { isPackagedElectron } from './utils/appMode';
import { initAppVersion } from './services/updateChecker';
import { useVideoMonitor } from './hooks/useVideoMonitor';
import { useChannelStore } from './store/useChannelStore';
import { isMultiloginProxyHost } from './utils/profileAdapter';
import type { OS } from './types';

export default function App() {
  // Splash in browser dev only — packaged Electron uses electron/splash.html (5.5s)
  const [showSplash, setShowSplash] = useState(() => {
    if (isPackagedElectron()) return false;
    const shown = sessionStorage.getItem('mmb_splash_shown');
    return !shown;
  });

  const handleSplashComplete = useCallback(() => {
    setShowSplash(false);
    sessionStorage.setItem('mmb_splash_shown', '1');
  }, []);

  useEffect(() => {
    initAppVersion();
  }, []);

  const {
    profiles, jobs, logs, activeTab, setActiveTab,
    browserProvider,
    createProfile, startProfile, stopProfile, deleteProfile, recreateProfile,
    deleteSelectedProfiles, recreateSelectedProfiles, exportProfileConfigs,
    recreatingIds, loading, fetchProfiles,
    toggleSelect, selectAll, deselectAll, startSelected, stopSelected,
    retryJob, clearLogs, renewProxy,
  } = useStore();

  const channelStore = useChannelStore();
  const videoMonitor = useVideoMonitor(profiles);
  const activeChannelsCount = channelStore.channels.filter(ch => ch.status === 'active').length;

  const runningCount = profiles.filter(p => p.status === 'running').length;
  const pendingJobs = jobs.filter(j => j.status === 'pending').length;

  // Check proxy expiry every 10 minutes — auto-renew expired proxies
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      profiles.forEach(p => {
        if (isMultiloginProxyHost(p.proxy.server)) return;
        if (p.status === 'stopped' && p.proxy.expiresAt > 0 && p.proxy.expiresAt < now) {
          renewProxy(p.id);
        }
      });
    }, 600000);
    return () => clearInterval(interval);
  }, [profiles, renewProxy]);

  useEffect(() => {
    if (activeTab === 'proxy-health') {
      setActiveTab('dashboard');
    } else if (activeTab === 'performance' || activeTab === 'orchestrator-log' || activeTab === 'video-manager' || activeTab === 'yt-agents') {
      setActiveTab('channels');
    }
  }, [activeTab, setActiveTab]);

  const renderPage = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard profiles={profiles} setActiveTab={setActiveTab} />;
      case 'monitor':
        return <MonitorPage profiles={profiles} onRefreshProfiles={() => fetchProfiles()} canStartRecycle={false} />;
      case 'profiles':
        return (
          <ProfilesPage
            profiles={profiles}
            browserProvider={browserProvider}
            loading={loading}
            recreatingIds={recreatingIds}
            onCreateProfile={(os: OS, proxyType?: string, profileMode?: string, androidDevice?: string) => createProfile(os, proxyType, profileMode, androidDevice)}
            onStartProfile={startProfile}
            onStopProfile={stopProfile}
            onDeleteProfile={deleteProfile}
            onRecreateProfile={recreateProfile}
            onToggleSelect={toggleSelect}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
            onStartSelected={startSelected}
            onStopSelected={stopSelected}
            onRenewProxy={renewProxy}
            onRefreshProfiles={() => fetchProfiles()}
            onDeleteSelected={deleteSelectedProfiles}
            onRecreateSelected={recreateSelectedProfiles}
            onExportConfigs={exportProfileConfigs}
          />
        );
      case 'channels':
        return (
          <ChannelsPage
            channels={channelStore.channels}
            getChannels={channelStore.getChannels}
            addChannel={channelStore.addChannel}
            updateChannel={channelStore.updateChannel}
            deleteChannel={channelStore.deleteChannel}
            syncChannel={channelStore.syncChannel}
            syncAllChannels={channelStore.syncAllChannels}
            toggleChannel={channelStore.toggleChannel}
            enableAllChannels={channelStore.enableAllChannels}
            disableAllChannels={channelStore.disableAllChannels}
            getVideos={channelStore.getVideos}
            toggleVideo={channelStore.toggleVideo}
            enableAllVideos={channelStore.enableAllVideos}
            disableAllVideos={channelStore.disableAllVideos}
            getPlaylists={channelStore.getPlaylists}
            addPlaylist={channelStore.addPlaylist}
            deletePlaylist={channelStore.deletePlaylist}
            togglePlaylist={channelStore.togglePlaylist}
            toasts={channelStore.toasts}
            dismissToast={channelStore.dismissToast}
            forceSyncToServer={channelStore.forceSyncToServer}
            videoMonitor={videoMonitor}
          />
        );
      case 'jobs':
        return <JobQueuePage jobs={jobs} onRetry={retryJob} />;
      case 'scheduler':
        return <SchedulerPage profiles={profiles} channels={channelStore.channels} getVideos={channelStore.getVideos} />;
      case 'video-shuffle':
        return <VideoShufflePage profiles={profiles} channels={channelStore.channels} getVideos={channelStore.getVideos} onRefreshProfiles={() => fetchProfiles()} />;
      case 'backlinks':
        return <BacklinkPoolPage profiles={profiles} />;
      case 'manual':
        return <ManualControlPage profiles={profiles} />;
      case 'analytics':
        return <AnalyticsPage profiles={profiles} setActiveTab={setActiveTab} />;
      case 'comments':
        return <CommentTemplatesPage />;
      case 'engagement':
        return <EngagementPage profiles={profiles} channels={channelStore.channels} getVideos={channelStore.getVideos} setActiveTab={setActiveTab} />;
      case 'gmail-setup':
        return <GmailSetupPage profiles={profiles} />;
      case 'logs':
        return <LogsPage profiles={profiles} onClear={clearLogs} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <Dashboard profiles={profiles} setActiveTab={setActiveTab} />;
    }
  };

  return (
    <>
      {showSplash && <SplashScreen onComplete={handleSplashComplete} />}
      <div className={`flex h-screen bg-gray-950 text-white overflow-hidden ${showSplash ? 'hidden' : ''}`}>
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        runningCount={runningCount}
        pendingJobs={pendingJobs}
        activeChannels={activeChannelsCount}
      />
      <main className="flex-1 overflow-hidden flex flex-col">
        <TopBar profiles={profiles} logs={logs} activeTab={activeTab} newVideoCount={videoMonitor.unreadCount} />
        <div className="flex-1 overflow-hidden flex flex-col">
          {renderPage()}
        </div>
      </main>
    </div>
    </>
  );
}
