import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import {
  Save, RefreshCw, Globe, Database, Server, Shield, Eye, EyeOff, Monitor, Key, Folder,
  Download, Upload, Zap, ExternalLink, Brain, Bell, Send, Trash2, Maximize2, Cookie, Search,
  CheckCircle2, XCircle, LogIn,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import type { BrowserProvider, ProviderSelection } from '../services/browserProviderApi';
import {
  type AppSettings,
  loadSettingsLocal,
  saveSettingsLocal,
  fetchSettingsFromServer,
  saveSettingsToServer,
  fetchConcurrency,
  testMoreLoginConnection,
  testMultiloginConnection,
  fetchMultiloginToken,
  testNotification,
  exportSettingsJson,
  parseSettingsImport,
} from '../utils/settingsApi';
import { backendFetch, getAuthHeaders } from '../services/backendOrigin';
import { isPackagedElectron } from '../utils/appMode';
import {
  loadNotificationPrefs,
  saveNotificationPrefs,
  type NotificationPrefs,
} from '../utils/notificationPrefs';
import { requestNotificationPermission } from '../services/notifications';
import { emptyTrash } from '../utils/trashApi';

function settingOn(v: boolean | string | undefined): boolean {
  return v === true || v === 'true';
}

const PROVIDER_INFO: Record<BrowserProvider, { label: string; connection: string }> = {
  morelogin: { label: 'MoreLogin', connection: 'localhost:40000' },
  multilogin: { label: 'Multilogin', connection: 'api.multilogin.com' },
};

const PROXY_LIFE_OPTIONS = ['1hr', '2hr', '4hr', '8hr', '24hr'] as const;

export default function SettingsPage() {
  const { browserProvider, setBrowserProvider, setActiveTab } = useStore();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettingsLocal());
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [concurrency, setConcurrency] = useState<{ limit: number; running: number; available: number } | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showMlPassword, setShowMlPassword] = useState(false);
  const [showMlToken, setShowMlToken] = useState(false);
  const [testingMl, setTestingMl] = useState<'morelogin' | 'multilogin' | null>(null);
  const [fetchingMlToken, setFetchingMlToken] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testingNotify, setTestingNotify] = useState<'telegram' | 'email' | null>(null);
  const [notifyPrefs, setNotifyPrefs] = useState<NotificationPrefs>(() => loadNotificationPrefs());
  const [browserNotifStatus, setBrowserNotifStatus] = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [trashActionMsg, setTrashActionMsg] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  // Real cookie pool state
  type CookieSet = { id: string; label: string; count: number; importedAt: number | null; domains?: string[] };
  type CookiePoolStatus = { hasCookies: boolean; poolSize: number; sets: CookieSet[] };
  const [cookieJson, setCookieJson] = useState('');
  const [cookieLabel, setCookieLabel] = useState('');
  const [cookiePool, setCookiePool] = useState<CookiePoolStatus | null>(null);
  const [cookieSaving, setCookieSaving] = useState(false);
  const [cookieMsg, setCookieMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const providerSynced = useRef(false);

  const refreshConcurrency = useCallback(async () => {
    const c = await fetchConcurrency();
    if (c) setConcurrency(c);
  }, []);

  const refreshCookieStatus = useCallback(async () => {
    try {
      const res = await backendFetch('/api/cookies/status', { headers: getAuthHeaders() });
      if (res.ok) setCookiePool(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if ('Notification' in window) {
      setBrowserNotifStatus(Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'unknown');
    }
  }, []);

  useEffect(() => {
    (async () => {
      const remote = await fetchSettingsFromServer();
      if (remote) {
        setSettings(remote);
        saveSettingsLocal(remote);
        setBackendStatus('ok');
        if (!providerSynced.current && remote.browserProvider) {
          providerSynced.current = true;
          if (remote.browserProvider !== browserProvider) {
            await setBrowserProvider(remote.browserProvider);
          }
        }
      } else {
        setBackendStatus('error');
      }
      await refreshConcurrency();
      await refreshCookieStatus();
    })();
    const t = setInterval(refreshConcurrency, 10000);
    return () => clearInterval(t);
  }, [browserProvider, setBrowserProvider, refreshConcurrency, refreshCookieStatus]);

  const update = <K extends keyof AppSettings>(key: K, val: AppSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: val }));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const payload: AppSettings = {
      ...settings,
      browserProvider,
      moreloginPort: settings.moreloginBaseUrl?.split(':').pop() || settings.moreloginPort || '40000',
    };
    saveSettingsLocal(payload);

    const result = await saveSettingsToServer(payload);
    if (result.success) {
      setBackendStatus('ok');
      setSettings(payload);
    } else {
      setBackendStatus('error');
      setSaveError(result.error || 'Backend save failed — saved locally only');
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    await refreshConcurrency();
  };

  const runTest = async (which: 'morelogin' | 'multilogin') => {
    setTestingMl(which);
    setTestResult(null);
    const r =
      which === 'morelogin'
        ? await testMoreLoginConnection(settings)
        : await testMultiloginConnection(settings);
    setTestResult(r);
    setTestingMl(null);
  };

  const runFetchMultiloginToken = async () => {
    if (!settings.multiloginEmail?.trim() || !settings.multiloginPassword?.trim()) {
      setTestResult({ ok: false, message: 'Pehle apna Multilogin email + password daalo (har member ka alag account).' });
      return;
    }
    setFetchingMlToken(true);
    setTestResult(null);
    const r = await fetchMultiloginToken({
      multiloginEmail: settings.multiloginEmail,
      multiloginPassword: settings.multiloginPassword,
      multiloginFolderId: settings.multiloginFolderId,
    });
    if (r.ok) {
      const remote = await fetchSettingsFromServer();
      if (remote) setSettings(remote);
      else {
        const local = loadSettingsLocal();
        if (local.multiloginToken) setSettings((s) => ({ ...s, multiloginToken: local.multiloginToken }));
      }
    }
    setTestResult(r);
    setFetchingMlToken(false);
  };

  const runNotifyTest = async (type: 'telegram' | 'email') => {
    setTestingNotify(type);
    setTestResult(null);
    const r = await testNotification(type, settings);
    setTestResult(r);
    setTestingNotify(null);
  };

  const updateNotifyPref = <K extends keyof NotificationPrefs>(key: K, val: NotificationPrefs[K]) => {
    setNotifyPrefs(prev => {
      const next = { ...prev, [key]: val };
      saveNotificationPrefs(next);
      return next;
    });
  };

  const enableBrowserNotifications = async () => {
    const ok = await requestNotificationPermission();
    setBrowserNotifStatus(ok ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'unknown');
    if (ok) updateNotifyPref('browserEnabled', true);
  };

  const handleImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = parseSettingsImport(String(reader.result));
        setSettings(imported);
        setSaveError(null);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : 'Invalid settings file');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
          <div>
            <h1 className="text-2xl font-bold text-white">Settings</h1>
            <p className="text-gray-500 text-sm mt-0.5">
              System config — saved to <span className="font-mono text-gray-400">user-settings.json</span> + browser backup
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {backendStatus === 'ok' && <span className="text-xs text-green-400">● Backend synced</span>}
            {backendStatus === 'error' && <span className="text-xs text-yellow-400">⚠ Backend offline</span>}
            {concurrency && (
              <span className="text-xs text-gray-500">
                Workers: {concurrency.running}/{concurrency.limit} ({concurrency.available} free)
              </span>
            )}
            <button
              type="button"
              onClick={() => exportSettingsJson({ ...settings, browserProvider })}
              className="flex items-center gap-1 px-3 py-2 rounded-xl bg-gray-800 text-gray-300 text-xs"
            >
              <Download size={14} /> Export
            </button>
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="flex items-center gap-1 px-3 py-2 rounded-xl bg-gray-800 text-gray-300 text-xs"
            >
              <Upload size={14} /> Import
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImport(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 ${
                saved ? 'bg-green-600/30 border border-green-500/40 text-green-400' : 'bg-red-600 hover:bg-red-500 text-white'
              }`}
            >
              {saving ? (
                <>
                  <RefreshCw size={14} className="animate-spin" /> Saving…
                </>
              ) : saved ? (
                '✓ Saved!'
              ) : (
                <>
                  <Save size={15} /> Save Settings
                </>
              )}
            </button>
          </div>
        </div>
        {saveError && (
          <div className="flex items-center justify-between bg-red-900/30 border border-red-700/30 rounded-lg px-3 py-2 mt-2">
            <span className="text-xs text-red-400">⚠️ {saveError}</span>
            <button type="button" onClick={() => setSaveError(null)} className="text-red-400 text-xs">
              ✕
            </button>
          </div>
        )}
        {testResult && (
          <div
            className={`mt-2 text-xs px-3 py-2 rounded-lg border ${
              testResult.ok ? 'bg-green-900/20 border-green-700/40 text-green-400' : 'bg-red-900/20 border-red-700/40 text-red-400'
            }`}
          >
            {testResult.message}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Browser Provider */}
        <Section title="Browser Provider" icon={<Monitor size={15} className="text-cyan-400" />} note="Saved with Settings — controls which profiles load on Profiles page">
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="text-gray-400 text-xs font-medium block mb-2">Active Provider</label>
              <select
                value={browserProvider}
                onChange={(e) => setBrowserProvider(e.target.value as ProviderSelection)}
                className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-cyan-500"
              >
                <option value="all">🌐 All Providers (mixed)</option>
                <option value="morelogin">MoreLogin</option>
                <option value="multilogin">Multilogin</option>
              </select>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(['all', 'morelogin', 'multilogin'] as const).map((key) => {
              const isActive = browserProvider === key;
              const label = key === 'all' ? 'All Providers' : PROVIDER_INFO[key].label;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setBrowserProvider(key)}
                  className={`rounded-xl border px-3 py-3 text-left transition-all ${
                    isActive ? 'bg-cyan-900/20 border-cyan-500/40' : 'bg-gray-800 border-gray-700'
                  }`}
                >
                  <div className="text-xs font-semibold text-white">{label}</div>
                  {isActive && <div className="text-[10px] text-cyan-400 mt-1">Active</div>}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setActiveTab('profiles')}
            className="mt-3 text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
          >
            <ExternalLink size={12} /> Per-profile watch/traffic/engagement → Profiles → Settings on each card
          </button>
        </Section>

        {/* Run limits — kept from old automation (working fields only) */}
        <Section title="Run Limits" icon={<Zap size={15} className="text-yellow-400" />} note="Used by Scheduler, Shuffle, and Backlinks when starting runs">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field
              label="Max concurrent profiles"
              value={settings.maxConcurrent}
              onChange={(v) => update('maxConcurrent', v)}
              type="number"
              desc="Global cap for /api/schedule/run"
            />
            <Field
              label="Multilogin wave size"
              value={settings.multiloginMaxConcurrent}
              onChange={(v) => update('multiloginMaxConcurrent', v)}
              type="number"
              desc="Profiles per Multilogin batch (plan limit)"
            />
            <Field
              label="Multilogin batch gap (ms)"
              value={settings.multiloginBatchGapMs}
              onChange={(v) => update('multiloginBatchGapMs', v)}
              type="number"
              desc="Delay between Multilogin waves"
            />
          </div>
        </Section>

        {/* MoreLogin */}
        <Section title="MoreLogin Local API" icon={<Globe size={15} className="text-blue-400" />}>
          <div className="grid grid-cols-1 gap-4">
            <Field
              label="Base URL"
              value={settings.moreloginBaseUrl}
              onChange={(v) => update('moreloginBaseUrl', v)}
              mono
              desc="Local API (MoreLogin desktop must be running)"
            />
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={testingMl === 'morelogin'}
              onClick={() => runTest('morelogin')}
              className="text-xs px-3 py-2 rounded-lg bg-blue-600/30 text-blue-300 border border-blue-600/40 disabled:opacity-50"
            >
              {testingMl === 'morelogin' ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          <div className="mt-4 bg-gray-800 border border-gray-700 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Shield size={14} className="text-yellow-400" />
                <span className="text-white text-sm font-semibold">Security verification</span>
              </div>
              <ToggleSwitch
                enabled={settings.moreloginSecurityEnabled}
                onChange={(v) => update('moreloginSecurityEnabled', v)}
              />
            </div>
            <div className="relative">
              <label className="text-gray-400 text-xs block mb-1.5">API Key</label>
              <div className="flex gap-2">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={settings.moreloginApiKey}
                  onChange={(e) => update('moreloginApiKey', e.target.value)}
                  className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono"
                />
                <button type="button" onClick={() => setShowApiKey(!showApiKey)} className="p-2.5 bg-gray-900 border border-gray-700 rounded-xl text-gray-400">
                  {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>
        </Section>

        {/* Multilogin */}
        <Section title="Multilogin" icon={<Key size={15} className="text-purple-400" />}>
          <div className="mb-4 bg-purple-950/30 border border-purple-800/40 rounded-xl px-4 py-3 text-xs text-purple-200/90 leading-relaxed">
            <p className="font-semibold text-purple-300 mb-1">Team setup (har member ka alag Multilogin account)</p>
            <p>1. Multilogin X app install karo + apne account se login</p>
            <p>2. Neeche apna email, password aur folder ID daalo</p>
            <p>3. <strong>Auto Get Token</strong> dabao — token khud save ho jayega (30 din)</p>
            <p>4. <strong>Test Multilogin</strong> → profiles dikhen to done ✅</p>
            <p className="text-purple-400/70 mt-2">Password kisi ko mat bhejo — sirf apne PC pe daalo.</p>
          </div>
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="text-gray-400 text-xs flex items-center gap-1 mb-1.5">
                <Folder size={11} /> Primary Folder ID
              </label>
              <input
                value={settings.multiloginFolderId}
                onChange={(e) => update('multiloginFolderId', e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono"
              />
            </div>
            {/* Multi-folder support */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-gray-400 text-xs flex items-center gap-1">
                  <Folder size={11} /> Additional Folder IDs
                  <span className="text-gray-600 ml-1">— profiles are fetched from all folders</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const ids = Array.isArray(settings.multiloginFolderIds) ? settings.multiloginFolderIds : [];
                    update('multiloginFolderIds', [...ids, '']);
                  }}
                  className="text-xs px-2 py-1 rounded-lg bg-purple-600/20 text-purple-400 border border-purple-600/30 hover:bg-purple-600/30"
                >
                  + Add Folder
                </button>
              </div>
              {(Array.isArray(settings.multiloginFolderIds) ? settings.multiloginFolderIds : []).length === 0 ? (
                <p className="text-xs text-gray-600 italic">No additional folders — only primary folder is used</p>
              ) : (
                <div className="space-y-2">
                  {(Array.isArray(settings.multiloginFolderIds) ? settings.multiloginFolderIds : []).map((fid, idx) => (
                    <div key={idx} className="flex gap-2">
                      <input
                        type="text"
                        value={fid}
                        placeholder={`Folder ID ${idx + 2}`}
                        onChange={(e) => {
                          const ids = [...(Array.isArray(settings.multiloginFolderIds) ? settings.multiloginFolderIds : [])];
                          ids[idx] = e.target.value;
                          update('multiloginFolderIds', ids);
                        }}
                        className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 rounded-xl px-3 py-2 text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const ids = [...(Array.isArray(settings.multiloginFolderIds) ? settings.multiloginFolderIds : [])];
                          ids.splice(idx, 1);
                          update('multiloginFolderIds', ids);
                        }}
                        className="p-2 bg-gray-800 border border-red-700/30 rounded-xl text-red-400 hover:bg-red-900/20"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="bg-gray-800 border border-purple-900/40 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-2">Automation token (recommended)</p>
              <div className="flex gap-2">
                <input
                  type={showMlToken ? 'text' : 'password'}
                  value={settings.multiloginToken}
                  onChange={(e) => update('multiloginToken', e.target.value)}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm font-mono text-gray-200"
                />
                <button type="button" onClick={() => setShowMlToken(!showMlToken)} className="p-2.5 bg-gray-900 border border-gray-700 rounded-xl text-gray-400">
                  {showMlToken ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-gray-500 text-xs mb-1 block">Email</label>
                <input
                  type="email"
                  value={settings.multiloginEmail}
                  onChange={(e) => update('multiloginEmail', e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200"
                />
              </div>
              <div>
                <label className="text-gray-500 text-xs mb-1 block">Password</label>
                <div className="flex gap-2">
                  <input
                    type={showMlPassword ? 'text' : 'password'}
                    value={settings.multiloginPassword}
                    onChange={(e) => update('multiloginPassword', e.target.value)}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200"
                  />
                  <button type="button" onClick={() => setShowMlPassword(!showMlPassword)} className="p-2 bg-gray-800 border border-gray-700 rounded-xl text-gray-400">
                    {showMlPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={fetchingMlToken}
              onClick={runFetchMultiloginToken}
              className="text-xs px-3 py-2 rounded-lg bg-green-600/30 text-green-300 border border-green-600/40 disabled:opacity-50"
            >
              {fetchingMlToken ? 'Fetching token…' : 'Auto Get Token'}
            </button>
            <button
              type="button"
              disabled={testingMl === 'multilogin'}
              onClick={() => runTest('multilogin')}
              className="text-xs px-3 py-2 rounded-lg bg-purple-600/30 text-purple-300 border border-purple-600/40 disabled:opacity-50"
            >
              {testingMl === 'multilogin' ? 'Testing…' : 'Test Multilogin'}
            </button>
          </div>
        </Section>

        <Section title="Multilogin Trash" icon={<Trash2 size={15} className="text-orange-400" />} note="Trash profiles count toward subscription limit — manual + auto cleanup">
          <div className="space-y-4">
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-white text-sm font-semibold">Auto purge on delete / recreate</p>
                <p className="text-gray-500 text-xs mt-1">When ON, delete & 24/7 recycle skip trash — permanent delete (frees quota instantly).</p>
              </div>
              <ToggleSwitch
                enabled={settingOn(settings.multiloginPurgeOnDelete)}
                onChange={(v) => update('multiloginPurgeOnDelete', v)}
              />
            </div>
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
              <div className="flex items-center justify-between gap-4 mb-3">
                <div>
                  <p className="text-white text-sm font-semibold">Scheduled auto-empty trash</p>
                  <p className="text-gray-500 text-xs mt-1">Background job permanently clears all trash profiles on interval.</p>
                </div>
                <ToggleSwitch
                  enabled={settingOn(settings.multiloginAutoEmptyTrash)}
                  onChange={(v) => update('multiloginAutoEmptyTrash', v)}
                />
              </div>
              <Field
                label="Empty trash every (hours)"
                value={settings.multiloginAutoEmptyTrashHours}
                onChange={(v) => update('multiloginAutoEmptyTrashHours', v)}
                type="number"
                desc="Requires Save Settings — server restarts the janitor timer"
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={emptyingTrash}
                onClick={async () => {
                  if (!window.confirm('Permanently delete ALL profiles in Multilogin trash now?')) return;
                  setEmptyingTrash(true);
                  setTrashActionMsg(null);
                  const res = await emptyTrash();
                  setEmptyingTrash(false);
                  setTrashActionMsg(
                    res.code === 0
                      ? `Done — ${res.data?.deleted ?? 0} profile(s) removed from trash`
                      : res.message || 'Empty trash failed',
                  );
                }}
                className="text-xs px-4 py-2 rounded-lg bg-orange-600/30 text-orange-300 border border-orange-600/40 disabled:opacity-50"
              >
                {emptyingTrash ? 'Emptying…' : 'Empty trash now'}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('profiles')}
                className="text-xs px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200"
              >
                Open Profiles → Trash tab
              </button>
            </div>
            {trashActionMsg && (
              <p className="text-xs text-orange-300/90">{trashActionMsg}</p>
            )}
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-white text-sm font-semibold">Auto-arrange windows on one screen</p>
                <p className="text-gray-500 text-xs mt-1">Jab 2+ profiles run hon, browser windows grid me ek display pe set ho jayengi.</p>
              </div>
              <ToggleSwitch
                enabled={settingOn(settings.multiloginAutoArrangeWindows)}
                onChange={(v) => update('multiloginAutoArrangeWindows', v)}
              />
            </div>
          </div>
        </Section>

        {/* Smartproxy — editable, applied to server env on save */}
        <Section title="Smartproxy (new profiles & rotate)" icon={<Server size={15} className="text-green-400" />}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Server" value={settings.proxyServer} onChange={(v) => update('proxyServer', v)} />
            <Field label="Port" value={settings.proxyPort} onChange={(v) => update('proxyPort', v)} type="number" />
            <Field label="Password" value={settings.proxyPassword} onChange={(v) => update('proxyPassword', v)} mono />
            <Field label="Username prefix" value={settings.proxyPrefix} onChange={(v) => update('proxyPrefix', v)} mono />
            <div className="col-span-2">
              <label className="text-gray-400 text-xs block mb-2">Default proxy session life</label>
              <div className="flex flex-wrap gap-2">
                {PROXY_LIFE_OPTIONS.map((life) => (
                  <button
                    key={life}
                    type="button"
                    onClick={() => update('defaultProxyLife', life)}
                    className={`px-4 py-2 rounded-xl border text-sm ${
                      settings.defaultProxyLife === life
                        ? 'bg-green-600/20 border-green-500/40 text-green-400'
                        : 'bg-gray-800 border-gray-700 text-gray-500'
                    }`}
                  >
                    {life}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">Applied to server proxy rotate + new profile generation after Save.</p>
        </Section>

        {/* Data storage */}
        <Section title="Data Storage" icon={<Database size={15} className="text-blue-400" />}>
          <div className="space-y-2 text-xs text-gray-400">
            {[
              ['Frontend', 'localStorage — profiles list cache, channels, logs, settings backup'],
              ['user-settings.json', 'Server — API keys, proxy, run limits'],
              ['analytics_data.json', 'Server — analytics'],
              ['watch_history.json', 'Server — shuffle watch history'],
              ['schedules_data.json', 'Server — saved schedules'],
              ['shuffle_data.json', 'Server — shuffle state'],
              ['backlinks_data.json', 'Server — backlink pool'],
            ].map(([name, desc]) => (
              <div key={name} className="bg-gray-800 rounded-xl px-3 py-2.5">
                <span className="text-blue-400 font-medium">{name}</span>
                <span className="text-gray-500"> — {desc}</span>
              </div>
            ))}
          </div>
        </Section>

        {/* Notifications */}
        <Section title="Notifications" icon={<Bell size={15} className="text-cyan-400" />} note="Browser popups (local) + Telegram instant alerts + email daily reports">
          <div className="mb-3 flex items-center gap-2 text-xs text-amber-300/90">
            <span className="px-2 py-0.5 rounded bg-amber-900/40 border border-amber-700/40">Coming Soon</span>
            <span className="text-gray-500">Email daily reports &amp; scheduled digest — Telegram + browser alerts work now</span>
          </div>
          <div className="mb-5 p-4 bg-gray-800/60 border border-gray-700 rounded-xl space-y-3">
            <p className="text-sm text-gray-300 font-medium">Browser notifications (free — no setup)</p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void enableBrowserNotifications()}
                className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium"
              >
                Allow browser notifications
              </button>
              <span className={`text-xs ${browserNotifStatus === 'granted' ? 'text-green-400' : browserNotifStatus === 'denied' ? 'text-red-400' : 'text-gray-500'}`}>
                {browserNotifStatus === 'granted' ? '● Allowed' : browserNotifStatus === 'denied' ? '● Blocked — enable in browser site settings' : '● Not requested yet'}
              </span>
            </div>
            <div className="grid sm:grid-cols-2 gap-2 text-sm">
              {([
                ['browserEnabled', 'Enable browser popups'],
                ['onScheduleComplete', 'Schedule finished'],
                ['onScheduleError', 'Schedule failed'],
                ['onWorkerError', 'Worker / profile errors'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-gray-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notifyPrefs[key]}
                    onChange={e => updateNotifyPref(key, e.target.checked)}
                    className="rounded border-gray-600 bg-gray-900 text-cyan-500"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <p className="text-xs text-gray-500 mb-3">
            <strong className="text-gray-400">Telegram setup:</strong> @BotFather → /newbot → copy Bot Token · Chat ID: message @userinfobot or add bot to group · Save settings, then Test.
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <Field label="Telegram Bot Token" value={settings.telegramBotToken || ''} onChange={v => update('telegramBotToken', v)} mono />
            <Field label="Telegram Chat ID" value={settings.telegramChatId || ''} onChange={v => update('telegramChatId', v)} mono />
            <Field label="Notify Email" value={settings.notifyEmail || ''} onChange={v => update('notifyEmail', v)} />
            <Field label="SMTP Host" value={settings.smtpHost || ''} onChange={v => update('smtpHost', v)} mono />
            <Field label="SMTP User" value={settings.smtpUser || ''} onChange={v => update('smtpUser', v)} mono />
            <Field label="SMTP Password" value={settings.smtpPass || ''} onChange={v => update('smtpPass', v)} mono />
            <Field label="Mail API URL (optional)" value={settings.mailApiUrl || ''} onChange={v => update('mailApiUrl', v)} desc="HTTP POST endpoint — easiest for real email delivery" />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={testingNotify !== null}
              onClick={() => void runNotifyTest('telegram')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm"
            >
              <Send size={14} />
              {testingNotify === 'telegram' ? 'Sending…' : 'Test Telegram'}
            </button>
            <button
              type="button"
              disabled={testingNotify !== null}
              onClick={() => void runNotifyTest('email')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm"
            >
              <Send size={14} />
              {testingNotify === 'email' ? 'Sending…' : 'Test Email'}
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-3">
            Backend auto-sends: schedule complete, YT agent errors, circuit breaker, high RAM, daily analytics (when Telegram/email configured).
          </p>
        </Section>

        {/* AI Brain */}
        <Section title="AI Brain (Claude Haiku)" icon={<Brain size={15} className="text-pink-400" />} note="Adds Claude-powered decisions to each profile — search query, read depth, next action. Without key, uses persona system.">
          <div>
            <label className="text-gray-400 text-xs block mb-1.5">Anthropic API Key</label>
            <input
              type="password"
              value={settings.anthropicApiKey || ''}
              onChange={(e) => update('anthropicApiKey', e.target.value)}
              placeholder="sk-ant-api03-..."
              className="w-full bg-gray-900 border border-gray-700 text-gray-200 rounded-xl px-3 py-2.5 text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-2">
              Get key: <span className="text-pink-400">console.anthropic.com → API Keys → Create key</span> · Cost: ~$0.25/million tokens · Max 25 calls/session per profile
            </p>
          </div>
          {settings.anthropicApiKey ? (
            <div className="mt-3 flex items-center gap-2 bg-pink-900/20 border border-pink-700/30 rounded-xl px-3 py-2">
              <Brain size={13} className="text-pink-400" />
              <span className="text-xs text-pink-300">AI Brain enabled — Claude Haiku will guide profile decisions</span>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
              <Brain size={13} className="text-gray-500" />
              <span className="text-xs text-gray-500">No key — using persona system (Researcher, Casual, Skimmer, etc.)</span>
            </div>
          )}
        </Section>

        {/* Window Resolution */}
        <Section title="Browser Window Resolution" icon={<Maximize2 size={15} className="text-indigo-400" />} note="Controls profile window size and fingerprint screen resolution — applied when windows auto-arrange">
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
              {([
                ['1280x720', '1280', '720'],
                ['1366x768', '1366', '768'],
                ['1440x900', '1440', '900'],
                ['1600x900', '1600', '900'],
                ['1920x1080', '1920', '1080'],
              ] as const).map(([label, w, h]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => { update('windowWidth', w); update('windowHeight', h); }}
                  className={`rounded-xl border px-3 py-2 text-sm transition-all ${
                    settings.windowWidth === w && settings.windowHeight === h
                      ? 'bg-indigo-900/30 border-indigo-500/50 text-indigo-300 font-semibold'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Width (px)" value={settings.windowWidth} onChange={(v) => update('windowWidth', v)} type="number" desc="Browser window / fingerprint screen width" />
              <Field label="Height (px)" value={settings.windowHeight} onChange={(v) => update('windowHeight', v)} type="number" desc="Browser window / fingerprint screen height" />
            </div>
            <p className="text-xs text-gray-500">Saved to <code className="text-gray-400">user-settings.json</code> — used by window arranger grid and new profile fingerprints. Android/mobile profiles keep their own viewport.</p>
          </div>
        </Section>

        {/* High RPM Cookie Warmup */}
        <Section title="High RPM/CPM Cookie Warmup" icon={<Cookie size={15} className="text-amber-400" />} note="Interest/cookie warmup for QA browsing behavior — OFF by default. When ON, each profile visits 3–5 random USA/UK finance sites before YouTube.">
          <div className="space-y-4">
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-white text-sm font-semibold">Enable cookie warmup</p>
                <p className="text-gray-500 text-xs mt-1">Profiles visit random USA/UK high RPM finance/loan/insurance sites before YouTube to simulate interest cookies. OFF = no external sites visited.</p>
              </div>
              <ToggleSwitch
                enabled={settingOn(settings.highRpmCookieWarmupEnabled)}
                onChange={(v) => update('highRpmCookieWarmupEnabled', v)}
              />
            </div>
            {settingOn(settings.highRpmCookieWarmupEnabled) && (
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Min sites per profile"
                  value={settings.warmupVisitCountMin}
                  onChange={(v) => update('warmupVisitCountMin', v)}
                  type="number"
                  desc="Min random sites visited"
                />
                <Field
                  label="Max sites per profile"
                  value={settings.warmupVisitCountMax}
                  onChange={(v) => update('warmupVisitCountMax', v)}
                  type="number"
                  desc="Max random sites visited"
                />
              </div>
            )}
            <div className="text-xs text-gray-600">
              Site categories: loans · mortgage · insurance · credit cards · investment · tax · banking · finance searches (USA/UK only)
            </div>
          </div>
        </Section>

        {/* Search Warmup */}
        <Section title="Search Warmup (Pre-video Related Searches)" icon={<Search size={15} className="text-teal-400" />} note="Before finding the exact video, perform 3–5 related YouTube searches — realistic QA browsing behavior. OFF by default.">
          <div className="space-y-4">
            <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-white text-sm font-semibold">Enable search warmup</p>
                <p className="text-gray-500 text-xs mt-1">When ON: before exact video search, agent does 3–5 related YouTube keyword searches (no video click). Each profile gets different keywords. When OFF: goes directly to exact title search.</p>
              </div>
              <ToggleSwitch
                enabled={settingOn(settings.searchWarmupEnabled)}
                onChange={(v) => update('searchWarmupEnabled', v)}
              />
            </div>
            {settingOn(settings.searchWarmupEnabled) && (
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label="Min search attempts"
                  value={settings.searchWarmupAttemptMin}
                  onChange={(v) => update('searchWarmupAttemptMin', v)}
                  type="number"
                  desc="Min related searches before exact video"
                />
                <Field
                  label="Max search attempts"
                  value={settings.searchWarmupAttemptMax}
                  onChange={(v) => update('searchWarmupAttemptMax', v)}
                  type="number"
                  desc="Max related searches before exact video"
                />
              </div>
            )}
            <p className="text-xs text-gray-500">After warmup searches, the agent still finds and verifies the exact video as normal. Direct URL fallback remains last resort only.</p>
          </div>
        </Section>

        {/* Real Cookie Pool */}
        <Section
          title="Cookie Pool (Anti-Bot)"
          icon={<LogIn size={15} className="text-green-400" />}
          note="Add multiple real cookie sets from different Chrome sessions. Each new profile gets a randomly assigned set — so no two profiles share the same cookies."
        >
          <div className="space-y-4">

            {/* Pool status */}
            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${cookiePool?.hasCookies ? 'bg-green-950/40 border-green-700/50' : 'bg-gray-800/60 border-gray-700'}`}>
              {cookiePool?.hasCookies
                ? <CheckCircle2 size={16} className="text-green-400 shrink-0" />
                : <XCircle size={16} className="text-gray-500 shrink-0" />}
              <div className="flex-1 min-w-0">
                {cookiePool?.hasCookies
                  ? <p className="text-sm text-green-300 font-medium">{cookiePool.poolSize} cookie set{cookiePool.poolSize !== 1 ? 's' : ''} in pool — profiles get randomly assigned one each</p>
                  : <p className="text-sm text-gray-400">Pool empty — add at least 1 set (3–5 recommended for variety)</p>}
              </div>
              {cookiePool?.hasCookies && (
                <button type="button"
                  className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-800/40 hover:border-red-600/60 shrink-0"
                  onClick={async () => {
                    await backendFetch('/api/cookies/clear', { method: 'DELETE', headers: getAuthHeaders() });
                    await refreshCookieStatus();
                    setCookieMsg({ ok: true, text: 'Pool cleared.' });
                    setTimeout(() => setCookieMsg(null), 3000);
                  }}>Clear All</button>
              )}
            </div>

            {/* Existing sets list */}
            {cookiePool && cookiePool.sets.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 font-medium">Sets in pool:</p>
                {cookiePool.sets.map(s => (
                  <div key={s.id} className="flex items-center gap-3 bg-gray-800/50 border border-gray-700/60 rounded-xl px-3 py-2">
                    <CheckCircle2 size={13} className="text-green-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white font-medium">{s.label}</p>
                      <p className="text-xs text-gray-500">
                        {s.count} cookies
                        {s.domains && s.domains.length > 0 ? ` · ${s.domains.join(', ')}` : ''}
                        {s.importedAt ? ` · ${new Date(s.importedAt).toLocaleDateString('en-IN')}` : ''}
                      </p>
                    </div>
                    <button type="button"
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-800/30 hover:border-red-600/50 shrink-0"
                      onClick={async () => {
                        await backendFetch(`/api/cookies/set/${s.id}`, { method: 'DELETE', headers: getAuthHeaders() });
                        await refreshCookieStatus();
                      }}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            {/* How to guide */}
            <div className="bg-gray-800/40 border border-gray-700/50 rounded-xl p-4 text-xs text-gray-400 space-y-1">
              <p className="text-gray-300 font-medium mb-2">How to add a set (do this 3–5 times from different Chrome profiles):</p>
              <p>1. Chrome → <span className="text-white">Cookie-Editor</span> extension (Chrome Web Store, free)</p>
              <p>2. Open a Chrome profile → visit <span className="text-white">youtube.com</span> → browse 5 min</p>
              <p>3. Cookie-Editor → <span className="text-white">Export → JSON</span> → copy</p>
              <p>4. Paste below, give it a name, click <span className="text-white">Add to Pool</span></p>
              <p>5. Repeat with a <span className="text-white">different Chrome profile</span> for more variety</p>
            </div>

            {/* Add new set form */}
            <div className="space-y-3 bg-gray-800/30 border border-gray-700/40 rounded-xl p-4">
              <p className="text-xs text-gray-400 font-medium">Add new cookie set to pool:</p>
              <input
                type="text"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-500 placeholder-gray-600"
                placeholder='Set name (e.g. "Chrome Profile 2" or "Team Member 1")'
                value={cookieLabel}
                onChange={e => setCookieLabel(e.target.value)}
              />
              <textarea
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-300 font-mono resize-none focus:outline-none focus:border-gray-500 placeholder-gray-600"
                rows={5}
                placeholder={'[\n  { "name": "CONSENT", "value": "YES+...", "domain": ".youtube.com", ... },\n  ...\n]'}
                value={cookieJson}
                onChange={e => setCookieJson(e.target.value)}
              />
              {cookieMsg && (
                <p className={`text-xs font-medium ${cookieMsg.ok ? 'text-green-400' : 'text-red-400'}`}>{cookieMsg.text}</p>
              )}
              <button
                type="button"
                disabled={cookieSaving || !cookieJson.trim()}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-700 hover:bg-green-600 disabled:opacity-40 text-white text-sm font-medium"
                onClick={async () => {
                  setCookieSaving(true);
                  setCookieMsg(null);
                  try {
                    const parsed = JSON.parse(cookieJson.trim());
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    const res = await backendFetch('/api/cookies/import', {
                      method: 'POST',
                      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
                      body: JSON.stringify({ cookies: arr, label: cookieLabel.trim() || undefined }),
                    });
                    const data = await res.json();
                    if (res.ok && data.success) {
                      setCookieMsg({ ok: true, text: `✅ ${data.count} cookies added! Pool now has ${data.poolSize} set${data.poolSize !== 1 ? 's' : ''}.` });
                      setCookieJson('');
                      setCookieLabel('');
                      await refreshCookieStatus();
                    } else {
                      setCookieMsg({ ok: false, text: data.error || 'Save failed' });
                    }
                  } catch (e: any) {
                    setCookieMsg({ ok: false, text: `Invalid JSON: ${(e as Error).message}` });
                  }
                  setCookieSaving(false);
                }}
              >
                <Save size={14} />
                {cookieSaving ? 'Adding…' : 'Add to Pool'}
              </button>
            </div>
          </div>
        </Section>

        {!isPackagedElectron() && <GitPushSection />}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  note,
  children,
}: {
  title: string;
  icon: ReactNode;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <h2 className="text-white font-semibold">{title}</h2>
      </div>
      {note
        ? <p className="text-gray-600 text-xs mb-4">{note}</p>
        : <div className="mb-4" />
      }
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  desc,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  desc?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="text-gray-400 text-xs block mb-1.5">{label}</label>
      {desc && <p className="text-gray-600 text-xs mb-1">{desc}</p>}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-gray-500 ${mono ? 'font-mono' : ''}`}
      />
    </div>
  );
}

