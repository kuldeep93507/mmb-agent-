'use strict';

/**
 * Fingerprint Data Constants & Pools
 * 
 * Provides predefined pools for fingerprint generation across all supported
 * operating systems (Windows, macOS, Android). Used by FingerprintGenerator
 * to produce unique, realistic browser fingerprints.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// JSDOC TYPE DEFINITIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * @typedef {Object} NoiseSetting
 * @property {boolean} enabled - Whether noise is enabled
 * @property {string} seed - 8-character alphanumeric seed
 */

/**
 * @typedef {Object} GeoLocation
 * @property {number} lat - Latitude (-90 to 90, 4 decimal places)
 * @property {number} lng - Longitude (-180 to 180, 4 decimal places)
 */

/**
 * @typedef {Object} MediaDevices
 * @property {number} audioInputs - Number of audio input devices (1-4)
 * @property {number} videoInputs - Number of video input devices (1-3)
 * @property {number} audioOutputs - Number of audio output devices (1-4)
 */

/**
 * @typedef {Object} WebGLMeta
 * @property {string} vendor - WebGL vendor string
 * @property {string} renderer - WebGL renderer string
 */

/**
 * @typedef {Object} WebGPUConfig
 * @property {string} vendor - WebGPU vendor (derived from WebGL vendor)
 * @property {string} adapter - WebGPU adapter (derived from WebGL renderer)
 */

/**
 * Extended fingerprint configuration for full profile creation.
 * Contains all browser identity parameters needed to create a unique,
 * undetectable browser profile across antidetect providers.
 * 
 * @typedef {Object} ExtendedFingerprintConfig
 * @property {string} userAgent - Full user-agent string
 * @property {string} timezone - IANA timezone string (e.g., 'America/New_York')
 * @property {string} language - BCP-47 language tag (e.g., 'en-US')
 * @property {string} resolution - Screen resolution (e.g., '1920x1080')
 * @property {'disabled'|'real'|'forward'} webRTC - WebRTC leak protection mode
 * @property {NoiseSetting} canvasNoise - Canvas fingerprint noise settings
 * @property {NoiseSetting} webGLNoise - WebGL image noise settings
 * @property {NoiseSetting} audioContextNoise - AudioContext noise settings
 * @property {GeoLocation} geolocation - Geographic coordinates
 * @property {string[]} fonts - List of font family names (40-120 entries)
 * @property {MediaDevices} mediaDevices - Media device counts
 * @property {boolean} clientRects - ClientRects noise flag
 * @property {string[]} speechVoices - List of speech synthesis voices (20-40 entries)
 * @property {WebGLMeta} webGLMeta - WebGL vendor and renderer
 * @property {WebGPUConfig} webGPU - WebGPU vendor and adapter
 * @property {number} cpu - CPU core count
 * @property {number} ram - RAM in GB
 * @property {string} [deviceModel] - Android device model
 * @property {string} [androidVersion] - Android OS version
 * @property {string} [macOsVersion] - macOS version string
 * @property {number} [battery] - Battery level (0-100)
 */

/**
 * @typedef {Object} GeoData
 * @property {string} timezone - IANA timezone
 * @property {string} language - BCP-47 language tag
 * @property {number} latitude - Latitude coordinate
 * @property {number} longitude - Longitude coordinate
 * @property {string} country - Country code (e.g., 'US')
 * @property {string} region - Region/state code
 * @property {string} city - City name
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// USER-AGENT POOLS (10+ per OS)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


/** Windows Chrome/Firefox user-agents */
const WINDOWS_USER_AGENTS = [
  // ── Chrome on Windows 10 ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
  // ── Chrome on Windows 11 (same NT 10.0 string) with patch versions ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.130 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.184 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.216 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.200 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.118 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.5938.150 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.188 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.171 Safari/537.36',
  // ── Firefox on Windows ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:119.0) Gecko/20100101 Firefox/119.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:117.0) Gecko/20100101 Firefox/117.0',
  // ── Microsoft Edge on Windows ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.2478.97 Safari/537.36 Edg/124.0.2478.97',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.2420.97 Safari/537.36 Edg/123.0.2420.97',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.2365.92 Safari/537.36 Edg/122.0.2365.92',
  // ── Opera on Windows ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OPR/108.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0',
  // ── Brave on Windows ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Brave/124',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Brave/122',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Brave/120',
  // ── Chrome on Windows 7 (still common) ──
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  // ── Vivaldi on Windows ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Vivaldi/6.7',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Vivaldi/6.6',
  // ── Chrome with different WebKit versions ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:122.0) Gecko/20100101 Firefox/122.0',
  // ── Chrome additional patch variants ──
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.60 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.86 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.94 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.140 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.130 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.159 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.88 Safari/537.36',
];

