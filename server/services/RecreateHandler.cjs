'use strict';

/**
 * RecreateHandler — Orchestrates profile recreation (delete + create fresh).
 *
 * Steps:
 *   1. Validate status (reject "recreating" or "starting")
 *   2. Set status to "recreating"
 *   3. Stop profile if running (30s timeout)
 *   4. Delete old profile via provider
 *   5. Create fresh profile (new proxy session, new fingerprint)
 *   6. Return new profile data
 *
 * Preserves: original name, OS, browserType, group
 *
 * Error handling:
 *   - Stop timeout → abort (status unchanged)
 *   - Deletion failed → abort (restore previous status)
 *   - Creation failed after deletion → set "error" status
 *
 * @module RecreateHandler
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9
 */

const { providerFactory } = require('../providers/ProviderFactory.cjs');
const fs = require('fs');
const path = require('path');
const { resolveCreateProxyType } = require('./proxyType.cjs');

function loadRecreateProxyType() {
  try {
    const settingsFile = path.join(__dirname, '..', '..', 'user-settings.json');
    if (fs.existsSync(settingsFile)) {
      return resolveCreateProxyType(null, JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ytProxyType);
    }
  } catch { /* ignore */ }
  return 'smartproxy';
}

function loadMultiloginPurgeOnDelete() {
  try {
    const settingsFile = path.join(__dirname, '..', '..', 'user-settings.json');
    if (fs.existsSync(settingsFile)) {
      const v = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).multiloginPurgeOnDelete;
      if (v === false || v === 'false') return false;
    }
  } catch { /* ignore */ }
  return true;
}

// Stop must cover Multilogin sequential launcher attempts (multiple endpoints × ~15s each).
const STOP_TIMEOUT_MS = Number(process.env.PROFILE_STOP_TIMEOUT_MS) || 120000;

/**
 * @typedef {object} RecreateOptions
 * @property {string} profileId - The profile ID to recreate
 * @property {'morelogin'|'multilogin'} browserType - Browser provider type
 * @property {boolean} preserveName - Whether to preserve the original profile name
 * @property {{ name: string, os: string, browserType: string, groupId?: string, status: string }} originalProfile - Original profile data
 * @property {Array<{name: string, value: string, domain: string, path?: string, expires?: number, httpOnly?: boolean, secure?: boolean}>} [cookies] - Optional cookies to import
 * @property {(profileId: string, newStatus: string) => void} [statusCallback] - Callback to update profile status externally
 */

/**
 * @typedef {object} RecreateResult
 * @property {number} code - Result code (0 = success, negative = error)
 * @property {string} message - Human-readable result message
 * @property {{ oldProfileId: string, newProfileId: string, newProxy: object, newFingerprint: object }|null} data - Result data or null on error
 */

class RecreateHandler {
  constructor() {
    // ProfileCreator is lazily loaded to avoid circular dependency issues
    // and because it may not exist yet during development
    this._profileCreator = null;
  }

  /**
   * Get the ProfileCreator instance (lazy-loaded).
   * @returns {object} ProfileCreator instance
   * @private
   */
  _getProfileCreator() {
    if (!this._profileCreator) {
      const ProfileCreator = require('./ProfileCreator.cjs');
      this._profileCreator = new ProfileCreator();  // must be instance, not class
    }
    return this._profileCreator;
  }

