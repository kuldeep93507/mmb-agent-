/**
 * Maps provider list rows + optional local snapshots into Profile objects.
 * No invented Smartproxy rows: unknown = empty / 0 / explicit 'unknown' until
 * provider APIs or create-full snapshot supply real values.
 */

import type { Profile, OS, ProxyConfig, FingerprintConfig, ProxyLife } from "../types";

const SNAPSHOT_PREFIX = "mmb_profile_snapshot_";

/** Row shape after backend list (+ optional enrichment). */
export type ProviderListRow = {
  id: string;
  name: string;
  status: string;
  debugPort: number | null;
  browserType: "morelogin" | "multilogin";
  os?: string | null;
  osId?: number;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  userAgentHint?: string;
};

export function mapProviderOsLabel(raw?: string | null, osId?: number): OS {
  if (osId === 2) return 'macOS';
  if (osId === 3) return 'Android';
  if (osId === 1) return 'Windows';
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "Unknown";
  if (s.includes("android")) return "Android";
  if (s.includes("mac") || s.includes("darwin")) return "macOS";
  if (s.includes("win")) return "Windows";
  return "Unknown";
}

/** Proxy fields we could not load yet — no fake expiry or session length. */
export function unknownProxy(): ProxyConfig {
  return {
    server: "",
    port: 0,
    username: "",
    password: "",
    state: "",
    city: "",
    life: "unknown",
    sessionId: "",
    assignedAt: 0,
    expiresAt: 0,
  };
}

/** Fingerprint fields we could not load yet — numeric sentinels -1 = unavailable. */
export function unknownFingerprint(os: OS): FingerprintConfig {
  return {
    userAgent: "",
    timezone: "",
    language: "",
    resolution: "",
    webGL: "",
    canvas: "",
    audioContext: "",
    cpu: -1,
    ram: -1,
    webRTC: "",
    geolocation: { lat: 0, lng: 0 },
    battery: -1,
    ...(os === "Android"
      ? { deviceModel: "", androidVersion: "" }
      : {}),
    ...(os === "macOS" ? { macOsVersion: "" } : {}),
  };
}

export function loadProfileSnapshot(profileId: string): {
  proxy?: ProxyConfig;
  fingerprint?: Partial<FingerprintConfig>;
} | null {
  try {
    const d = localStorage.getItem(SNAPSHOT_PREFIX + profileId);
    if (!d) return null;
    return JSON.parse(d);
  } catch {
    return null;
  }
}