/** macOS Chrome/Safari/Firefox/Edge user-agents */
const MACOS_USER_AGENTS = [
  // ── Chrome on macOS Sonoma (14.x) ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
  // ── Chrome with patch versions on macOS ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.130 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.184 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.216 Safari/537.36',
  // ── Chrome on macOS 14.x (Sonoma) ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  // ── Chrome on macOS 13.x (Ventura) ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  // ── Safari on macOS ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  // ── Firefox on macOS ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
  // ── Edge on macOS ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  // ── Opera on macOS ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 OPR/108.0.0.0',
  // ── Brave on macOS ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Brave/124',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Brave/122',
  // ── macOS 12.x (Monterey) Chrome ──
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];

/** Android mobile user-agents */
const ANDROID_USER_AGENTS = [
  // ── Samsung Galaxy S-series ──
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S926B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  // ── Samsung Galaxy A-series ──
  'Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-A346B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-A236B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  // ── Google Pixel ──
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36',
  // ── Xiaomi / Redmi ──
  'Mozilla/5.0 (Linux; Android 13; 2201123G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; 2201123G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; M2101K6G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; 22081212UG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; 21121119SC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  // ── OnePlus ──
  'Mozilla/5.0 (Linux; Android 14; CPH2609) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; CPH2451) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; CPH2451) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  // ── OPPO / Realme ──
  'Mozilla/5.0 (Linux; Android 13; CPH2525) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; RMX3771) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; RMX3311) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  // ── Motorola ──
  'Mozilla/5.0 (Linux; Android 13; motorola edge 40 pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; motorola edge 40) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; moto g84 5g) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; moto g62 5g) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Mobile Safari/537.36',
  // ── Vivo / iQOO ──
  'Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; V2205) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  // ── Nothing Phone ──
  'Mozilla/5.0 (Linux; Android 13; A065) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; A063) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  // ── Chrome with patch versions on Android ──
  'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.130 Mobile Safari/537.36',
  // ── Android 15 early adopters ──
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  // ── Sony Xperia ──
  'Mozilla/5.0 (Linux; Android 13; XQ-EC72) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; XQ-BT52) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  // ── Low-end / budget devices ──
  'Mozilla/5.0 (Linux; Android 13; A5010) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Redmi Note 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCREEN RESOLUTIONS PER OS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Common desktop resolutions for Windows */
const WINDOWS_RESOLUTIONS = [
  '1920x1080',
  '1366x768',
  '1536x864',
  '1440x900',
  '1280x720',
  '2560x1440',
  '1600x900',
  '1280x1024',
];

/** macOS Retina and standard resolutions */
const MACOS_RESOLUTIONS = [
  '2560x1600',
  '2560x1440',
  '1440x900',
];

/** Android mobile resolutions */
const ANDROID_RESOLUTIONS = [
  '1080x2340',
  '1080x2400',
  '1080x2412',
  '1080x2408',
  '1080x1920',
  '1440x3200',
  '1440x3088',
  '720x1600',
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBGL VENDOR/RENDERER PAIRS PER OS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Windows WebGL vendor/renderer pairs */
const WINDOWS_WEBGL_PAIRS = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

/** macOS WebGL vendor/renderer pairs (Apple Silicon + Intel) */
const MACOS_WEBGL_PAIRS = [
  { vendor: 'Apple', renderer: 'Apple M1' },
  { vendor: 'Apple', renderer: 'Apple M1 Pro' },
  { vendor: 'Apple', renderer: 'Apple M1 Max' },
  { vendor: 'Apple', renderer: 'Apple M2' },
  { vendor: 'Apple', renderer: 'Apple M2 Pro' },
  { vendor: 'Apple', renderer: 'Apple M2 Max' },
  { vendor: 'Apple', renderer: 'Apple M3' },
  { vendor: 'Apple', renderer: 'Apple M3 Pro' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 OpenGL Engine)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics 645 OpenGL Engine)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon Pro 5300M OpenGL Engine)' },
];

