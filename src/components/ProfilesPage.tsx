import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Plus, CheckSquare, Square, Play, StopCircle, Search,
  RefreshCw, Trash2, RotateCcw, Download, ChevronLeft, ChevronRight, Clock, AlertTriangle, Zap,
  LayoutGrid, List, Settings, Globe,
} from 'lucide-react';
import type { Profile, OS } from '../types';
import type { ProviderSelection } from '../services/browserProviderApi';
import type { StandardProfile } from '../services/browserProviderApi';
import ProfileCard from './ProfileCard';
import NewProfileModal from './NewProfileModal';
import ProfileSettings from './ProfileSettings';
import { backendFetch } from '../services/backendOrigin';
import { listTrashProfiles, deleteTrashProfiles, emptyTrash } from '../utils/trashApi';
import {
  fetchSettingsFromServer,
  saveSettingsToServer,
  loadSettingsLocal,
} from '../utils/settingsApi';

type BrowserProvider = 'morelogin' | 'multilogin';

/* ─────────────────────────────────────────────────────────────────────────────
   COMPACT VIEW COMPONENT
───────────────────────────────────────────────────────────────────────────── */
function statusMeta(status: string) {
  switch (status) {
    case 'running':    return { color: '#16a34a', bg: '#dcfce7', label: 'Running'    };
    case 'watching':   return { color: '#16a34a', bg: '#dcfce7', label: 'Watching'   };
    case 'starting':   return { color: '#4f46e5', bg: '#eef2ff', label: 'Starting'   };
    case 'connecting': return { color: '#4f46e5', bg: '#eef2ff', label: 'Connecting' };
    case 'searching':  return { color: '#4f46e5', bg: '#eef2ff', label: 'Searching'  };
    case 'waiting':    return { color: '#d97706', bg: '#fef3c7', label: 'Queued'     };
    case 'error':      return { color: '#dc2626', bg: '#fee2e2', label: 'Error'      };
    case 'crashed':    return { color: '#dc2626', bg: '#fee2e2', label: 'Crashed'    };
    case 'recreating': return { color: '#7c3aed', bg: '#f3e8ff', label: 'Recreating' };
    default:           return { color: '#6b7280', bg: '#f3f4f6', label: status.charAt(0).toUpperCase() + status.slice(1) };
  }
}

function proxyMeta(proxy: { host?: string; expiresAt?: number }) {
  const now = Date.now();
  const exp = proxy.expiresAt || 0;
  if (!exp)                     return { color: '#6b7280', label: 'No proxy' };
  if (exp < now)                return { color: '#dc2626', label: 'Expired'  };
  if (exp < now + 7_200_000)    return { color: '#d97706', label: 'Expiring' };
  return                               { color: '#16a34a', label: 'OK'       };
}

interface CompactProfileListProps {
  profiles: import('../types').Profile[];
  recreatingIds: Set<string>;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onSettings: (id: string) => void;
  onDelete: (id: string) => void;
  onRecreate: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  allSelected: boolean;
}

