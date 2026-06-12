import { useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';
import type { Profile } from '../../types';

interface Props {
  profiles: Profile[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  maxHeight?: string;
  /** Profiles that cannot be selected (e.g. currently running) */
  disabledIds?: string[];
  disabledHint?: string;
}

export default function ProfilePickerPanel({
  profiles,
  selectedIds,
  onChange,
  maxHeight = '320px',
  disabledIds = [],
  disabledHint = 'Active',
}: Props) {
  const [q, setQ] = useState('');
  const selected = new Set(selectedIds);
  const disabled = new Set(disabledIds);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return profiles;
    return profiles.filter(p =>
      (p.name || '').toLowerCase().includes(needle)
      || p.id.toLowerCase().includes(needle)
      || (p.status || '').toLowerCase().includes(needle),
    );
  }, [profiles, q]);

  const toggle = (id: string) => {
    if (disabled.has(id)) return;
    if (selected.has(id)) onChange(selectedIds.filter(x => x !== id));
    else onChange([...selectedIds, id]);
  };

  const selectVisible = () => {
    const ids = new Set(selectedIds);
    filtered.forEach(p => { if (!disabled.has(p.id)) ids.add(p.id); });
    onChange([...ids]);
  };

  const clearAll = () => onChange([]);

  return (
    <div className="border border-gray-800 rounded-xl bg-gray-900/50 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b border-gray-800 bg-gray-900/80">
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Users size={14} className="text-amber-400" />
          <span className="font-semibold text-white">{selectedIds.length}</span>
          <span>/ {profiles.length} selected</span>
        </div>
        <div className="flex-1 min-w-[140px] relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search profile name…"
            className="w-full pl-8 pr-2 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-white text-xs"
          />
        </div>
        <button type="button" onClick={selectVisible}
          className="text-[10px] px-2 py-1 rounded-md border border-amber-700/40 text-amber-300 hover:bg-amber-900/20">
          + Visible
        </button>
        <button type="button" onClick={clearAll}
          className="text-[10px] px-2 py-1 rounded-md border border-gray-700 text-gray-400 hover:text-white">
          Clear
        </button>
      </div>

      <div className="overflow-y-auto" style={{ maxHeight }}>
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-gray-900 z-10 text-gray-500 uppercase tracking-wide">
            <tr>
              <th className="p-2 w-8" />
              <th className="p-2 font-medium">Profile</th>
              <th className="p-2 font-medium w-20 hidden sm:table-cell">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(p => {
              const on = selected.has(p.id);
              const off = disabled.has(p.id);
              return (
                <tr key={p.id}
                  onClick={() => toggle(p.id)}
                  className={`border-t border-gray-800/80 ${
                    off ? 'opacity-50 cursor-not-allowed' : `cursor-pointer ${on ? 'bg-amber-900/15' : 'hover:bg-gray-800/40'}`
                  }`}>
                  <td className="p-2 text-center">
                    <input type="checkbox" readOnly checked={on} disabled={off} className="rounded border-gray-600 pointer-events-none" />
                  </td>
                  <td className="p-2">
                    <div className="text-gray-100 font-medium truncate max-w-[200px]">{p.name || `…${p.id.slice(-6)}`}</div>
                    <div className="text-[10px] text-gray-600 font-mono truncate">{p.id.slice(0, 12)}…</div>
                  </td>
                  <td className="p-2 hidden sm:table-cell">
                    {off ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-900/40 text-green-300">{disabledHint}</span>
                    ) : (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                        p.status === 'running' ? 'bg-emerald-900/40 text-emerald-300' : 'bg-gray-800 text-gray-500'
                      }`}>{p.status || '—'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={3} className="p-6 text-center text-gray-600">Koi profile match nahi</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
