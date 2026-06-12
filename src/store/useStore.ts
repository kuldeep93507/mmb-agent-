import { useState, useCallback, useEffect, useRef } from 'react';
import type { Profile, Job, LogEntry, OS, TaskType, LogSource } from '../types';
import { postActivityLog, clearActivityLogs } from '../utils/logsApi';
import {
  renewProxySession
} from '../utils/generators';
import { profileFromListRow, saveSnapshotFromCreateFull, inferProxyTypeFromProfile, isMultiloginProxyHost, type ProviderListRow } from '../utils/profileAdapter';
import { hydrateAllAppDataFromServer } from '../utils/appDataApi';
import { fetchSettingsFromServer, saveSettingsLocal } from '../utils/settingsApi';
import * as moreloginApi from '../services/moreloginApi';
import {
  listProfiles as listProviderProfiles,
  listProfilesAll,
  startProfile as startProviderProfile,
  stopProfile as stopProviderProfile,
  deleteProfile as deleteProviderProfile,
  type BrowserProvider,
  type ProviderSelection,
} from '../services/browserProviderApi';
import { backendFetch, getAuthHeaders } from '../services/backendOrigin';

function genId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// BUG FIX: Generate serial profile names (Profile_001, Profile_002, etc.)
function getNextProfileNumber(): number {
  try {
    const stored = localStorage.getItem('mmb_profile_counter');
    const current = stored ? parseInt(stored, 10) : 0;
    const next = current + 1;
    localStorage.setItem('mmb_profile_counter', next.toString());
    return next;
  } catch {
    return 1; // Fallback
  }
}

function formatProfileName(index: number): string {
  return `Profile_${String(index).padStart(3, '0')}`; // Profile_001, Profile_002, etc.
}

const ACTIVE_TAB_KEY = 'mmb_active_tab';

/** Must match Sidebar NAV_ITEMS ids */
export const VALID_APP_TABS = new Set([
  'dashboard', 'monitor', 'profiles', 'channels', 'video-shuffle', 'backlinks', 'scheduler',
  'manual', 'analytics', 'comments', 'jobs', 'logs', 'settings', 'engagement', 'gmail-setup',
  'proxy', 'selector-health', 'future-agent', 'fleet', 'notification-hub',
]);

const REMOVED_TAB_REDIRECT: Record<string, string> = {
  'proxy-health': 'dashboard',
  recycle: 'dashboard',
  performance: 'channels',
  'orchestrator-log': 'channels',
  'video-manager': 'channels',
  'yt-agents': 'channels',
};

function loadActiveTab(): string {
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY);
    if (saved && REMOVED_TAB_REDIRECT[saved]) return REMOVED_TAB_REDIRECT[saved];
    if (saved && VALID_APP_TABS.has(saved)) return saved;
  } catch { /* ignore */ }
  return 'dashboard';
}

