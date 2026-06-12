import { Wand2, Play, Rocket, ChevronDown, ChevronUp, Settings2 } from 'lucide-react';

interface Props {
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  fromAI?: boolean;
}

export default function MastermindSimpleGuide({ advancedOpen, onToggleAdvanced, fromAI }: Props) {
  return (
    <div className="rounded-2xl border-2 border-violet-500/50 bg-gradient-to-br from-violet-950/50 to-gray-950 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <Wand2 size={28} className="text-violet-400 shrink-0 mt-0.5" />
        <div>
          <h3 className="text-lg font-bold text-white">
            {fromAI ? '✓ AI se plan aa gaya — ab confuse mat ho' : 'Simple tarika — yahi follow karo'}
          </h3>
          <p className="text-sm text-gray-400 mt-1">
            Setup tab advanced hai. Pehle <strong className="text-violet-300">AI Goal Planner</strong> use karo — wahi asli kaam hota hai.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { step: '1', icon: <Wand2 size={20} />, title: 'AI Goal Planner', desc: 'Videos + time + views → Plan Generate' },
          { step: '2', icon: <Play size={20} />, title: 'Plan + Real Run', desc: '▶ Plan + Start Real Run — ek click' },
          { step: '3', icon: <Rocket size={20} />, title: 'Shift / 3-day queue', desc: 'Day Plan → kal shift ya 3 din queue' },
        ].map(({ step, icon, title, desc }) => (
          <div key={step} className="bg-gray-900/80 border border-gray-700 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-8 h-8 rounded-full bg-violet-600 text-white font-bold flex items-center justify-center text-sm">{step}</span>
              <span className="text-violet-300">{icon}</span>
              <span className="text-white font-bold text-sm">{title}</span>
            </div>
            <p className="text-xs text-gray-400 leading-relaxed">{desc}</p>
          </div>
        ))}
      </div>

      <div className="bg-amber-950/30 border border-amber-700/40 rounded-xl px-4 py-3 text-sm text-amber-100">
        <strong className="text-amber-300">Setup tab (yeh page) kab use karo?</strong>
        <ul className="mt-2 space-y-1 text-xs text-amber-200/90 list-disc list-inside">
          <li>AI se sab set ho chuka → <strong>yahan kuch mat chhedo</strong>, seedha Day Plan jao</li>
          <li>Traffic / ghante manually badalne hon → neeche Advanced kholo</li>
          <li>Videos change karni hon → <strong>Setup tab</strong> me videos panel ya <strong>AI Goal Planner</strong></li>
        </ul>
      </div>

      <button type="button" onClick={onToggleAdvanced}
        className="flex items-center gap-2 text-sm font-semibold text-gray-400 hover:text-white transition-colors">
        <Settings2 size={16} />
        {advancedOpen ? 'Advanced settings chhupao' : 'Advanced settings dikhao (manual experts)'}
        {advancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    </div>
  );
}
