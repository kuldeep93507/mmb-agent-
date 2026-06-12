import { CheckCircle, Clock, PlayCircle, Film, Ban } from 'lucide-react';
import type { DemoPlanSlot } from '../../utils/mastermindDemoPlan';

interface Props {
  slots: DemoPlanSlot[];
  highlightId?: string;
  now?: Date;
  compact?: boolean;
}

function statusMeta(slot: DemoPlanSlot) {
  if (slot.runtimeStatus === 'running') {
    return { label: 'ABHI CHAL RAHI', color: 'text-blue-400', border: 'border-blue-600/50 bg-blue-950/25', Icon: PlayCircle };
  }
  if (slot.runtimeStatus === 'done') {
    return { label: 'HO GAYI', color: 'text-emerald-400', border: 'border-emerald-800/40 bg-emerald-950/15', Icon: CheckCircle };
  }
  return { label: 'ABHI NAHI', color: 'text-amber-400', border: 'border-amber-800/40 bg-amber-950/10', Icon: Clock };
}

export default function ProfileDayTimeline({ slots, highlightId, now = new Date(), compact }: Props) {
  const sorted = [...slots].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const nowMs = now.getTime();

  if (!sorted.length) {
    return <p className="text-[10px] text-gray-600 py-4 text-center">Is profile ke liye aaj koi video assign nahi</p>;
  }

  return (
    <div className="relative space-y-1">
      {!compact && (
        <div className="text-[9px] text-gray-600 bg-gray-900/60 border border-gray-800 rounded-lg px-2 py-1.5 mb-2 space-y-0.5">
          <p><strong className="text-amber-400">Start–End</strong> = kab browser khulega band hoga (aaj ka clock)</p>
          <p><strong className="text-gray-400">Video lambai</strong> = YouTube video kitni lambi (8:30)</p>
          <p><strong className="text-gray-400">Session</strong> = poora kaam ads+scroll ke saath (~11:05)</p>
          {sorted.some(s => s.tabsInBundle > 1) && (
            <p><strong className="text-purple-400">Tab gap</strong> = Tab-2/3 pehle wali tab ke kitne sec baad khulegi</p>
          )}
          {sorted.some(s => s.cooldownLabel) && (
            <p><strong className="text-orange-400">Profile gap</strong> = session ke baad profile band → dubara khulne ka wait</p>
          )}
        </div>
      )}

      {sorted.map((slot, idx) => {
        const meta = statusMeta(slot);
        const isHighlight = slot.id === highlightId;
        const isFuture = slot.scheduledAt.getTime() > nowMs;
        const showNowBefore = idx > 0
          && sorted[idx - 1].scheduledEndAt.getTime() <= nowMs
          && slot.scheduledAt.getTime() > nowMs;

        return (
          <div key={slot.id}>
            {showNowBefore && (
              <div className="flex items-center gap-2 py-1 my-1">
                <div className="h-px flex-1 bg-red-500/50" />
                <span className="text-[9px] font-bold text-red-400">● ABHI YAHAN</span>
                <div className="h-px flex-1 bg-red-500/50" />
              </div>
            )}
            {slot.cooldownLabel && (
              <div className="flex items-center gap-2 py-0.5 ml-[72px]">
                <div className="h-px flex-1 border-t border-dashed border-orange-700/50" />
                <span className="text-[8px] text-orange-400/90">{slot.cooldownLabel}</span>
                <div className="h-px flex-1 border-t border-dashed border-orange-700/50" />
              </div>
            )}
            <div className={`flex gap-2 ${compact ? 'py-1' : 'py-2'}`}>
              <div className="flex flex-col items-center w-[72px] shrink-0 text-center">
                <span className="text-[8px] text-gray-600 uppercase">Start</span>
                <span className="font-mono text-sm text-amber-400 font-bold">{slot.timeLabel}</span>
                <span className="text-[8px] text-gray-600 uppercase mt-1">End</span>
                <span className="font-mono text-[10px] text-gray-500">{slot.endTimeLabel}</span>
              </div>
              <div className={`flex-1 min-w-0 rounded-xl border px-3 py-2 ${meta.border} ${isHighlight ? 'ring-1 ring-amber-500/60' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`text-[9px] font-bold uppercase ${meta.color}`}>{meta.label}</p>
                    <p className="text-gray-200 text-xs font-semibold truncate flex items-center gap-1 mt-0.5">
                      <Film size={10} className="text-red-400 shrink-0" /> {slot.videoTitle}
                    </p>
                    <div className="mt-1.5 space-y-0.5 text-[10px]">
                      <p className="text-amber-300/90">
                        ⏰ <strong>Chalegi:</strong> {slot.timeLabel} se {slot.endTimeLabel} tak
                      </p>
                      <p className="text-gray-500">
                        📹 <strong>Video lambai:</strong> {slot.durationLabel}
                        <span className="text-gray-600 mx-1">·</span>
                        <strong>Session:</strong> ~{slot.sessionLabel}
                      </p>
                      <p className="text-gray-500">
                        🚦 {slot.trafficLabel}
                        <span className="text-purple-400 mx-1">· Tab {slot.tabIndex}/{slot.tabsInBundle}</span>
                        {slot.tabGapSec != null && slot.tabGapSec > 0 && (
                          <span className="text-purple-300"> · +{slot.tabGapSec}s tab gap</span>
                        )}
                      </p>
                      {slot.profileActionLabel && (
                        <p className={`text-[10px] mt-0.5 ${
                          slot.profileAction === 'parallel_tab' ? 'text-purple-400'
                            : slot.profileAction === 'close_reopen' ? 'text-red-400/90'
                              : 'text-orange-400/90'
                        }`}>
                          {slot.profileAction === 'keep_open' && '🔓 '}
                          {slot.profileAction === 'close_reopen' && '🔒 '}
                          {slot.profileAction === 'parallel_tab' && '⧉ '}
                          {slot.profileActionLabel}
                        </p>
                      )}
                    </div>
                    {isFuture && (
                      <p className="text-[9px] text-amber-600/80 mt-1 flex items-center gap-1">
                        <Ban size={9} /> Abhi nahi — {slot.timeLabel} pe khulegi
                      </p>
                    )}
                    {slot.runtimeStatus === 'done' && (
                      <p className="text-[9px] text-emerald-600/80 mt-1">✓ {slot.endTimeLabel} pe band</p>
                    )}
                  </div>
                  <meta.Icon size={14} className={`${meta.color} shrink-0`} />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
