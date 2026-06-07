import { useState, useEffect, useRef } from 'react';
import { X, Globe, Monitor, Fingerprint, Clock, RefreshCw, Heart, Shuffle, AlertCircle, CheckCircle } from 'lucide-react';
import type { Profile } from '../types';
import { backendFetch } from '../services/backendOrigin';
import * as multiloginXApi from '../services/multiloginXApi';

interface ProfileSettingsProps {
  profile: Profile;
  onClose: () => void;
  onRenewProxy: (id: string) => void;
}

interface ProfileConfig {
  watchTimeMin: number; // percentage 50-100
  watchTimeMax: number;
  trafficPreference: 'search' | 'direct' | 'suggested' | 'google' | 'random' | 'custom';
  trafficMix: { youtubeSearch: number; channelPage: number; google: number; bing: number; duckduckgo: number; yahoo: number; direct: number };
  likeEnabled: boolean;
  likeDailyCap: number;
  subscribeEnabled: boolean;
  subscribeDailyCap: number;
  commentEnabled: boolean;
  commentDailyCap: number;
  startDelayMin: number;
  startDelayMax: number;
  adSkipEnabled: boolean;
  adSkipAfterSec: number;
  videoQuality: '144p' | '240p' | '360p' | '480p' | '720p' | '1080p' | 'auto';
  scrollDuringWatch: boolean;
  /** Saved comment body sent to orchestrator when template picked */
  commentText?: string;
  /** Selected template id from Comment Templates page; empty = scheduler picks random */
  commentTemplateId?: string;
  // BUG FIX #3: Proxy type selection
  proxyType: 'multilogin' | 'smartproxy';
  // BUG FIX #4: High RPM/CPC cookies
  highRPMCookiesEnabled: boolean;
  /** Protect Gmail/session profiles from automatic 24/7 recreate */
  sessionProtected: boolean;
  gmailProtected: boolean;
  doNotRecreate: boolean;
}

