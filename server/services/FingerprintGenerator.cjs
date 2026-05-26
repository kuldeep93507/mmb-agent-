'use strict';

/**
 * FingerprintGenerator Service
 * 
 * Generates complete, unique fingerprint configurations for browser profiles.
 * Produces an ExtendedFingerprintConfig matching the typedef in fingerprintData.cjs.
 * 
 * All data pools are imported from fingerprintData.cjs.
 */

const {
  WINDOWS_USER_AGENTS,
  MACOS_USER_AGENTS,
  ANDROID_USER_AGENTS,
  WINDOWS_RESOLUTIONS,
  MACOS_RESOLUTIONS,
  ANDROID_RESOLUTIONS,
  WINDOWS_WEBGL_PAIRS,
  MACOS_WEBGL_PAIRS,
  ANDROID_WEBGL_PAIRS,
  FONT_POOL,
  SPEECH_VOICES_POOL,
  COUNTRY_LANGUAGE_MAP,
  STATE_TIMEZONE_MAP,
  ANDROID_DEVICES,
  MACOS_VERSIONS,
  CPU_CORES,
  RAM_SIZES,
  WEBRTC_MODES,
} = require('./fingerprintData.cjs');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UTILITY HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Select a random element from an array.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Chrome Mobile versions for Android UA generation — keep up to date with current releases
// Last updated: 2026-05 — Chrome 137 is current stable
const CHROME_MOBILE_VERSIONS = [
  // Chrome 137 (May 2026 — current stable)
  '137.0.7151.68',  '137.0.7151.55',
  // Chrome 136 (April 2026)
  '136.0.7103.125', '136.0.7103.92',  '136.0.7103.60',
  // Chrome 135 (March 2026)
  '135.0.7049.114', '135.0.7049.85',  '135.0.7049.52',
  // Chrome 134 (February 2026)
  '134.0.6998.135', '134.0.6998.107', '134.0.6998.72',
  // Chrome 133 (January 2026)
  '133.0.6943.98',  '133.0.6943.68',
  // Chrome 132 (December 2025)
  '132.0.6834.163', '132.0.6834.79',
  // Generic round-number versions (still common in UA strings)
  '136.0.0.0', '135.0.0.0', '134.0.0.0', '133.0.0.0',
];

/**
 * Build a realistic Android user-agent string from device data.
 * Uses the device's modelCode (real Android identifier) so UA matches the fingerprint device.
 * Format: Mozilla/5.0 (Linux; Android {ver}; {modelCode}) AppleWebKit/537.36 ... Chrome/{ver} Mobile Safari/537.36
 *
 * @param {object} device - Android device object with modelCode and androidVersion
 * @returns {string}
 */
function buildAndroidUserAgent(device) {
  const chromeVer = randomFrom(CHROME_MOBILE_VERSIONS);
  return `Mozilla/5.0 (Linux; Android ${device.androidVersion}; ${device.modelCode}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Mobile Safari/537.36`;
}

/**
 * Generate a random integer between min and max (inclusive).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Shuffle an array using Fisher-Yates and return a slice of the given size.
 * @template T
 * @param {T[]} arr - Source array (not mutated)
 * @param {number} count - Number of elements to pick
 * @returns {T[]}
 */
function randomSubset(arr, count) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

/**
 * Round a number to 4 decimal places.
 * @param {number} value
 * @returns {number}
 */
