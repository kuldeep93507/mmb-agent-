/** SHA-256 seeds for demo — mirrors server_python fingerprint_builder / entropy pattern. */

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface DemoSessionEntropy {
  sessionSeed: string;
  scrollCurveId: string;
  humanActivityId: string;
  tabSeed: string;
}

/** Per profile · per tab · per session · per day — unique human + scroll curve */
export async function buildSessionEntropy(opts: {
  profileId: string;
  tabIndex: number;
  sessionIndex: number;
  dayKey: string;
  trafficSource: string;
}): Promise<DemoSessionEntropy> {
  const base = await sha256Hex(
    `${opts.profileId}:tab${opts.tabIndex}:sess${opts.sessionIndex}:${opts.dayKey}:${opts.trafficSource}`,
  );
  const scroll = await sha256Hex(`${base}:scroll-curve:no-click`);
  const human = await sha256Hex(`${base}:human-activity`);
  const tab = await sha256Hex(`${base}:tab-open`);
  return {
    sessionSeed: base.slice(0, 16),
    scrollCurveId: scroll.slice(0, 12),
    humanActivityId: human.slice(0, 12),
    tabSeed: tab.slice(0, 10),
  };
}
