/**
 * Built-in YouTube channels — always present after app load.
 * Re-added automatically if missing from localStorage.
 */
export const PERMANENT_CHANNEL_IDS = [
  'UCrrDPJFcz4qIB59FG-qfD0A',
  'UCNxO4SBckt-vI9VPazA_4Iw',
] as const;

const PERMANENT_SET = new Set<string>(PERMANENT_CHANNEL_IDS);

export function isPermanentChannel(channelId: string): boolean {
  return PERMANENT_SET.has(channelId);
}
