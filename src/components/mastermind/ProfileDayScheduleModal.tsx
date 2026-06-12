import { X, Calendar } from 'lucide-react';
import type { DemoPlanSlot } from '../../utils/mastermindDemoPlan';
import { todayDayKey } from '../../utils/mastermindSessionTime';
import ProfileDayTimeline from './ProfileDayTimeline';

interface Props {
  profileId: string;
  profileName: string;
  slots: DemoPlanSlot[];
  onClose: () => void;
}

export default function ProfileDayScheduleModal({ profileId, profileName, slots, onClose }: Props) {
  const dayKey = todayDayKey();
  const now = new Date();
  const today = slots.filter(s => s.profileId === profileId && s.dayKey === dayKey);
  const done = today.filter(s => s.runtimeStatus === 'done').length;
  const running = today.filter(s => s.runtimeStatus === 'running').length;
  const waiting = today.filter(s => s.runtimeStatus === 'waiting').length;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70" onClick={onClose} aria-hidden />
      <div className="fixed inset-2 md:inset-4 lg:inset-6 z-50 bg-gray-950 border border-gray-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-w-[1400px] mx-auto">
        <div className="px-5 py-4 border-b border-gray-800 bg-gray-900/80 flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase text-emerald-500 font-semibold flex items-center gap-1">
              <Calendar size={11} /> Aaj ki poori schedule — konsi video kab · kab nahi
            </p>
            <h2 className="text-white font-bold text-lg">{profileName}</h2>
            <p className="text-[10px] text-gray-600 font-mono">{profileId} · {dayKey} · midnight reset</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-gray-500 hover:text-white rounded-lg">
            <X size={20} />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-3 p-4 border-b border-gray-800 bg-gray-900/40 text-center">
          <Stat label="Total assign" val={today.length} color="text-white" />
          <Stat label="Ho gayi" val={done} color="text-emerald-400" />
          <Stat label="Abhi chal rahi" val={running} color="text-blue-400" />
          <Stat label="Abhi nahi (wait)" val={waiting} color="text-amber-400" />
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          <ProfileDayTimeline slots={today} now={now} />
        </div>
      </div>
    </>
  );
}

function Stat({ label, val, color }: { label: string; val: number; color: string }) {
  return (
    <div>
      <p className={`text-2xl font-bold ${color}`}>{val}</p>
      <p className="text-[10px] text-gray-500">{label}</p>
    </div>
  );
}
