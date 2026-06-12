/** Plan window helpers — 24h / 1h / custom time range. */

import type { DemoPlanWindow } from './mastermindDemoTypes';

export function planWindowMinutes(w: DemoPlanWindow): number {
  if (w.mode === '24h') return 24 * 60;
  if (w.mode === '1h') return 60;
  const start = w.customStartHour * 60 + w.customStartMinute;
  let end = w.customEndHour * 60 + w.customEndMinute;
  if (end <= start) end += 24 * 60;
  return end - start;
}

export function planWindowBounds(w: DemoPlanWindow, dayStart: Date): { startMs: number; endMs: number } {
  const base = dayStart.getTime();
  if (w.mode === '24h') {
    return { startMs: base, endMs: base + 24 * 3600000 };
  }
  if (w.mode === '1h') {
    const startMs = base + w.oneHourStart * 3600000;
    return { startMs, endMs: startMs + 3600000 };
  }
  const startMs = base + (w.customStartHour * 60 + w.customStartMinute) * 60000;
  let endMs = base + (w.customEndHour * 60 + w.customEndMinute) * 60000;
  if (endMs <= startMs) endMs += 24 * 3600000;
  return { startMs, endMs };
}

export function formatWindowLabel(w: DemoPlanWindow): string {
  if (w.mode === '24h') return 'Poora din (24h)';
  if (w.mode === '1h') return `Sirf 1 ghanta — ${String(w.oneHourStart).padStart(2, '0')}:00`;
  const s = `${String(w.customStartHour).padStart(2, '0')}:${String(w.customStartMinute).padStart(2, '0')}`;
  const e = `${String(w.customEndHour).padStart(2, '0')}:${String(w.customEndMinute).padStart(2, '0')}`;
  return `Custom ${s} – ${e}`;
}