export function useStore() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>(() => {
    try { const d = localStorage.getItem('mmb_logs'); return d ? JSON.parse(d) : []; } catch { return []; }
  });
  const [activeTab, setActiveTabState] = useState<string>(loadActiveTab);
  const [loading, setLoading] = useState(false);
  const [recreatingIds, setRecreatingIds] = useState<Set<string>>(new Set());
  const [browserProvider, setBrowserProviderState] = useState<ProviderSelection>(() => {
    try {
      let stored = localStorage.getItem('mmb_browser_provider');
      if (stored === 'adspower') {
        stored = 'multilogin';
        try {
          localStorage.setItem('mmb_browser_provider', 'multilogin');
        } catch {
          /* ignore */
        }
      }
      if (stored === 'morelogin' || stored === 'multilogin' || stored === 'all') {
        return stored;
      }
    } catch {}
    return 'multilogin';
  });
  const browserProviderRef = useRef<ProviderSelection>(browserProvider);

  const setActiveTab = useCallback((tab: string) => {
    const resolved = REMOVED_TAB_REDIRECT[tab] || (VALID_APP_TABS.has(tab) ? tab : 'dashboard');
    setActiveTabState(resolved);
    try { localStorage.setItem(ACTIVE_TAB_KEY, resolved); } catch { /* ignore */ }
  }, []);

  const addLog = useCallback((
    level: LogEntry['level'],
    message: string,
    profileId?: string,
    profileName?: string,
    source: LogSource = 'profile',
  ) => {
    const entry: LogEntry = {
      id: genId(),
      profileId,
      profileName,
      level,
      message,
      timestamp: Date.now(),
      source,
    };
    setLogs(prev => {
      const updated = [entry, ...prev].slice(0, 500);
      try { localStorage.setItem('mmb_logs', JSON.stringify(updated.slice(0, 500))); } catch {}
      return updated;
    });
    void postActivityLog(level, message, { profileId, profileName, source, id: entry.id });
  }, []);

  // ============ FETCH REAL PROFILES FROM BROWSER PROVIDER ============
  const fetchProfiles = useCallback(async (providerOverride?: ProviderSelection) => {
    const provider = providerOverride || browserProviderRef.current;
    setLoading(true);
    try {
      const res = provider === 'all'
        ? await listProfilesAll(1, 100)
        : await listProviderProfiles(provider, 1, 100);

      if (res.code === 0 && res.data) {
        const mappedProfiles: Profile[] = res.data.profiles.map((sp: ProviderListRow & { osName?: string; osId?: number }) =>
          profileFromListRow({
            id: sp.id,
            name: sp.name,
            status: sp.status,
            debugPort: sp.debugPort ?? null,
            browserType: sp.browserType,
            os: sp.os ?? sp.osName,
            osId: sp.osId,
            proxyHost: sp.proxyHost,
            proxyPort: sp.proxyPort,
            proxyUsername: sp.proxyUsername,
            userAgentHint: sp.userAgentHint,
          }),
        );

        setProfiles(mappedProfiles);
        addLog('success', `Fetched ${mappedProfiles.length} profiles from ${provider} (Total: ${res.data.total})`);

        // Surface per-provider errors when in "all" mode
        if (provider === 'all' && 'errors' in res.data && Array.isArray(res.data.errors)) {
          for (const e of res.data.errors) {
            addLog('warn', `${e.provider}: ${e.message}`);
          }
        }
      } else {
        addLog('error', `${provider} API error: ${res.message || 'Unknown error'} (code: ${res.code})`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog('error', `Failed to fetch profiles from ${provider}: ${message}`);
      // On failure after provider change: keep empty profiles, set loading=false
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, [addLog]);

  // ============ SET BROWSER PROVIDER ============
  const setBrowserProvider = useCallback(async (provider: ProviderSelection) => {
    setBrowserProviderState(provider);
    browserProviderRef.current = provider;
    try { localStorage.setItem('mmb_browser_provider', provider); } catch {}
    setProfiles([]);
    setLoading(true);
    await fetchProfiles(provider);
  }, [fetchProfiles]);

  // Hydrate server-backed data + API token on mount; sync browser provider from server settings
  useEffect(() => {
    void fetchSettingsFromServer().then((s) => {
      if (!s) return;
      saveSettingsLocal(s);
      const remote = s.browserProvider;
      if (remote === 'morelogin' || remote === 'multilogin' || remote === 'all') {
        setBrowserProviderState(remote);
        browserProviderRef.current = remote;
        try { localStorage.setItem('mmb_browser_provider', remote); } catch { /* ignore */ }
      }
    });
    void hydrateAllAppDataFromServer();
  }, []);

  // Live worker queue from backend (replaces fake simulated jobs)
  useEffect(() => {
    const mapWorkerStatus = (s: string): Job['status'] => {
      if (['watching', 'running', 'connecting', 'starting'].includes(s)) return 'running';
      if (s === 'done') return 'done';
      if (s === 'error' || s === 'crashed') return 'failed';
      return 'pending';
    };
    const poll = async () => {
      try {
        const res = await backendFetch('/api/workers');
        if (!res.ok) return;
        const data = await res.json();
        const workers = Array.isArray(data.workers) ? data.workers : [];
        const workerJobs: Job[] = workers.map((w: Record<string, unknown>) => ({
          id: String(w.profileId),
          profileId: String(w.profileId),
          profileName: String(w.profileName || w.profileId),
          taskType: 'watch_video' as TaskType,
          status: mapWorkerStatus(String(w.status || 'waiting')),
          retryCount: Number(w.retries) || 0,
          createdAt: Number(w.startedAt) || Date.now(),
          startedAt: String(w.status) !== 'waiting' ? Number(w.startedAt) || Date.now() : undefined,
          completedAt: w.status === 'done' ? Date.now() : undefined,
          details: w.currentVideo
            ? String(w.currentVideo)
            : w.progress
              ? `Progress ${w.progress}`
              : undefined,
        }));

        const queuedRaw = Array.isArray(data.queuedJobs) ? data.queuedJobs : [];
        const queuedMapped: Job[] = queuedRaw.map((q: Record<string, unknown>) => ({
          id: String(q.id || q.profileId || genId()),
          profileId: String(q.profileId || ''),
          profileName: String(q.profileName || q.profileId || 'Profile'),
          taskType: (String(q.taskType || 'watch_video') as TaskType),
          status: 'pending',
          retryCount: Number(q.retryCount) || 0,
          createdAt: Number(q.createdAt) || Date.now(),
          startedAt: undefined,
          completedAt: undefined,
          details: q.details ? String(q.details) : undefined,
        }));

        const activeProfiles = new Set(workerJobs.map((j) => j.profileId));
        const pendingExtras = queuedMapped.filter((j) => j.profileId && !activeProfiles.has(j.profileId));
        setJobs([...pendingExtras, ...workerJobs]);
      } catch { /* offline */ }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  // Auto-fetch profiles on mount
  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  // ============ CREATE PROFILE — Full pipeline with fingerprint + proxy ============
  const createProfile = useCallback(
    async (os: OS, proxyType?: string, profileMode?: string, androidDevice?: string, resolution?: string, profileName?: string): Promise<{ code: number; message?: string }> => {
      const current = browserProviderRef.current;
      let provider: BrowserProvider = current === 'all' ? 'multilogin' : current;
      if (current === 'all') {
        try {
          const pick = localStorage.getItem('mmb_create_provider');
          if (pick === 'morelogin' || pick === 'multilogin') provider = pick;
        } catch { /* ignore */ }
        addLog('info', `Creating via ${provider} (All Providers mode — change in New Profile modal)`);
      }

      // Resolve proxy type — 'smartproxy' | 'multilogin' | 'none'
      const resolvedProxyType = proxyType || 'smartproxy';
      // Resolve profile mode — 'cloud' (persistent) | 'quick' (local launcher, full fingerprint)
      const resolvedProfileMode = profileMode || 'cloud';

      const proxyLabel = resolvedProxyType === 'multilogin'
        ? '[Multilogin Residential Proxy]'
        : resolvedProxyType === 'smartproxy'
          ? '[SmartProxy]'
          : '[No Proxy]';

      const modeLabel = resolvedProfileMode === 'quick' ? ' (Quick/Local)' : ' (Cloud/Persistent)';
      const deviceLabel = os === 'Android' && androidDevice ? ` [${androidDevice}]` : '';
      const resLabel = resolution && resolution !== 'auto' ? ` [${resolution}]` : '';

      try {
        const customName = profileName?.trim().replace(/[^\w\s\-_.]/g, '').slice(0, 48);
        const profileNameFinal = customName
          ? customName
          : formatProfileName(getNextProfileNumber());

        addLog('info', `Creating "${profileNameFinal}" — ${os}${deviceLabel}${resLabel} via ${provider} ${proxyLabel}${modeLabel}...`);

        const body: Record<string, unknown> = {
          os,
          browserType: provider,
          name: profileNameFinal,
          proxyType: resolvedProxyType,       // 'smartproxy' | 'multilogin' | 'none'
          profileMode: resolvedProfileMode,   // 'cloud' | 'quick'
          fingerprintConfig: {
            canvas: 'noise',
            webrtc: 'custom',
            timezone: 'custom',
            screen: 'custom',
            navigator: 'custom',
            geolocation: 'custom',
            audio: 'noise',
            webgl: 'noise',
          },
        };

        // Pass Android device model if user selected a specific one
        if (os === 'Android' && androidDevice && androidDevice !== 'auto') {
          body.androidDevice = androidDevice;
        }

        // Pass user-selected resolution (override country pool auto-pick)
        if (resolution && resolution !== 'auto') {
          body.resolution = resolution;
          const parts = resolution.toLowerCase().replace('×', 'x').split('x');
          if (parts.length === 2) {
            const w = parseInt(parts[0], 10);
            const h = parseInt(parts[1], 10);
            if (w > 0 && h > 0) {
              body.screenWidth = w;
              body.screenHeight = h;
            }
          }
        }

        const res = await backendFetch('/api/profiles/create-full', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        let result: { code?: number; message?: string; data?: unknown };
        try {
          result = await res.json();
        } catch {
          const msg = `Invalid response (${res.status})`;
          addLog('error', `Failed to create profile: ${msg}`);
          return { code: -1, message: msg };
        }

        if (result.code === 0 && result.data) {
          const d = result.data as {
            id?: string;
            profileMode?: string;
            proxy?: { state?: string; type?: string; host?: string; server?: string; country?: string };
            fingerprint?: { timezone?: string };
          };

          if (d.id) {
            saveSnapshotFromCreateFull(d.id, os, {
              proxy: d.proxy as Record<string, unknown> | undefined,
              fingerprint: d.fingerprint,
            });
          }

          const proxyInfo = d.proxy?.type === 'multilogin_residential'
            ? `Multilogin (${d.proxy.server || 'gate.multilogin.com'}) ${(d.proxy.country || 'us').toUpperCase()}`
            : `SmartProxy US-${d.proxy?.state || '?'}`;

          addLog(
            'success',
            `✅ Profile created! ID: ${d.id} | Mode: ${d.profileMode || 'cloud'} | Proxy: ${proxyInfo} | TZ: ${d.fingerprint?.timezone || '?'}`,
          );
          await fetchProfiles();
          return { code: 0 };
        }
        const msg = result.message || 'Unknown error';
        addLog('error', `Failed to create profile: ${msg}`);
        return { code: typeof result.code === 'number' ? result.code : -1, message: msg };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        addLog('error', `Create profile failed: ${message}`);
        return { code: -1, message };
      }
    },
    [addLog, fetchProfiles],
  );

  // Helper: resolve which provider a profile belongs to.
  // If profile.browserType is set (modern path), use that.
  // Otherwise fall back to the active provider, or "morelogin" in "all" mode.
  const resolveProviderFor = useCallback((profile: Profile): BrowserProvider => {
    if (profile.browserType) return profile.browserType;
    const current = browserProviderRef.current;
    return current === 'all' ? 'multilogin' : current;
  }, []);

  // ============ START PROFILE — routes via the profile's provider ============
  const startProfile = useCallback(async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;

    const provider = resolveProviderFor(profile);

    setProfiles(prev => prev.map(p =>
      p.id === profileId ? { ...p, status: 'starting', currentAction: 'Connecting...' } : p
    ));
    addLog('info', `Starting profile "${profile.name}" via ${provider}...`, profileId, profile.name);

    try {
      const res = await startProviderProfile(provider, profileId);
      if (res.code === 0 && res.data && res.data.cdpPort) {
        setProfiles(prev => prev.map(p =>
          p.id === profileId
            ? { ...p, status: 'running', currentAction: 'Active', ip: `debug:${res.data!.cdpPort}` }
            : p
        ));
        addLog('success', `Profile "${profile.name}" started via ${provider}! CDP port: ${res.data.cdpPort}`, profileId, profile.name);
      } else {
        // For MoreLogin, fall back to legacy status polling on timeout
        if (provider === 'morelogin' && res.code === -1) {
          addLog('warn', `Start request timed out for "${profile.name}" — checking status...`, profileId, profile.name);
          await pollProfileStatus(profileId, profile.name);
        } else {
          setProfiles(prev => prev.map(p =>
            p.id === profileId ? { ...p, status: 'error', currentAction: 'Start failed' } : p
          ));
          addLog('error', `Failed to start "${profile.name}" (${provider}): ${res.message || 'Unknown error'}`, profileId, profile.name);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setProfiles(prev => prev.map(p =>
        p.id === profileId ? { ...p, status: 'error', currentAction: 'Start failed' } : p
      ));
      addLog('error', `Start request error for "${profile.name}" (${provider}): ${message}`, profileId, profile.name);
    }
  }, [profiles, addLog, resolveProviderFor]);

  // Poll profile status after timeout/error (MoreLogin only — uses MoreLogin's status endpoint)
  const pollProfileStatus = useCallback(async (profileId: string, profileName: string) => {
    // Wait 5 seconds then check status
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      const statusRes = await moreloginApi.getProfileStatus(profileId);
      if (statusRes.code === 0 && statusRes.data) {
        if (statusRes.data.status === 'running') {
          setProfiles(prev => prev.map(p =>
            p.id === profileId
              ? { ...p, status: 'running', currentAction: 'Active', ip: statusRes.data.debugPort ? `debug:${statusRes.data.debugPort}` : undefined }
              : p
          ));
          addLog('success', `Profile "${profileName}" is running! Debug port: ${statusRes.data.debugPort || 'N/A'}`, profileId, profileName);
        } else {
          setProfiles(prev => prev.map(p =>
            p.id === profileId ? { ...p, status: 'stopped', currentAction: 'Idle' } : p
          ));
          addLog('info', `Profile "${profileName}" status: ${statusRes.data.status}`, profileId, profileName);
        }
      }
    } catch {
      setProfiles(prev => prev.map(p =>
        p.id === profileId ? { ...p, status: 'error', currentAction: 'Status check failed' } : p
      ));
      addLog('error', `Could not verify status for "${profileName}"`, profileId, profileName);
    }
  }, [addLog]);

  // ============ STOP PROFILE — routes via the profile's provider ============
  const stopProfile = useCallback(async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;

    const provider = resolveProviderFor(profile);
    addLog('info', `Stopping profile "${profile.name}" via ${provider}...`, profileId, profile.name);

    try {
      const res = await stopProviderProfile(provider, profileId);
      if (res.code === 0) {
        setProfiles(prev => prev.map(p =>
          p.id === profileId ? { ...p, status: 'stopped', ip: undefined, currentAction: 'Idle' } : p
        ));
        addLog('success', `Profile "${profile.name}" stopped (${provider}).`, profileId, profile.name);
      } else {
        addLog('error', `Failed to stop "${profile.name}" (${provider}): ${res.message || 'Unknown error'}`, profileId, profile.name);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog('error', `Stop failed for "${profile.name}" (${provider}): ${message}`, profileId, profile.name);
    }

    setJobs(prev => prev.map(j => j.profileId === profileId && j.status === 'running'
      ? { ...j, status: 'failed', completedAt: Date.now() } : j
    ));
  }, [profiles, addLog, resolveProviderFor]);

  // ============ DELETE PROFILE — routes via the profile's provider ============
  const deleteProfile = useCallback(async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;

    const provider = resolveProviderFor(profile);
    addLog('warn', `Deleting profile "${profile.name}" via ${provider}...`, profileId, profile.name);

    try {
      const res = await deleteProviderProfile(provider, profileId);
      if (res.code === 0) {
        setProfiles(prev => prev.filter(p => p.id !== profileId));
        setJobs(prev => prev.filter(j => j.profileId !== profileId));
        addLog('success', `Profile "${profile.name}" deleted (${provider}).`, profileId, profile.name);
      } else {
        addLog('error', `Failed to delete "${profile.name}" (${provider}): ${res.message || 'Unknown error'}`, profileId, profile.name);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog('error', `Delete failed for "${profile.name}" (${provider}): ${message}`, profileId, profile.name);
    }
  }, [profiles, addLog, resolveProviderFor]);

  // ============ RECREATE PROFILE — Full pipeline: delete + create fresh ============
  const recreateProfile = useCallback(async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;

    const provider = resolveProviderFor(profile);
    setRecreatingIds(prev => new Set(prev).add(profileId));
    setProfiles(prev => prev.map(p =>
      p.id === profileId ? { ...p, status: 'recreating' as const, currentAction: 'Recreating…' } : p
    ));
    addLog('info', `Recreating profile "${profile.name}" via ${provider} (new proxy + fingerprint)...`, profileId, profile.name);

    try {
      const proxyTypeForRecreate = inferProxyTypeFromProfile(profile);
      const res = await backendFetch('/api/profiles/recreate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId,
          browserType: provider,
          os: profile.os,
          name: profile.name,
          proxyType: proxyTypeForRecreate,
          fingerprintConfig: {
            canvas: 'noise',
            webrtc: 'custom',
            timezone: 'custom',
            screen: 'custom',
            navigator: 'custom',
            geolocation: 'custom',
            audio: 'noise',
            webgl: 'noise',
          },
        }),
      });

      const result = await res.json();

      if (result.code === 0 && result.data) {
        addLog('success', `Profile recreated! Old: ${result.data.oldProfileId} → New: ${result.data.newProfileId}`, profileId, profile.name);
        await fetchProfiles();
      } else {
        addLog('error', `Recreate failed: ${result.message || 'Unknown error'}`, profileId, profile.name);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      addLog('error', `Recreate failed for "${profile.name}": ${message}`, profileId, profile.name);
      setProfiles(prev => prev.map(p =>
        p.id === profileId ? { ...p, status: 'error' as const, currentAction: 'Recreate failed' } : p
      ));
    } finally {
      setRecreatingIds(prev => {
        const next = new Set(prev);
        next.delete(profileId);
        return next;
      });
    }
  }, [profiles, addLog, resolveProviderFor, fetchProfiles]);

  const deleteSelectedProfiles = useCallback(async () => {
    const selected = profiles.filter(p => p.selected);
    if (selected.length === 0) return;
    for (const p of selected) {
      await deleteProfile(p.id);
      await new Promise(r => setTimeout(r, 400));
    }
  }, [profiles, deleteProfile]);

  const recreateSelectedProfiles = useCallback(async () => {
    const selected = profiles.filter(p => p.selected);
    if (selected.length === 0) return;
    for (const p of selected) {
      await recreateProfile(p.id);
      await new Promise(r => setTimeout(r, 2000));
    }
  }, [profiles, recreateProfile]);

  const exportProfileConfigs = useCallback(() => {
    const configs: Record<string, unknown> = {};
    profiles.forEach(p => {
      try {
        const raw = localStorage.getItem(`mmb_profile_config_${p.id}`);
        if (raw) configs[p.id] = { name: p.name, config: JSON.parse(raw) };
      } catch { /* skip */ }
    });
    const blob = new Blob([JSON.stringify(configs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mmb-profile-configs-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 200);
    addLog('success', `Exported settings for ${Object.keys(configs).length} profiles`);
  }, [profiles, addLog]);

  const toggleSelect = useCallback((profileId: string) => {
    setProfiles(prev => prev.map(p => p.id === profileId ? { ...p, selected: !p.selected } : p));
  }, []);

  const selectAll = useCallback(() => {
    setProfiles(prev => prev.map(p => ({ ...p, selected: true })));
  }, []);

  const deselectAll = useCallback(() => {
    setProfiles(prev => prev.map(p => ({ ...p, selected: false })));
  }, []);

  const startSelected = useCallback(() => {
    profiles.filter(p => p.selected && p.status === 'stopped').forEach(p => startProfile(p.id));
  }, [profiles, startProfile]);

  const stopSelected = useCallback(() => {
    profiles.filter(p => p.selected && (p.status === 'running' || p.status === 'starting')).forEach(p => stopProfile(p.id));
  }, [profiles, stopProfile]);

  const retryJob = useCallback(async (jobId: string) => {
    try {
      await backendFetch(`/api/workers/stop/${jobId}`, { method: 'POST', headers: getAuthHeaders() });
      addLog('info', `Worker stopped for retry — re-run schedule for profile ${jobId.slice(-4)}`);
    } catch (err) {
      addLog('warn', `Could not stop worker: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addLog]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    try { localStorage.removeItem('mmb_logs'); } catch {}
    void clearActivityLogs();
  }, []);

  const renewProxy = useCallback(async (profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return;

    if (isMultiloginProxyHost(profile.proxy.server)) {
      addLog('info', `"${profile.name}" uses Multilogin built-in proxy — rotate from MLX or recreate profile instead.`, profileId, profile.name);
      return;
    }

    if (profile.status === 'running' || profile.status === 'starting') {
      addLog('warn', `Stop "${profile.name}" before renewing proxy on the provider.`, profileId, profile.name);
    }

    try {
      const provider = resolveProviderFor(profile);
      const res = await backendFetch('/api/proxy/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId,
          currentProxy: profile.proxy,
          browserType: provider,
        }),
      });
      const data = await res.json();

      if (res.ok && data.success && data.proxy) {
        setProfiles(prev => prev.map(p =>
          p.id === profileId ? { ...p, proxy: data.proxy } : p
        ));
        const providerNote = data.providerUpdated
          ? ` (${provider} profile updated)`
          : data.providerMessage
            ? ` — UI only: ${data.providerMessage}`
            : '';
        addLog(
          data.providerUpdated ? 'success' : 'warn',
          `Proxy rotated for "${profile.name}" | Session: ${data.proxy.sessionId}${providerNote}`,
          profileId,
          profile.name,
        );
      } else {
        // Fallback: client-side rotation (old behaviour) if backend unavailable
        const newProxy = renewProxySession(profile.proxy);
        setProfiles(prev => prev.map(p =>
          p.id === profileId ? { ...p, proxy: newProxy } : p
        ));
        addLog('warn', `Proxy renewed locally for "${profile.name}" (backend unavailable) | Session: ${newProxy.sessionId}`, profileId, profile.name);
      }
    } catch {
      // Fallback: client-side rotation
      const newProxy = renewProxySession(profile.proxy);
      setProfiles(prev => prev.map(p =>
        p.id === profileId ? { ...p, proxy: newProxy } : p
      ));
      addLog('warn', `Proxy renewed locally for "${profile.name}" | Session: ${newProxy.sessionId}`, profileId, profile.name);
    }
  }, [profiles, addLog, resolveProviderFor]);

  return {
    profiles, jobs, logs, activeTab, setActiveTab, loading,
    browserProvider, setBrowserProvider,
    createProfile, startProfile, stopProfile, deleteProfile, recreateProfile,
    deleteSelectedProfiles, recreateSelectedProfiles, exportProfileConfigs,
    recreatingIds,
    toggleSelect, selectAll, deselectAll, startSelected, stopSelected,
    retryJob, clearLogs, renewProxy, fetchProfiles,
  };
}