function roundTo4Decimals(value) {
  return Math.round(value * 10000) / 10000;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FINGERPRINT GENERATOR CLASS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class FingerprintGenerator {
  /**
   * Generate a complete ExtendedFingerprintConfig.
   *
   * @param {'Windows'|'macOS'|'Android'} os - Target operating system
   * @param {import('./fingerprintData.cjs').GeoData} geoData - Geographic data from GeoIP resolution
   * @param {string|null} [androidDeviceOverride] - Optional specific Android device model name (null = auto-random)
   * @returns {import('./fingerprintData.cjs').ExtendedFingerprintConfig}
   */
  generate(os, geoData, androidDeviceOverride = null) {
    // ── For Android: select device FIRST — UA, resolution, pixelRatio all come from device ──
    let androidDevice = null;
    if (os === 'Android') {
      androidDevice = this._selectAndroidDevice(androidDeviceOverride);
    }

    // Android UA is built FROM the device (modelCode + androidVersion) — ensures UA matches device.
    // Windows/macOS UA is randomly picked from the OS-specific pool.
    const userAgent = (os === 'Android' && androidDevice)
      ? buildAndroidUserAgent(androidDevice)
      : this.selectUserAgent(os);

    // Use device-specific resolution for Android, random pool for Windows/macOS
    const resolution = (os === 'Android' && androidDevice)
      ? androidDevice.resolution
      : this.selectResolution(os);
    const pixelRatio = (os === 'Android' && androidDevice)
      ? androidDevice.pixelRatio
      : (os === 'macOS' ? 2 : 1);
    const webGLMeta = this.selectWebGLMeta(os);
    const webGPU = this.deriveWebGPU(webGLMeta);
    const webRTC = this.selectWebRTCMode();
    const canvasNoise = { enabled: true, seed: this.generateNoiseSeed() };
    const webGLNoise = { enabled: true, seed: this.generateNoiseSeed() };
    const audioContextNoise = { enabled: true, seed: this.generateNoiseSeed() };

    // Geolocation from geoData, rounded to 4 decimal places
    const geolocation = {
      lat: roundTo4Decimals(geoData.latitude),
      lng: roundTo4Decimals(geoData.longitude),
    };

    // Timezone and language from geoData
    const timezone = geoData.timezone;
    const language = geoData.language;

    // Fonts: 40-120 entries from pool
    const fontCount = randomInt(40, 120);
    const fonts = randomSubset(FONT_POOL, Math.min(fontCount, FONT_POOL.length));

    // Media devices
    const mediaDevices = {
      audioInputs: randomInt(1, 4),
      videoInputs: randomInt(1, 3),
      audioOutputs: randomInt(1, 4),
    };

    // ClientRects: random boolean
    const clientRects = Math.random() < 0.5;

    // Speech voices: 20-40 entries from pool
    const voiceCount = randomInt(20, 40);
    const speechVoices = randomSubset(SPEECH_VOICES_POOL, Math.min(voiceCount, SPEECH_VOICES_POOL.length));

    // CPU and RAM based on OS
    const cpu = randomFrom(CPU_CORES[os] || CPU_CORES.Windows);
    const ram = randomFrom(RAM_SIZES[os] || RAM_SIZES.Windows);

    // Battery: unique per profile (20–100%), charging state random
    // Android always has battery; Windows/macOS laptops have battery too
    const battery = randomInt(20, 100);
    const batteryCharging = Math.random() < 0.4; // 40% chance charging

    /** @type {import('./fingerprintData.cjs').ExtendedFingerprintConfig} */
    const config = {
      userAgent,
      timezone,
      language,
      resolution,
      pixelRatio,
      webRTC,
      canvasNoise,
      webGLNoise,
      audioContextNoise,
      geolocation,
      fonts,
      mediaDevices,
      clientRects,
      speechVoices,
      webGLMeta,
      webGPU,
      cpu,
      ram,
      battery,
      batteryCharging,
    };

    // OS-specific fields
    if (os === 'Android' && androidDevice) {
      // androidDevice was already selected at top of generate() for resolution purposes
      config.deviceModel = androidDevice.model;
      config.androidVersion = androidDevice.androidVersion;
    } else if (os === 'macOS') {
      config.macOsVersion = randomFrom(MACOS_VERSIONS);
    }

    return config;
  }

  /**
   * Generate an 8-character alphanumeric noise seed (a-z, 0-9).
   * @returns {string}
   */
  generateNoiseSeed() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let seed = '';
    for (let i = 0; i < 8; i++) {
      seed += chars[Math.floor(Math.random() * chars.length)];
    }
    return seed;
  }

  /**
   * Select a random user-agent string appropriate for the given OS.
   * Each OS pool has at least 10 entries.
   * 
   * @param {'Windows'|'macOS'|'Android'} os
   * @returns {string}
   */
  selectUserAgent(os) {
    switch (os) {
      case 'Windows':
        return randomFrom(WINDOWS_USER_AGENTS);
      case 'macOS':
        return randomFrom(MACOS_USER_AGENTS);
      case 'Android':
        return randomFrom(ANDROID_USER_AGENTS);
      default:
        return randomFrom(WINDOWS_USER_AGENTS);
    }
  }

  /**
   * Select an OS-appropriate screen resolution from predefined lists.
   * 
   * @param {'Windows'|'macOS'|'Android'} os
   * @returns {string}
   */
  selectResolution(os) {
    switch (os) {
      case 'Windows':
        return randomFrom(WINDOWS_RESOLUTIONS);
      case 'macOS':
        return randomFrom(MACOS_RESOLUTIONS);
      case 'Android':
        return randomFrom(ANDROID_RESOLUTIONS);
      default:
        return randomFrom(WINDOWS_RESOLUTIONS);
    }
  }

  /**
   * Select an OS-appropriate WebGL vendor/renderer pair.
   * 
   * @param {'Windows'|'macOS'|'Android'} os
   * @returns {{vendor: string, renderer: string}}
   */
  selectWebGLMeta(os) {
    switch (os) {
      case 'Windows':
        return { ...randomFrom(WINDOWS_WEBGL_PAIRS) };
      case 'macOS':
        return { ...randomFrom(MACOS_WEBGL_PAIRS) };
      case 'Android':
        return { ...randomFrom(ANDROID_WEBGL_PAIRS) };
      default:
        return { ...randomFrom(WINDOWS_WEBGL_PAIRS) };
    }
  }

  /**
   * Derive WebGPU configuration from WebGL metadata.
   * Maps vendor → vendor, renderer → adapter.
   * 
   * @param {{vendor: string, renderer: string}} webGLMeta
   * @returns {{vendor: string, adapter: string}}
   */
  deriveWebGPU(webGLMeta) {
    return {
      vendor: webGLMeta.vendor,
      adapter: webGLMeta.renderer,
    };
  }

  /**
   * Select a random WebRTC mode from the valid options.
   * @returns {'disabled'|'real'|'forward'}
   */
  selectWebRTCMode() {
    return randomFrom(WEBRTC_MODES);
  }

  /**
   * Select an Android device — either a specific override or random from pool.
   * @param {string|null} [deviceOverride] - Specific device model name, or null for random
   * @returns {{model: string, androidVersion: string}}
   * @private
   */
  _selectAndroidDevice(deviceOverride = null) {
    if (deviceOverride) {
      // Try to find matching device in the pool (by model name substring match)
      const found = ANDROID_DEVICES.find(
        d => d.model.toLowerCase().includes(deviceOverride.toLowerCase()) ||
             deviceOverride.toLowerCase().includes(d.model.toLowerCase())
      );
      if (found) {
        return found;
      }

      // Not found in pool — create a synthetic entry with sensible defaults
      const versionMap = {
        'S24': '14', 'S23': '13', 'S22': '12', 'S21': '12',
        'Pixel 9': '15', 'Pixel 8': '14', 'Pixel 7': '13', 'Pixel 6': '12',
        'OnePlus 12': '14', 'OnePlus 11': '13',
        'Xiaomi 14': '14', 'Xiaomi 13': '13',
        'Edge 40 Pro': '13', 'Edge 40': '13',
        'Nothing Phone 2': '13', 'Nothing Phone 1': '12',
      };
      // Resolution map for known models not in pool
      const resMap = {
        'Ultra': { resolution: '1440x3088', pixelRatio: 3.0 },
        'Pro':   { resolution: '1344x2992', pixelRatio: 3.0 },
        '14':    { resolution: '1080x2400', pixelRatio: 2.625 },
      };

      let androidVersion = '13';
      for (const [key, ver] of Object.entries(versionMap)) {
        if (deviceOverride.includes(key)) { androidVersion = ver; break; }
      }
      let resolution = '1080x2400';
      let pixelRatio = 2.625;
      for (const [key, val] of Object.entries(resMap)) {
        if (deviceOverride.includes(key)) { resolution = val.resolution; pixelRatio = val.pixelRatio; break; }
      }
      // modelCode is used in buildAndroidUserAgent() — must always be present.
      // Use the override string itself as modelCode so the UA reflects the actual device.
      return { model: deviceOverride, modelCode: deviceOverride, androidVersion, resolution, pixelRatio };
    }
    return randomFrom(ANDROID_DEVICES);
  }
}

module.exports = FingerprintGenerator;
