/**
 * Global traffic-source enable/disable — mirrors server_python/traffic_source_control.py
 * Settings → temporarily band sources project-wide.
 */

import { backendFetch } from '../services/backendOrigin';

export type TrafficSourceId =
  | 'search'
  | 'google'
  | 'bing'
  | 'notification'
  | 'homepage'
  | 'channel_discovery'
  | 'direct'
  | 'suggested'
  | 'backlinks';

export interface TrafficSourceRow {
  id: TrafficSourceId | string;
  label: string;
  enabled: boolean;
}

export const TRAFFIC_SOURCE_DEFS: { id: TrafficSourceId; label: string; emoji: string }[] = [
  { id: 'search', label: 'YouTube Search', emoji: '🔍' },
  { id: 'google', label: 'Google Search', emoji: '🌐' },
  { id: 'bing', label: 'Bing Search', emoji: '🔷' },
  { id: 'notification', label: 'Notification', emoji: '🔔' },
  { id: 'homepage', label: 'Homepage Browse', emoji: '🏠' },
  { id: 'channel_discovery', label: 'Channel Discovery', emoji: '📺' },
  { id: 'direct', label: 'Direct URL', emoji: '🔗' },
  { id: 'suggested', label: 'Suggested', emoji: '💡' },
  { id: 'backlinks', label: 'Backlinks', emoji: '↗' },
];

/** Fleet page labels → canonical id */
export const FLEET_TRAFFIC_TO_ID: Record<string, string> = {
  '🎲 Random (per profile)': 'random',
  'YouTube Search': 'search',
  Direct: 'direct',
  Google: 'google',
  Bing: 'bing',
  'Channel Page': 'channel_discovery',
  Notification: 'notification',
  Homepage: 'homepage',
};

export function fleetTrafficId(label: string): string {
  return FLEET_TRAFFIC_TO_ID[label] ?? label.toLowerCase().replace(/\s+/g, '_');
}

export function isTrafficEnabled(id: string, disabled: Set<string> | string[]): boolean {
  const set = disabled instanceof Set ? disabled : new Set(disabled);
  if (id === 'random') return true;
  return !set.has(id);
}

export function filterDisabledIds<T extends string>(
  options: readonly T[],
  disabled: Set<string> | string[],
): T[] {
  const set = disabled instanceof Set ? disabled : new Set(disabled);
  return options.filter((id) => id === 'random' || !set.has(id));
}

export async function fetchTrafficSourceStatus(): Promise<{
  disabled: string[];
  sources: TrafficSourceRow[];
}> {
  const r = await backendFetch('/api/traffic-sources');
  const d = await r.json();
  if (!d.success) throw new Error(d.error || 'traffic-sources failed');
  return {
    disabled: Array.isArray(d.disabled) ? d.disabled : [],
    sources: Array.isArray(d.sources) ? d.sources : [],
  };
}

export async function toggleTrafficSource(
  sourceId: string,
  enabled: boolean,
): Promise<{ disabled: string[]; sources: TrafficSourceRow[] }> {
  const r = await backendFetch('/api/traffic-sources/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId, enabled }),
  });
  const d = await r.json();
  if (!d.success) throw new Error(d.error || 'toggle failed');
  return { disabled: d.disabled ?? [], sources: d.sources ?? [] };
}
