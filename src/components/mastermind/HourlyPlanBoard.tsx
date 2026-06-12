import { useState } from 'react';
import { ChevronDown, ChevronRight, Clock } from 'lucide-react';
import type { DemoPlanSlot } from '../../utils/mastermindDemoPlan';
import ProfileActionBadge from './ProfileActionBadge';

interface Props {
  slots: DemoPlanSlot[];
  hourSummary: { hour: number; count: number; label: string }[];
  onSlotClick?: (slot: DemoPlanSlot) => void;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export default function HourlyPlanBoard({ slots, hourSummary, onSlotClick }: Props) {
  const [openHour, setOpenHour] = useState<number | null>(hourSummary[0]?.hour ?? null);

  const hoursWithSlots = hourSummary.length
    ? hourSummary
    : Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, label: `${pad2(h)}:00` }));

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-300 font-semibold flex items-center gap-2">
        <Clock size={16} className="text-amber-400" /> Har ghante ka alag plan
      </p>
      <div className="border border-gray-800 rounded-xl overflow-hidden divide-y divide-gray-800/60 max-h-[65vh] overflow-y-auto">
        {hoursWithSlots.map(({ hour, count, label }) => {
          const hourSlots = slots.filter(s => s.hourBucket === hour)
            .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
          const isOpen = openHour === hour;

          return (
            <div key={hour}>
              <button type="button"
                onClick={() => setOpenHour(isOpen ? null : hour)}
                className="w-full flex items-center gap-4 px-4 py-4 bg-gray-900/50 hover:bg-gray-900/80 text-left">
                {isOpen ? <ChevronDown size={18} className="text-amber-400" /> : <ChevronRight size={18} className="text-gray-600" />}
                <span className="text-xl font-bold text-amber-400 font-mono w-20">{label}</span>
                <span className="text-sm text-gray-400 flex-1">{count || hourSlots.length} views</span>
                {hourSlots.some(s => s.runtimeStatus === 'running') && (
                  <span className="text-xs text-blue-400 font-bold">● LIVE</span>
                )}
              </button>
              {isOpen && (
                <div className="px-4 pb-4 space-y-2 bg-gray-950/30">
                  {!hourSlots.length && (
                    <p className="text-sm text-gray-600 py-3">Is ghante me koi slot nahi</p>
                  )}
                  {hourSlots.map(slot => (
                    <button key={slot.id} type="button" onClick={() => onSlotClick?.(slot)}
                      className="w-full flex flex-wrap items-center gap-3 text-left px-4 py-3 rounded-xl border border-gray-800 hover:border-gray-600 bg-gray-900/50">
                      <span className="font-mono text-base text-amber-300 font-bold whitespace-nowrap">
                        {slot.timeLabel}–{slot.endTimeLabel}
                      </span>
                      <span className="text-sm text-gray-200 font-medium">{slot.profileName}</span>
                      <span className="text-sm text-emerald-400">{slot.trafficLabel}</span>
                      <ProfileActionBadge action={slot.profileAction} size="md" />
                      <span className="text-sm text-gray-500 truncate flex-1 min-w-[120px]">{slot.videoTitle}</span>
                      <span className={`text-xs font-bold uppercase ${
                        slot.runtimeStatus === 'done' ? 'text-emerald-500'
                          : slot.runtimeStatus === 'running' ? 'text-blue-400' : 'text-amber-500'
                      }`}>
                        {slot.runtimeStatus}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
