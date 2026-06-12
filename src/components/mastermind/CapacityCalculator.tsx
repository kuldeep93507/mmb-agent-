import { Gauge, AlertTriangle } from 'lucide-react';
import type { DemoCampaignDefaults, DemoCampaignVideo } from '../../utils/mastermindDemoTypes';
import { trafficQuotasTotal } from '../../utils/mastermindDemoTypes';
import { computeMaxDailyCapacity } from '../../utils/mastermindCapacity';

interface Props {
  profileCount: number;
  videos: DemoCampaignVideo[];
  defaults: DemoCampaignDefaults;
  plannedSlots?: number;
}

export default function CapacityCalculator({ profileCount, videos, defaults, plannedSlots }: Props) {
  const avgDur = videos.length
    ? Math.round(videos.reduce((s, v) => s + (v.durationSec || 600), 0) / videos.length)
    : 600;
  const goalViews = plannedSlots ?? trafficQuotasTotal(defaults.trafficQuotas);
  const cap = computeMaxDailyCapacity({
    profileCount,
    avgVideoDurationSec: avgDur,
    goalViews,
    defaults,
  });

  const durLabel = `${Math.floor(avgDur / 60)}m video`;

  return (
    <div className={`rounded-xl border p-3 ${cap.impossible ? 'bg-red-950/25 border-red-800/50' : 'bg-gray-900/60 border-gray-800'}`}>
      <p className="text-[10px] uppercase text-gray-500 font-semibold flex items-center gap-1 mb-2">
        <Gauge size={12} /> Capacity calculator (demo estimate)
      </p>
      <p className="text-xs text-gray-300">
        <strong className="text-white">{profileCount || 48}</strong> profiles ·{' '}
        <strong className="text-amber-300">{durLabel}</strong> ·{' '}
        <strong className="text-purple-300">{defaults.tabsPerProfile}</strong> tab(s) →{' '}
        max ~<strong className="text-emerald-400">{cap.maxViews.toLocaleString()}</strong> views possible
      </p>
      <p className="text-[10px] text-gray-600 mt-1">{cap.detail}</p>
      {cap.impossible && (
        <p className="text-[10px] text-red-400 mt-2 flex items-center gap-1 font-semibold">
          <AlertTriangle size={11} />
          Goal {goalViews.toLocaleString()} &gt; max {cap.maxViews.toLocaleString()} — impossible! Profiles/tabs badhao ya goal ghatao
        </p>
      )}
    </div>
  );
}