function GitPushSection() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    backendFetch('/api/update/version')
      .then((r) => r.json())
      .then((d) => setVersion(d.version || '1.0.0'))
      .catch(() => setVersion('1.0.0'));
  }, []);

  const handlePush = async () => {
    if (!version.trim() || !changelog.trim()) return;
    setPushing(true);
    setResult(null);
    try {
      const res = await backendFetch('/api/update/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ version, changelog: changelog.split('\n').filter((l) => l.trim()) }),
      });
      const data = await res.json();
      setResult(data);
      if (data.success) setChangelog('');
    } catch (err) {
      setResult({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
    setPushing(false);
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-800/40 transition-colors"
      >
        <div>
          <h2 className="text-gray-400 font-medium text-sm">🛠 Developer Tools</h2>
          <p className="text-gray-600 text-xs mt-0.5">Push update to GitHub — version bump &amp; changelog</p>
        </div>
        <span className="text-gray-600 text-xs">{open ? '▲ Hide' : '▼ Show'}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-800">
          <div className="grid grid-cols-2 gap-4 mb-4 mt-4">
            <div>
              <label className="text-gray-400 text-xs block mb-1">Version</label>
              <input
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm font-mono text-gray-200"
              />
            </div>
          </div>
          <textarea
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
            rows={3}
            placeholder="Changelog lines…"
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 mb-3 resize-none"
          />
          <button
            type="button"
            onClick={handlePush}
            disabled={pushing || !version.trim() || !changelog.trim()}
            className="bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white px-4 py-2 rounded-xl text-sm font-semibold"
          >
            {pushing ? 'Pushing…' : 'Push to GitHub'}
          </button>
          {result && <p className={`text-xs mt-2 ${result.success ? 'text-green-400' : 'text-red-400'}`}>{result.message}</p>}
        </div>
      )}
    </div>
  );
}

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      aria-pressed={enabled}
      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${enabled ? 'bg-green-600' : 'bg-gray-700'}`}
    >
      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${enabled ? 'left-6' : 'left-1'}`} />
    </button>
  );
}
