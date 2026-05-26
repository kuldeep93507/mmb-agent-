'use strict';

/**
 * UniquenessValidator Service
 * 
 * Validates fingerprint and proxy uniqueness across all active profiles.
 * Ensures no two profiles share the same fingerprint combination or proxy session ID.
 * 
 * Fingerprint uniqueness is determined by the COMBINATION of:
 *   - userAgent
 *   - resolution
 *   - webGLMeta (vendor + renderer concatenated)
 *   - geolocation (lat/lng rounded to 4 decimal places)
 * 
 * Proxy uniqueness is determined by session ID only (all proxies share same server:port).
 * 
 * @module UniquenessValidator
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CONSTANTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Profile statuses that should be checked for uniqueness conflicts.
 * Only active profiles (not deleted/archived) are considered.
 */
const ACTIVE_STATUSES = ['running', 'stopped', 'starting', 'error', 'recreating'];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UTILITY HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Round a number to 4 decimal places for geolocation comparison.
 * @param {number} value
 * @returns {number}
 */
function roundTo4Decimals(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Build a uniqueness signature — any matching signature = duplicate profile.
 * @param {object} config
 * @returns {string}
 */
function fingerprintSignature(config) {
  if (!config) return '';
  const fontsKey = Array.isArray(config.fonts)
    ? `${config.fonts.length}:${config.fonts.slice(0, 3).join(',')}`
    : '';
  const media = config.mediaDevices || {};
  return [
    config.userAgent || '',
    config.resolution || '',
    config.pixelRatio ?? '',
    config.timezone || '',
    config.language || '',
    config.cpu ?? '',
    config.ram ?? '',
    config.battery ?? '',
    config.canvasNoise?.seed || '',
    config.webGLNoise?.seed || '',
    config.audioContextNoise?.seed || '',
    config.webGLMeta?.vendor || '',
    config.webGLMeta?.renderer || '',
    roundTo4Decimals(config.geolocation?.lat || 0),
    roundTo4Decimals(config.geolocation?.lng || 0),
    media.audioInputs ?? '',
    media.videoInputs ?? '',
    media.audioOutputs ?? '',
    fontsKey,
  ].join('|');
}

/**
 * Extract the fingerprint comparison key from a fingerprint config.
 * @param {object} config - Fingerprint config object
 * @returns {{ userAgent: string, resolution: string, webGLKey: string, geoKey: string, signature: string }}
 */
function extractComparisonFields(config) {
  const userAgent = config.userAgent || '';
  const resolution = config.resolution || '';
  const webGLKey = (config.webGLMeta ? (config.webGLMeta.vendor || '') + (config.webGLMeta.renderer || '') : '');

  let geoLat = 0;
  let geoLng = 0;
  if (config.geolocation) {
    geoLat = roundTo4Decimals(config.geolocation.lat || 0);
    geoLng = roundTo4Decimals(config.geolocation.lng || 0);
  }
  const geoKey = `${geoLat},${geoLng}`;

  return {
    userAgent,
    resolution,
    webGLKey,
    geoKey,
    signature: fingerprintSignature(config),
    canvasSeed: config.canvasNoise?.seed || '',
    webglSeed: config.webGLNoise?.seed || '',
    audioSeed: config.audioContextNoise?.seed || '',
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UNIQUENESS VALIDATOR CLASS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class UniquenessValidator {
  /**
   * Validate that a fingerprint config is unique across all active profiles.
   * 
   * Checks the COMBINATION of:
   *   - userAgent
   *   - resolution
   *   - webGLMeta vendor + renderer (concatenated)
   *   - geolocation (lat/lng rounded to 4 decimal places)
   * 
   * A conflict occurs when ALL FOUR fields match an existing profile's combination exactly.
   * 
   * @param {object} config - The ExtendedFingerprintConfig to validate
   * @param {object[]} existingProfiles - Array of existing profile objects with fingerprint and status fields
   * @returns {{ unique: boolean, conflictField?: string, conflictProfileId?: string }}
   */
  validateFingerprint(config, existingProfiles) {
    if (!config || !existingProfiles || !Array.isArray(existingProfiles)) {
      return { unique: true };
    }

    const newFields = extractComparisonFields(config);

    for (const profile of existingProfiles) {
      // Only check against active profiles
      if (!profile.status || !ACTIVE_STATUSES.includes(profile.status)) {
        continue;
      }

      // Skip profiles without fingerprint data
      if (!profile.fingerprint) {
        continue;
      }

      const existingFields = extractComparisonFields(profile.fingerprint);

      // Full signature match (canvas/webgl/audio seeds + UA + GPU + screen + media)
      if (newFields.signature && newFields.signature === existingFields.signature) {
        return {
          unique: false,
          conflictField: 'fingerprint_signature',
          conflictProfileId: profile.id || profile._id || undefined,
        };
      }

      // Individual seed collision (must be globally unique per profile)
      if (newFields.canvasSeed && newFields.canvasSeed === existingFields.canvasSeed) {
        return { unique: false, conflictField: 'canvasNoise.seed', conflictProfileId: profile.id || profile._id };
      }
      if (newFields.webglSeed && newFields.webglSeed === existingFields.webglSeed) {
        return { unique: false, conflictField: 'webGLNoise.seed', conflictProfileId: profile.id || profile._id };
      }
      if (newFields.audioSeed && newFields.audioSeed === existingFields.audioSeed) {
        return { unique: false, conflictField: 'audioContextNoise.seed', conflictProfileId: profile.id || profile._id };
      }

      // Legacy combination check (UA + resolution + WebGL + geo all same)
      const userAgentMatch = newFields.userAgent === existingFields.userAgent;
      const resolutionMatch = newFields.resolution === existingFields.resolution;
      const webGLMatch = newFields.webGLKey === existingFields.webGLKey;
      const geoMatch = newFields.geoKey === existingFields.geoKey;

      if (userAgentMatch && resolutionMatch && webGLMatch && geoMatch) {
        return {
          unique: false,
          conflictField: 'fingerprint_combination',
          conflictProfileId: profile.id || profile._id || undefined,
        };
      }
    }

    return { unique: true };
  }

  /**
   * Validate that a proxy session ID is unique across all active profiles.
   * 
   * Since all proxies share the same server:port, uniqueness is enforced
   * by session ID only.
   * 
   * @param {string} sessionId - The proxy session ID to validate
   * @param {object[]} existingProfiles - Array of existing profile objects with proxy and status fields
   * @returns {{ unique: boolean, conflictField?: string, conflictProfileId?: string }}
   */
  validateProxy(sessionId, existingProfiles) {
    if (!sessionId || !existingProfiles || !Array.isArray(existingProfiles)) {
      return { unique: true };
    }

    for (const profile of existingProfiles) {
      // Only check against active profiles
      if (!profile.status || !ACTIVE_STATUSES.includes(profile.status)) {
        continue;
      }

      // Skip profiles without proxy data
      if (!profile.proxy) {
        continue;
      }

      // Check session ID match
      const existingSessionId = profile.proxy.sessionId;
      if (existingSessionId && existingSessionId === sessionId) {
        return {
          unique: false,
          conflictField: 'proxy_sessionId',
          conflictProfileId: profile.id || profile._id || undefined,
        };
      }
    }

    return { unique: true };
  }
}

// Export a singleton instance and the class for testing
const uniquenessValidator = new UniquenessValidator();

module.exports = uniquenessValidator;
module.exports.UniquenessValidator = UniquenessValidator;
module.exports.fingerprintSignature = fingerprintSignature;
module.exports.extractComparisonFields = extractComparisonFields;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