function CompactProfileList({
  profiles, recreatingIds,
  onStart, onStop, onSettings, onDelete, onRecreate, onToggleSelect,
  onSelectAll, onDeselectAll, allSelected,
}: CompactProfileListProps) {
  const isLive = (s: string) => ['running','watching','starting','connecting','searching','waiting'].includes(s);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 12, color: 'var(--mmb-text)',
      }}>
        <thead>
          <tr style={{ background: 'var(--mmb-surface)', borderBottom: '2px solid var(--mmb-border)' }}>
            <th style={{ padding: '8px 10px', textAlign: 'center', width: 36 }}>
              <button
                type="button"
                onClick={allSelected ? onDeselectAll : onSelectAll}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--mmb-muted)', padding: 0 }}
              >
                {allSelected
                  ? <CheckSquare size={14} style={{ color: '#4f46e5' }} />
                  : <Square size={14} />}
              </button>
            </th>
            {['Name', 'Status', 'Provider', 'OS', 'IP', 'Proxy', 'Actions'].map(h => (
              <th key={h} style={{
                padding: '8px 10px', textAlign: 'left',
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '.06em', color: 'var(--mmb-muted)',
                whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profiles.map((p, i) => {
            const sm    = statusMeta(p.status);
            const pm    = proxyMeta(p.proxy);
            const live  = isLive(p.status);
            const isRec = recreatingIds.has(p.id) || p.status === 'recreating';
            const rowBg = p.selected
              ? 'rgba(79,70,229,.07)'
              : i % 2 === 0 ? 'var(--mmb-surface)' : 'var(--mmb-bg)';

            return (
              <tr key={p.id} style={{
                background: rowBg,
                borderBottom: '1px solid var(--mmb-border)',
                transition: 'background .1s',
              }}
              onMouseEnter={e => { if (!p.selected) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--mmb-surface2)'; }}
              onMouseLeave={e => { if (!p.selected) (e.currentTarget as HTMLTableRowElement).style.background = rowBg; }}
              >
                {/* Checkbox */}
                <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                  <button type="button" onClick={() => onToggleSelect(p.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--mmb-muted)' }}>
                    {p.selected
                      ? <CheckSquare size={14} style={{ color: '#4f46e5' }} />
                      : <Square size={14} />}
                  </button>
                </td>

                {/* Name */}
                <td style={{ padding: '6px 10px', maxWidth: 180, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {live && (
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: '#16a34a', flexShrink: 0,
                        boxShadow: '0 0 0 2px #dcfce7',
                        animation: 'mmb-pulse-dot 1.5s ease-out infinite',
                      }} />
                    )}
                    <span style={{
                      fontWeight: 600, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis',
                      maxWidth: 160, display: 'block',
                    }} title={p.name}>
                      {p.name}
                    </span>
                  </div>
                </td>

                {/* Status */}
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 8px', borderRadius: 99,
                    fontSize: 11, fontWeight: 600,
                    background: sm.bg, color: sm.color,
                  }}>
                    {isRec ? '↻ Recreating' : sm.label}
                  </span>
                </td>

                {/* Provider */}
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 99,
                    background: p.browserType === 'multilogin' ? 'rgba(124,58,237,.15)' : 'rgba(37,99,235,.15)',
                    color: p.browserType === 'multilogin' ? '#7c3aed' : '#2563eb',
                  }}>
                    {p.browserType === 'multilogin' ? '🟣 MLX' : '🔵 ML'}
                  </span>
                </td>

                {/* OS */}
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', color: 'var(--mmb-muted)', fontSize: 11 }}>
                  {p.os === 'Windows' ? '🪟' : p.os === 'macOS' ? '🍎' : p.os === 'Android' ? '🤖' : '❓'} {p.os}
                </td>

                {/* IP */}
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--mmb-muted)' }}>
                    {p.ip || '—'}
                  </span>
                </td>

                {/* Proxy */}
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 11, fontWeight: 600, color: pm.color,
                  }}>
                    <Globe size={11} /> {pm.label}
                  </span>
                </td>

                {/* Actions */}
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {live ? (
                      <button type="button" onClick={() => onStop(p.id)}
                        title="Stop"
                        style={actionBtnStyle('#dc2626', 'rgba(220,38,38,.12)')}>
                        ⏹
                      </button>
                    ) : (
                      <button type="button" onClick={() => onStart(p.id)}
                        title="Start"
                        style={actionBtnStyle('#16a34a', 'rgba(22,163,74,.12)')}>
                        ▶
                      </button>
                    )}
                    <button type="button" onClick={() => onRecreate(p.id)}
                      title="Recreate"
                      disabled={isRec}
                      style={actionBtnStyle('#4f46e5', 'rgba(79,70,229,.12)', isRec)}>
                      <RotateCcw size={11} />
                    </button>
                    <button type="button" onClick={() => onSettings(p.id)}
                      title="Settings"
                      style={actionBtnStyle('#6b7280', 'rgba(107,114,128,.12)')}>
                      <Settings size={11} />
                    </button>
                    <button type="button" onClick={() => onDelete(p.id)}
                      title="Delete"
                      style={actionBtnStyle('#dc2626', 'rgba(220,38,38,.1)')}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function actionBtnStyle(color: string, bg: string, disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 26, height: 26, borderRadius: 6,
    background: bg, color, border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? .45 : 1, fontSize: 11,
    transition: 'opacity .1s',
    flexShrink: 0,
  };
}

const PROVIDER_LABELS: Record<ProviderSelection, string> = {
  all: 'All Providers',
  morelogin: 'MoreLogin',
  multilogin: 'Multilogin',
};

type SortKey = 'name' | 'status' | 'proxyExpiry';

const PAGE_SIZE_GRID = 24;
const PAGE_SIZE_COMPACT = 50;
const TRASH_PAGE_SIZE = 20;

interface ProfilesPageProps {
  profiles: Profile[];
  browserProvider?: ProviderSelection;
  loading?: boolean;
  recreatingIds?: Set<string>;

  onCreateProfile: (os: OS, proxyType?: string, profileMode?: string, androidDevice?: string, resolution?: string, profileName?: string) => Promise<{ code: number; message?: string }>;
  onStartProfile: (id: string) => void;
  onStopProfile: (id: string) => void;
  onDeleteProfile: (id: string) => void;
  onRecreateProfile: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onStartSelected: () => void;
  onStopSelected: () => void;
  onRenewProxy: (id: string) => void;
  onRefreshProfiles: () => void;
  onDeleteSelected: () => void;
  onRecreateSelected: () => void;
  onExportConfigs: () => void;
}

export default function ProfilesPage({
  profiles, browserProvider, loading = false, recreatingIds = new Set(),
  onCreateProfile, onStartProfile, onStopProfile, onDeleteProfile,
  onRecreateProfile, onToggleSelect, onSelectAll, onDeselectAll,
  onStartSelected, onStopSelected, onRenewProxy,
  onRefreshProfiles, onDeleteSelected, onRecreateSelected, onExportConfigs,
}: ProfilesPageProps) {
  const [showNewModal, setShowNewModal] = useState(false);
  const [settingsProfileId, setSettingsProfileId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterOS, setFilterOS] = useState<'All' | OS>('All');
  const [filterStatus, setFilterStatus] = useState<string>('All');
  const [filterProvider, setFilterProvider] = useState<'All' | BrowserProvider>('All');
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [page, setPage] = useState(1);
  const [arrangeError, setArrangeError] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [viewMode, setViewMode] = useState<'active' | 'trash'>('active');
  const [trashProfiles, setTrashProfiles] = useState<StandardProfile[]>([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashSelected, setTrashSelected] = useState<Set<string>>(new Set());
  const [trashPage, setTrashPage] = useState(1);
  const [displayMode, setDisplayMode] = useState<'grid' | 'compact'>(() =>
    (localStorage.getItem('mmb_profiles_display') as 'grid' | 'compact') || 'grid'
  );
  const [autoEmptyTrash, setAutoEmptyTrash] = useState(false);
  const [autoEmptyHours, setAutoEmptyHours] = useState('6');
  const [autoEmptySaving, setAutoEmptySaving] = useState(false);
  const [autoEmptyMsg, setAutoEmptyMsg] = useState<string | null>(null);

  const showTrashTab = !browserProvider || browserProvider === 'multilogin' || browserProvider === 'all';

  const loadTrashSettings = useCallback(async () => {
    const remote = await fetchSettingsFromServer();
    const s = remote || loadSettingsLocal();
    setAutoEmptyTrash(s.multiloginAutoEmptyTrash === true || s.multiloginAutoEmptyTrash === 'true');
    setAutoEmptyHours(s.multiloginAutoEmptyTrashHours || '6');
  }, []);

  useEffect(() => {
    if (showTrashTab) loadTrashSettings();
  }, [showTrashTab, loadTrashSettings]);

  const saveAutoEmptyTrash = async (enabled: boolean, hours = autoEmptyHours) => {
    setAutoEmptySaving(true);
    setAutoEmptyMsg(null);
    try {
      const base = (await fetchSettingsFromServer()) || loadSettingsLocal();
      const res = await saveSettingsToServer({
        ...base,
        multiloginAutoEmptyTrash: enabled,
        multiloginAutoEmptyTrashHours: hours,
      });
      if (res.success) {
        setAutoEmptyTrash(enabled);
        setAutoEmptyHours(hours);
        setAutoEmptyMsg(
          enabled
            ? `Auto empty trash ON — har ${hours}h trash clean hoga`
            : 'Auto empty trash OFF',
        );
      } else {
        setAutoEmptyMsg(res.error || 'Save failed');
      }
    } catch (err) {
      setAutoEmptyMsg(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setAutoEmptySaving(false);
    }
  };

  const handleToggleAutoEmptyTrash = () => {
    saveAutoEmptyTrash(!autoEmptyTrash);
  };

  const handleAutoEmptyHoursBlur = () => {
    const h = autoEmptyHours.trim() || '6';
    if (h !== autoEmptyHours) setAutoEmptyHours(h);
    if (autoEmptyTrash) saveAutoEmptyTrash(true, h);
  };

  const loadTrash = useCallback(async (page = 1) => {
    setTrashLoading(true);
    setTrashError(null);
    try {
      const res = await listTrashProfiles(page, TRASH_PAGE_SIZE);
      if (res.code === 0 && res.data) {
        setTrashProfiles(res.data.profiles || []);
        setTrashTotal(res.data.total || 0);
        setTrashPage(res.data.current || page);
        setTrashSelected(new Set());
      } else {
        setTrashError(res.message || 'Failed to load trash');
        setTrashProfiles([]);
        setTrashTotal(0);
      }
    } catch (err) {
      setTrashError(err instanceof Error ? err.message : 'Failed to load trash');
    } finally {
      setTrashLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode === 'trash' && showTrashTab) {
      loadTrash(trashPage);
    }
  }, [viewMode, showTrashTab, trashPage, loadTrash]);

  useEffect(() => {
    if (showTrashTab) {
      listTrashProfiles(1, 1).then((res) => {
        if (res.code === 0 && res.data) setTrashTotal(res.data.total || 0);
      }).catch(() => {});
    }
  }, [showTrashTab, viewMode]);

  const selectedCount = profiles.filter(p => p.selected).length;
  const runningCount = profiles.filter(p => p.status === 'running').length;
  const settingsProfile = settingsProfileId ? profiles.find(p => p.id === settingsProfileId) || null : null;

  const providerCounts = profiles.reduce<Record<string, number>>((acc, p) => {
    const key = p.browserType || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const filtered = useMemo(() => {
    let list = profiles.filter(p => {
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.ip?.includes(search)) return false;
      if (filterOS !== 'All' && p.os !== filterOS) return false;
      if (filterStatus !== 'All' && p.status !== filterStatus) return false;
      if (filterProvider !== 'All' && p.browserType !== filterProvider) return false;
      return true;
    });

    list = [...list].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'status') return a.status.localeCompare(b.status);
      const ae = a.proxy.expiresAt || 0;
      const be = b.proxy.expiresAt || 0;
      return ae - be;
    });
    return list;
  }, [profiles, search, filterOS, filterStatus, filterProvider, sortBy]);

  const PAGE_SIZE = displayMode === 'compact' ? PAGE_SIZE_COMPACT : PAGE_SIZE_GRID;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const handleArrangeWindows = async () => {
    const runningIds = profiles.filter(p => p.status === 'running').map(p => p.id);
    if (runningIds.length === 0) {
      setArrangeError('No running profiles — start profiles first, then arrange windows.');
      return;
    }
    setArrangeError(null);
    try {
      const res = await backendFetch('/api/manual/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds: runningIds, command: 'arrangeWindows' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setArrangeError(data.message || data.error || `Server error ${res.status}`);
        return;
      }
      if (data.success === false) {
        setArrangeError(data.message || 'Arrange windows failed');
      }
    } catch (err) {
      setArrangeError(err instanceof Error ? err.message : 'Network error — is backend running?');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedCount === 0) return;
    if (!window.confirm(`Delete ${selectedCount} selected profile(s)? This cannot be undone.`)) return;
    setBulkBusy(true);
    await onDeleteSelected();
    setBulkBusy(false);
  };

  const handleBulkRecreate = async () => {
    if (selectedCount === 0) return;
    if (!window.confirm(`Recreate ${selectedCount} profile(s)? Old profiles will be replaced (new proxy + fingerprint).`)) return;
    setBulkBusy(true);
    await onRecreateSelected();
    setBulkBusy(false);
  };

  const handleEmptyTrash = async () => {
    if (!window.confirm('Permanently delete ALL profiles in Multilogin trash? This frees subscription quota and cannot be undone.')) return;
    setBulkBusy(true);
    setTrashError(null);
    const res = await emptyTrash();
    setBulkBusy(false);
    if (res.code === 0) {
      await loadTrash(1);
    } else {
      setTrashError(res.message || 'Empty trash failed');
    }
  };

  const handleTrashDeleteSelected = async () => {
    const ids = [...trashSelected];
    if (!ids.length) return;
    if (!window.confirm(`Permanently delete ${ids.length} profile(s) from trash?`)) return;
    setBulkBusy(true);
    const res = await deleteTrashProfiles(ids);
    setBulkBusy(false);
    if (res.code === 0) {
      await loadTrash(trashPage);
    } else {
      setTrashError(res.message || 'Delete failed');
    }
  };

  const handleTrashDeleteOne = async (id: string, name: string) => {
    if (!window.confirm(`Permanently delete "${name}" from trash?`)) return;
    setBulkBusy(true);
    const res = await deleteTrashProfiles([id]);
    setBulkBusy(false);
    if (res.code === 0) {
      await loadTrash(trashPage);
    } else {
      setTrashError(res.message || 'Delete failed');
    }
  };

  const trashTotalPages = Math.max(1, Math.ceil(trashTotal / TRASH_PAGE_SIZE));
  const safeTrashPage = Math.min(trashPage, trashTotalPages);
  const trashSelectedCount = trashSelected.size;

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-gray-800 bg-gray-950/50 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-white">Profiles</h1>
              {showTrashTab && (
                <div className="flex items-center gap-1 ml-2 bg-gray-900 border border-gray-700 rounded-xl p-0.5">
                  <button
                    type="button"
                    onClick={() => setViewMode('active')}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
                      viewMode === 'active' ? 'bg-red-600/30 text-red-300' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    Active
                  </button>
                  <button
                    type="button"
                    onClick={() => { setViewMode('trash'); setTrashPage(1); }}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1 ${
                      viewMode === 'trash' ? 'bg-orange-600/30 text-orange-300' : 'text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    <Trash2 size={11} /> Trash
                    {trashTotal > 0 && viewMode !== 'trash' && (
                      <span className="bg-orange-600/40 text-orange-200 px-1.5 rounded-full text-[10px]">{trashTotal}</span>
                    )}
                  </button>
                </div>
              )}
              {browserProvider && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-600/20 border border-blue-500/30 text-blue-400">
                  {PROVIDER_LABELS[browserProvider]}
                </span>
              )}
              {loading && (
                <span className="text-xs text-yellow-400 animate-pulse">Refreshing…</span>
              )}
            </div>
            <p className="text-gray-500 text-sm mt-0.5">
              {viewMode === 'trash'
                ? `${trashTotal} in Multilogin trash • ${trashSelectedCount} selected`
                : `${profiles.length} total • ${runningCount} running • ${selectedCount} selected`}
            </p>
            {Object.keys(providerCounts).length > 1 && (
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {providerCounts.morelogin !== undefined && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-900/40 border border-blue-700/30 text-blue-400">
                    🔵 MoreLogin: {providerCounts.morelogin}
                  </span>
                )}
                {providerCounts.multilogin !== undefined && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-900/40 border border-purple-700/30 text-purple-400">
                    🟣 Multilogin: {providerCounts.multilogin}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {viewMode === 'trash' ? (
              <>
                <button
                  type="button"
                  onClick={() => loadTrash(trashPage)}
                  disabled={trashLoading || bulkBusy}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 hover:text-white text-sm disabled:opacity-50"
                >
                  <RefreshCw size={15} className={trashLoading ? 'animate-spin' : ''} />
                  Refresh trash
                </button>
                <button
                  type="button"
                  onClick={handleTrashDeleteSelected}
                  disabled={trashSelectedCount === 0 || bulkBusy}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-900/30 border border-red-700/40 text-red-400 text-sm disabled:opacity-40"
                >
                  <Trash2 size={14} /> Delete selected ({trashSelectedCount})
                </button>
                <button
                  type="button"
                  onClick={handleToggleAutoEmptyTrash}
                  disabled={autoEmptySaving}
                  title="Background me trash auto clean — server har X hours me empty karega"
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-semibold disabled:opacity-50 transition-all ${
                    autoEmptyTrash
                      ? 'bg-green-900/40 border-green-600/50 text-green-300'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Zap size={14} className={autoEmptyTrash ? 'text-green-400' : ''} />
                  Auto Empty Trash: {autoEmptyTrash ? 'ON' : 'OFF'}
                </button>
                <div className="flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-xl px-2 py-1.5">
                  <Clock size={13} className="text-gray-500" />
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={autoEmptyHours}
                    onChange={(e) => setAutoEmptyHours(e.target.value)}
                    onBlur={handleAutoEmptyHoursBlur}
                    disabled={autoEmptySaving}
                    title="Auto empty interval (hours)"
                    className="w-12 bg-transparent text-gray-200 text-xs text-center focus:outline-none"
                  />
                  <span className="text-gray-500 text-xs">h</span>
                </div>
                <button
                  type="button"
                  onClick={handleEmptyTrash}
                  disabled={trashTotal === 0 || bulkBusy}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-semibold disabled:opacity-40"
                >
                  <AlertTriangle size={14} /> Empty trash now
                </button>
              </>
            ) : (
              <>
            <button
              type="button"
              onClick={onRefreshProfiles}
              disabled={loading}
              title="Reload profiles from MoreLogin / Multilogin"
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 hover:text-white text-sm disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              type="button"
              onClick={onExportConfigs}
              title="Backup profile automation settings (localStorage)"
              className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-800 border border-gray-700 text-gray-300 hover:text-white text-sm"
            >
              <Download size={15} />
              Export configs
            </button>
            <button
              type="button"
              onClick={handleArrangeWindows}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600/20 border border-purple-600/30 text-purple-400 hover:bg-purple-600/30 transition-all text-sm font-medium"
            >
              ⊞ Arrange Windows
            </button>
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-all text-sm font-semibold shadow-lg shadow-red-900/30"
            >
              <Plus size={15} />
              New Profile
            </button>
              </>
            )}
          </div>
        </div>

        {viewMode === 'active' && (
        <>
        {arrangeError && (
          <div className="mb-3 rounded-xl border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-300 flex justify-between gap-2">
            <span>{arrangeError}</span>
            <button type="button" onClick={() => setArrangeError(null)} className="text-red-400 hover:text-red-200">✕</button>
          </div>
        )}

        <div className="mb-3 rounded-xl border border-blue-800/30 bg-blue-950/20 px-3 py-2 text-[11px] text-blue-200/80 leading-relaxed">
          Profile settings (watch time, likes, traffic) are stored in this browser&apos;s localStorage.
          Use <strong className="text-blue-300">Export configs</strong> to backup — clearing browser data will remove them.
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={onSelectAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 text-xs font-medium">
            <CheckSquare size={13} /> Select All
          </button>
          <button type="button" onClick={onDeselectAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200 text-xs font-medium">
            <Square size={13} /> Deselect
          </button>
          <button type="button" onClick={onStartSelected} disabled={selectedCount === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-900/30 border border-green-700/40 text-green-400 disabled:opacity-40 text-xs font-medium">
            <Play size={13} /> Start ({selectedCount})
          </button>
          <button type="button" onClick={onStopSelected} disabled={selectedCount === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-900/30 border border-red-700/40 text-red-400 disabled:opacity-40 text-xs font-medium">
            <StopCircle size={13} /> Stop ({selectedCount})
          </button>
          <button type="button" onClick={handleBulkRecreate} disabled={selectedCount === 0 || bulkBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-900/30 border border-blue-700/40 text-blue-400 disabled:opacity-40 text-xs font-medium">
            <RotateCcw size={13} className={bulkBusy ? 'animate-spin' : ''} /> Recreate selected
          </button>
          <button type="button" onClick={handleBulkDelete} disabled={selectedCount === 0 || bulkBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-900/20 border border-red-800/40 text-red-500 disabled:opacity-40 text-xs font-medium">
            <Trash2 size={13} /> Delete selected
          </button>

          <div className="w-px h-5 bg-gray-700 mx-1" />

          {(['All', 'Windows', 'Android', 'macOS', 'Unknown'] as const).map(os => (
            <button key={os} type="button" onClick={() => { setFilterOS(os); setPage(1); }}
              className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all
                ${filterOS === os ? 'bg-red-600/20 border-red-500/40 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
              {os}
            </button>
          ))}

          <div className="w-px h-5 bg-gray-700 mx-1" />

          {(['All', 'running', 'stopped', 'starting', 'error', 'recreating'] as const).map(s => (
            <button key={s} type="button" onClick={() => { setFilterStatus(s); setPage(1); }}
              className={`px-3 py-1.5 rounded-xl border text-xs font-medium capitalize transition-all
                ${filterStatus === s ? 'bg-blue-600/20 border-blue-500/40 text-blue-400' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
              {s}
            </button>
          ))}

          {Object.keys(providerCounts).length > 1 && (
            <>
              <div className="w-px h-5 bg-gray-700 mx-1" />
              {(['All', 'morelogin', 'multilogin'] as const).map(p => (
                <button key={p} type="button" onClick={() => { setFilterProvider(p); setPage(1); }}
                  className={`px-3 py-1.5 rounded-xl border text-xs font-medium transition-all
                    ${filterProvider === p ? 'bg-cyan-600/20 border-cyan-500/40 text-cyan-400' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
                  {p === 'All' ? 'All Providers' : PROVIDER_LABELS[p]}
                </button>
              ))}
            </>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-xs min-w-[200px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              type="text"
              placeholder="Search profiles by name or IP..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="w-full bg-gray-800 border border-gray-700 text-gray-200 rounded-xl pl-9 pr-3 py-2 text-xs focus:outline-none focus:border-gray-500"
            />
          </div>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as SortKey)}
            className="bg-gray-800 border border-gray-700 text-gray-300 rounded-xl px-3 py-2 text-xs"
          >
            <option value="name">Sort: Name</option>
            <option value="status">Sort: Status</option>
            <option value="proxyExpiry">Sort: Proxy expiry</option>
          </select>
          <span className="text-gray-600 text-xs">
            {filtered.length} shown • page {safePage}/{totalPages}
          </span>

          {/* View mode toggle */}
          <div className="flex items-center gap-0.5 bg-gray-800 border border-gray-700 rounded-xl p-0.5 ml-auto">
            <button
              type="button"
              title="Grid View"
              onClick={() => { setDisplayMode('grid'); localStorage.setItem('mmb_profiles_display','grid'); setPage(1); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                displayMode === 'grid'
                  ? 'bg-indigo-600/30 text-indigo-300'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <LayoutGrid size={13} /> Grid
            </button>
            <button
              type="button"
              title="Compact List View"
              onClick={() => { setDisplayMode('compact'); localStorage.setItem('mmb_profiles_display','compact'); setPage(1); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                displayMode === 'compact'
                  ? 'bg-indigo-600/30 text-indigo-300'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <List size={13} /> Compact
            </button>
          </div>
        </div>
        </>
        )}

        {viewMode === 'trash' && (
          <div className="mb-3 rounded-xl border border-orange-800/40 bg-orange-950/20 px-3 py-2 text-[11px] text-orange-200/90 leading-relaxed">
            Multilogin trash profiles still count toward your subscription limit.
            Use <strong className="text-orange-100">Empty trash now</strong> (manual) or turn on{' '}
            <strong className="text-orange-100">Auto Empty Trash</strong> (har {autoEmptyHours}h background clean).
            {' '}Full purge-on-delete &amp; schedule settings → <strong className="text-orange-100">Settings → Multilogin Trash</strong>.
          </div>
        )}

        {autoEmptyMsg && viewMode === 'trash' && (
          <div className="mb-3 rounded-xl border border-green-700/40 bg-green-950/20 px-3 py-2 text-xs text-green-300">
            {autoEmptyMsg}
          </div>
        )}

        {trashError && viewMode === 'trash' && (
          <div className="mb-3 rounded-xl border border-red-700/40 bg-red-900/20 px-3 py-2 text-xs text-red-300 flex justify-between gap-2">
            <span>{trashError}</span>
            <button type="button" onClick={() => setTrashError(null)} className="text-red-400 hover:text-red-200">✕</button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {viewMode === 'trash' ? (
          trashLoading && trashProfiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-gray-500 text-sm">
              <RefreshCw size={24} className="animate-spin mb-3" /> Loading trash…
            </div>
          ) : trashProfiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64">
              <Trash2 size={48} className="text-gray-600 mb-4" />
              <h3 className="text-gray-400 font-semibold text-lg">Trash is empty</h3>
              <p className="text-gray-600 text-sm mt-1">No removed Multilogin profiles in this folder.</p>
            </div>
          ) : (
            <div className="space-y-2 max-w-3xl">
              <div className="flex items-center gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => {
                    if (trashSelected.size === trashProfiles.length) {
                      setTrashSelected(new Set());
                    } else {
                      setTrashSelected(new Set(trashProfiles.map(p => p.id)));
                    }
                  }}
                  className="text-xs px-3 py-1.5 rounded-xl bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200"
                >
                  {trashSelected.size === trashProfiles.length ? 'Deselect all' : 'Select all on page'}
                </button>
              </div>
              {trashProfiles.map(p => {
                const selected = trashSelected.has(p.id);
                return (
                  <div
                    key={p.id}
                    className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                      selected ? 'bg-orange-950/30 border-orange-700/40' : 'bg-gray-900/50 border-gray-800'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setTrashSelected(prev => {
                          const next = new Set(prev);
                          if (next.has(p.id)) next.delete(p.id);
                          else next.add(p.id);
                          return next;
                        });
                      }}
                      className="text-gray-400 hover:text-white"
                    >
                      {selected ? <CheckSquare size={16} className="text-orange-400" /> : <Square size={16} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="text-white text-sm font-medium truncate">{p.name || 'Unnamed profile'}</div>
                      <div className="text-gray-500 text-xs font-mono truncate">{p.id}</div>
                    </div>
                    <button
                      type="button"
                      disabled={bulkBusy}
                      onClick={() => handleTrashDeleteOne(p.id, p.name || p.id)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-900/30 border border-red-700/40 text-red-400 text-xs hover:bg-red-900/50 disabled:opacity-40"
                    >
                      <Trash2 size={12} /> Delete forever
                    </button>
                  </div>
                );
              })}
            </div>
          )
        ) : pageItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <div className="text-6xl mb-4">🤖</div>
            <h3 className="text-gray-400 font-semibold text-lg mb-2">
              {profiles.length === 0 ? 'No Profiles Yet' : 'No profiles match filters'}
            </h3>
            {profiles.length === 0 && (
              <button type="button" onClick={() => setShowNewModal(true)}
                className="mt-4 flex items-center gap-2 px-6 py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold">
                <Plus size={16} /> Create First Profile
              </button>
            )}
          </div>
        ) : displayMode === 'compact' ? (
          <CompactProfileList
            profiles={pageItems}
            recreatingIds={recreatingIds}
            onStart={onStartProfile}
            onStop={onStopProfile}
            onSettings={id => setSettingsProfileId(id)}
            onDelete={onDeleteProfile}
            onRecreate={onRecreateProfile}
            onToggleSelect={onToggleSelect}
            onSelectAll={onSelectAll}
            onDeselectAll={onDeselectAll}
            allSelected={pageItems.length > 0 && pageItems.every(p => p.selected)}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {pageItems.map(profile => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                isRecreating={recreatingIds.has(profile.id) || profile.status === 'recreating'}
                onStart={onStartProfile}
                onStop={onStopProfile}
                onSettings={id => setSettingsProfileId(id)}
                onDelete={onDeleteProfile}
                onRecreate={onRecreateProfile}
                onToggleSelect={onToggleSelect}
              />
            ))}
          </div>
        )}
      </div>

      {viewMode === 'active' && filtered.length > (displayMode === 'compact' ? PAGE_SIZE_COMPACT : PAGE_SIZE_GRID) && (
        <div className="flex-shrink-0 px-6 py-3 border-t border-gray-800 flex items-center justify-center gap-4">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 disabled:opacity-40 text-xs"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="text-gray-500 text-xs">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 disabled:opacity-40 text-xs"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}

      {viewMode === 'trash' && trashTotal > TRASH_PAGE_SIZE && (
        <div className="flex-shrink-0 px-6 py-3 border-t border-gray-800 flex items-center justify-center gap-4">
          <button
            type="button"
            disabled={safeTrashPage <= 1}
            onClick={() => setTrashPage(p => Math.max(1, p - 1))}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 disabled:opacity-40 text-xs"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="text-gray-500 text-xs">
            Page {safeTrashPage}/{trashTotalPages} • {trashTotal} in trash ({TRASH_PAGE_SIZE} per page)
          </span>
          <button
            type="button"
            disabled={safeTrashPage >= trashTotalPages}
            onClick={() => setTrashPage(p => Math.min(trashTotalPages, p + 1))}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-400 disabled:opacity-40 text-xs"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}

      {showNewModal && (
        <NewProfileModal
          onClose={() => setShowNewModal(false)}
          onCreate={onCreateProfile}
          activeProvider={browserProvider === 'morelogin' ? 'morelogin' : browserProvider === 'multilogin' ? 'multilogin' : 'all'}
        />
      )}
      {settingsProfile && (
        <ProfileSettings
          profile={settingsProfile}
          onClose={() => setSettingsProfileId(null)}
          onRenewProxy={id => { onRenewProxy(id); }}
        />
      )}
    </div>
  );
}
