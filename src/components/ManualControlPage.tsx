import { useState, useCallback, useEffect } from 'react';
import { CheckSquare, Square, Play, Pause, SkipForward, StopCircle, Search, Plus, X, Monitor, Smartphone, Apple } from 'lucide-react';
import type { Profile } from '../types';
import { backendFetch } from '../services/backendOrigin';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TYPES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
type Platform = 'windows' | 'macos' | 'android';

interface ProfileTab {
  id: string;
  title: string;
  url: string;
  watchProgress: number; // 0-100
  isActive: boolean;
}

interface ProfileState {
  profileId: string;
  status: 'idle' | 'active' | 'paused';
  scrollPosition: number; // 0-100
  currentVideo: string;
  watchProgress: number;
  tabs: ProfileTab[];
  keepAlive: boolean;
  platform: Platform;
}

interface ManualControlPageProps {
  profiles: Profile[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PLATFORM HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function detectPlatform(os: string): Platform {
  const lower = os.toLowerCase();
  if (lower.includes('android')) return 'android';
  if (lower.includes('mac') || lower.includes('ios')) return 'macos';
  return 'windows';
}

function getPlatformIcon(platform: Platform) {
  switch (platform) {
    case 'windows': return <Monitor size={12} className="text-blue-400" />;
    case 'macos': return <Apple size={12} className="text-gray-300" />;
    case 'android': return <Smartphone size={12} className="text-green-400" />;
  }
}

function getPlatformLabel(platform: Platform) {
  switch (platform) {
    case 'windows': return '🪟 Win';
    case 'macos': return '🍎 Mac';
    case 'android': return '🤖 Android';
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN COMPONENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function ManualControlPage({ profiles }: ManualControlPageProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [profileStates, setProfileStates] = useState<Record<string, ProfileState>>({});
  const [searchInput, setSearchInput] = useState('');
  const [showKeywordModal, setShowKeywordModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keywords, setKeywords] = useState<Record<string, string[]>>(() => {
    try {
      const d = localStorage.getItem('mmb_keywords');
      if (d) {
        const parsed = JSON.parse(d);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      }
      return {};
    } catch {
      console.warn('Failed to parse keywords from localStorage');
      return {}; // Safe fallback
    }
  });

  // Sync profileStates when profiles load/change from MoreLogin API
  useEffect(() => {
    if (profiles.length === 0) return;
    setProfileStates(prev => {
      const states: Record<string, ProfileState> = { ...prev };
      profiles.forEach(p => {
        if (!states[p.id]) {
          states[p.id] = {
            profileId: p.id,
            status: p.status === 'running' ? 'active' : 'idle',
            scrollPosition: 0,
            currentVideo: '',
            watchProgress: 0,
            tabs: [{ id: 'tab1', title: 'YouTube', url: 'https://youtube.com', watchProgress: 0, isActive: true }],
            keepAlive: true,
            platform: detectPlatform(p.os),
          };
        } else {
          states[p.id] = { ...states[p.id], status: p.status === 'running' ? 'active' : 'idle' };
        }
      });
      return states;
    });
  }, [profiles]);

  // Selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const selectAll = () => setSelectedIds(profiles.map(p => p.id));
  const deselectAll = () => setSelectedIds([]);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // BATCH COMMANDS — sends to all selected profiles
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const sendBatchCommand = useCallback(async (command: string, params?: any) => {
    if (selectedIds.length === 0) return;
    try {
      setError(null);
      const res = await backendFetch('/api/manual/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds: selectedIds, command, params }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(`Command failed: ${data.message || 'Unknown error'}`);
        console.error('Batch command failed:', data);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Network error: ${msg}`);
      console.error('Batch command error:', err);
      return;
    }

    // Update local state for UI feedback
    if (command === 'scrollDown') {
      setProfileStates(prev => {
        const updated = { ...prev };
        selectedIds.forEach(id => {
          if (updated[id]) {
            updated[id] = { ...updated[id], scrollPosition: Math.min(100, updated[id].scrollPosition + Math.random() * 15 + 5) };
          }
        });
        return updated;
      });
    }
    if (command === 'scrollUp') {
      setProfileStates(prev => {
        const updated = { ...prev };
        selectedIds.forEach(id => {
          if (updated[id]) {
            updated[id] = { ...updated[id], scrollPosition: Math.max(0, updated[id].scrollPosition - Math.random() * 15 - 5) };
          }
        });
        return updated;
      });
    }
  }, [selectedIds]);

  const handleSearch = useCallback(() => {
    if (!searchInput.trim() || selectedIds.length === 0) return;
    sendBatchCommand('search', { query: searchInput });
    setSearchInput('');
  }, [searchInput, selectedIds, sendBatchCommand]);

  const handleNewTab = () => sendBatchCommand('newTab');
  const handleNewWindow = () => sendBatchCommand('newWindow');
  const handlePlayAll = () => sendBatchCommand('play');
  const handlePauseAll = () => sendBatchCommand('pause');
  const handleNextAll = () => sendBatchCommand('next');

  const handleToggleKeepAlive = (profileId: string) => {
    const currentState = profileStates[profileId];
    const newValue = currentState ? !currentState.keepAlive : true;
    setProfileStates(prev => ({
      ...prev,
      [profileId]: { ...prev[profileId], keepAlive: newValue },
    }));
    sendBatchCommand('keepAlive', { profileId, enabled: newValue });
  };

  // START PROFILES — Connect to MoreLogin + CDP
  const handleStartProfiles = useCallback(async () => {
    if (selectedIds.length === 0) return;
    try {
      setError(null);
      const res = await backendFetch('/api/manual/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds: selectedIds }),
      });
      const data = await res.json();
      if (data.success) {
        // Update profile states
        setProfileStates(prev => {
          const updated = { ...prev };
          for (const r of data.results) {
            if (updated[r.profileId]) {
              updated[r.profileId] = { ...updated[r.profileId], status: r.status === 'connected' ? 'active' : 'idle' };
            }
          }
          return updated;
        });
      } else {
        setError(`Start failed: ${data.message || 'Unknown error'}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(`Network error: ${msg}`);
      console.error('Start profiles failed:', err);
    }
  }, [selectedIds]);

  // Keyword helpers
  const saveKeywords = (data: Record<string, string[]>) => {
    setKeywords(data);
    localStorage.setItem('mmb_keywords', JSON.stringify(data));
  };

  const useKeyword = (keyword: string) => {
    setSearchInput(keyword);
  };

  return (
    <div className="flex h-full">
      {/* ━━━ LEFT SIDEBAR — Profile List ━━━ */}
      <div className="w-64 border-r border-gray-800 bg-gray-950 flex flex-col flex-shrink-0">
        <div className="p-3 border-b border-gray-800">
          <h2 className="text-sm font-bold text-white mb-2">Profiles</h2>
          <div className="flex gap-1">
            <button onClick={selectAll} className="flex-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded-lg transition-all">
              <CheckSquare size={10} className="inline mr-1" />All
            </button>
            <button onClick={deselectAll} className="flex-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded-lg transition-all">
              <Square size={10} className="inline mr-1" />None
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {profiles.map(p => {
            const state = profileStates[p.id];
            const isSelected = selectedIds.includes(p.id);
            const platform = state?.platform || detectPlatform(p.os);
            return (
              <button key={p.id} onClick={() => toggleSelect(p.id)}
                className={`w-full flex items-center gap-2 p-2 rounded-lg text-left transition-all ${isSelected ? 'bg-red-900/30 border border-red-600/40' : 'bg-gray-900 border border-transparent hover:border-gray-700'}`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${state?.status === 'active' ? 'bg-green-500 animate-pulse' : state?.status === 'paused' ? 'bg-yellow-500' : 'bg-gray-600'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white truncate">{p.name}</p>
                  <div className="flex items-center gap-1 mt-0.5">
                    {getPlatformIcon(platform)}
                    <span className="text-xs text-gray-500">{getPlatformLabel(platform)}</span>
                  </div>
                </div>
                {/* Mini scroll position bar */}
                <div className="w-1 h-8 bg-gray-800 rounded-full relative flex-shrink-0">
                  <div className="absolute bottom-0 w-full bg-red-500 rounded-full transition-all" style={{ height: `${state?.scrollPosition || 0}%` }} />
                </div>
                {isSelected && <span className="text-red-400 text-xs">✓</span>}
              </button>
            );
          })}
        </div>

        <div className="p-3 border-t border-gray-800 text-xs text-gray-500 text-center">
          {selectedIds.length} / {profiles.length} selected
        </div>
      </div>

      {/* ━━━ MAIN AREA ━━━ */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* TOP BAR — Batch Controls */}
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-950/80 flex-shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 mr-2">Batch ({selectedIds.length}):</span>

            {/* START PROFILES — Must be clicked first! */}
            <button onClick={handleStartProfiles} disabled={selectedIds.length === 0}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-all">🚀 Start & Connect</button>

            {/* Open YouTube on all selected */}
            <button onClick={() => sendBatchCommand('openYoutube')} disabled={selectedIds.length === 0}
              className="bg-red-700 hover:bg-red-600 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">▶ YouTube</button>

            <div className="w-px h-5 bg-gray-700" />

            {/* Scroll */}
            <button onClick={() => sendBatchCommand('scrollUp')} disabled={selectedIds.length === 0}
              className="bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">↑ Scroll Up</button>
            <button onClick={() => sendBatchCommand('scrollDown')} disabled={selectedIds.length === 0}
              className="bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">↓ Scroll Down</button>

            <div className="w-px h-5 bg-gray-700" />

            {/* Video */}
            <button onClick={handlePlayAll} disabled={selectedIds.length === 0}
              className="bg-green-800 hover:bg-green-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all"><Play size={10} className="inline mr-1" />Play All</button>
            <button onClick={handlePauseAll} disabled={selectedIds.length === 0}
              className="bg-yellow-800 hover:bg-yellow-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all"><Pause size={10} className="inline mr-1" />Pause</button>
            <button onClick={() => sendBatchCommand('skipBackward')} disabled={selectedIds.length === 0}
              className="bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">⏪ -10s</button>
            <button onClick={() => sendBatchCommand('skipForward')} disabled={selectedIds.length === 0}
              className="bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">⏩ +10s</button>
            <button onClick={handleNextAll} disabled={selectedIds.length === 0}
              className="bg-blue-800 hover:bg-blue-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all"><SkipForward size={10} className="inline mr-1" />Next</button>

            <div className="w-px h-5 bg-gray-700" />

            {/* Tab/Window */}
            <button onClick={handleNewTab} disabled={selectedIds.length === 0}
              className="bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all"><Plus size={10} className="inline mr-1" />New Tab</button>
            <button onClick={handleNewWindow} disabled={selectedIds.length === 0}
              className="bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">⊞ New Window</button>

            <div className="w-px h-5 bg-gray-700" />

            {/* Keep Alive */}
            <div className="flex items-center gap-1 bg-green-900/30 border border-green-700/30 px-2 py-1 rounded-lg">
              <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs text-green-400">Keep Alive</span>
            </div>

            {/* Shorts Warmup */}
            <button onClick={() => sendBatchCommand('shortsWarmup', { count: 10 })} disabled={selectedIds.length === 0}
              className="bg-pink-800 hover:bg-pink-700 disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">🎬 Shorts Warmup</button>

            {/* Keyword Pool */}
            <button onClick={() => setShowKeywordModal(true)}
              className="ml-auto bg-purple-800 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-all">🔑 Keywords</button>
          </div>
        </div>

        {/* ERROR NOTIFICATION */}
        {error && (
          <div className="px-4 py-2 bg-red-900/30 border-b border-red-800/30 flex items-center justify-between">
            <span className="text-xs text-red-400">⚠️ {error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300 text-xs font-bold">✕</button>
          </div>
        )}

        {/* SEARCH BAR */}
        <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/50 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Search size={14} className="text-gray-500" />
            <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Type to search on all selected profiles (human-like typing)..."
              className="flex-1 bg-transparent text-white text-sm placeholder-gray-600 focus:outline-none" />
            <button onClick={handleSearch} disabled={!searchInput.trim() || selectedIds.length === 0}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-30 text-white px-3 py-1 rounded-lg text-xs font-medium transition-all">Search All</button>
          </div>
          {/* Quick Keywords */}
          {selectedIds.length > 0 && keywords[selectedIds[0]]?.length > 0 && (
            <div className="flex gap-1 mt-2 flex-wrap">
              <span className="text-xs text-gray-500">Quick:</span>
              {(keywords[selectedIds[0]] || []).slice(0, 5).map((kw, i) => (
                <button key={i} onClick={() => useKeyword(kw)}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-0.5 rounded text-xs transition-all">{kw}</button>
              ))}
            </div>
          )}
        </div>

        {/* MAIN CONTENT — Per Profile Controls */}
        <div className="flex-1 overflow-y-auto p-4">
          {selectedIds.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <div className="text-5xl mb-4">👈</div>
              <p className="text-lg font-medium">Select profiles from sidebar</p>
              <p className="text-sm mt-1">Then use batch controls or per-profile controls below</p>
            </div>
          ) : (
            <div className="space-y-3">
              {selectedIds.map(id => {
                const profile = profiles.find(p => p.id === id);
                const state = profileStates[id];
                if (!profile || !state) return null;
                return (
                  <ProfileControlCard key={id} profile={profile} state={state}
                    onToggleKeepAlive={() => handleToggleKeepAlive(id)}
                    onCommand={(cmd, params) => sendBatchCommand(cmd, { ...params, profileId: id })} />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ━━━ KEYWORD POOL MODAL ━━━ */}
      {showKeywordModal && (
        <KeywordPoolModal
          profiles={profiles}
          keywords={keywords}
          onSave={saveKeywords}
          onClose={() => setShowKeywordModal(false)} />
      )}
    </div>
  );
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PER-PROFILE CONTROL CARD
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function ProfileControlCard({ profile, state, onToggleKeepAlive, onCommand }: {
  profile: Profile; state: ProfileState;
  onToggleKeepAlive: () => void;
  onCommand: (cmd: string, params?: any) => void;
}) {
  const platform = state.platform;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800">
        <div className={`w-2 h-2 rounded-full ${state.status === 'active' ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`} />
        <span className="font-semibold text-sm text-white">{profile.name}</span>
        <div className="flex items-center gap-1 bg-gray-800 px-2 py-0.5 rounded-full">
          {getPlatformIcon(platform)}
          <span className="text-xs text-gray-400">{getPlatformLabel(platform)}</span>
        </div>
        {/* Keep Alive */}
        <button onClick={onToggleKeepAlive}
          className={`ml-auto flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-all ${state.keepAlive ? 'bg-green-900/40 border border-green-700/40 text-green-400' : 'bg-gray-800 border border-gray-700 text-gray-500'}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${state.keepAlive ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
          Anti-Sleep {state.keepAlive ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className="p-4 grid grid-cols-3 gap-4">
        {/* Col 1: Scroll + Video */}
        <div className="space-y-3">
          {/* Scroll Controls */}
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">Scroll</p>
            <div className="flex items-center gap-2">
              <button onClick={() => onCommand('scrollUp')}
                className="bg-gray-800 hover:bg-gray-700 text-white px-3 py-1.5 rounded-lg text-xs transition-all active:bg-gray-600">↑ Up</button>
              <button onClick={() => onCommand('scrollDown')}
                className="bg-gray-800 hover:bg-gray-700 text-white px-3 py-1.5 rounded-lg text-xs transition-all active:bg-gray-600">↓ Down</button>
              {/* Scroll position indicator */}
              <div className="flex-1 h-2 bg-gray-800 rounded-full relative">
                <div className="absolute left-0 top-0 h-full bg-red-600 rounded-full transition-all" style={{ width: `${state.scrollPosition}%` }} />
              </div>
              <span className="text-xs text-gray-500 w-8 text-right">{Math.round(state.scrollPosition)}%</span>
            </div>
          </div>

          {/* Video Controls */}
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">Video</p>
            {state.currentVideo && (
              <p className="text-xs text-green-400 mb-1 truncate">▶ {state.currentVideo}</p>
            )}
            <div className="flex items-center gap-1">
              <button onClick={() => onCommand('play')} className="bg-green-800 hover:bg-green-700 text-white p-1.5 rounded-lg transition-all"><Play size={12} /></button>
              <button onClick={() => onCommand('pause')} className="bg-yellow-800 hover:bg-yellow-700 text-white p-1.5 rounded-lg transition-all"><Pause size={12} /></button>
              <button onClick={() => onCommand('skipBackward')} className="bg-gray-700 hover:bg-gray-600 text-white p-1.5 rounded-lg transition-all text-xs font-bold">-10s</button>
              <button onClick={() => onCommand('skipForward')} className="bg-gray-700 hover:bg-gray-600 text-white p-1.5 rounded-lg transition-all text-xs font-bold">+10s</button>
              <button onClick={() => onCommand('next')} className="bg-blue-800 hover:bg-blue-700 text-white p-1.5 rounded-lg transition-all"><SkipForward size={12} /></button>
              <button onClick={() => onCommand('stop')} className="bg-red-800 hover:bg-red-700 text-white p-1.5 rounded-lg transition-all"><StopCircle size={12} /></button>
            </div>
            {/* Watch progress */}
            <div className="mt-1.5 h-1.5 bg-gray-800 rounded-full">
              <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${state.watchProgress}%` }} />
            </div>
          </div>
        </div>

        {/* Col 2: Tabs */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-gray-500 font-medium">Tabs ({state.tabs.length})</p>
            <div className="flex gap-1">
              <button onClick={() => onCommand('newTab')} className="bg-gray-800 hover:bg-gray-700 text-white px-1.5 py-0.5 rounded text-xs transition-all" title="New Tab">+</button>
              <button onClick={() => onCommand('newWindow')} className="bg-gray-800 hover:bg-gray-700 text-white px-1.5 py-0.5 rounded text-xs transition-all" title="New Window">⊞</button>
            </div>
          </div>
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {state.tabs.map((tab, i) => (
              <div key={tab.id} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs ${tab.isActive ? 'bg-gray-800 border border-gray-700' : 'bg-gray-900'}`}>
                <div className={`w-1.5 h-1.5 rounded-full ${tab.isActive ? 'bg-blue-400' : 'bg-gray-600'}`} />
                <span className="text-gray-300 truncate flex-1">{tab.title}</span>
                {tab.watchProgress > 0 && <span className="text-green-400 text-xs">{tab.watchProgress}%</span>}
                <button onClick={() => onCommand('closeTab', { tabIndex: i })} className="text-gray-600 hover:text-red-400 transition-all"><X size={10} /></button>
              </div>
            ))}
          </div>
        </div>

        {/* Col 3: Platform Info + Manual Click */}
        <div className="space-y-3">
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">Platform Shortcuts</p>
            <div className="bg-gray-800 rounded-lg p-2 text-xs text-gray-400 space-y-0.5">
              {platform === 'windows' && <>
                <p>🖱️ Mouse wheel scroll</p>
                <p>Ctrl+T → New tab</p>
                <p>Ctrl+W → Close tab</p>
              </>}
              {platform === 'macos' && <>
                <p>🖱️ Trackpad gesture</p>
                <p>Cmd+T → New tab</p>
                <p>Cmd+W → Close tab</p>
              </>}
              {platform === 'android' && <>
                <p>👆 Touch swipe scroll</p>
                <p>⌨️ Virtual keyboard</p>
                <p>📱 Tap to interact</p>
              </>}
            </div>
          </div>

          {/* Manual Click Targets */}
          <div>
            <p className="text-xs text-gray-500 mb-1.5 font-medium">Quick Actions</p>
            <div className="grid grid-cols-2 gap-1">
              <button onClick={() => onCommand('clickVideo')} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs transition-all">▶ Video</button>
              <button onClick={() => onCommand('clickLike')} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs transition-all">👍 Like</button>
              <button onClick={() => onCommand('clickSubscribe')} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs transition-all">🔔 Subscribe</button>
              <button onClick={() => onCommand('clickComment')} className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-1 rounded text-xs transition-all">💬 Comment</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// KEYWORD POOL MODAL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function KeywordPoolModal({ profiles, keywords, onSave, onClose }: {
  profiles: Profile[];
  keywords: Record<string, string[]>;
  onSave: (data: Record<string, string[]>) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'per-profile' | 'bulk'>('bulk');
  const [bulkText, setBulkText] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState(profiles[0]?.id || '');
  const [perProfileInput, setPerProfileInput] = useState('');

  const handleBulkAdd = () => {
    if (!bulkText.trim()) return;
    const kws = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
    const updated = { ...keywords };
    profiles.forEach(p => {
      if (!updated[p.id]) updated[p.id] = [];
      updated[p.id] = [...new Set([...updated[p.id], ...kws])];
    });
    onSave(updated);
    setBulkText('');
  };

  const handlePerProfileAdd = () => {
    if (!perProfileInput.trim() || !selectedProfileId) return;
    const kws = perProfileInput.split(',').map(k => k.trim()).filter(Boolean);
    const updated = { ...keywords };
    if (!updated[selectedProfileId]) updated[selectedProfileId] = [];
    updated[selectedProfileId] = [...new Set([...updated[selectedProfileId], ...kws])];
    onSave(updated);
    setPerProfileInput('');
  };

  const removeKeyword = (profileId: string, keyword: string) => {
    const updated = { ...keywords };
    updated[profileId] = (updated[profileId] || []).filter(k => k !== keyword);
    onSave(updated);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-bold text-lg">🔑 Keyword Pool</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button onClick={() => setMode('bulk')}
              className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${mode === 'bulk' ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400'}`}>Bulk Add (All Profiles)</button>
            <button onClick={() => setMode('per-profile')}
              className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${mode === 'per-profile' ? 'bg-purple-600 text-white' : 'bg-gray-800 text-gray-400'}`}>Per Profile</button>
          </div>

          {mode === 'bulk' && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">Add keywords to ALL profiles (one per line):</label>
              <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)}
                placeholder="funny cat videos&#10;coding tutorial&#10;react hooks explained"
                rows={4} className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 resize-none" />
              <button onClick={handleBulkAdd} disabled={!bulkText.trim()}
                className="mt-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all">Add to All Profiles</button>
            </div>
          )}

          {mode === 'per-profile' && (
            <div>
              <label className="text-xs text-gray-400 block mb-1">Select profile:</label>
              <select value={selectedProfileId} onChange={(e) => setSelectedProfileId(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white mb-2 focus:outline-none">
                {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div className="flex gap-2">
                <input type="text" value={perProfileInput} onChange={(e) => setPerProfileInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handlePerProfileAdd()}
                  placeholder="keyword1, keyword2, keyword3..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-purple-500" />
                <button onClick={handlePerProfileAdd} className="bg-purple-600 hover:bg-purple-500 text-white px-3 py-2 rounded-xl text-sm transition-all">Add</button>
              </div>
            </div>
          )}

          {/* Current keywords */}
          <div className="space-y-2">
            <p className="text-xs text-gray-500 font-medium">Current Keywords:</p>
            {profiles.map(p => {
              const pKeywords = keywords[p.id] || [];
              if (pKeywords.length === 0) return null;
              return (
                <div key={p.id} className="bg-gray-800 rounded-lg p-2">
                  <p className="text-xs text-gray-400 font-medium mb-1">{p.name}:</p>
                  <div className="flex flex-wrap gap-1">
                    {pKeywords.map(kw => (
                      <span key={kw} className="flex items-center gap-1 bg-gray-700 text-gray-300 px-2 py-0.5 rounded text-xs">
                        {kw}
                        <button onClick={() => removeKeyword(p.id, kw)} className="text-red-400 hover:text-red-300"><X size={10} /></button>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-800">
          <button onClick={onClose} className="w-full bg-gray-800 hover:bg-gray-700 text-white py-2 rounded-xl text-sm font-medium transition-all">Close</button>
        </div>
      </div>
    </div>
  );
}
