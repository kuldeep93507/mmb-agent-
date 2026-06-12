export default function PlanActionLegend() {
  return (
    <div className="flex flex-wrap gap-3 items-center text-xs text-gray-400 bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-3">
      <span className="font-semibold text-gray-500 uppercase tracking-wide text-[10px]">Legend</span>
      <span className="inline-flex items-center gap-1.5">
        <span className="px-2 py-0.5 rounded border border-orange-600/60 bg-orange-950/40 text-orange-300 text-[10px] font-bold">OPEN</span>
        Gap chhota — profile band mat karo
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="px-2 py-0.5 rounded border border-red-700/60 bg-red-950/40 text-red-300 text-[10px] font-bold">CLOSE→OPEN</span>
        Gap bada — band karke dubara kholo
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="px-2 py-0.5 rounded border border-purple-600/60 bg-purple-950/40 text-purple-300 text-[10px] font-bold">PARALLEL TAB</span>
        Lambe ads — nayi tab me agla video
      </span>
      <span className="inline-flex items-center gap-1.5 ml-auto">
        <span className="w-2 h-2 rounded-full bg-emerald-500" /> done
        <span className="w-2 h-2 rounded-full bg-blue-400 ml-2" /> LIVE
        <span className="w-2 h-2 rounded-full bg-amber-500 ml-2" /> wait
      </span>
    </div>
  );
}
