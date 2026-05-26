import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Plus, Trash2, Play, Globe, Download, Upload, Search, Square, Pencil, AlertCircle } from 'lucide-react';
import type { Profile } from '../types';
import { backendFetch } from '../services/backendOrigin';
import { profileConfigsForSchedule } from '../utils/profileConfigsForSchedule';
import LiveProgressPanel from './LiveProgressPanel';
import { postActivityLog } from '../utils/logsApi';
import {
  type Backlink,
  type BacklinkSourceType,
  fetchBacklinksFromServer,
  syncBacklinksToServer,
  loadBacklinksLocal,
  loadManualAssignLocal,
  exportBacklinksJson,
  parseBacklinksImport,
  isValidUrl,
  pollBacklinkRunUntilDone,
  stopScheduleRun,
} from '../utils/backlinkApi';

const SOURCE_TYPES: { value: BacklinkSourceType; label: string; icon: string }[] = [
  { value: 'linkedin', label: 'LinkedIn', icon: '💼' },
  { value: 'quora', label: 'Quora', icon: '❓' },
  { value: 'reddit', label: 'Reddit', icon: '🟠' },
  { value: 'blog', label: 'Blog/Website', icon: '📝' },
  { value: 'twitter', label: 'Twitter/X', icon: '🐦' },
  { value: 'facebook', label: 'Facebook', icon: '📘' },
  { value: 'other', label: 'Other', icon: '🔗' },
];

const PROFILE_PAGE = 24;

function fisherYatesShuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}


interface BacklinkPoolPageProps {
  profiles: Profile[];
}

