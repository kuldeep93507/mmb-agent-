import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play, Square, RefreshCw, CheckCircle, AlertTriangle, XCircle,
  Clock, SkipForward, RotateCcw, Trash2, Upload, Plus, Minus,
  CheckSquare, Square as SquareIcon, Search,
} from 'lucide-react';
import type { Profile } from '../types';
import { backendFetch } from '../services/backendOrigin';
import { saveGmailData } from '../utils/gmailProfileStore';

interface CredentialRow {
  profileId: string;
  profileName: string;
  email: string;
  password: string;
  browserType: string;
}

type EntryStatus = 'pending' | 'running' | 'success' | 'needs_phone' | 'captcha' | 'wrong_password' | 'blocked' | 'error' | 'skipped' | 'waiting_resume';

interface StatusEntry {
  profileId: string;
  profileName: string;
  email: string;
  status: EntryStatus;
  message: string;
  startedAt: number | null;
  doneAt: number | null;
}

interface GmailStatus {
  running: boolean;
  stopped: boolean;
  batchSize: number;
  counts: { total: number; pending: number; running: number; success: number; failed: number; waiting: number };
  entries: StatusEntry[];
  logs: { time: string; level: string; message: string }[];
}

interface GmailSetupPageProps {
  profiles: Profile[];
}

const STATUS_CONFIG: Record<EntryStatus, { label: string; color: string; icon: React.ReactNode }> = {
  pending:        { label: 'Pending',           color: 'text-gray-400',   icon: <Clock size={13} /> },
  running:        { label: 'Running...',         color: 'text-blue-400',   icon: <RefreshCw size={13} className="animate-spin" /> },
  success:        { label: 'Done ✅',            color: 'text-green-400',  icon: <CheckCircle size={13} /> },
  needs_phone:    { label: '📱 Phone needed',    color: 'text-amber-400',  icon: <AlertTriangle size={13} /> },
  captcha:        { label: '🤖 CAPTCHA',         color: 'text-orange-400', icon: <AlertTriangle size={13} /> },
  wrong_password: { label: 'Wrong password',     color: 'text-red-400',    icon: <XCircle size={13} /> },
  blocked:        { label: 'Blocked by Google',  color: 'text-red-500',    icon: <XCircle size={13} /> },
  error:          { label: 'Error',              color: 'text-red-400',    icon: <XCircle size={13} /> },
  skipped:        { label: 'Skipped',            color: 'text-gray-500',   icon: <SkipForward size={13} /> },
  waiting_resume: { label: 'Waiting...',         color: 'text-purple-400', icon: <Clock size={13} /> },
};

