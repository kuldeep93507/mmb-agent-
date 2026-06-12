import type { DemoPlanSlot } from '../../utils/mastermindDemoPlan';

interface Props {
  action?: DemoPlanSlot['profileAction'];
  size?: 'sm' | 'md';
}

const META = {
  keep_open: { label: 'OPEN', title: 'Profile band nahi — seedha agla session', className: 'border-orange-600/60 bg-orange-950/40 text-orange-300' },
  close_reopen: { label: 'CLOSE→OPEN', title: 'Profile band → dubara khulega', className: 'border-red-700/60 bg-red-950/40 text-red-300' },
  parallel_tab: { label: 'PARALLEL TAB', title: 'Lambi ads — nayi tab me agla session', className: 'border-purple-600/60 bg-purple-950/40 text-purple-300' },
} as const;

export default function ProfileActionBadge({ action, size = 'sm' }: Props) {
  if (!action) return null;
  const m = META[action];
  const px = size === 'md' ? 'px-2 py-1 text-xs' : 'px-1.5 py-0.5 text-[10px]';
  return (
    <span title={m.title} className={`inline-flex font-bold rounded border ${px} ${m.className}`}>
      {m.label}
    </span>
  );
}