export default function BacklinkPoolPage({ profiles }: BacklinkPoolPageProps) {
  const [backlinks, setBacklinks] = useState<Backlink[]>(() => loadBacklinksLocal());
  const [manualAssign, setManualAssign] = useState<Record<string, string[]>>(() => loadManualAssignLocal());
  const [syncing, setSyncing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [newType, setNewType] = useState<BacklinkSourceType>('blog');
  const [newTarget, setNewTarget] = useState('');
  const [newYoutubeUrl, setNewYoutubeUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [activeScheduleId, setActiveScheduleId] = useState<string | null>(null);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const [assignMode, setAssignMode] = useState<'random' | 'manual'>('random');
  const [runError, setRunError] = useState('');
  const [profileSearch, setProfileSearch] = useState('');
  const [poolSearch, setPoolSearch] = useState('');
  const [profilePage, setProfilePage] = useState(0);
  const importRef = useRef<HTMLInputElement>(null);
  const pollStopRef = useRef<(() => void) | null>(null);

  const persist = useCallback(async (links: Backlink[], assign: Record<string, string[]>) => {
    setSyncing(true);
    await syncBacklinksToServer({ links, manualAssign: assign });
    setSyncing(false);
  }, []);

  useEffect(() => {
    (async () => {
      const remote = await fetchBacklinksFromServer();
      if (remote) {
        if (remote.links.length > 0) setBacklinks(remote.links);
        if (Object.keys(remote.manualAssign).length > 0) setManualAssign(remote.manualAssign);
      } else {
        await persist(backlinks, manualAssign);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      persist(backlinks, manualAssign);
    }, 800);
    return () => clearTimeout(t);
  }, [backlinks, manualAssign, persist]);

  const filteredProfiles = useMemo(() => {
    const q = profileSearch.trim().toLowerCase();
    const list = q ? profiles.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : profiles;
    return list;
  }, [profiles, profileSearch]);

  const profilePageCount = Math.max(1, Math.ceil(filteredProfiles.length / PROFILE_PAGE));
  const pagedProfiles = filteredProfiles.slice(
    profilePage * PROFILE_PAGE,
    (profilePage + 1) * PROFILE_PAGE,
  );

  const filteredPool = useMemo(() => {
    const q = poolSearch.trim().toLowerCase();
    if (!q) return backlinks;
    return backlinks.filter(
      (b) =>
        b.sourceUrl.toLowerCase().includes(q) ||
        b.targetVideoTitle.toLowerCase().includes(q) ||
        b.sourceType.includes(q),
    );
  }, [backlinks, poolSearch]);

  const resetForm = () => {
    setNewUrl('');
    setNewTarget('');
    setNewYoutubeUrl('');
    setNewType('blog');
    setEditId(null);
  };

  const saveBacklink = () => {
    const url = newUrl.trim();
    if (!url || !isValidUrl(url)) {
      setRunError('Valid http(s) source URL required');
      return;
    }
    if (newYoutubeUrl.trim() && !isValidUrl(newYoutubeUrl.trim())) {
      setRunError('YouTube URL must be valid http(s)');
      return;
    }
    setRunError('');
    const payload: Backlink = {
      id: editId || `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sourceUrl: url,
      sourceType: newType,
      targetVideoTitle: newTarget.trim(),
      targetYoutubeUrl: newYoutubeUrl.trim(),
      usedCount: editId ? backlinks.find((b) => b.id === editId)?.usedCount || 0 : 0,
      lastUsed: editId ? backlinks.find((b) => b.id === editId)?.lastUsed ?? null : null,
    };
    if (editId) {
      setBacklinks((prev) => prev.map((b) => (b.id === editId ? payload : b)));
    } else {
      setBacklinks((prev) => [...prev, payload]);
    }
    resetForm();
    setShowAdd(false);
  };

  const startEdit = (b: Backlink) => {
    setEditId(b.id);
    setNewUrl(b.sourceUrl);
    setNewType(b.sourceType);
    setNewTarget(b.targetVideoTitle);
    setNewYoutubeUrl(b.targetYoutubeUrl);
    setShowAdd(true);
  };

  const toggleManualAssign = (profileId: string, backlinkId: string) => {
    setManualAssign((prev) => {
      const current = prev[profileId] || [];
      const updated = current.includes(backlinkId)
        ? current.filter((x) => x !== backlinkId)
        : [...current, backlinkId];
      return { ...prev, [profileId]: updated };
    });
  };

  const handleRun = async () => {
    if (backlinks.length === 0 || selectedProfiles.length === 0) return;
    setRunning(true);
    setRunError('');

    try {
      const scheduleId = `backlink_${Date.now()}`;
      const scheduleData = {
        id: scheduleId,
        name: 'Backlink Traffic Run',
        selectedProfiles,
        selectedChannels: [],
        assignmentMode: 'per-profile',
        sameForAll: [],
        perProfile: selectedProfiles.map((profileId) => {
          let picked: Backlink[];
          if (assignMode === 'manual') {
            const assignedIds = manualAssign[profileId] || [];
            picked = backlinks.filter((b) => assignedIds.includes(b.id));
            if (picked.length === 0) picked = [backlinks[Math.floor(Math.random() * backlinks.length)]];
          } else {
            const count = Math.min(backlinks.length, Math.floor(Math.random() * 3) + 1);
            picked = fisherYatesShuffle(backlinks).slice(0, count);
          }
          return {
            profileId,
            channelSelections: [
              {
                channelId: 0,
                channelName: 'Backlink Traffic',
                videos: picked.map((b) => ({
                  mode: 'backlink' as const,
                  value: b.targetVideoTitle || 'YouTube Video',
                  title: b.targetVideoTitle,
                  url: b.targetYoutubeUrl,
                  targetYoutubeUrl: b.targetYoutubeUrl,
                  backlink: {
                    id: b.id,
                    sourceUrl: b.sourceUrl,
                    sourceType: b.sourceType,
                  },
                })),
              },
            ],
          };
        }),
        profileDelayMin: 5,
        profileDelayMax: 20,
        tabDelayMin: 3,
        tabDelayMax: 10,
        trafficType: 'backlink',
        profileConfigs: profileConfigsForSchedule(selectedProfiles, profiles),
      };

      const res = await backendFetch('/api/schedule/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: scheduleData }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `API error ${res.status}`);

      setActiveScheduleId(scheduleId);
      pollStopRef.current?.();
      pollStopRef.current = pollBacklinkRunUntilDone(selectedProfiles, async (stats) => {
        if (stats.running === 0 && stats.waiting === 0 && stats.total > 0) {
          const remote = await fetchBacklinksFromServer();
          if (remote?.links.length) setBacklinks(remote.links);
          setRunning(false);
          setActiveScheduleId(null);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void postActivityLog('error', `Backlink run failed: ${msg}`, { source: 'backlink' });
      setRunError(msg);
      setRunning(false);
    }
  };

  const handleStop = async () => {
    if (activeScheduleId) await stopScheduleRun(activeScheduleId);
    pollStopRef.current?.();
    setRunning(false);
    setActiveScheduleId(null);
    const remote = await fetchBacklinksFromServer();
    if (remote?.links.length) setBacklinks(remote.links);
  };

  const handleImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = parseBacklinksImport(String(reader.result));
        setBacklinks((prev) => {
          const ids = new Set(prev.map((b) => b.id));
          const merged = [...prev];
          for (const b of imported) {
            if (!ids.has(b.id)) merged.push(b);
          }
          return merged;
        });
        setRunError('');
      } catch (e) {
        setRunError(e instanceof Error ? e.message : 'Import failed');
      }
    };
    reader.readAsText(file);
  };

  const totalUsed = backlinks.reduce((sum, b) => sum + b.usedCount, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-bold text-white">Backlink Traffic</h1>
            <p className="text-gray-500 text-sm mt-0.5">
              External referral → YouTube (server-backed pool + real backlink agent path)
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { resetForm(); setShowAdd(true); }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold"
            >
              <Plus size={15} /> Add
            </button>
            <button
              type="button"
              onClick={() => exportBacklinksJson(backlinks)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 text-gray-300 text-sm"
            >
              <Download size={15} /> Export
            </button>
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 text-gray-300 text-sm"
            >
              <Upload size={15} /> Import
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
            {running ? (
              <button
                type="button"
                onClick={handleStop}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold"
              >
                <Square size={15} /> Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={handleRun}
                disabled={backlinks.length === 0 || selectedProfiles.length === 0}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-sm font-bold"
              >
                <Play size={15} /> Run ({selectedProfiles.length})
              </button>
            )}
          </div>
        </div>

        {syncing && <p className="text-xs text-yellow-400 mb-2">Syncing to server…</p>}
        {runError && (
          <div className="mb-4 bg-red-900/30 border border-red-700/50 rounded-lg px-3 py-2 flex items-center gap-2">
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            <span className="text-red-400 text-xs flex-1">{runError}</span>
            <button type="button" onClick={() => setRunError('')} className="text-red-400 text-xs">✕</button>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Pool size" value={backlinks.length} color="text-blue-400" border="border-blue-700/30 bg-blue-900/10" />
          <StatCard label="Times used" value={totalUsed} color="text-green-400" border="border-green-700/30 bg-green-900/10" />
          <StatCard label="Source types" value={[...new Set(backlinks.map((b) => b.sourceType))].length} color="text-purple-400" border="border-purple-700/30 bg-purple-900/10" />
          <StatCard label="Selected profiles" value={selectedProfiles.length} color="text-orange-400" border="border-orange-700/30 bg-orange-900/10" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <LiveProgressPanel />

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-white font-semibold text-sm">Profiles</h3>
            <div className="flex gap-2 items-center">
              <div className="relative">
                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  value={profileSearch}
                  onChange={(e) => { setProfileSearch(e.target.value); setProfilePage(0); }}
                  placeholder="Search…"
                  className="pl-7 pr-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded-lg text-white w-36"
                />
              </div>
              <button type="button" onClick={() => setSelectedProfiles(profiles.map((p) => p.id))} className="text-xs text-blue-400">All</button>
              <button type="button" onClick={() => setSelectedProfiles([])} className="text-xs text-gray-400">None</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {pagedProfiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() =>
                  setSelectedProfiles((prev) =>
                    prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                  )
                }
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium ${
                  selectedProfiles.includes(p.id)
                    ? 'border-blue-500 bg-blue-900/30 text-blue-300'
                    : 'border-gray-700 bg-gray-800 text-gray-400'
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
          {profilePageCount > 1 && (
            <div className="flex justify-center gap-2 mt-3">
              <button type="button" disabled={profilePage === 0} onClick={() => setProfilePage((p) => p - 1)} className="text-xs px-2 py-1 bg-gray-800 rounded disabled:opacity-40">Prev</button>
              <span className="text-xs text-gray-500 self-center">{profilePage + 1}/{profilePageCount}</span>
              <button type="button" disabled={profilePage >= profilePageCount - 1} onClick={() => setProfilePage((p) => p + 1)} className="text-xs px-2 py-1 bg-gray-800 rounded disabled:opacity-40">Next</button>
            </div>
          )}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
          <h3 className="text-white font-semibold text-sm mb-3">Assign mode</h3>
          <div className="flex gap-3 mb-4">
            <ModeBtn active={assignMode === 'random'} onClick={() => setAssignMode('random')} title="Random from pool" desc="1–3 random backlinks per profile" emoji="🎲" />
            <ModeBtn active={assignMode === 'manual'} onClick={() => setAssignMode('manual')} title="Manual per profile" desc="Pick links per profile" emoji="🎯" color="purple" />
          </div>
          {assignMode === 'manual' && selectedProfiles.length > 0 && backlinks.length > 0 && (
            <div className="space-y-3 max-h-60 overflow-y-auto">
              {selectedProfiles.map((pid) => {
                const profile = profiles.find((p) => p.id === pid);
                const assigned = manualAssign[pid] || [];
                return (
                  <div key={pid} className="bg-gray-800 rounded-xl p-3">
                    <p className="text-white text-xs font-medium mb-2">{profile?.name || pid}</p>
                    <div className="flex flex-wrap gap-1">
                      {backlinks.map((b) => {
                        const on = assigned.includes(b.id);
                        const info = SOURCE_TYPES.find((s) => s.value === b.sourceType);
                        return (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() => toggleManualAssign(pid, b.id)}
                            className={`px-2 py-1 rounded-lg text-xs ${on ? 'bg-purple-600 text-white' : 'bg-gray-700 text-gray-400'}`}
                          >
                            {info?.icon} {b.sourceUrl.replace(/https?:\/\//, '').slice(0, 22)}…
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-semibold text-sm">Backlink pool</h3>
            <input
              value={poolSearch}
              onChange={(e) => setPoolSearch(e.target.value)}
              placeholder="Filter pool…"
              className="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white w-40"
            />
          </div>
          {filteredPool.length === 0 ? (
            <div className="text-center py-12 text-gray-600">
              <Globe size={40} className="mx-auto mb-3 opacity-30" />
              <p>No backlinks. Add external pages that link to your YouTube videos.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredPool.map((b) => {
                const info = SOURCE_TYPES.find((s) => s.value === b.sourceType);
                return (
                  <div key={b.id} className="flex items-center gap-3 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
                    <span className="text-lg">{info?.icon || '🔗'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white text-sm font-medium truncate">{b.sourceUrl}</span>
                        <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded capitalize">{b.sourceType}</span>
                      </div>
                      {b.targetVideoTitle && <p className="text-xs text-gray-500 mt-0.5">→ {b.targetVideoTitle}</p>}
                      {b.targetYoutubeUrl && <p className="text-xs text-blue-500/80 truncate mt-0.5">{b.targetYoutubeUrl}</p>}
                    </div>
                    <div className="text-right flex-shrink-0 text-xs text-gray-500">
                      <div>Used: {b.usedCount}x</div>
                      {b.lastUsed && <div>{new Date(b.lastUsed).toLocaleDateString()}</div>}
                    </div>
                    <button type="button" onClick={() => startEdit(b)} className="text-gray-500 hover:text-blue-400"><Pencil size={14} /></button>
                    <button type="button" onClick={() => setBacklinks((prev) => prev.filter((x) => x.id !== b.id))} className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 text-xs text-gray-500 space-y-1">
          <p className="text-gray-300 font-medium">How it works</p>
          <p>1. Opens your external URL (LinkedIn, blog, etc.)</p>
          <p>2. Reads page like a human, finds YouTube link</p>
          <p>3. Clicks through → watches on YouTube</p>
          <p className="text-green-400">Analytics tracks traffic_backlink when referral path succeeds.</p>
        </div>
      </div>

      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl p-6">
            <h2 className="text-white font-bold text-lg mb-4">{editId ? 'Edit' : 'Add'} Backlink</h2>
            <div className="space-y-4">
              <Field label="Source URL (page with YouTube link)">
                <input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://linkedin.com/posts/…" className="field-input" />
              </Field>
              <Field label="Source type">
                <div className="grid grid-cols-4 gap-2">
                  {SOURCE_TYPES.map((s) => (
                    <button key={s.value} type="button" onClick={() => setNewType(s.value)} className={`p-2 rounded-lg border text-center ${newType === s.value ? 'border-blue-500 bg-blue-900/30' : 'border-gray-700 bg-gray-800'}`}>
                      <div className="text-lg">{s.icon}</div>
                      <div className="text-[10px] text-gray-400">{s.label}</div>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Target video title (for verify / fallback search)">
                <input value={newTarget} onChange={(e) => setNewTarget(e.target.value)} className="field-input" />
              </Field>
              <Field label="Target YouTube URL (recommended)">
                <input value={newYoutubeUrl} onChange={(e) => setNewYoutubeUrl(e.target.value)} placeholder="https://youtube.com/watch?v=…" className="field-input" />
              </Field>
            </div>
            <div className="flex gap-2 mt-6">
              <button type="button" onClick={() => { setShowAdd(false); resetForm(); }} className="flex-1 bg-gray-800 text-gray-300 py-2.5 rounded-xl text-sm">Cancel</button>
              <button type="button" onClick={saveBacklink} disabled={!newUrl.trim()} className="flex-1 bg-blue-600 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold">Save</button>
            </div>
          </div>
        </div>
      )}

      <style>{`.field-input{width:100%;background:#1f2937;border:1px solid #374151;color:#fff;border-radius:0.75rem;padding:0.625rem 0.75rem;font-size:0.875rem}`}</style>
    </div>
  );
}

function StatCard({ label, value, color, border }: { label: string; value: number; color: string; border: string }) {
  return (
    <div className={`border rounded-xl p-3 ${border}`}>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function ModeBtn({ active, onClick, title, desc, emoji, color }: { active: boolean; onClick: () => void; title: string; desc: string; emoji: string; color?: string }) {
  const border = color === 'purple' ? (active ? 'border-purple-500 bg-purple-900/20' : 'border-gray-700 bg-gray-800') : (active ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700 bg-gray-800');
  return (
    <button type="button" onClick={onClick} className={`flex-1 p-3 rounded-xl border-2 text-left ${border}`}>
      <span className="text-lg">{emoji}</span>
      <p className="text-xs font-medium text-gray-300 mt-1">{title}</p>
      <p className="text-xs text-gray-500">{desc}</p>
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1">{label}</label>
      {children}
    </div>
  );
}