  /**
   * Recreate a profile: delete the old one and create a fresh replacement.
   *
   * @param {RecreateOptions} options - Recreation options
   * @returns {Promise<RecreateResult>}
   */
  async recreate(options) {
    const {
      profileId,
      browserType,
      preserveName,
      originalProfile,
      cookies,
      statusCallback,
      fingerprintConfig,
      proxyType,
    } = options;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 1: Validate status — reject "recreating" or "starting"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const currentStatus = originalProfile.status;

    if (currentStatus === 'recreating' || currentStatus === 'starting') {
      return {
        code: -8,
        message: `Cannot recreate profile: profile is currently "${currentStatus}". Please wait until the operation completes.`,
        data: null,
      };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 2: Set status to "recreating"
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (statusCallback) {
      statusCallback(profileId, 'recreating');
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 3: Stop profile if marked running (RecreateHandler timeout must exceed provider's multi-endpoint stop)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (currentStatus === 'running') {
      const stopResult = await this._stopWithTimeout(profileId, browserType, options.cdpPort);

      if (!stopResult.success) {
        // Check if failure is a "zombie" stop — browser not responding but may actually be dead.
        // "Could not stop profile — browser may still be open in Multilogin" means all launcher
        // endpoints returned errors but we can't confirm the process is live.
        // In this case: proceed to deletion anyway (Cloud API delete works regardless of launcher state).
        const isZombieOrUnreachable = stopResult.error && (
          /could not stop|browser may still be open|not running|already stopped/i.test(stopResult.error)
        );

        if (isZombieOrUnreachable) {
          console.warn(`[RecreateHandler] Stop soft-failed (zombie/unreachable) — proceeding to deletion: ${stopResult.error}`);
          // Fall through to Step 4: deletion
        } else {
          // Hard failure (timeout, network, auth error) → abort and restore previous status
          if (statusCallback) {
            statusCallback(profileId, currentStatus);
          }
          return {
            code: -8,
            message: `Recreate aborted: failed to stop profile within ${STOP_TIMEOUT_MS / 1000} seconds. ${stopResult.error || ''}`.trim(),
            data: null,
          };
        }
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 4: Delete old profile via provider
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const deleteResult = await this._deleteProfile(profileId, browserType);

    if (!deleteResult.success) {
      // Deletion failed → abort, restore previous status
      if (statusCallback) {
        statusCallback(profileId, currentStatus);
      }
      return {
        code: -1,
        message: `Recreate aborted: failed to delete old profile. ${deleteResult.error || ''}`.trim(),
        data: null,
      };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 5: Create fresh profile (new proxy, new fingerprint)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const createOptions = {
      name: preserveName ? originalProfile.name : undefined,
      os: originalProfile.os || 'Windows',
      browserType: browserType,
      cookies: cookies || undefined,
      groupId: originalProfile.groupId || undefined,
      proxyType: proxyType || loadRecreateProxyType(),
      fingerprintConfig: fingerprintConfig || {
        canvas: 'real',
        webrtc: 'real',
        timezone: 'real',
        screen: 'real',
        navigator: 'real',
      },
    };

    let createResult;
    try {
      const profileCreator = this._getProfileCreator();
      createResult = await profileCreator.createProfile(createOptions);
    } catch (err) {
      // Creation failed after deletion → set "error" status
      if (statusCallback) {
        statusCallback(profileId, 'error');
      }
      return {
        code: -9,
        message: `Recreate partially failed: old profile was deleted but new profile creation failed. Error: ${err.message}`,
        data: null,
      };
    }

    // Check if ProfileCreator returned an error response
    if (!createResult || createResult.code !== 0) {
      // Creation failed after deletion → set "error" status
      if (statusCallback) {
        statusCallback(profileId, 'error');
      }
      return {
        code: -9,
        message: `Recreate partially failed: old profile was deleted but new profile creation failed. ${createResult ? createResult.message : 'Unknown error'}`,
        data: null,
      };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 6: Return new profile data
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const newData = createResult.data;

    return {
      code: 0,
      message: 'Profile recreated successfully',
      data: {
        oldProfileId: profileId,
        newProfileId: newData.id,
        newProxy: newData.proxy || null,
        newFingerprint: newData.fingerprint || null,
      },
    };
  }

  /**
   * Stop a profile with bounded timeout (default 120s — Multilogin may hit several launcher endpoints sequentially).
   *
   * @param {string} profileId - Profile ID to stop
   * @param {string} browserType - Browser provider type
   * @returns {Promise<{ success: boolean, error?: string }>}
   * @private
   */
  async _stopWithTimeout(profileId, browserType, cdpPort) {
    try {
      const provider = providerFactory.getProvider(browserType);

      // Race between stop operation and timeout
      const stopOpts = cdpPort ? { cdpPort } : {};
      const stopPromise = provider.stopProfile(profileId, stopOpts);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Stop operation timed out after ${STOP_TIMEOUT_MS / 1000} seconds`));
        }, STOP_TIMEOUT_MS);
      });

      const result = await Promise.race([stopPromise, timeoutPromise]);

      // Check if provider returned success
      if (result && result.code === 0) {
        return { success: true };
      }

      // Non-zero code but not a hard failure — profile might already be stopped
      // Treat as success if the profile is simply not running
      if (result && (result.message?.toLowerCase().includes('not running') ||
          result.message?.toLowerCase().includes('already stopped'))) {
        return { success: true };
      }

      return { success: false, error: result ? result.message : 'Unknown stop error' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Delete a profile via the appropriate provider.
   *
   * @param {string} profileId - Profile ID to delete
   * @param {string} browserType - Browser provider type
   * @returns {Promise<{ success: boolean, error?: string }>}
   * @private
   */
  async _deleteProfile(profileId, browserType) {
    try {
      const provider = providerFactory.getProvider(browserType);
      const permanently = browserType === 'multilogin' && loadMultiloginPurgeOnDelete();
      const result = await provider.deleteProfile(profileId, { permanently });

      if (result && result.code === 0) {
        return { success: true };
      }

      return { success: false, error: result ? result.message : 'Unknown deletion error' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

module.exports = RecreateHandler;
