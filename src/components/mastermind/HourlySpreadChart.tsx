/** Bada readable ghante-wise chart — chote fonts nahi */

interface HourSlot {
  hour: number;
  views: number;
  label?: string;
}

interface Props {
  slots: HourSlot[];
  title?: string;
  accentClass?: string;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export default function HourlySpreadChart({
  slots,
  title = 'Ghante-wise spread',
  accentClass = 'bg-violet-600',
}: Props) {
  if (!slots.length) return null;
  const max = Math.max(...slots.map(s => s.views), 1);

  return (
    <div className="bg-gray-900/70 border-2 border-gray-700 rounded-2xl p-5">
      <p className="text-sm font-bold text-white uppercase tracking-wide mb-4">{title}</p>
      <div className="flex items-end gap-2 sm:gap-3 min-h-[140px]">
        {slots.map(s => {
          const pct = Math.max(12, (s.views / max) * 100);
          return (
            <div
              key={s.hour}
              className="flex-1 flex flex-col items-center justify-end min-w-[44px] max-w-[80px]"
              title={`${pad2(s.hour)}:00 — ${s.views} views`}
            >
              <span className="text-lg sm:text-xl font-bold text-white font-mono mb-1">{s.views}</span>
              <div
                className={`w-full rounded-t-lg ${accentClass} opacity-90`}
                style={{ height: `${pct}px`, minHeight: 12, maxHeight: 100 }}
              />
              <span className="text-sm font-bold text-amber-400 font-mono mt-2">{pad2(s.hour)}:00</span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 mt-3">
        Upar number = us ghante kitne sessions/views plan hue
      </p>
    </div>
  );
}