export default function GmailSetupPage({ profiles }: GmailSetupPageProps) {
  // credentials: profileId -> { email, password }
  const [credentials, setCredentials] = useState<Record<string, { email: string; password: string }>>({});
  // which profileIds are selected (checked)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [profileSearch, setProfileSearch] = useState('');

  const [batchSize, setBatchSize] = useState(3);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [tab, setTab] = useState<'setup' | 'status'>('setup');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');

  // CSV import
  const [csvText, setCsvText] = useState('');
  const [importError, setImportError] = useState('');
  const [showCsvPanel, setShowCsvPanel] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Polling ────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const res = await backendFetch('/api/gmail-login/status');
      const data: GmailStatus = await res.json();
      setGmailStatus(data);
      // Auto-save every successful login into gmailProfileStore
      // so EngagementPage can immediately see these profiles
      if (data.entries) {
        data.entries
          .filter(e => e.status === 'success' && e.email)
          .forEach(e => saveGmailData(e.profileId, { isGmail: true, email: e.email }));
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  useEffect(() => {
    if (gmailStatus?.running) setTab('status');
  }, [gmailStatus?.running]);

  // ── Profile list helpers ───────────────────────────────────────────────
  const filteredProfiles = profiles.filter(p =>
    p.name.toLowerCase().includes(profileSearch.toLowerCase())
  );

  const toggleProfile = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // ensure credentials row exists
        setCredentials(c => c[id] ? c : { ...c, [id]: { email: '', password: '' } });
      }
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      filteredProfiles.forEach(p => {
        next.add(p.id);
        setCredentials(c => c[p.id] ? c : { ...c, [p.id]: { email: '', password: '' } });
      });
      return next;
    });
  };

  const deselectAllVisible = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      filteredProfiles.forEach(p => next.delete(p.id));
      return next;
    });
  };

  const updateCred = (profileId: string, field: 'email' | 'password', value: string) => {
    setCredentials(prev => ({
      ...prev,
      [profileId]: { ...prev[profileId], email: prev[profileId]?.email || '', password: prev[profileId]?.password || '', [field]: value },
    }));
  };

  // Build rows for selected profiles
  const selectedProfiles = profiles.filter(p => selectedIds.has(p.id));
  const readyRows: CredentialRow[] = selectedProfiles
    .filter(p => credentials[p.id]?.email && credentials[p.id]?.password)
    .map(p => ({
      profileId: p.id,
      profileName: p.name,
      email: credentials[p.id].email,
      password: credentials[p.id].password,
      browserType: p.browserType || 'multilogin',
    }));

  // ── CSV Import ─────────────────────────────────────────────────────────
  const handleImportCsv = () => {
    setImportError('');
    const lines = csvText.trim().split('\n').filter(l => l.trim());
    if (!lines.length) { setImportError('CSV empty hai'); return; }
    const firstLower = lines[0].toLowerCase();
    const hasHeader = firstLower.includes('email') || firstLower.includes('profile') || firstLower.includes('password');
    const dataLines = hasHeader ? lines.slice(1) : lines;
    const errors: string[] = [];
    let imported = 0;

    for (let i = 0; i < dataLines.length; i++) {
      const parts = dataLines[i].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      if (parts.length < 2) { errors.push(`Line ${i + 2}: columns kam hai`); continue; }

      let profileId = '', email = '', password = '';

      if (parts.length >= 3) {
        const nameOrId = parts[0];
        email = parts[1];
        password = parts[2];
        const matched = profiles.find(p => p.id === nameOrId || p.name.toLowerCase() === nameOrId.toLowerCase());
        profileId = matched?.id || '';
      } else {
        email = parts[0];
        password = parts[1];
        const matched = profiles.find(p => p.name.toLowerCase().includes(email.split('@')[0].toLowerCase()));
        profileId = matched?.id || '';
      }

      if (!email.includes('@')) { errors.push(`Line ${i + 2}: email invalid`); continue; }
      if (!password) { errors.push(`Line ${i + 2}: password missing`); continue; }

      if (profileId) {
        setSelectedIds(prev => new Set([...prev, profileId]));
        setCredentials(c => ({ ...c, [profileId]: { email, password } }));
        imported++;
      } else {
        errors.push(`Line ${i + 2}: profile match nahi mila for "${parts[0] || email}"`);
      }
    }

    if (errors.length) setImportError(errors.join(' | '));
    if (imported > 0 && !errors.length) { setCsvText(''); setShowCsvPanel(false); }
  };

  // ── API actions ────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (!readyRows.length) {
      setStartError('Pehle profiles select karo aur email + password bharo');
      return;
    }
    setStarting(true);
    setStartError('');
    try {
      const res = await backendFetch('/api/gmail-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: readyRows, batchSize }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Server error ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      if (data.ok) {
        setStartError('');
        setTab('status');
        void fetchStatus();
      } else {
        setStartError(data.error || 'Server ne start nahi kiya — error hai');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStartError(`Start failed: ${msg}`);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    await backendFetch('/api/gmail-login/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    void fetchStatus();
  };

  const handleMarkDone = async (profileId: string) => {
    await backendFetch(`/api/gmail-login/mark-done/${encodeURIComponent(profileId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    void fetchStatus();
  };

  const handleSkip = async (profileId: string) => {
    await backendFetch(`/api/gmail-login/skip/${encodeURIComponent(profileId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    void fetchStatus();
  };

  const handleRetry = async (profileId: string) => {
    await backendFetch(`/api/gmail-login/retry/${encodeURIComponent(profileId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    void fetchStatus();
  };

  const handleClear = async () => {
    if (!window.confirm('Clear all entries and logs?')) return;
    await backendFetch('/api/gmail-login/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setGmailStatus(null);
    void fetchStatus();
  };

  const counts = gmailStatus?.counts;
  const entries = gmailStatus?.entries || [];
  const isRunning = gmailStatus?.running || false;
  const needsAttention = entries.filter(e => e.status === 'needs_phone' || e.status === 'captcha');

  const allVisibleSelected = filteredProfiles.length > 0 && filteredProfiles.every(p => selectedIds.has(p.id));

  return (
    <div className="flex flex-col h-full">

      {/* ── Header ── */}
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">📧 Gmail Setup</h1>
            <p className="text-gray-500 text-sm mt-0.5">
              Profiles select karo → Email/Password bharo → Start karo
            </p>
            {!isRunning && readyRows.length === 0 && selectedIds.size === 0 && (
              <p className="text-amber-500 text-xs mt-1">
                ⚠ Left panel se profiles check karo, phir email + password bharo — tab Start button enable hoga
              </p>
            )}
            {!isRunning && selectedIds.size > 0 && readyRows.length === 0 && (
              <p className="text-amber-500 text-xs mt-1">
                ⚠ {selectedIds.size} profile(s) selected — abhi email + password bharo (right panel mein)
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isRunning ? (
              <button onClick={handleStop}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-700 hover:bg-red-600 text-white text-sm font-bold">
                <Square size={14} /> Stop
              </button>
            ) : (
              <button onClick={() => void handleStart()} disabled={starting}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-60 text-white text-sm font-bold">
                {starting
                  ? <><RefreshCw size={14} className="animate-spin" /> Starting…</>
                  : <><Play size={14} /> Start Login {readyRows.length > 0 && `(${readyRows.length})`}</>
                }
              </button>
            )}
            <button onClick={() => void fetchStatus()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs">
              <RefreshCw size={13} /> Refresh
            </button>
            {!isRunning && gmailStatus && entries.length > 0 && (
              <button onClick={handleClear}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs">
                <Trash2 size={13} /> Clear
              </button>
            )}
          </div>
        </div>

        {/* Stats */}
        {counts && counts.total > 0 && (
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <div className="text-xs text-gray-500">Total: <span className="text-white font-medium">{counts.total}</span></div>
            <div className="text-xs text-green-400">✅ Done: <span className="font-medium">{counts.success}</span></div>
            <div className="text-xs text-blue-400">⏳ Running: <span className="font-medium">{counts.running}</span></div>
            <div className="text-xs text-gray-400">📋 Pending: <span className="font-medium">{counts.pending}</span></div>
            <div className="text-xs text-amber-400">📱 Attention: <span className="font-medium">{counts.waiting}</span></div>
            <div className="text-xs text-red-400">❌ Failed: <span className="font-medium">{counts.failed}</span></div>
            {isRunning && <div className="text-xs text-blue-400 animate-pulse">● Processing...</div>}
          </div>
        )}

        {/* Start error */}
        {startError && (
          <div className="mt-3 p-3 bg-red-900/30 border border-red-600/40 rounded-xl text-red-300 text-sm flex items-center gap-2">
            <XCircle size={15} />
            <span>{startError}</span>
            <button onClick={() => setStartError('')} className="ml-auto text-red-500 hover:text-red-300">✕</button>
          </div>
        )}

        {/* Attention banner */}
        {needsAttention.length > 0 && (
          <div className="mt-3 p-3 bg-amber-900/30 border border-amber-600/40 rounded-xl text-amber-300 text-sm flex items-center gap-2">
            <AlertTriangle size={16} />
            <span><strong>{needsAttention.length} profile(s)</strong> ko manually verify karna hai — browser open hai, complete karo phir "Mark Done" karo</span>
          </div>
        )}
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b border-gray-800 px-6 bg-gray-950/30 flex-shrink-0">
        {(['setup', 'status'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            {t === 'setup'
              ? `⚙️ Setup (${selectedIds.size} selected)`
              : `📊 Live Status ${entries.length ? `(${entries.length})` : ''}`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">

        {/* ══════════════ SETUP TAB ══════════════ */}
        {tab === 'setup' && (
          <div className="flex-1 overflow-hidden flex gap-0">

            {/* LEFT: Profile Checklist */}
            <div className="w-72 flex-shrink-0 border-r border-gray-800 flex flex-col bg-gray-950">
              {/* Search + select all */}
              <div className="p-3 border-b border-gray-800 space-y-2">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                  <input
                    value={profileSearch}
                    onChange={e => setProfileSearch(e.target.value)}
                    placeholder="Profile search..."
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={allVisibleSelected ? deselectAllVisible : selectAllVisible}
                    className="flex-1 flex items-center gap-1.5 justify-center px-2 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs">
                    {allVisibleSelected
                      ? <><SquareIcon size={12} /> Deselect All</>
                      : <><CheckSquare size={12} /> Select All</>}
                  </button>
                  <span className="text-xs text-gray-600">{selectedIds.size}/{profiles.length}</span>
                </div>
              </div>

              {/* Profile list */}
              <div className="flex-1 overflow-y-auto">
                {filteredProfiles.length === 0 ? (
                  <p className="text-gray-600 text-xs text-center py-8">Koi profile nahi mila</p>
                ) : (
                  filteredProfiles.map(p => {
                    const checked = selectedIds.has(p.id);
                    const cred = credentials[p.id];
                    const hasCred = cred?.email && cred?.password;
                    return (
                      <button key={p.id} onClick={() => toggleProfile(p.id)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors border-b border-gray-800/50
                          ${checked ? 'bg-blue-900/20 hover:bg-blue-900/30' : 'hover:bg-gray-900'}`}>
                        <div className={`w-4 h-4 rounded flex-shrink-0 border flex items-center justify-center transition-colors
                          ${checked ? 'bg-blue-600 border-blue-500' : 'border-gray-600'}`}>
                          {checked && <CheckCircle size={10} className="text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-white text-xs font-medium truncate">{p.name}</div>
                          {checked && hasCred && (
                            <div className="text-green-500 text-[10px] truncate">{cred.email}</div>
                          )}
                          {checked && !hasCred && (
                            <div className="text-amber-500 text-[10px]">⚠ email/pass bharo</div>
                          )}
                        </div>
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          p.status === 'running' ? 'bg-green-500' : 'bg-gray-700'
                        }`} />
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* RIGHT: Credentials form for selected profiles */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">

              {/* Batch size + CSV + Start */}
              <div className="flex items-center gap-4 flex-wrap">
                {/* Batch size */}
                <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2">
                  <span className="text-gray-400 text-xs">Batch:</span>
                  <button onClick={() => setBatchSize(b => Math.max(1, b - 1))}
                    className="w-6 h-6 rounded bg-gray-800 hover:bg-gray-700 text-white flex items-center justify-center">
                    <Minus size={11} />
                  </button>
                  <span className="text-white font-bold text-sm w-6 text-center">{batchSize}</span>
                  <button onClick={() => setBatchSize(b => Math.min(10, b + 1))}
                    className="w-6 h-6 rounded bg-gray-800 hover:bg-gray-700 text-white flex items-center justify-center">
                    <Plus size={11} />
                  </button>
                  <span className="text-gray-600 text-xs ml-1">profiles parallel</span>
                </div>

                {/* CSV toggle */}
                <button onClick={() => setShowCsvPanel(p => !p)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs border border-gray-700">
                  <Upload size={12} /> Bulk CSV Import
                </button>

                {readyRows.length > 0 && !isRunning && (
                  <button onClick={() => void handleStart()} disabled={starting}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-60 text-white text-sm font-bold">
                    {starting
                      ? <><RefreshCw size={14} className="animate-spin" /> Starting…</>
                      : <><Play size={14} /> Start Login ({readyRows.length} ready, batch {batchSize})</>
                    }
                  </button>
                )}
              </div>

              {/* CSV Panel */}
              {showCsvPanel && (
                <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 space-y-3">
                  <h3 className="text-white font-medium text-sm flex items-center gap-2"><Upload size={14} /> CSV Bulk Import</h3>
                  <p className="text-gray-500 text-xs">
                    Format: <code className="bg-gray-800 px-1 rounded text-gray-300">ProfileName, email@gmail.com, password</code> — ek line per profile
                  </p>
                  <p className="text-gray-600 text-xs">
                    Profile name wahi hona chahiye jo Multilogin/MoreLogin mein hai. Header row optional hai.
                  </p>
                  <textarea
                    value={csvText}
                    onChange={e => setCsvText(e.target.value)}
                    placeholder={'Profile_01,user1@gmail.com,pass123\nProfile_02,user2@gmail.com,pass456\n...'}
                    className="w-full h-28 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-white text-xs font-mono resize-none focus:outline-none focus:border-blue-500"
                  />
                  {importError && <p className="text-red-400 text-xs">{importError}</p>}
                  <button onClick={handleImportCsv}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">
                    <Upload size={13} /> Parse & Import
                  </button>
                </div>
              )}

              {/* Credential rows for selected profiles */}
              {selectedIds.size === 0 ? (
                <div className="text-center py-16 text-gray-600">
                  <div className="text-4xl mb-3">👈</div>
                  <p className="text-base font-medium text-gray-500">Pehle left side se profiles select karo</p>
                  <p className="text-sm mt-1">Jitne profiles mein Gmail login karni ho unhe check karo</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-gray-300 text-sm font-medium">{selectedIds.size} profiles selected — email & password bharo</h3>
                    <span className="text-xs text-green-400">{readyRows.length} ready</span>
                  </div>

                  {/* Column headers */}
                  <div className="grid grid-cols-[1.5fr_2fr_2fr] gap-3 text-xs text-gray-600 px-3">
                    <span>Profile</span><span>Gmail Email</span><span>Password</span>
                  </div>

                  {selectedProfiles.map(p => {
                    const cred = credentials[p.id] || { email: '', password: '' };
                    const isReady = cred.email && cred.password;
                    return (
                      <div key={p.id}
                        className={`grid grid-cols-[1.5fr_2fr_2fr] gap-3 items-center bg-gray-900 border rounded-xl px-3 py-2.5 transition-colors
                          ${isReady ? 'border-green-700/40' : 'border-gray-700'}`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isReady ? 'bg-green-500' : 'bg-amber-500'}`} />
                          <span className="text-white text-xs font-medium truncate" title={p.name}>{p.name}</span>
                        </div>
                        <input
                          value={cred.email}
                          onChange={e => updateCred(p.id, 'email', e.target.value)}
                          placeholder="email@gmail.com"
                          type="email"
                          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500 w-full"
                        />
                        <input
                          value={cred.password}
                          onChange={e => updateCred(p.id, 'password', e.target.value)}
                          placeholder="password"
                          type="password"
                          className="bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500 w-full"
                        />
                      </div>
                    );
                  })}

                  {readyRows.length > 0 && (
                    <div className="pt-2 space-y-2">
                      <button onClick={() => void handleStart()} disabled={isRunning || starting}
                        className="flex items-center gap-2 px-6 py-3 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white font-bold">
                        {starting
                          ? <><RefreshCw size={16} className="animate-spin" /> Starting…</>
                          : <><Play size={16} /> Start Gmail Login ({readyRows.length} profiles, batch {batchSize})</>
                        }
                      </button>
                      {startError && (
                        <p className="text-red-400 text-xs flex items-center gap-1">
                          <XCircle size={12} /> {startError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════ STATUS TAB ══════════════ */}
        {tab === 'status' && (
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {entries.length === 0 ? (
              <div className="text-center py-16 text-gray-600">
                <p className="text-lg">Abhi koi entries nahi</p>
                <p className="text-sm mt-1">Setup tab mein profiles select karo aur Start karo</p>
              </div>
            ) : (
              <div className="bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-xs text-gray-500">
                      <th className="px-4 py-3 text-left">#</th>
                      <th className="px-4 py-3 text-left">Profile</th>
                      <th className="px-4 py-3 text-left">Email</th>
                      <th className="px-4 py-3 text-left">Status</th>
                      <th className="px-4 py-3 text-left">Message</th>
                      <th className="px-4 py-3 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, idx) => {
                      const cfg = STATUS_CONFIG[entry.status] || STATUS_CONFIG.pending;
                      const needsAction = entry.status === 'needs_phone' || entry.status === 'captcha';
                      return (
                        <tr key={entry.profileId}
                          className={`border-b border-gray-800/50 ${needsAction ? 'bg-amber-900/10' : ''}`}>
                          <td className="px-4 py-3 text-gray-600 text-xs">{idx + 1}</td>
                          <td className="px-4 py-3 text-white font-medium text-xs">{entry.profileName}</td>
                          <td className="px-4 py-3 text-gray-300 text-xs">{entry.email}</td>
                          <td className="px-4 py-3">
                            <span className={`flex items-center gap-1.5 text-xs font-medium ${cfg.color}`}>
                              {cfg.icon} {cfg.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-400 text-xs max-w-xs truncate" title={entry.message}>
                            {entry.message}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              {needsAction && (
                                <button onClick={() => void handleMarkDone(entry.profileId)}
                                  className="px-2 py-1 rounded text-xs bg-green-800/40 text-green-400 hover:bg-green-700/40 border border-green-700/30">
                                  Mark Done
                                </button>
                              )}
                              {(entry.status === 'error' || entry.status === 'wrong_password' || entry.status === 'blocked') && (
                                <button onClick={() => void handleRetry(entry.profileId)}
                                  className="px-2 py-1 rounded text-xs bg-blue-800/40 text-blue-400 hover:bg-blue-700/40 border border-blue-700/30 flex items-center gap-1">
                                  <RotateCcw size={11} /> Retry
                                </button>
                              )}
                              {entry.status !== 'success' && entry.status !== 'running' && entry.status !== 'skipped' && (
                                <button onClick={() => void handleSkip(entry.profileId)}
                                  className="px-2 py-1 rounded text-xs bg-gray-800 text-gray-500 hover:text-gray-300 flex items-center gap-1">
                                  <SkipForward size={11} /> Skip
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Logs */}
            {gmailStatus?.logs && gmailStatus.logs.length > 0 && (
              <div className="bg-gray-950 border border-gray-800 rounded-2xl p-4">
                <h3 className="text-gray-400 text-xs font-medium mb-2">Recent Logs</h3>
                <div className="space-y-0.5 max-h-48 overflow-y-auto">
                  {[...gmailStatus.logs].reverse().map((log, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs font-mono">
                      <span className="text-gray-600 flex-shrink-0">{log.time.slice(11, 19)}</span>
                      <span className={`flex-shrink-0 ${
                        log.level === 'error' ? 'text-red-400' :
                        log.level === 'success' ? 'text-green-400' :
                        log.level === 'warn' ? 'text-amber-400' : 'text-blue-400'
                      }`}>[{log.level}]</span>
                      <span className="text-gray-300">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
