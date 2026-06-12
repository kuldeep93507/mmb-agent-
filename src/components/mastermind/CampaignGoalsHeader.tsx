import type { DemoCampaignGoals } from '../../utils/mastermindDemoTypes';
import type { DemoActionProjection } from '../../utils/mastermindDemoPlan';

interface Props {
  goals: DemoCampaignGoals;
  onChange: (g: DemoCampaignGoals) => void;
  projection: DemoActionProjection[] | null;
  readOnly?: boolean;
}

const ENGAGEMENT_FIELDS: { key: keyof DemoCampaignGoals; label: string; emoji: string }[] = [
  { key: 'views', label: 'Views', emoji: '👁' },
  { key: 'likes', label: 'Likes', emoji: '👍' },
  { key: 'dislikes', label: 'Dislikes', emoji: '👎' },
  { key: 'subscribes', label: 'Subscribers', emoji: '📺' },
  { key: 'bells', label: 'Bell ON', emoji: '🔔' },
  { key: 'comments', label: 'Comments', emoji: '💬' },
  { key: 'commentLikes', label: 'Comment likes', emoji: '💬👍' },
];

const BEHAVIOR_FIELDS: { key: keyof DemoCampaignGoals; label: string; emoji: string; hint: string }[] = [
  { key: 'watchProfiles', label: 'Watch profiles', emoji: '⏱', hint: 'Kitne profiles par watch %' },
  { key: 'volumeProfiles', label: 'Volume profiles', emoji: '🔊', hint: 'Kitne profiles par volume' },
  { key: 'scrollProfiles', label: 'Scroll profiles', emoji: '📜', hint: 'Kitne profiles par scroll' },
  { key: 'captionsProfiles', label: 'Captions profiles', emoji: '🇨', hint: 'Kitne profiles par captions' },
];

function GoalField({
  label, emoji, value, onChange, readOnly, proj, hint,
}: {
  label: string;
  emoji: string;
  value: number;
  onChange: (n: number) => void;
  readOnly?: boolean;
  proj?: DemoActionProjection;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] text-gray-500 flex items-center gap-1 mb-1" title={hint}>
        {emoji} {label}
      </span>
      <input
        type="number"
        min={0}
        readOnly={readOnly}
        value={value}
        onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        className={`w-full bg-gray-950 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm font-semibold ${readOnly ? 'opacity-80' : ''}`}
      />
      {proj && (
        <span className={`text-[9px] mt-0.5 block ${proj.ok ? 'text-emerald-500' : 'text-amber-500'}`}>
          plan: {proj.projected}/{proj.goal}
          {proj.detail ? ` · ${proj.detail}` : ''}
        </span>
      )}
    </label>
  );
}

export default function CampaignGoalsHeader({ goals, onChange, projection, readOnly }: Props) {
  const projMap = new Map(projection?.map(p => [p.key, p]) ?? []);

  return (
    <div className="bg-gray-900/80 border border-gray-800 rounded-xl p-3 space-y-3">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">
        Campaign targets (24h) — tum set karo · agent sirf manage karega
      </p>

      <div>
        <p className="text-[9px] text-gray-600 uppercase mb-1.5 font-semibold">Engagement goals</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {ENGAGEMENT_FIELDS.map(({ key, label, emoji }) => (
            <GoalField
              key={key}
              label={label}
              emoji={emoji}
              value={goals[key]}
              readOnly={readOnly}
              proj={projMap.get(key)}
              onChange={n => onChange({ ...goals, [key]: n })}
            />
          ))}
        </div>
      </div>

      <div>
        <p className="text-[9px] text-gray-600 uppercase mb-1.5 font-semibold">Profile behavior targets (kitne profiles par apply)</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {BEHAVIOR_FIELDS.map(({ key, label, emoji, hint }) => (
            <GoalField
              key={key}
              label={label}
              emoji={emoji}
              hint={hint}
              value={goals[key]}
              readOnly={readOnly}
              proj={projMap.get(key)}
              onChange={n => onChange({ ...goals, [key]: n })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
