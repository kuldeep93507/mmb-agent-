import {
  PROXY_PREFIX, PROXY_SERVER, PROXY_PORT, PROXY_PASSWORD,
  US_STATE_CITIES, STATE_TIMEZONES, PROXY_LIVES, LIFE_MS,
  ANDROID_DEVICES, WINDOWS_UA_LIST, MACOS_VERSIONS, WINDOWS_WEBGL,
  CPU_CORES, RAM_SIZES
} from '../data/proxyData';
import { getProxyConfigFromSettings } from './settingsApi';
import type { OS, ProxyConfig, FingerprintConfig, ProxyLife } from '../types';

function proxyCredentials() {
  const s = getProxyConfigFromSettings();
  return {
    server: s.proxyServer || PROXY_SERVER,
    port: parseInt(String(s.proxyPort), 10) || PROXY_PORT,
    password: s.proxyPassword || PROXY_PASSWORD,
    prefix: s.proxyPrefix || PROXY_PREFIX,
    defaultLife: (s.defaultProxyLife as ProxyLife) || '4hr',
  };
}

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export function generateProxyConfig(life?: ProxyLife): ProxyConfig {
  const creds = proxyCredentials();
  const states = Object.keys(US_STATE_CITIES);
  const state = randomFrom(states);
  const cities = US_STATE_CITIES[state];
  const city = randomFrom(cities);
  const sessionId = generateSessionId();
  const selectedLife = life || creds.defaultLife || randomFrom([...PROXY_LIVES]);
  const now = Date.now();
  const username = `${creds.prefix}_area-US_state-${state}_city-${city}_life-${selectedLife}_session-${sessionId}`;

  return {
    server: creds.server,
    port: creds.port,
    username,
    password: creds.password,
    state,
    city,
    life: selectedLife,
    sessionId,
    assignedAt: now,
    expiresAt: now + LIFE_MS[selectedLife],
  };
}

export function renewProxySession(existing: ProxyConfig): ProxyConfig {
  const creds = proxyCredentials();
  const newSessionId = generateSessionId();
  const now = Date.now();
  const username = `${creds.prefix}_area-US_state-${existing.state}_city-${existing.city}_life-${existing.life}_session-${newSessionId}`;
  return {
    ...existing,
    username,
    sessionId: newSessionId,
    assignedAt: now,
    expiresAt: now + LIFE_MS[existing.life],
  };
}

function generateGeoFromState(state: string): { lat: number; lng: number } {
  const geoMap: Record<string, { lat: number; lng: number }> = {
    TX: { lat: 30.2672 + (Math.random() - 0.5) * 2, lng: -97.7431 + (Math.random() - 0.5) * 2 },
    CA: { lat: 34.0522 + (Math.random() - 0.5) * 2, lng: -118.2437 + (Math.random() - 0.5) * 2 },
    NY: { lat: 40.7128 + (Math.random() - 0.5) * 0.5, lng: -74.006 + (Math.random() - 0.5) * 0.5 },
    FL: { lat: 25.7617 + (Math.random() - 0.5) * 2, lng: -80.1918 + (Math.random() - 0.5) * 2 },
    WA: { lat: 47.6062 + (Math.random() - 0.5) * 1, lng: -122.3321 + (Math.random() - 0.5) * 1 },
    IL: { lat: 41.8781 + (Math.random() - 0.5) * 1, lng: -87.6298 + (Math.random() - 0.5) * 1 },
    AZ: { lat: 33.4484 + (Math.random() - 0.5) * 2, lng: -112.074 + (Math.random() - 0.5) * 2 },
    GA: { lat: 33.749 + (Math.random() - 0.5) * 1, lng: -84.388 + (Math.random() - 0.5) * 1 },
    NC: { lat: 35.2271 + (Math.random() - 0.5) * 1, lng: -80.8431 + (Math.random() - 0.5) * 1 },
    OH: { lat: 39.9612 + (Math.random() - 0.5) * 1, lng: -82.9988 + (Math.random() - 0.5) * 1 },
  };
  return geoMap[state] || { lat: 37.7749, lng: -122.4194 };
}

function generateFakeIP(state: string): string {
  const prefixMap: Record<string, string> = {
    TX: '45', CA: '104', NY: '72', FL: '96', WA: '66',
    IL: '173', AZ: '138', GA: '142', NC: '184', OH: '198',
  };
  const prefix = prefixMap[state] || '45';
  return `${prefix}.${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}`;
}

export function generateWindowsFingerprint(proxy: ProxyConfig): FingerprintConfig {
  const timezone = STATE_TIMEZONES[proxy.state] || 'America/New_York';
  return {
    userAgent: randomFrom(WINDOWS_UA_LIST),
    timezone,
    language: 'en-US',
    resolution: '1920x1080',
    webGL: randomFrom(WINDOWS_WEBGL),
    canvas: `noise-${generateSessionId()}`,
    audioContext: `noise-${generateSessionId()}`,
    cpu: randomFrom(CPU_CORES),
    ram: randomFrom(RAM_SIZES),
    webRTC: 'privacy-mode',
    geolocation: generateGeoFromState(proxy.state),
    battery: randomInt(20, 100),
  };
}

export function generateAndroidFingerprint(proxy: ProxyConfig): FingerprintConfig {
  const device = randomFrom(ANDROID_DEVICES);
  const timezone = STATE_TIMEZONES[proxy.state] || 'America/New_York';
  return {
    userAgent: `Mozilla/5.0 (Linux; Android ${device.android}; ${device.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36`,
    timezone,
    language: 'en-US',
    resolution: device.resolution,
    webGL: device.gpu,
    canvas: `noise-${generateSessionId()}`,
    audioContext: `noise-${generateSessionId()}`,
    cpu: randomFrom([6, 8]),
    ram: randomFrom([6, 8, 12]),
    webRTC: 'privacy-mode',
    geolocation: generateGeoFromState(proxy.state),
    battery: randomInt(20, 100),
    deviceModel: device.model,
    androidVersion: device.android,
  };
}

export function generateMacOSFingerprint(proxy: ProxyConfig): FingerprintConfig {
  const version = randomFrom(MACOS_VERSIONS);
  const timezone = STATE_TIMEZONES[proxy.state] || 'America/New_York';
  return {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X ${version.replace('.', '_')}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
    timezone,
    language: 'en-US',
    resolution: randomFrom(['2560x1600', '2560x1440', '1440x900']),
    webGL: randomFrom(['Apple M1', 'Apple M2', 'Intel Iris Pro']),
    canvas: `noise-${generateSessionId()}`,
    audioContext: `noise-${generateSessionId()}`,
    cpu: randomFrom([8, 10, 12]),
    ram: randomFrom([8, 16, 32]),
    webRTC: 'privacy-mode',
    geolocation: generateGeoFromState(proxy.state),
    battery: randomInt(20, 100),
    macOsVersion: version,
  };
}

export function generateFingerprint(os: OS, proxy: ProxyConfig): FingerprintConfig {
  if (os === 'Windows') return generateWindowsFingerprint(proxy);
  if (os === 'Android') return generateAndroidFingerprint(proxy);
  return generateMacOSFingerprint(proxy);
}

export function generateFakeIPForProxy(proxy: ProxyConfig): string {
  return generateFakeIP(proxy.state);
}

export function generateProfileName(os: OS, count: number): string {
  return `${os}-Profile-${String(count).padStart(3, '0')}`;
}