export function saveProfileSnapshot(
  profileId: string,
  payload: { proxy: ProxyConfig; fingerprint: FingerprintConfig }
) {
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + profileId, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function clearProfileSnapshot(profileId: string) {
  try {
    localStorage.removeItem(SNAPSHOT_PREFIX + profileId);
  } catch {
    /* ignore */
  }
}

export function mergeFingerprint(
  base: FingerprintConfig,
  partial?: Partial<FingerprintConfig> | null
): FingerprintConfig {
  if (!partial || typeof partial !== "object") return base;
  const geolocation =
    partial.geolocation && typeof partial.geolocation === "object"
      ? { ...base.geolocation, ...partial.geolocation }
      : base.geolocation;
  return { ...base, ...partial, geolocation };
}

export function proxyFromBackendCreate(proxyData: {
  server?: string;
  port?: number;
  sessionId?: string;
  state?: string;
  city?: string;
  life?: string;
  assignedAt?: number;
  expiresAt?: number;
  type?: string;
  country?: string;
}): ProxyConfig {
  const lifeKnown =
    proxyData.life &&
    ["1hr", "2hr", "4hr", "8hr", "24hr"].includes(proxyData.life)
      ? (proxyData.life as ProxyLife)
      : "unknown";
  return {
    server: proxyData.server || "",
    port: proxyData.port || 0,
    username:
      proxyData.type === 'multilogin_residential'
        ? `MLX ${(proxyData.country || 'us').toUpperCase()}`
        : "(assigned — username/password not returned in API response)",
    password: "",
    state: proxyData.state || (proxyData.type === 'multilogin_residential' ? proxyData.country?.toUpperCase() || 'US' : ''),
    city: proxyData.city || "",
    life: lifeKnown,
    sessionId: proxyData.sessionId || "",
    assignedAt: proxyData.assignedAt || Date.now(),
    expiresAt: proxyData.expiresAt || 0,
  };
}

export function isMultiloginProxyHost(host?: string): boolean {
  const h = String(host || '').toLowerCase();
  return h.includes('multilogin.com') || h.includes('gate.multilogin');
}

export function isSmartProxyHost(host?: string): boolean {
  return String(host || '').toLowerCase().includes('smartproxy.net');
}

export function inferProxyTypeFromProfile(profile: Pick<Profile, 'proxy'>): 'multilogin' | 'smartproxy' {
  if (isMultiloginProxyHost(profile.proxy.server)) return 'multilogin';
  if (isSmartProxyHost(profile.proxy.server)) return 'smartproxy';
  return 'smartproxy';
}

export function proxyProviderLabel(host?: string): string {
  if (isMultiloginProxyHost(host)) return 'Multilogin Built-in';
  if (isSmartProxyHost(host)) return 'SmartProxy';
  if (host) return host;
  return 'Unknown';
}

/** Maps provider list status → Profile card status */
function mapListStatus(raw: string): Profile["status"] {
  const s = (raw || "").toLowerCase();
  if (s === "running") return "running";
  if (s === "starting") return "starting";
  if (s === "error") return "error";
  return "stopped";
}

function proxyHintsFromRow(sp: ProviderListRow): ProxyConfig | null {
  const host = String(sp.proxyHost || "").trim();
  if (!host) return null;
  const base = {
    ...unknownProxy(),
    server: host,
    port: Number(sp.proxyPort) || 0,
    username: String(sp.proxyUsername || "").trim(),
  };
  if (isMultiloginProxyHost(host)) {
    return { ...base, life: 'unknown', state: 'US/UK' };
  }
  return base;
}

/** Browser provider list row → Profile */
export function profileFromListRow(sp: ProviderListRow): Profile {
  const os = mapProviderOsLabel(sp.os, sp.osId);
  const snap = loadProfileSnapshot(sp.id);

  const hintedProxy = proxyHintsFromRow(sp);
  let proxy: ProxyConfig;
  if (snap?.proxy) {
    proxy = { ...unknownProxy(), ...snap.proxy };
  } else if (hintedProxy) {
    proxy = hintedProxy;
  } else {
    proxy = unknownProxy();
  }

  const uaHint = String(sp.userAgentHint || "").trim();
  let fingerprint: FingerprintConfig;
  if (snap?.fingerprint) {
    fingerprint = mergeFingerprint(unknownFingerprint(os), snap.fingerprint);
  } else if (uaHint) {
    fingerprint = { ...unknownFingerprint(os), userAgent: uaHint };
  } else {
    fingerprint = unknownFingerprint(os);
  }

  const st = mapListStatus(sp.status);

  return {
    id: sp.id,
    name: sp.name,
    os,
    status: st,
    proxy,
    fingerprint,
    currentAction: st === "running" ? "Active" : "Idle",
    createdAt: Date.now(),
    selected: false,
    envId: sp.id,
    ip: sp.debugPort ? `debug:${sp.debugPort}` : undefined,
    browserType: sp.browserType,
  };
}

/** Persist server-returned proxy+fingerprint after create-full succeeds. */
export function saveSnapshotFromCreateFull(
  profileId: string,
  os: OS,
  data: { proxy?: Record<string, unknown>; fingerprint?: Partial<FingerprintConfig> | null }
) {
  if (!data?.fingerprint) return;
  const raw = data.proxy as Record<string, unknown> | undefined;
  let proxy: ProxyConfig;
  if (raw?.type === 'multilogin_residential') {
    proxy = proxyFromBackendCreate({
      type: 'multilogin_residential',
      country: String(raw.country || 'us'),
      server: String(raw.server || raw.host || 'gate.multilogin.com'),
      port: Number(raw.port) || 1080,
    });
  } else if (raw) {
    proxy = proxyFromBackendCreate(raw as Parameters<typeof proxyFromBackendCreate>[0]);
  } else {
    return;
  }
  const fingerprint = mergeFingerprint(unknownFingerprint(os), data.fingerprint);
  saveProfileSnapshot(profileId, { proxy, fingerprint });
}
