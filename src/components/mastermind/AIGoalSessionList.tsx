import { useMemo, useState } from 'react';
import { User, List, LayoutGrid, ChevronDown, ChevronRight } from 'lucide-react';
import type { AIGoalPlannerResult, AIGoalSessionRow } from '../../utils/aiGoalPlanner';
import { fmtClock } from '../../utils/aiGoalPlanner';

type ViewMode = 'chronological' | 'byProfile';

interface Props {
  plan: AIGoalPlannerResult;
}

function PhaseBadge({ phase }: { phase: AIGoalSessionRow['phase'] }) {
  if (phase === 'now') return <span className="text-[10px] font-bold text-blue-400 bg-blue-950/50 px-1.5 py-0.5 rounded">ABHI</span>;
  if (phase === 'past') return <span className="text-[10px] font-bold text-gray-600 bg-gray-900 px-1.5 py-0.5 rounded">guzar chuka</span>;
  return <span className="text-[10px] font-bold text-emerald-500 bg-emerald-950/40 px-1.5 py-0.5 rounded">aane wala</span>;
}

function SessionRow({ row, showProfile }: { row: AIGoalSessionRow; showProfile: boolean }) {
  return (
    <tr className="border-t border-gray-800/80 hover:bg-gray-800/30 text-sm">
      <td className="p-2.5 font-mono text-violet-300 font-bold whitespace-nowrap">{row.seq}</td>
      {showProfile && (
        <td className="p-2.5 whitespace-nowrap">
          <span className="text-white font-medium">{row.profileName}</span>
          {row.tabsInBundle > 1 && (
            <span className="text-[10px] text-purple-400 ml-1">tab {row.tabIndex}</span>
          )}
        </td>
      )}
      <td className="p-2.5 whitespace-nowrap">
        <span className="text-amber-400 font-mono font-bold">{row.startLabel}</span>
        <span className="text-gray-600 mx-1">→</span>
        <span className="text-gray-400 font-mono">{row.endLabel}</span>
        <span className="text-[10px] text-gray-600 ml-1">({row.sessionLabel})</span>
      </td>
      <td className="p-2.5 text-gray-300 max-w-[220px] truncate" title={row.videoTitle}>
        {row.tabsInBundle > 1 && (
          <span className="text-[9px] text-purple-400 font-bold mr-1">T{row.tabIndex}</span>
        )}
        {row.videoTitle}
        <span className="text-[10px] text-gray-600 block">{row.channelName}</span>
      </td>
      <td className="p-2.5 text-emerald-400 text-xs whitespace-nowrap">{row.trafficLabel}</td>
      <td className="p-2.5 text-xs whitespace-nowrap">
        {row.actionsPlanned.length > 0 ? (
          <span className="text-amber-300">{row.actionsPlanned.join(' · ')}</span>
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </td>
      <td className="p-2.5 whitespace-nowrap">
        <span className="text-cyan-400 font-mono text-xs font-semibold">{row.nextSessionLabel}</span>
        {row.gapBeforeSec > 0 && (
          <span className="text-[9px] text-gray-600 block">{row.gapLabel}</span>
        )}
      </td>
      <td className="p-2.5"><PhaseBadge phase={row.phase} /></td>
    </tr>
  );
}

export default function AIGoalSessionList({ plan }: Props) {
  const [view, setView] = useState<ViewMode>('chronological');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const nowLabel = useMemo(() => fmtClock(new Date()), [plan.plannedAt]);

  const toggleProfile = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase text-gray-500 font-semibold flex items-center gap-2">
            <List size={13} className="text-violet-400" />
            Session list — profile × time × video × agla session
          </p>
          <p className="text-[10px] text-gray-600 mt-0.5">
            Plan time: <strong className="text-amber-400">{fmtClock(plan.plannedAt)}</strong>
            {' · '}Abhi clock: <strong className="text-white">{nowLabel}</strong>
            {' · '}{plan.sessions.length} sessions · {plan.profileTimelines.length} profiles
          </p>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={() => setView('chronological')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs border ${
              view === 'chronological' ? 'border-violet-500 bg-violet-900/30 text-violet-100' : 'border-gray-800 text-gray-500'
            }`}>
            <List size={12} /> Time order
          </button>
          <button type="button" onClick={() => setView('byProfile')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs border ${
              view === 'byProfile' ? 'border-violet-500 bg-violet-900/30 text-violet-100' : 'border-gray-800 text-gray-500'
            }`}>
            <LayoutGrid size={12} /> Profile wise
          </button>
        </div>
      </div>

      {view === 'chronological' ? (
        <div className="border border-gray-800 rounded-xl overflow-hidden overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-left min-w-[720px]">
            <thead className="sticky top-0 bg-gray-900 z-10 text-[10px] text-gray-500 uppercase">
              <tr>
                <th className="p-2.5 w-8">#</th>
                <th className="p-2.5">Profile</th>
                <th className="p-2.5">Start → End</th>
                <th className="p-2.5">Video</th>
                <th className="p-2.5">Traffic</th>
                <th className="p-2.5">Actions</th>
                <th className="p-2.5">Agla session</th>
                <th className="p-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {plan.sessions.map(row => (
                <SessionRow key={row.id} row={row} showProfile />
              ))}
            </tbody>
          </table>
          {!plan.sessions.length && (
            <p className="text-center text-gray-500 text-sm py-8">Koi session fit nahi — window badhao ya goal ghatao</p>
          )}
        </div>
      ) : (
        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
          {plan.profileTimelines.map(pt => {
            const open = expanded.has(pt.profileId) || plan.profileTimelines.length <= 8;
            return (
              <div key={pt.profileId} className="border border-gray-800 rounded-xl overflow-hidden bg-gray-900/40">
                <button type="button" onClick={() => toggleProfile(pt.profileId)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800/40 text-left">
                  {open ? <ChevronDown size={14} className="text-gray-500" /> : <ChevronRight size={14} className="text-gray-500" />}
                  <User size={14} className="text-violet-400" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-bold text-sm">{pt.profileName}</p>
                    <p className="text-[10px] text-gray-500">
                      {pt.sessionCount} sessions · {pt.firstStart} → {pt.lastEnd}
                      {pt.nextUp && (
                        <span className="text-cyan-400 ml-2">Agla: {pt.nextUp.startLabel} — {pt.nextUp.videoTitle.slice(0, 40)}</span>
                      )}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-violet-300">{pt.sessionCount}</span>
                </button>
                {open && (
                  <div className="border-t border-gray-800 overflow-x-auto">
                    <table className="w-full text-left min-w-[600px]">
                      <thead className="text-[10px] text-gray-600 uppercase bg-gray-950/50">
                        <tr>
                          <th className="p-2 pl-10">#</th>
                          <th className="p-2">Start → End</th>
                          <th className="p-2">Video</th>
                          <th className="p-2">Traffic</th>
                          <th className="p-2">Actions</th>
                          <th className="p-2">Agla session</th>
                          <th className="p-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pt.sessions.map(row => (
                          <SessionRow key={row.id} row={row} showProfile={false} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
