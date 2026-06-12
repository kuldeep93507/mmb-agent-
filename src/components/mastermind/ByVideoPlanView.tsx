import { Film, Clock, CheckCircle, PlayCircle } from 'lucide-react';
import type { DemoPlanSlot } from '../../utils/mastermindDemoPlan';
import type { DemoVideoSummary } from '../../utils/mastermindDemoPlan';

interface Props {
  videos: DemoVideoSummary[];
  slots: DemoPlanSlot[];
  selectedVideoId: string;
  onSelectVideo: (id: string) => void;
  onSlotClick?: (slot: DemoPlanSlot) => void;
}

export default function ByVideoPlanView({ videos, slots, selectedVideoId, onSelectVideo, onSlotClick }: Props) {
  const videoSlots = slots
    .filter(s => s.videoId === selectedVideoId)
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

  const summary = videos.find(v => v.videoId === selectedVideoId);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {videos.map(v => (
          <button key={v.videoId} type="button" onClick={() => onSelectVideo(v.videoId)}
            className={`text-[10px] px-2 py-1 rounded border max-w-[200px] truncate ${
              selectedVideoId === v.videoId ? 'border-amber-500 text-amber-200 bg-amber-900/20' : 'border-gray-700 text-gray-500'
            }`}
            title={v.title}>
            <Film size={9} className="inline mr-0.5" />
            {v.channelName}: {v.slotsPlanned}/{v.viewGoal}
          </button>
        ))}
      </div>

      {summary && (
        <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-3">
          <p className="text-sm text-white font-semibold truncate">{summary.title}</p>
          <p className="text-[10px] text-gray-500">{summary.channelName} · {summary.durationLabel} · goal {summary.viewGoal} · planned {summary.slotsPlanned}</p>
          <p className="text-[10px] text-amber-400/80 mt-1">Sirf is video ki poori list — {videoSlots.length} slots</p>
        </div>
      )}

      <div className="border border-gray-800 rounded-xl overflow-hidden max-h-[65vh] overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-gray-900 z-10 text-gray-500 uppercase text-[10px]">
            <tr>
              <th className="p-2">Time</th>
              <th className="p-2">Profile</th>
              <th className="p-2">Traffic</th>
              <th className="p-2 hidden sm:table-cell">Session</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {videoSlots.map(slot => (
              <tr key={slot.id}
                onClick={() => onSlotClick?.(slot)}
                className="border-t border-gray-800/80 hover:bg-gray-800/40 cursor-pointer">
                <td className="p-2 font-mono text-amber-400/90 whitespace-nowrap">
                  {slot.timeLabel}━━{slot.endTimeLabel}
                  {slot.cooldownLabel && (
                    <span className="block text-[9px] text-gray-600">{slot.cooldownLabel}</span>
                  )}
                </td>
                <td className="p-2 text-gray-300">{slot.profileName}</td>
                <td className="p-2 text-emerald-400/90">{slot.trafficLabel}</td>
                <td className="p-2 hidden sm:table-cell text-gray-600">
                  <Clock size={10} className="inline mr-0.5" />{slot.sessionLabel}
                  {slot.tabIndex > 1 && <span className="text-purple-400 ml-1">T{slot.tabIndex}</span>}
                </td>
                <td className="p-2">
                  {slot.runtimeStatus === 'done' && <span className="text-emerald-500 flex items-center gap-0.5 text-[9px]"><CheckCircle size={10} /> done</span>}
                  {slot.runtimeStatus === 'running' && <span className="text-blue-400 flex items-center gap-0.5 text-[9px]"><PlayCircle size={10} /> LIVE</span>}
                  {slot.runtimeStatus === 'waiting' && <span className="text-amber-500 text-[9px]">wait</span>}
                </td>
              </tr>
            ))}
            {!videoSlots.length && (
              <tr><td colSpan={5} className="p-4 text-center text-gray-600 text-[10px]">Is video ke liye koi slot nahi</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