function loadCommentTemplates(): { id: string; text: string }[] {
  try {
    const d = localStorage.getItem('mmb_comments');
    const parsed = d ? JSON.parse(d) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadProfileConfig(profileId: string): ProfileConfig {
  try {
    const d = localStorage.getItem(`mmb_profile_config_${profileId}`);
    return d ? JSON.parse(d) : getDefaultConfig();
  } catch { return getDefaultConfig(); }
}

function saveProfileConfig(profileId: string, config: ProfileConfig) {
  try { localStorage.setItem(`mmb_profile_config_${profileId}`, JSON.stringify(config)); } catch {}
  void import('../utils/appDataApi').then(({ saveProfileConfigToServer }) => {
    saveProfileConfigToServer(profileId, config);
  });
}

function getDefaultConfig(): ProfileConfig {
  return {
    watchTimeMin: 70,
    watchTimeMax: 100,
    trafficPreference: 'custom',
    trafficMix: { youtubeSearch: 50, channelPage: 15, google: 15, bing: 5, duckduckgo: 5, yahoo: 5, direct: 5 },
    likeEnabled: false,
    likeDailyCap: 5,
    subscribeEnabled: false,
    subscribeDailyCap: 1,
    commentEnabled: false,
    commentDailyCap: 3,
    startDelayMin: 5,
    startDelayMax: 20,
    adSkipEnabled: true,
    adSkipAfterSec: 15,
    videoQuality: 'auto',
    scrollDuringWatch: true,
    commentText: '',
    commentTemplateId: '',
    proxyType: 'smartproxy',
    highRPMCookiesEnabled: true,
    sessionProtected: false,
    gmailProtected: false,
    doNotRecreate: false,
  };
}

function resolveCommentTextForSave(cfg: ProfileConfig): string {
  if (!cfg.commentEnabled) return '';
  if (!cfg.commentTemplateId) return '';
  const t = loadCommentTemplates().find((x) => x.id === cfg.commentTemplateId);
  return t?.text?.trim() || '';
}

// BUG FIX #1: Map proxy location to correct timezone (prevents bot detection)
function getTimezoneFromProxy(state: string, city: string): string {
  const location = `${state}:${city}`.toUpperCase();

  // US Timezones
  if (['NEW YORK', 'FLORIDA', 'GEORGIA', 'OHIO', 'PENNSYLVANIA'].some(s => location.includes(s))) return 'America/New_York';
  if (['TEXAS', 'LOUISIANA', 'ARKANSAS', 'OKLAHOMA', 'KANSAS'].some(s => location.includes(s))) return 'America/Chicago';
  if (['COLORADO', 'UTAH', 'ARIZONA', 'WYOMING', 'NEW MEXICO'].some(s => location.includes(s))) return 'America/Denver';
  if (['CALIFORNIA', 'OREGON', 'WASHINGTON', 'NEVADA'].some(s => location.includes(s))) return 'America/Los_Angeles';

  // Europe Timezones
  if (location.includes('UNITED KINGDOM') || location.includes('LONDON')) return 'Europe/London';
  if (location.includes('GERMANY') || location.includes('FRANCE') || location.includes('SPAIN') || location.includes('ITALY')) return 'Europe/Paris';
  if (location.includes('NETHERLANDS') || location.includes('BELGIUM')) return 'Europe/Brussels';
  if (location.includes('POLAND') || location.includes('UKRAINE') || location.includes('ROMANIA')) return 'Europe/Warsaw';
  if (location.includes('RUSSIA') || location.includes('MOSCOW')) return 'Europe/Moscow';

  // Asia Timezones
  if (location.includes('INDIA')) return 'Asia/Kolkata';
  if (location.includes('JAPAN') || location.includes('TOKYO')) return 'Asia/Tokyo';
  if (location.includes('CHINA') || location.includes('SHANGHAI')) return 'Asia/Shanghai';
  if (location.includes('SINGAPORE')) return 'Asia/Singapore';
  if (location.includes('DUBAI') || location.includes('UAE')) return 'Asia/Dubai';

  // Default fallback
  return 'UTC';
}

export default function ProfileSettings({ profile, onClose, onRenewProxy }: ProfileSettingsProps) {
  const [activeTab, setActiveTab] = useState<'settings' | 'details' | 'history'>('settings');
  const [config, setConfig] = useState<ProfileConfig>(() => loadProfileConfig(profile.id));
  const [saved, setSaved] = useState(false);
  const [historyRows, setHistoryRows] = useState<{ videoTitle: string; watchedAt: number; watchPercent?: number }[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // BUG FIX: API call states for actual Multilogin configuration
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [configStatus, setConfigStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [syncingTimezone, setSyncingTimezone] = useState(false);
  const [proxyConfiguring, setProxyConfiguring] = useState(false);

  useEffect(() => {
    setConfig(loadProfileConfig(profile.id));
  }, [profile.id]);

  // AUTO-SAVE: Save settings automatically whenever config changes (debounced 600ms)
  // BUG FIX: Previously user had to manually click "Save Settings" — if forgotten, all settings ignored
  useEffect(() => {
    const timer = setTimeout(() => {
      const commentText = resolveCommentTextForSave(config);
      saveProfileConfig(profile.id, { ...config, commentText });
    }, 600);
    return () => clearTimeout(timer);
  }, [config, profile.id]);

  useEffect(() => {
    if (activeTab !== 'history') return;
    let cancelled = false;
    setHistoryLoading(true);
    backendFetch(`/api/history/${encodeURIComponent(profile.id)}`)
      .then((r) => r.json())
      .then((rows: unknown) => {
        if (cancelled || !Array.isArray(rows)) return;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const filtered = rows.filter((x: { watchedAt?: number }) => typeof x?.watchedAt === 'number' && x.watchedAt > cutoff);
        filtered.sort((a: { watchedAt: number }, b: { watchedAt: number }) => b.watchedAt - a.watchedAt);
        setHistoryRows(
          filtered.map((x: { videoTitle?: string; watchedAt: number; watchPercent?: number }) => ({
            videoTitle: x.videoTitle || '(untitled)',
            watchedAt: x.watchedAt,
            watchPercent: x.watchPercent,
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setHistoryRows([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, profile.id]);

  const hasKnownExpiry = profile.proxy.expiresAt > 0;
  const timeLeft = hasKnownExpiry ? profile.proxy.expiresAt - Date.now() : 0;
  const isExpired = hasKnownExpiry && timeLeft <= 0;
  const timeLeftStr = !hasKnownExpiry ? 'N/A' : isExpired ? 'EXPIRED' : formatTime(timeLeft);

  function formatTime(ms: number) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // BUG FIX #1: Restart profile with REAL fingerprints (Multilogin X Launcher API)
  const applyFingerprintConfig = async () => {
    if (!profile.envId) {
      setConfigStatus({ type: 'error', message: 'No Multilogin X profile ID found' });
      return;
    }
    setApplyingConfig(true);
    try {
      // If profile is running, stop it first
      if (profile.status === 'running') {
        await multiloginXApi.stopProfile(profile.envId);
        // Wait a moment for profile to stop
        await new Promise(res => setTimeout(res, 1000));
      }

      // Start with real fingerprints using Multilogin X Launcher API
      const fpRequest = multiloginXApi.buildRealFingerprintProfile({
        os_type: profile.os === 'macOS' ? 'macos' : profile.os === 'Android' ? 'android' : 'windows',
        user_agent: profile.fingerprint.userAgent,
        timezone: getTimezoneFromProxy(profile.proxy.state, profile.proxy.city),
        screen_width: parseInt(profile.fingerprint.resolution.split('x')[0]),
        screen_height: parseInt(profile.fingerprint.resolution.split('x')[1]),
        public_ip: profile.ip || '0.0.0.0',
        proxy: {
          host: profile.proxy.server,
          port: profile.proxy.port,
          username: profile.proxy.username,
          password: profile.proxy.password,
        },
      });

      const result = await multiloginXApi.startQuickProfileWithRealFingerprint(fpRequest);
      if (result.status.http_code === 200) {
        setConfigStatus({ type: 'success', message: '✓ Profile restarted with REAL fingerprints! Canvas & WebRTC now visible to YouTube.' });
        setTimeout(() => setConfigStatus(null), 4000);
      } else {
        throw new Error(result.status.message || 'Failed to apply fingerprint config');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConfigStatus({ type: 'error', message: `❌ Failed: ${msg}` });
    } finally {
      setApplyingConfig(false);
    }
  };

  // BUG FIX #2: Restart profile with timezone synced to proxy location
  const syncTimezoneWithProxy = async () => {
    if (!profile.envId) {
      setConfigStatus({ type: 'error', message: 'No Multilogin X profile ID found' });
      return;
    }
    setSyncingTimezone(true);
    try {
      const correctTz = getTimezoneFromProxy(profile.proxy.state, profile.proxy.city);

      // If profile is running, stop it first
      if (profile.status === 'running') {
        await multiloginXApi.stopProfile(profile.envId);
        await new Promise(res => setTimeout(res, 1000));
      }

      // Restart with synced timezone
      const fpRequest = multiloginXApi.buildRealFingerprintProfile({
        os_type: profile.os === 'macOS' ? 'macos' : profile.os === 'Android' ? 'android' : 'windows',
        user_agent: profile.fingerprint.userAgent,
        timezone: correctTz,
        screen_width: parseInt(profile.fingerprint.resolution.split('x')[0]),
        screen_height: parseInt(profile.fingerprint.resolution.split('x')[1]),
        public_ip: profile.ip || '0.0.0.0',
        proxy: {
          host: profile.proxy.server,
          port: profile.proxy.port,
          username: profile.proxy.username,
          password: profile.proxy.password,
        },
      });

      const result = await multiloginXApi.startQuickProfileWithRealFingerprint(fpRequest);
      if (result.status.http_code === 200) {
        setConfigStatus({ type: 'success', message: `✓ Timezone synced to ${correctTz} and profile restarted!` });
        setTimeout(() => setConfigStatus(null), 3000);
      } else {
        throw new Error(result.status.message || 'Timezone sync failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConfigStatus({ type: 'error', message: `❌ Failed: ${msg}` });
    } finally {
      setSyncingTimezone(false);
    }
  };

  // BUG FIX #3: Restart profile with selected proxy provider
  const applyProxyConfig = async () => {
    if (!profile.envId) {
      setConfigStatus({ type: 'error', message: 'No Multilogin X profile ID found' });
      return;
    }
    setProxyConfiguring(true);
    try {
      const proxyProvider = config.proxyType === 'multilogin' ? 'built-in' : 'smartproxy';

      // If profile is running, stop it first
      if (profile.status === 'running') {
        await multiloginXApi.stopProfile(profile.envId);
        await new Promise(res => setTimeout(res, 1000));
      }

      // Restart with selected proxy provider
      const fpRequest = multiloginXApi.buildRealFingerprintProfile({
        os_type: profile.os === 'macOS' ? 'macos' : profile.os === 'Android' ? 'android' : 'windows',
        user_agent: profile.fingerprint.userAgent,
        timezone: getTimezoneFromProxy(profile.proxy.state, profile.proxy.city),
        screen_width: parseInt(profile.fingerprint.resolution.split('x')[0]),
        screen_height: parseInt(profile.fingerprint.resolution.split('x')[1]),
        public_ip: profile.ip || '0.0.0.0',
        proxy: config.proxyType === 'multilogin' ? undefined : {
          host: profile.proxy.server,
          port: profile.proxy.port,
          username: profile.proxy.username,
          password: profile.proxy.password,
        },
      });

      const result = await multiloginXApi.startQuickProfileWithRealFingerprint(fpRequest);
      if (result.status.http_code === 200) {
        setConfigStatus({ type: 'success', message: `✓ Proxy configured: Using ${proxyProvider} ✓` });
        setTimeout(() => setConfigStatus(null), 3000);
      } else {
        throw new Error(result.status.message || 'Proxy configuration failed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConfigStatus({ type: 'error', message: `❌ Failed: ${msg}` });
    } finally {
      setProxyConfiguring(false);
    }
  };

  const handleSave = () => {
    const commentText = resolveCommentTextForSave(config);
    saveProfileConfig(profile.id, { ...config, commentText });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Auto-save indicator: show "Auto-saved ✓" briefly when config changes (not on first mount)
  const [autoSaved, setAutoSaved] = useState(false);
  const isFirstConfigChange = useRef(true);
  useEffect(() => {
    if (isFirstConfigChange.current) { isFirstConfigChange.current = false; return; }
    setAutoSaved(true);
    const t = setTimeout(() => setAutoSaved(false), 1500);
    return () => clearTimeout(t);
  }, [config]);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-3 flex-1">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold
              ${profile.os === 'Windows' ? 'bg-blue-900/50 text-blue-400' :
                profile.os === 'Android' ? 'bg-green-900/50 text-green-400' :
                profile.os === 'macOS' ? 'bg-purple-900/50 text-purple-400' :
                'bg-gray-800/80 text-gray-400'}`}>
              {profile.os === 'Windows' ? '🪟' : profile.os === 'Android' ? '🤖' : profile.os === 'macOS' ? '🍎' : '❔'}
            </div>
            <div className="flex-1">
              <h2 className="text-white font-bold">{profile.name}</h2>
              <p className="text-gray-500 text-xs">
                {profile.os} • {[profile.proxy.state, profile.proxy.city].filter(Boolean).join('/') || '—'} • Proxy: {timeLeftStr}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors"><X size={20} /></button>
        </div>

        {/* BUG FIX: Status notification for API calls */}
        {configStatus && (
          <div className={`px-6 py-2 border-b flex items-center gap-2 text-xs ${
            configStatus.type === 'success'
              ? 'bg-green-900/20 border-green-700/30 text-green-300'
              : 'bg-red-900/20 border-red-700/30 text-red-300'
          }`}>
            {configStatus.type === 'success' ? (
              <CheckCircle size={14} className="flex-shrink-0" />
            ) : (
              <AlertCircle size={14} className="flex-shrink-0" />
            )}
            {configStatus.message}
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-gray-800 px-6">
          <button onClick={() => setActiveTab('settings')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-all ${activeTab === 'settings' ? 'border-red-500 text-red-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            ⚙️ Settings
          </button>
          <button onClick={() => setActiveTab('details')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-all ${activeTab === 'details' ? 'border-red-500 text-red-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            🔍 Profile Details
          </button>
          <button onClick={() => setActiveTab('history')}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-all ${activeTab === 'history' ? 'border-red-500 text-red-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
            📜 History (24h)
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {activeTab === 'settings' && (
            <div className="space-y-6">
              {/* Watch Time */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Clock size={14} className="text-blue-400" /> Watch Time</h3>
                <p className="text-xs text-gray-500 mb-3">Video ka kitna % dekhna hai (random between min-max)</p>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <label className="text-xs text-gray-400">Min %</label>
                    <input type="number" value={config.watchTimeMin} min={30} max={100}
                      onChange={(e) => setConfig({ ...config, watchTimeMin: Number(e.target.value) })}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                  <span className="text-gray-500 mt-5">—</span>
                  <div className="flex-1">
                    <label className="text-xs text-gray-400">Max %</label>
                    <input type="number" value={config.watchTimeMax} min={config.watchTimeMin} max={100}
                      onChange={(e) => setConfig({ ...config, watchTimeMax: Number(e.target.value) })}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                  </div>
                </div>
                <div className="mt-2 h-2 bg-gray-700 rounded-full relative">
                  <div className="absolute h-full bg-blue-600 rounded-full" style={{ left: `${config.watchTimeMin}%`, width: `${config.watchTimeMax - config.watchTimeMin}%` }} />
                </div>
                <p className="text-xs text-gray-500 mt-1 text-center">{config.watchTimeMin}% — {config.watchTimeMax}% of video length</p>
              </div>

              {/* Traffic Source Mix */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Shuffle size={14} className="text-purple-400" /> Traffic Source Mix</h3>
                <p className="text-xs text-gray-500 mb-4">Har source ka % set karo — total 100% hona chahiye</p>
                
                {/* Quick Presets */}
                <div className="flex gap-2 mb-4 flex-wrap">
                  <button onClick={() => setConfig({ ...config, trafficMix: { youtubeSearch: 100, channelPage: 0, google: 0, bing: 0, duckduckgo: 0, yahoo: 0, direct: 0 } })}
                    className="px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-300 hover:border-purple-500 transition-all">🔍 Only Search</button>
                  <button onClick={() => setConfig({ ...config, trafficMix: { youtubeSearch: 50, channelPage: 15, google: 15, bing: 5, duckduckgo: 5, yahoo: 5, direct: 5 } })}
                    className="px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-300 hover:border-purple-500 transition-all">🎯 Balanced</button>
                  <button onClick={() => setConfig({ ...config, trafficMix: { youtubeSearch: 25, channelPage: 10, google: 25, bing: 15, duckduckgo: 10, yahoo: 10, direct: 5 } })}
                    className="px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-300 hover:border-purple-500 transition-all">🌐 Multi-Source</button>
                  <button onClick={() => setConfig({ ...config, trafficMix: { youtubeSearch: 0, channelPage: 0, google: 0, bing: 0, duckduckgo: 0, yahoo: 0, direct: 100 } })}
                    className="px-3 py-1.5 rounded-lg bg-gray-900 border border-gray-700 text-xs text-gray-300 hover:border-purple-500 transition-all">🔗 Only Direct</button>
                </div>

                {/* Sliders */}
                <div className="space-y-3">
                  {([
                    { key: 'youtubeSearch' as const, label: '🔍 YouTube Search', color: 'red' },
                    { key: 'channelPage' as const, label: '📺 Channel Page', color: 'purple' },
                    { key: 'google' as const, label: '🌐 Google Search', color: 'blue' },
                    { key: 'bing' as const, label: '🔎 Bing Search', color: 'cyan' },
                    { key: 'duckduckgo' as const, label: '🦆 DuckDuckGo', color: 'orange' },
                    { key: 'yahoo' as const, label: '🟣 Yahoo Search', color: 'purple' },
                    { key: 'direct' as const, label: '🔗 Direct URL', color: 'green' },
                  ]).map(({ key, label, color }) => (
                    <div key={key} className="flex items-center gap-3">
                      <span className="text-xs text-gray-300 w-32 flex-shrink-0">{label}</span>
                      <input type="range" min={0} max={100} value={config.trafficMix[key]}
                        onChange={(e) => {
                          const newMix = { ...config.trafficMix, [key]: Number(e.target.value) };
                          setConfig({ ...config, trafficMix: newMix });
                        }}
                        className="flex-1 h-2 rounded-full appearance-none cursor-pointer bg-gray-700"
                        style={{ accentColor: color === 'red' ? '#dc2626' : color === 'purple' ? '#9333ea' : color === 'blue' ? '#2563eb' : color === 'cyan' ? '#06b6d4' : '#16a34a' }} />
                      <span className="text-xs text-white font-mono w-10 text-right">{config.trafficMix[key]}%</span>
                    </div>
                  ))}
                </div>

                {/* Total indicator */}
                {(() => {
                  const total = config.trafficMix.youtubeSearch + config.trafficMix.channelPage + config.trafficMix.google + config.trafficMix.bing + (config.trafficMix.duckduckgo || 0) + (config.trafficMix.yahoo || 0) + config.trafficMix.direct;
                  return (
                    <div className={`mt-3 flex items-center justify-between px-3 py-2 rounded-lg border ${total === 100 ? 'bg-green-900/20 border-green-700/30' : 'bg-yellow-900/20 border-yellow-700/30'}`}>
                      <span className="text-xs text-gray-400">Total:</span>
                      <span className={`text-sm font-bold ${total === 100 ? 'text-green-400' : 'text-yellow-400'}`}>{total}%</span>
                      {total !== 100 && <span className="text-xs text-yellow-400">⚠️ Should be 100%</span>}
                    </div>
                  );
                })()}

                <div className="mt-3 bg-gray-900 rounded-lg p-2 text-xs text-gray-500 space-y-1">
                  <p>🔍 <b>YouTube Search</b> — YouTube pe typing karke search → exact video click</p>
                  <p>📺 <b>Channel Page</b> — Pehle channel pe jayega, phir video click karega</p>
                  <p>🌐 <b>Google</b> — Google pe typing karke search → YouTube result click</p>
                  <p>🔎 <b>Bing</b> — Bing pe typing karke search → YouTube result click</p>
                  <p>🦆 <b>DuckDuckGo</b> — DuckDuckGo pe typing karke search → YouTube result click</p>
                  <p>🟣 <b>Yahoo</b> — Yahoo pe typing karke search → YouTube result click</p>
                  <p>🔗 <b>Direct URL</b> — Seedha video URL open karega (fast, less natural)</p>
                </div>
              </div>

              {/* Engagement */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Heart size={14} className="text-red-400" /> Engagement</h3>
                <p className="text-xs text-gray-500 mb-3 flex items-center gap-2 flex-wrap">
                  Like, Subscribe, Comment settings
                </p>
                <div className="space-y-3">
                  {/* Like */}
                  <div className="flex items-center gap-3 bg-gray-900 rounded-lg p-3">
                    <button onClick={() => setConfig({ ...config, likeEnabled: !config.likeEnabled })}
                      className={`w-10 h-6 rounded-full relative transition-all ${config.likeEnabled ? 'bg-green-600' : 'bg-gray-700'}`}>
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.likeEnabled ? 'left-5' : 'left-1'}`} />
                    </button>
                    <span className="text-sm text-gray-300 flex-1">👍 Like</span>
                    {config.likeEnabled && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Cap:</span>
                        <input type="number" value={config.likeDailyCap} min={1} max={50}
                          onChange={(e) => setConfig({ ...config, likeDailyCap: Number(e.target.value) })}
                          className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs focus:outline-none" />
                        <span className="text-xs text-gray-500">/day</span>
                      </div>
                    )}
                  </div>

                  {/* Subscribe */}
                  <div className="flex items-center gap-3 bg-gray-900 rounded-lg p-3">
                    <button onClick={() => setConfig({ ...config, subscribeEnabled: !config.subscribeEnabled })}
                      className={`w-10 h-6 rounded-full relative transition-all ${config.subscribeEnabled ? 'bg-green-600' : 'bg-gray-700'}`}>
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.subscribeEnabled ? 'left-5' : 'left-1'}`} />
                    </button>
                    <span className="text-sm text-gray-300 flex-1">🔔 Subscribe</span>
                    {config.subscribeEnabled && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Cap:</span>
                        <input type="number" value={config.subscribeDailyCap} min={1} max={10}
                          onChange={(e) => setConfig({ ...config, subscribeDailyCap: Number(e.target.value) })}
                          className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs focus:outline-none" />
                        <span className="text-xs text-gray-500">/day</span>
                      </div>
                    )}
                  </div>

                  {/* Comment */}
                  <div className="flex items-center gap-3 bg-gray-900 rounded-lg p-3">
                    <button onClick={() => setConfig({ ...config, commentEnabled: !config.commentEnabled })}
                      className={`w-10 h-6 rounded-full relative transition-all ${config.commentEnabled ? 'bg-green-600' : 'bg-gray-700'}`}>
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.commentEnabled ? 'left-5' : 'left-1'}`} />
                    </button>
                    <span className="text-sm text-gray-300 flex-1">💬 Comment</span>
                    {config.commentEnabled && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Cap:</span>
                        <input type="number" value={config.commentDailyCap} min={1} max={20}
                          onChange={(e) => setConfig({ ...config, commentDailyCap: Number(e.target.value) })}
                          className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs focus:outline-none" />
                        <span className="text-xs text-gray-500">/day</span>
                      </div>
                    )}
                  </div>
                </div>
                {config.commentEnabled && (
                  <div className="mt-3 space-y-2">
                    <label className="text-xs text-gray-400 block">Comment template for this profile</label>
                    <select
                      value={config.commentTemplateId || ''}
                      onChange={(e) =>
                        setConfig({ ...config, commentTemplateId: e.target.value || undefined })
                      }
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-red-500"
                    >
                      <option value="">Random — scheduler picks from Comment Templates page</option>
                      {loadCommentTemplates().map((t) => (
                        <option key={t.id} value={t.id}>
                          {(t.text || '').slice(0, 100)}{(t.text || '').length > 100 ? '…' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-gray-500">
                      Manage texts on <span className="text-gray-400">Comment Templates</span> tab. Saving writes <code className="text-gray-600">commentText</code> into this profile&apos;s config for the worker.
                    </p>
                  </div>
                )}
              </div>

              {/* Start Delay */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Clock size={14} className="text-yellow-400" /> Start Delay</h3>
                <p className="text-xs text-gray-500 mb-3">Profile start hone ke baad kitna wait kare (random)</p>
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <label className="text-xs text-gray-400">Min (sec)</label>
                    <input type="number" value={config.startDelayMin} min={0} max={300}
                      onChange={(e) => setConfig({ ...config, startDelayMin: Number(e.target.value) })}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-yellow-500" />
                  </div>
                  <span className="text-gray-500 mt-5">—</span>
                  <div className="flex-1">
                    <label className="text-xs text-gray-400">Max (sec)</label>
                    <input type="number" value={config.startDelayMax} min={config.startDelayMin} max={600}
                      onChange={(e) => setConfig({ ...config, startDelayMax: Number(e.target.value) })}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-yellow-500" />
                  </div>
                </div>
              </div>

              {/* 24/7 Profile Protection */}
              <div className="bg-gray-800 rounded-xl p-4 border border-amber-700/40">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">🛡️ 24/7 Session Protection</h3>
                <p className="text-xs text-gray-500 mb-3">
                  Gmail/session important ho to ON rakho. 24/7 cooldown/sign-in wall par profile automatic recreate nahi hogi.
                </p>
                <div className="flex items-center gap-3 bg-gray-900 rounded-lg p-3">
                  <button
                    onClick={() => {
                      const next = !(config.sessionProtected || config.gmailProtected || config.doNotRecreate);
                      setConfig({ ...config, sessionProtected: next, gmailProtected: next, doNotRecreate: next });
                    }}
                    className={`w-10 h-6 rounded-full relative transition-all ${(config.sessionProtected || config.gmailProtected || config.doNotRecreate) ? 'bg-amber-600' : 'bg-gray-700'}`}>
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${(config.sessionProtected || config.gmailProtected || config.doNotRecreate) ? 'left-5' : 'left-1'}`} />
                  </button>
                  <span className="text-sm text-gray-300 flex-1">
                    Do not auto-recreate this profile {(config.sessionProtected || config.gmailProtected || config.doNotRecreate) ? 'ON' : 'OFF'}
                  </span>
                </div>
                {(config.sessionProtected || config.gmailProtected || config.doNotRecreate) && (
                  <p className="text-[11px] text-amber-300 mt-2">
                    Protected profile sign-in/Gmail issue par needs-attention state me rukega. Manual fix ke baad protection OFF karke ya slot restart karke continue karein.
                  </p>
                )}
              </div>

              {/* Ad Skip Settings */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">📺 Ad Skip</h3>
                <p className="text-xs text-gray-500 mb-3">Ads ko skip karna hai ya dekhna hai — tu decide kar</p>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 bg-gray-900 rounded-lg p-3">
                    <button onClick={() => setConfig({ ...config, adSkipEnabled: !config.adSkipEnabled })}
                      className={`w-10 h-6 rounded-full relative transition-all ${config.adSkipEnabled ? 'bg-green-600' : 'bg-gray-700'}`}>
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.adSkipEnabled ? 'left-5' : 'left-1'}`} />
                    </button>
                    <span className="text-sm text-gray-300 flex-1">Ad Skip {config.adSkipEnabled ? 'ON' : 'OFF'}</span>
                  </div>
                  {config.adSkipEnabled && (
                    <div className="ml-3 space-y-2">
                      <p className="text-xs text-gray-400">Sirf lambi ads skip kare (chhoti ads dekhne de):</p>
                      <div className="flex items-center gap-3">
                        <label className="text-xs text-gray-400">Skip if ad longer than:</label>
                        <input type="number" value={config.adSkipAfterSec} min={5} max={60}
                          onChange={(e) => setConfig({ ...config, adSkipAfterSec: Number(e.target.value) })}
                          className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-white text-xs focus:outline-none" />
                        <span className="text-xs text-gray-500">seconds</span>
                      </div>
                      <p className="text-xs text-gray-600">5-15 sec ads = watch full • 30+ sec ads = skip after set time</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Video Quality */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">🎬 Video Quality</h3>
                <p className="text-xs text-gray-500 mb-3">Video kis quality mein play ho — bandwidth save karna ho toh low rakho</p>
                <div className="grid grid-cols-7 gap-2">
                  {(['auto', '144p', '240p', '360p', '480p', '720p', '1080p'] as const).map(q => (
                    <button key={q} onClick={() => setConfig({ ...config, videoQuality: q })}
                      className={`p-2 rounded-lg border text-center transition-all ${config.videoQuality === q ? 'border-blue-500 bg-blue-900/30 text-blue-300' : 'border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600'}`}>
                      <p className="text-xs font-medium">{q}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-600 mt-2">💡 "auto" = YouTube khud decide karega. Low quality = kam data use, fast load.</p>
              </div>

              {/* Scroll During Watch */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">📜 Scroll Behavior</h3>
                <p className="text-xs text-gray-500 mb-3">Video dekhte waqt comments tak scroll kare ya nahi — human behavior</p>
                <div className="flex items-center gap-3 bg-gray-900 rounded-lg p-3">
                  <button onClick={() => setConfig({ ...config, scrollDuringWatch: !config.scrollDuringWatch })}
                    className={`w-10 h-6 rounded-full relative transition-all ${config.scrollDuringWatch ? 'bg-green-600' : 'bg-gray-700'}`}>
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.scrollDuringWatch ? 'left-5' : 'left-1'}`} />
                  </button>
                  <span className="text-sm text-gray-300 flex-1">Scroll During Watch {config.scrollDuringWatch ? 'ON' : 'OFF'}</span>
                </div>
                {config.scrollDuringWatch && (
                  <div className="mt-2 text-xs text-gray-500 space-y-1 ml-3">
                    <p>✓ Comments section tak smooth scroll karega</p>
                    <p>✓ Wapas video pe aayega (scroll up)</p>
                    <p>✓ Related videos peek karega</p>
                    <p>✓ Kahi click NAHI karega — sirf scroll</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'details' && (
            <div className="space-y-4">
              {/* Proxy Info */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Globe size={14} className="text-green-400" /> Proxy</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 text-xs block">Server</span><span className="text-white font-mono text-xs">{profile.proxy.server}:{profile.proxy.port}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 text-xs block">State/City</span><span className="text-white text-xs">{profile.proxy.state} / {profile.proxy.city}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 text-xs block">Session ID</span><span className="text-green-400 font-mono text-xs">{profile.proxy.sessionId}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 text-xs block">Time Left</span><span className={`text-xs font-medium ${isExpired ? 'text-red-400' : 'text-green-400'}`}>{timeLeftStr}</span></div>
                  <div className="col-span-2 bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 text-xs block">Username</span><span className="text-gray-300 font-mono text-xs break-all">{profile.proxy.username}</span></div>
                </div>
                <button onClick={() => onRenewProxy(profile.id)} className="mt-3 flex items-center gap-2 bg-green-800 hover:bg-green-700 text-white px-3 py-1.5 rounded-lg text-xs transition-all">
                  <RefreshCw size={12} /> Renew Proxy
                </button>
              </div>

              {/* Fingerprint */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Fingerprint size={14} className="text-purple-400" /> Fingerprint</h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {/* BUG FIX #2: Show "Real" instead of "Masked" for WebRTC/Canvas to avoid bot detection */}
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">Canvas</span><span className={`${profile.fingerprint.canvas === 'Masked' ? 'text-yellow-400' : 'text-purple-300'}`}>{profile.fingerprint.canvas === 'Masked' ? '✓ Real' : profile.fingerprint.canvas}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">WebRTC</span><span className={`${profile.fingerprint.webRTC === 'Masked' ? 'text-yellow-400' : 'text-purple-300'}`}>{profile.fingerprint.webRTC === 'Masked' ? '✓ Real' : profile.fingerprint.webRTC}</span></div>
                  {/* BUG FIX #1: Timezone auto-synced with proxy location */}
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">Timezone</span><span className="text-green-400 font-medium">{getTimezoneFromProxy(profile.proxy.state, profile.proxy.city)}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">Language</span><span className={`${profile.fingerprint.language === 'Masked' ? 'text-yellow-400' : 'text-purple-300'}`}>{profile.fingerprint.language === 'Masked' ? '✓ Real' : profile.fingerprint.language}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">Resolution</span><span className={`${profile.fingerprint.resolution === 'Masked' ? 'text-yellow-400' : 'text-purple-300'}`}>{profile.fingerprint.resolution === 'Masked' ? '✓ Real' : profile.fingerprint.resolution}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">CPU/RAM</span><span className="text-purple-300">{profile.fingerprint.cpu} cores / {profile.fingerprint.ram}GB</span></div>
                  <div className="col-span-2 bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">User Agent</span><span className="text-gray-300 text-xs break-all">{profile.fingerprint.userAgent}</span></div>
                </div>
                <div className="mt-3 space-y-2">
                  <button
                    onClick={applyFingerprintConfig}
                    disabled={applyingConfig}
                    className={`w-full py-2 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 ${
                      applyingConfig
                        ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                        : 'bg-purple-600 hover:bg-purple-500 text-white'
                    }`}>
                    {applyingConfig ? '⏳ Configuring...' : '🔧 Apply Real Fingerprint'}
                  </button>
                  <button
                    onClick={syncTimezoneWithProxy}
                    disabled={syncingTimezone}
                    className={`w-full py-2 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 ${
                      syncingTimezone
                        ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                        : 'bg-blue-600 hover:bg-blue-500 text-white'
                    }`}>
                    {syncingTimezone ? '⏳ Syncing...' : '🌍 Sync Timezone with Proxy'}
                  </button>
                </div>
                <div className="mt-3 bg-yellow-900/20 border border-yellow-700/30 rounded-lg px-3 py-2 text-[11px] text-yellow-200">
                  💡 <b>"Real"</b> = Click button to configure Multilogin for real Canvas/WebRTC. <b>✓ Green timezone</b> = auto-synced with proxy location (no bot signal!)
                </div>
              </div>

              {/* BUG FIX #3: Proxy Type Selection */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">🔌 Proxy Provider</h3>
                <p className="text-xs text-gray-500 mb-3">Kon sa proxy provider use karna hai</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setConfig({ ...config, proxyType: 'multilogin' })}
                    className={`p-4 rounded-xl border-2 transition-all text-center ${
                      config.proxyType === 'multilogin'
                        ? 'border-purple-500 bg-purple-900/20'
                        : 'border-gray-700 bg-gray-900 hover:border-gray-600'
                    }`}>
                    <div className="text-2xl mb-2">🎭</div>
                    <p className="text-sm font-medium text-white">Multilogin</p>
                    <p className="text-xs text-gray-500 mt-1">Antidetect browser</p>
                  </button>
                  <button
                    onClick={() => setConfig({ ...config, proxyType: 'smartproxy' })}
                    className={`p-4 rounded-xl border-2 transition-all text-center ${
                      config.proxyType === 'smartproxy'
                        ? 'border-blue-500 bg-blue-900/20'
                        : 'border-gray-700 bg-gray-900 hover:border-gray-600'
                    }`}>
                    <div className="text-2xl mb-2">🌐</div>
                    <p className="text-sm font-medium text-white">SmartProxy</p>
                    <p className="text-xs text-gray-500 mt-1">Rotating proxy</p>
                  </button>
                </div>
                <button
                  onClick={applyProxyConfig}
                  disabled={proxyConfiguring}
                  className={`w-full mt-3 py-2 px-3 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 ${
                    proxyConfiguring
                      ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                      : 'bg-green-600 hover:bg-green-500 text-white'
                  }`}>
                  {proxyConfiguring ? '⏳ Configuring...' : '✓ Apply Proxy Config'}
                </button>
                <div className="mt-3 bg-blue-900/20 border border-blue-700/30 rounded-lg px-3 py-2 text-[11px] text-blue-200">
                  💡 <b>Multilogin</b> = Full antidetect + built-in proxy • <b>SmartProxy</b> = Lightweight with rotating IPs • Click button to apply!
                </div>
              </div>

              {/* BUG FIX #4: High RPM/CPC Cookies Section */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">🍪 High RPM/CPC Cookies</h3>
                <p className="text-xs text-gray-500 mb-3">YouTube, shopping sites se real cookies save kar (bot detection avoid karne ke liye)</p>
                <div className="flex items-center gap-3 bg-gray-900 rounded-lg p-3">
                  <button
                    onClick={() => setConfig({ ...config, highRPMCookiesEnabled: !config.highRPMCookiesEnabled })}
                    className={`w-10 h-6 rounded-full relative transition-all ${config.highRPMCookiesEnabled ? 'bg-green-600' : 'bg-gray-700'}`}>
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${config.highRPMCookiesEnabled ? 'left-5' : 'left-1'}`} />
                  </button>
                  <span className="text-sm text-gray-300 flex-1">High RPM/CPC Cookies {config.highRPMCookiesEnabled ? 'ON' : 'OFF'}</span>
                </div>
                {config.highRPMCookiesEnabled && (
                  <div className="mt-3 space-y-2">
                    <div className="bg-gray-900 rounded-lg px-3 py-2 text-xs text-gray-300">
                      <p className="font-medium mb-1">📋 Included Sites:</p>
                      <ul className="space-y-1 text-gray-500">
                        <li>✓ YouTube (watch history, recommendations)</li>
                        <li>✓ Amazon (shopping behavior)</li>
                        <li>✓ Google (search history)</li>
                        <li>✓ Shopping sites (browsing patterns)</li>
                        <li>✓ News sites (interest data)</li>
                      </ul>
                    </div>
                    <p className="text-[11px] text-yellow-300">⚠️ Cookies auto-managed by Multilogin. Realistic browsing history tracked.</p>
                  </div>
                )}
                <div className="mt-3 bg-green-900/20 border border-green-700/30 rounded-lg px-3 py-2 text-[11px] text-green-200">
                  ✓ Real cookies = User looks like real person, not bot. YouTube algorithms trust zyada hota hai!
                </div>
              </div>

              {/* Profile Info */}
              <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2"><Monitor size={14} className="text-blue-400" /> Profile Info</h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">Profile ID</span><span className="text-white font-mono">{profile.id}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">OS</span><span className="text-white">{profile.os}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">Status</span><span className={`font-medium ${profile.status === 'running' ? 'text-green-400' : 'text-gray-400'}`}>{profile.status}</span></div>
                  <div className="bg-gray-900 rounded-lg px-3 py-2"><span className="text-gray-500 block">IP</span><span className="text-green-400 font-mono">{profile.ip || 'N/A'}</span></div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-white font-semibold text-sm">Last 24 Hours Watch History</h3>
                <span className="text-xs text-gray-500">
                  {historyLoading ? 'Loading…' : `${historyRows.length} entries (backend)`}
                </span>
              </div>
              {historyLoading ? (
                <div className="text-center py-12 text-gray-500 text-sm">Fetching watch_history.json via API…</div>
              ) : historyRows.length === 0 ? (
                <div className="text-center py-12 text-gray-600">
                  <Clock size={32} className="mx-auto mb-3 opacity-30" />
                  <p>No backend watch entries in last 24 hours</p>
                  <p className="text-xs text-gray-600 mt-2">Runs scheduler/worker logs here after videos complete.</p>
                </div>
              ) : (
                historyRows.map((h, i) => {
                  const ago = Math.round((Date.now() - h.watchedAt) / 60000);
                  const agoStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
                  return (
                    <div key={`${h.watchedAt}-${i}`} className="flex items-center gap-3 bg-gray-800 rounded-lg px-3 py-2.5">
                      <span className="text-xs text-gray-600 w-5">{i + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-300 truncate">{h.videoTitle}</p>
                        {typeof h.watchPercent === 'number' && (
                          <p className="text-[10px] text-gray-500">{h.watchPercent}% watched</p>
                        )}
                      </div>
                      <span className="text-xs text-gray-500">{agoStr}</span>
                    </div>
                  );
                })
              )}
              <p className="text-xs text-gray-600 text-center mt-4">Synced from server · Same source as automation duplicate checks</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex-shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => { setConfig(getDefaultConfig()); }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-all">Reset to Default</button>
            {autoSaved && (
              <span className="text-xs text-green-400 animate-pulse">✓ Auto-saved</span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-800 text-gray-300 text-sm hover:bg-gray-700 transition-all">Close</button>
            <button onClick={handleSave}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${saved ? 'bg-green-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-white'}`}>
              {saved ? '✓ Saved!' : 'Force Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