/** Android WebGL vendor/renderer pairs */
const ANDROID_WEBGL_PAIRS = [
  { vendor: 'Qualcomm', renderer: 'Adreno (TM) 740' },
  { vendor: 'Qualcomm', renderer: 'Adreno (TM) 730' },
  { vendor: 'Qualcomm', renderer: 'Adreno (TM) 660' },
  { vendor: 'Qualcomm', renderer: 'Adreno (TM) 650' },
  { vendor: 'Qualcomm', renderer: 'Adreno (TM) 642L' },
  { vendor: 'ARM', renderer: 'Mali-G710 MC10' },
  { vendor: 'ARM', renderer: 'Mali-G78 MP20' },
  { vendor: 'ARM', renderer: 'Mali-G68 MC4' },
  { vendor: 'ARM', renderer: 'Mali-G77 MC9' },
  { vendor: 'ARM', renderer: 'Mali-G710 MC12' },
  { vendor: 'Qualcomm', renderer: 'Adreno (TM) 732' },
  { vendor: 'Qualcomm', renderer: 'Adreno (TM) 620' },
];


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FONT POOL (200+ entries)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Predefined pool of font family names for fingerprint generation */
const FONT_POOL = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold',
  'Bahnschrift', 'Calibri', 'Calibri Light', 'Cambria', 'Cambria Math',
  'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel',
  'Courier', 'Courier New', 'Ebrima', 'Franklin Gothic Medium',
  'Gabriola', 'Gadugi', 'Georgia', 'HoloLens MDL2 Assets',
  'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI',
  'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic',
  'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei',
  'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
  'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti',
  'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MS PGothic',
  'MS UI Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
  'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print',
  'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic',
  'Segoe UI Symbol', 'SimSun', 'Sitka Banner', 'Sitka Display',
  'Sitka Heading', 'Sitka Small', 'Sitka Subheading', 'Sitka Text',
  'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
  'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  'Yu Gothic UI', 'Yu Mincho',
  // Extended common fonts
  'Helvetica', 'Helvetica Neue', 'Geneva', 'Optima', 'Futura',
  'Gill Sans', 'Avenir', 'Avenir Next', 'Baskerville',
  'Big Caslon', 'Bodoni 72', 'Bookman Old Style', 'Bradley Hand',
  'Brush Script MT', 'Century Gothic', 'Century Schoolbook',
  'Chalkboard', 'Chalkboard SE', 'Chalkduster', 'Charter',
  'Cochin', 'Copperplate', 'Didot', 'Euphemia UCAS',
  'Herculanum', 'Hoefler Text', 'Iowan Old Style', 'Kefa',
  'Kohinoor Bangla', 'Kohinoor Devanagari', 'Kohinoor Telugu',
  'Lucida Grande', 'Luminari', 'Marion', 'Marker Felt',
  'Menlo', 'Monaco', 'Noteworthy', 'Palatino', 'Papyrus',
  'Phosphate', 'Rockwell', 'Savoye LET', 'SignPainter',
  'Skia', 'Snell Roundhand', 'STIXGeneral', 'Superclarendon',
  'Trattatello', 'Zapfino',
  // Google Fonts / Web-common
  'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Oswald',
  'Source Sans Pro', 'Raleway', 'PT Sans', 'Merriweather',
  'Noto Sans', 'Noto Serif', 'Ubuntu', 'Playfair Display',
  'Poppins', 'Nunito', 'Rubik', 'Work Sans', 'Fira Sans',
  'Quicksand', 'Karla', 'Cabin', 'Barlow', 'Mulish',
  'Inter', 'DM Sans', 'Manrope', 'Space Grotesk', 'Outfit',
  'Plus Jakarta Sans', 'Red Hat Display', 'Lexend',
  'IBM Plex Sans', 'IBM Plex Mono', 'IBM Plex Serif',
  'JetBrains Mono', 'Fira Code', 'Source Code Pro',
  'Droid Sans', 'Droid Serif', 'Droid Sans Mono',
  'PT Serif', 'PT Mono', 'Libre Baskerville', 'Libre Franklin',
  'Crimson Text', 'Josefin Sans', 'Josefin Slab',
  'Exo 2', 'Titillium Web', 'Archivo', 'Archivo Narrow',
  'Hind', 'Hind Siliguri', 'Hind Madurai',
  'Mukta', 'Overpass', 'Asap', 'Catamaran',
  'Cormorant Garamond', 'EB Garamond', 'Spectral',
  'Bitter', 'Domine', 'Vollkorn', 'Alegreya',
  'Alegreya Sans', 'Cardo', 'Gentium Book Basic',
  'Neuton', 'Old Standard TT', 'Sorts Mill Goudy',
  'Amatic SC', 'Caveat', 'Dancing Script', 'Great Vibes',
  'Indie Flower', 'Kaushan Script', 'Lobster', 'Pacifico',
  'Sacramento', 'Satisfy', 'Shadows Into Light',
  'Yanone Kaffeesatz', 'Zilla Slab', 'Inconsolata',
  'Anonymous Pro', 'Cousine', 'Cutive Mono', 'Share Tech Mono',
  'Space Mono', 'Ubuntu Mono', 'VT323',
  'Abel', 'Acme', 'Advent Pro', 'Alata', 'Albert Sans',
  'Aleo', 'Alice', 'Alike', 'Allerta', 'Allura',
  'Amiri', 'Antic Slab', 'Anton', 'Arimo', 'Arvo',
  'Assistant', 'Atkinson Hyperlegible', 'Audiowide',
  'Bangers', 'Be Vietnam Pro', 'Bebas Neue', 'Belleza',
  'BioRhyme', 'Black Ops One', 'Bree Serif', 'Cantarell',
  'Charm', 'Chivo', 'Cinzel', 'Commissioner',
  'Comfortaa', 'Concert One', 'Cookie', 'Courgette',
  'Cuprum', 'DM Mono', 'DM Serif Display', 'Encode Sans',
  'Epilogue', 'Exo', 'Fahkwang', 'Figtree',
  'Francois One', 'Fredoka One', 'Gochi Hand',
  'Gothic A1', 'Gruppo', 'Gudea', 'Handlee',
  'Heebo', 'Hind Guntur', 'IBM Plex Sans Condensed',
];


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SPEECH VOICES POOL (60+ entries)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Predefined pool of speech synthesis voice names */
const SPEECH_VOICES_POOL = [
  'Microsoft David - English (United States)',
  'Microsoft Zira - English (United States)',
  'Microsoft Mark - English (United States)',
  'Google US English',
  'Google UK English Female',
  'Google UK English Male',
  'Alex',
  'Daniel',
  'Karen',
  'Moira',
  'Samantha',
  'Tessa',
  'Victoria',
  'Fred',
  'Agnes',
  'Albert',
  'Bad News',
  'Bahh',
  'Bells',
  'Boing',
  'Bruce',
  'Bubbles',
  'Cellos',
  'Deranged',
  'Good News',
  'Hysterical',
  'Junior',
  'Kathy',
  'Pipe Organ',
  'Princess',
  'Ralph',
  'Trinoids',
  'Whisper',
  'Zarvox',
  'Google Deutsch',
  'Google Español',
  'Google Français',
  'Google Italiano',
  'Google 日本語',
  'Google 한국의',
  'Google Nederlands',
  'Google Polski',
  'Google Português do Brasil',
  'Google Русский',
  'Google हिन्दी',
  'Google 中文（简体）',
  'Google 中文（繁體）',
  'Microsoft Hazel - English (Great Britain)',
  'Microsoft Susan - English (Great Britain)',
  'Microsoft George - English (Great Britain)',
  'Microsoft Heera - English (India)',
  'Microsoft Ravi - English (India)',
  'Microsoft Sabina - Czech',
  'Microsoft Hortense - French (France)',
  'Microsoft Julie - French (France)',
  'Microsoft Paul - French (France)',
  'Microsoft Hedda - German',
  'Microsoft Katja - German',
  'Microsoft Stefan - German',
  'Microsoft Elsa - Italian',
  'Microsoft Cosimo - Italian',
  'Microsoft Haruka - Japanese',
  'Microsoft Ichiro - Japanese',
  'Microsoft Heami - Korean',
  'Microsoft Helena - Spanish (Spain)',
  'Microsoft Laura - Spanish (Spain)',
  'Microsoft Pablo - Spanish (Spain)',
  'Microsoft Sabina - Spanish (Mexico)',
  'Microsoft Raul - Spanish (Mexico)',
  'Microsoft Irina - Russian',
  'Microsoft Pavel - Russian',
  'Microsoft Huihui - Chinese (Simplified)',
  'Microsoft Yaoyao - Chinese (Simplified)',
  'Microsoft Kangkang - Chinese (Simplified)',
  'Microsoft Tracy - Chinese (Traditional)',
  'Microsoft Danny - Chinese (Traditional)',
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// COUNTRY-TO-LANGUAGE MAPPING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maps country codes to BCP-47 language tags */
const COUNTRY_LANGUAGE_MAP = {
  US: 'en-US',
  GB: 'en-GB',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  IE: 'en-IE',
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  BE: 'fr-BE',
  ES: 'es-ES',
  MX: 'es-MX',
  AR: 'es-AR',
  CO: 'es-CO',
  CL: 'es-CL',
  PE: 'es-PE',
  IT: 'it-IT',
  PT: 'pt-PT',
  BR: 'pt-BR',
  NL: 'nl-NL',
  PL: 'pl-PL',
  RU: 'ru-RU',
  UA: 'uk-UA',
  CZ: 'cs-CZ',
  SK: 'sk-SK',
  RO: 'ro-RO',
  HU: 'hu-HU',
  SE: 'sv-SE',
  NO: 'nb-NO',
  DK: 'da-DK',
  FI: 'fi-FI',
  JP: 'ja-JP',
  KR: 'ko-KR',
  CN: 'zh-CN',
  TW: 'zh-TW',
  HK: 'zh-HK',
  IN: 'hi-IN',
  TH: 'th-TH',
  VN: 'vi-VN',
  ID: 'id-ID',
  MY: 'ms-MY',
  PH: 'fil-PH',
  TR: 'tr-TR',
  SA: 'ar-SA',
  AE: 'ar-AE',
  EG: 'ar-EG',
  IL: 'he-IL',
  GR: 'el-GR',
  BG: 'bg-BG',
  HR: 'hr-HR',
  RS: 'sr-RS',
  SI: 'sl-SI',
  ZA: 'en-ZA',
  NG: 'en-NG',
  KE: 'en-KE',
  GH: 'en-GH',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STATE-TO-TIMEZONE MAPPING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maps US state abbreviations to IANA timezone strings */
const STATE_TIMEZONE_MAP = {
  TX: 'America/Chicago',
  CA: 'America/Los_Angeles',
  NY: 'America/New_York',
  FL: 'America/New_York',
  WA: 'America/Los_Angeles',
  IL: 'America/Chicago',
  AZ: 'America/Phoenix',
  GA: 'America/New_York',
  NC: 'America/New_York',
  OH: 'America/New_York',
  PA: 'America/New_York',
  MI: 'America/Detroit',
  NJ: 'America/New_York',
  VA: 'America/New_York',
  MA: 'America/New_York',
  TN: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  MO: 'America/Chicago',
  MD: 'America/New_York',
  WI: 'America/Chicago',
  CO: 'America/Denver',
  MN: 'America/Chicago',
  SC: 'America/New_York',
  AL: 'America/Chicago',
  LA: 'America/Chicago',
  KY: 'America/New_York',
  OR: 'America/Los_Angeles',
  OK: 'America/Chicago',
  CT: 'America/New_York',
  UT: 'America/Denver',
  NV: 'America/Los_Angeles',
  AR: 'America/Chicago',
  MS: 'America/Chicago',
  KS: 'America/Chicago',
  NM: 'America/Denver',
  NE: 'America/Chicago',
  ID: 'America/Boise',
  HI: 'Pacific/Honolulu',
  WV: 'America/New_York',
  NH: 'America/New_York',
  ME: 'America/New_York',
  MT: 'America/Denver',
  RI: 'America/New_York',
  DE: 'America/New_York',
  SD: 'America/Chicago',
  ND: 'America/Chicago',
  AK: 'America/Anchorage',
  VT: 'America/New_York',
  WY: 'America/Denver',
  DC: 'America/New_York',
};

/**
 * Maps full SmartProxy state names → IANA timezone strings.
 * Used to derive timezone from proxy state so fingerprint matches exit IP location.
 */
const FULL_STATE_TIMEZONE_MAP = {
  TEXAS:         'America/Chicago',
  CALIFORNIA:    'America/Los_Angeles',
  NEWYORK:       'America/New_York',
  FLORIDA:       'America/New_York',
  WASHINGTON:    'America/Los_Angeles',
  ILLINOIS:      'America/Chicago',
  ARIZONA:       'America/Phoenix',
  GEORGIA:       'America/New_York',
  NORTHCAROLINA: 'America/New_York',
  OHIO:          'America/New_York',
  PENNSYLVANIA:  'America/New_York',
  MICHIGAN:      'America/Detroit',
  NEWJERSEY:     'America/New_York',
  VIRGINIA:      'America/New_York',
  MASSACHUSETTS: 'America/New_York',
  TENNESSEE:     'America/Chicago',
  INDIANA:       'America/Indiana/Indianapolis',
  MISSOURI:      'America/Chicago',
  MARYLAND:      'America/New_York',
  COLORADO:      'America/Denver',
  MINNESOTA:     'America/Chicago',
  SOUTHCAROLINA: 'America/New_York',
  ALABAMA:       'America/Chicago',
  LOUISIANA:     'America/Chicago',
  KENTUCKY:      'America/New_York',
  OREGON:        'America/Los_Angeles',
  OKLAHOMA:      'America/Chicago',
  CONNECTICUT:   'America/New_York',
  UTAH:          'America/Denver',
  NEVADA:        'America/Los_Angeles',
  ARKANSAS:      'America/Chicago',
  MISSISSIPPI:   'America/Chicago',
  KANSAS:        'America/Chicago',
  NEWMEXICO:     'America/Denver',
  NEBRASKA:      'America/Chicago',
  IDAHO:         'America/Boise',
  HAWAII:        'Pacific/Honolulu',
  WESTVIRGINIA:  'America/New_York',
  NEWHAMPSHIRE:  'America/New_York',
  MAINE:         'America/New_York',
  MONTANA:       'America/Denver',
  RHODEISLAND:   'America/New_York',
  DELAWARE:      'America/New_York',
  SOUTHDAKOTA:   'America/Chicago',
  NORTHDAKOTA:   'America/Chicago',
  ALASKA:        'America/Anchorage',
  VERMONT:       'America/New_York',
  WYOMING:       'America/Denver',
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ANDROID DEVICE MODELS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Android device models with exact specs.
 * model      = display name (shown in UI)
 * modelCode  = real Android UA identifier (what Chrome puts in the UA string)
 * resolution = "widthxheight" portrait (width < height)
 * pixelRatio = device pixel ratio (DPR) — 2.0 / 2.625 / 3.0
 * androidVersion = OS version string
 *
 * UA generated as:
 *   Mozilla/5.0 (Linux; Android {ver}; {modelCode}) AppleWebKit/537.36 ... Chrome/xxx Mobile Safari/537.36
 */
const ANDROID_DEVICES = [
  // ── Samsung Galaxy S-series ──
  { model: 'Samsung Galaxy S24 Ultra', modelCode: 'SM-S928B', androidVersion: '14', resolution: '1440x3088', pixelRatio: 3.0 },
  { model: 'Samsung Galaxy S24',       modelCode: 'SM-S921B', androidVersion: '14', resolution: '1080x2340', pixelRatio: 2.625 },
  { model: 'Samsung Galaxy S23 Ultra', modelCode: 'SM-S918B', androidVersion: '13', resolution: '1440x3088', pixelRatio: 3.0 },
  { model: 'Samsung Galaxy S23',       modelCode: 'SM-S911B', androidVersion: '13', resolution: '1080x2340', pixelRatio: 2.625 },
  { model: 'Samsung Galaxy S22',       modelCode: 'SM-S901B', androidVersion: '12', resolution: '1080x2340', pixelRatio: 2.625 },
  { model: 'Samsung Galaxy S21',       modelCode: 'SM-G991B', androidVersion: '12', resolution: '1080x2400', pixelRatio: 2.625 },
  // ── Samsung Galaxy A-series ──
  { model: 'Samsung Galaxy A54',       modelCode: 'SM-A546B', androidVersion: '13', resolution: '1080x2340', pixelRatio: 2.625 },
  { model: 'Samsung Galaxy A34',       modelCode: 'SM-A346B', androidVersion: '13', resolution: '1080x2340', pixelRatio: 2.625 },
  { model: 'Samsung Galaxy A14',       modelCode: 'SM-A145F', androidVersion: '13', resolution: '1080x2408', pixelRatio: 2.0 },
  // ── Google Pixel (uses product name directly in UA) ──
  { model: 'Google Pixel 8 Pro',       modelCode: 'Pixel 8 Pro',  androidVersion: '14', resolution: '1344x2992', pixelRatio: 3.0 },
  { model: 'Google Pixel 8',           modelCode: 'Pixel 8',      androidVersion: '14', resolution: '1080x2400', pixelRatio: 2.625 },
  { model: 'Google Pixel 7 Pro',       modelCode: 'Pixel 7 Pro',  androidVersion: '13', resolution: '1440x3120', pixelRatio: 3.0 },
  { model: 'Google Pixel 7',           modelCode: 'Pixel 7',      androidVersion: '13', resolution: '1080x2400', pixelRatio: 2.625 },
  { model: 'Google Pixel 6a',          modelCode: 'Pixel 6a',     androidVersion: '12', resolution: '1080x2400', pixelRatio: 2.625 },
  { model: 'Google Pixel 6',           modelCode: 'Pixel 6',      androidVersion: '12', resolution: '1080x2400', pixelRatio: 2.625 },
  // ── OnePlus ──
  { model: 'OnePlus 12',               modelCode: 'CPH2609',  androidVersion: '14', resolution: '1440x3168', pixelRatio: 3.0 },
  { model: 'OnePlus 11',               modelCode: 'CPH2449',  androidVersion: '13', resolution: '1440x3216', pixelRatio: 3.0 },
  { model: 'OnePlus Nord 3',           modelCode: 'CPH2493',  androidVersion: '13', resolution: '1080x2412', pixelRatio: 2.625 },
  // ── Xiaomi ──
  { model: 'Xiaomi 14 Pro',            modelCode: '2312DRA50G', androidVersion: '14', resolution: '1440x3200', pixelRatio: 3.0 },
  { model: 'Xiaomi 13',                modelCode: '2211133G',   androidVersion: '13', resolution: '1080x2400', pixelRatio: 2.625 },
  { model: 'Redmi Note 12 Pro',        modelCode: '22101316UCP',androidVersion: '13', resolution: '1080x2400', pixelRatio: 2.625 },
  // ── Motorola ──
  { model: 'Motorola Edge 40 Pro',     modelCode: 'XT2301-4', androidVersion: '13', resolution: '1080x2400', pixelRatio: 2.625 },
  { model: 'Motorola Edge 40',         modelCode: 'XT2303-2', androidVersion: '13', resolution: '1080x2400', pixelRatio: 2.625 },
  { model: 'Moto G84',                 modelCode: 'XT2347-3', androidVersion: '13', resolution: '1080x2400', pixelRatio: 2.0 },
  // ── OPPO / Realme / Nothing ──
  { model: 'OPPO Find X6 Pro',         modelCode: 'PGEM10', androidVersion: '13', resolution: '1440x3168', pixelRatio: 3.0 },
  { model: 'Realme GT5',               modelCode: 'RMX3764', androidVersion: '13', resolution: '1080x2412', pixelRatio: 2.625 },
  { model: 'Nothing Phone 2',          modelCode: 'A065',   androidVersion: '13', resolution: '1080x2412', pixelRatio: 2.625 },
  { model: 'Nothing Phone 1',          modelCode: 'A063',   androidVersion: '12', resolution: '1080x2400', pixelRatio: 2.625 },
  // ── Sony / Vivo ──
  { model: 'Sony Xperia 1 V',          modelCode: 'XQ-DQ72', androidVersion: '13', resolution: '1644x3840', pixelRatio: 3.0 },
  { model: 'Vivo X90 Pro',             modelCode: 'V2227A',  androidVersion: '13', resolution: '1260x2800', pixelRatio: 3.0 },
];

/** macOS version strings */
const MACOS_VERSIONS = ['12.6', '13.2', '13.4', '14.0', '14.1', '14.2', '14.3'];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CPU & RAM OPTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Available CPU core counts per OS */
const CPU_CORES = {
  Windows: [4, 6, 8, 12, 16],
  macOS: [8, 10, 12, 16, 20],
  Android: [4, 6, 8],
};

/** Available RAM sizes (GB) per OS */
const RAM_SIZES = {
  Windows: [8, 16, 32, 64],
  macOS: [8, 16, 32, 64],
  Android: [4, 6, 8, 12],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WEBRTC MODES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Valid WebRTC leak protection modes */
const WEBRTC_MODES = ['disabled', 'altered', 'altered', 'altered']; // 'real' removed — leaks IP

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

module.exports = {
  // User-agent pools
  WINDOWS_USER_AGENTS,
  MACOS_USER_AGENTS,
  ANDROID_USER_AGENTS,

  // Resolution pools
  WINDOWS_RESOLUTIONS,
  MACOS_RESOLUTIONS,
  ANDROID_RESOLUTIONS,

  // WebGL pairs
  WINDOWS_WEBGL_PAIRS,
  MACOS_WEBGL_PAIRS,
  ANDROID_WEBGL_PAIRS,

  // Font pool
  FONT_POOL,

  // Speech voices
  SPEECH_VOICES_POOL,

  // Geo mappings
  COUNTRY_LANGUAGE_MAP,
  STATE_TIMEZONE_MAP,
  FULL_STATE_TIMEZONE_MAP,

  // Device data
  ANDROID_DEVICES,
  MACOS_VERSIONS,

  // Hardware options
  CPU_CORES,
  RAM_SIZES,

  // Constants
  WEBRTC_MODES,
};
