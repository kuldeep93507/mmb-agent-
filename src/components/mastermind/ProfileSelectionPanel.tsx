import { useMemo, useState } from 'react';
import { Users, Search, CheckSquare, Square, AlertTriangle } from 'lucide-react';
import type { Profile } from '../../types';

interface Props {
  profiles: Profile[];
  /** null = sab selected (default — naye profiles bhi auto-include hote hain) */
  selectedIds: string[] | null;
  onChange: (ids: string[] | null) => void;
}

const STATUS_DOT: Record<string, string> = {
  running: 'bg-emerald-400',
  starting: 'bg-blue-400',
  error: 'bg-red-500',
  recreating: 'bg-amber-400',
  stopped: 'bg-gray-600',
};

export default function ProfileSelectionPanel({ profiles, selectedIds, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(true);

  const selectedSet = useMemo(
    () => (selectedIds === null ? null : new Set(selectedIds)),
    [selectedIds],
  );
  const isSelected = (id: string) => (selectedSet ? selectedSet.has(id) : true);
  const selectedCount = selectedSet
    ? profiles.filter(p => selectedSet.has(p.id)).length
    : profiles.length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(p =>
      (p.name || '').toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    );
  }, [profiles, query]);

  const toggle = (id: string) => {
    const base = selectedSet ? new Set(selectedSet) : new Set(profiles.map(p => p.id));
    if (base.has(id)) base.delete(id);
    else base.add(id);
    if (base.size === profiles.length && profiles.every(p => base.has(p.id))) onChange(null);
    else onChange([...base]);
  };

  const selectAll = () => onChange(null);
  const clearAll = () => onChange([]);
  const selectVisible = () => {
    const base = selectedSet ? new Set(selectedSet) : new Set(profiles.map(p => p.id));
    filtered.forEach(p => base.add(p.id));
    if (base.size === profiles.length && profiles.every(p => base.has(p.id))) onChange(null);
    else onChange([...base]);
  };

  if (!profiles.length) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <p className="text-xs text-gray-500 flex items-center gap-2">
          <Users size={14} className="text-amber-400" />
          Koi profile nahi mila — pehle Dashboard pe MoreLogin/Multilogin profiles load karo.
          Bina profiles ke plan <strong className="text-amber-400">48 demo profiles</strong> use karega.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className="w-full px-4 py-3 flex flex-wrap items-center gap-2 text-left hover:bg-gray-800/30"
      >
        <Users size={15} className="text-amber-400" />
        <span className="text-sm font-bold text-white">Profile Selection</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-bold ${
          selectedCount === 0
            ? 'border-red-700/50 bg-red-950/40 text-red-400'
            : 'border-emerald-700/50 bg-emerald-950/40 text-emerald-300'
        }`}>
          {selectedCount} / {profiles.length} selected
        </span>
        {selectedIds === null && (
          <span className="text-[9px] text-gray-500">(sab — naye profiles auto-include)</span>
        )}
        <span className="ml-auto text-[10px] text-gray-500">{collapsed ? 'kholo ▾' : 'band karo ▴'}</span>
      </button>

      {selectedCount === 0 && (
        <p className="mx-4 mb-3 text-[11px] text-red-400 bg-red-950/30 border border-red-800/50 rounded-lg px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={13} />
          Koi profile selected nahi — plan generate nahi hoga. Kam se kam 1 profile chuno.
        </p>
      )}

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Profile name ya ID se dhoondho…"
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-gray-950 border border-gray-700 text-xs text-gray-200 placeholder-gray-600 focus:border-amber-600 outline-none"
              />
            </div>
            <button type="button" onClick={selectAll}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-emerald-700/40 bg-emerald-950/30 text-[11px] text-emerald-300 hover:bg-emerald-900/30">
              <CheckSquare size={12} /> Select all
            </button>
            <button type="button" onClick={clearAll}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-700 text-[11px] text-gray-400 hover:bg-gray-800">
              <Square size={12} /> Clear
            </button>
            {query.trim() && (
              <button type="button" onClick={selectVisible}
                className="px-2.5 py-1.5 rounded-lg border border-amber-700/40 bg-amber-950/30 text-[11px] text-amber-300 hover:bg-amber-900/30">
                + Visible ({filtered.length})
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-72 overflow-y-auto pr-1">
            {filtered.map(p => {
              const on = isSelected(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.id)}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-colors ${
                    on
                      ? 'border-amber-600/50 bg-amber-950/20'
                      : 'border-gray-800 bg-gray-950/40 hover:border-gray-700'
                  }`}
                >
                  {on ? (
                    <CheckSquare size={15} className="text-amber-400 shrink-0" />
                  ) : (
                    <Square size={15} className="text-gray-600 shrink-0" />
                  )}
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[p.status] ?? 'bg-gray-600'}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs font-medium truncate ${on ? 'text-amber-100' : 'text-gray-400'}`}>
                      {p.name || p.id.slice(0, 8)}
                    </span>
                    <span className="block text-[9px] text-gray-600 font-mono truncate">{p.id}</span>
                  </span>
                </button>
              );
            })}
            {!filtered.length && (
              <p className="col-span-full text-center text-[11px] text-gray-600 py-4">
                "{query}" se koi profile match nahi hua
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
