'use strict';

/**
 * ProfileCreator — Orchestrates the full profile creation pipeline.
 *
 * Pipeline steps:
 *   1. Validate inputs (OS, browserType)
 *   2. Assign proxy via ProxyRotator
 *   3. Resolve GeoIP from proxy
 *   4. Generate fingerprint via FingerprintGenerator
 *   5. Validate uniqueness (retry up to 3 times)
 *   6. Build payload and call provider API (30s timeout)
 *   7. Import cookies (non-blocking)
 *
 * Error codes:
 *   -1  — Provider API error / unreachable
 *   -5  — Invalid browserType
 *   -6  — Proxy pool exhausted
 *   -7  — Fingerprint uniqueness exhausted (3 attempts)
 *   -10 — Provider API timeout (30s)
 *
 * No partial state: if any step fails (except cookies), no local record is persisted.
 *
 * @module ProfileCreator
 */

const proxyRotator = require('./ProxyRotator.cjs');
const GeoIPResolver = require('./GeoIPResolver.cjs');
const FingerprintGenerator = require('./FingerprintGenerator.cjs');
const uniquenessValidator = require('./UniquenessValidator.cjs');
const { providerFactory, VALID_PROVIDERS } = require('../providers/ProviderFactory.cjs');
const { FULL_STATE_TIMEZONE_MAP } = require('./fingerprintData.cjs');
const { normalizeProxyCountry, geoForProxyCountry } = require('./proxyCountry.cjs');
const { normalizeProxyType, isMultiloginProxyType, isSmartProxyType } = require('./proxyType.cjs');

// Valid OS options
const VALID_OS = ['Windows', 'macOS', 'Android'];

// Provider API timeout (30 seconds)
const PROVIDER_TIMEOUT_MS = 30000;

// Maximum uniqueness retry attempts
const MAX_UNIQUENESS_RETRIES = 3;

class ProfileCreator {
  constructor() {
    this.geoIPResolver = new GeoIPResolver();
    this.fingerprintGenerator = new FingerprintGenerator();
  }

  /**
   * Create a full profile with the complete pipeline.
   *
   * @param {object} options - Profile creation options
   * @param {string} [options.name] - Profile name (auto-generated if not provided)
   * @param {'Windows'|'macOS'|'Android'} options.os - Target operating system
   * @param {'morelogin'|'multilogin'} options.browserType - Browser provider
   * @param {Array} [options.cookies] - Cookies to import after creation
   * @param {string} [options.groupId] - Group ID for the profile
   * @param {string} [options.proxyLife] - Proxy life duration
   * @param {object[]} [options.existingProfiles] - Existing profiles for uniqueness checks
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async createProfile(options) {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 1: Validate inputs
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const validationError = this._validateInputs(options);
    if (validationError) {
      return validationError;
    }

    const { os, browserType, cookies, groupId, proxyLife, name, proxyType: rawProxyType, fingerprintConfig, profileMode, androidDevice, proxyCountry } = options;
    const resolvedProxyType = normalizeProxyType(rawProxyType) || 'smartproxy';
    const useSmartProxy = isSmartProxyType(resolvedProxyType);
    const useMultiloginProxy = isMultiloginProxyType(resolvedProxyType);
    const useQuickProfile = profileMode === 'quick';

    console.log(`[ProfileCreator] proxyType=${resolvedProxyType} (raw=${rawProxyType || 'default'})`);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 2: Get provider (validates availability)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let provider;
    try {
      provider = providerFactory.getProvider(browserType);
    } catch (err) {
      return {
        code: -5,
        message: `Provider unavailable: ${err.message}`,
        data: null,
      };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 3: Assign proxy
    // If proxyType = 'smartproxy' → use SmartProxy pool (default)
    // If proxyType = 'multilogin' → skip SmartProxy, provider uses its own built-in proxy
    // If proxyType = 'none' → no proxy assigned
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let proxy = null;
    if (useSmartProxy) {
      const proxyResult = proxyRotator.assignProxy(proxyLife);
      if (!proxyResult.success) {
        return {
          code: -6,
          message: proxyResult.error || 'Proxy pool exhausted — no available proxies',
          data: null,
        };
      }
      proxy = proxyResult.proxy;
    } else if (useMultiloginProxy) {
      const mlCountry = normalizeProxyCountry(proxyCountry, true);
      proxy = { type: 'multilogin_residential', country: mlCountry };
      console.log(`[ProfileCreator] Proxy type: multilogin — country: ${mlCountry.toUpperCase()} (US/UK only)`);
    } else {
      return {
        code: -5,
        message: `Invalid proxyType "${rawProxyType}". Use smartproxy or multilogin (Multilogin residential).`,
        data: null,
      };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 4: Resolve GeoIP from proxy (only for SmartProxy)
    // NOTE: ip-api.com resolves us.smartproxy.net (gateway IP), not the real
    // residential exit IP. So we override timezone from the proxy's state name
    // to ensure fingerprint timezone matches the actual exit node location.
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let geoData = { country: 'US', language: 'en-US', timezone: 'America/New_York', city: '', region: '' };
    if (proxy && proxy.server) {
      // SmartProxy — resolve GeoIP from proxy server
      const geoResult = await this.geoIPResolver.resolve(proxy.server);
      geoData = geoResult.data;

      // Override timezone with state-derived value if we know the proxy state
      if (proxy.state && FULL_STATE_TIMEZONE_MAP[proxy.state]) {
        geoData.timezone = FULL_STATE_TIMEZONE_MAP[proxy.state];
        geoData.country = 'US';
        geoData.language = 'en-US';
      }
    } else if (proxy && proxy.type === 'multilogin_residential') {
      geoData = geoForProxyCountry(proxy.country, FULL_STATE_TIMEZONE_MAP);
      console.log(`[ProfileCreator] Multilogin proxy geo → ${geoData.country} ${geoData.timezone} ${geoData.language}`);
    } else {
      const US_STATES = Object.keys(FULL_STATE_TIMEZONE_MAP);
      const randomState = US_STATES[Math.floor(Math.random() * US_STATES.length)];
      geoData.timezone = FULL_STATE_TIMEZONE_MAP[randomState] || 'America/New_York';
      console.log(`[ProfileCreator] Using random US timezone: ${geoData.timezone} (state: ${randomState})`);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 5: Generate fingerprint with uniqueness validation (up to 3 attempts)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const existingProfiles = options.existingProfiles || [];
    let fingerprint = null;
    let uniquenessAchieved = false;

    for (let attempt = 0; attempt < MAX_UNIQUENESS_RETRIES; attempt++) {
      fingerprint = this.fingerprintGenerator.generate(os, geoData, androidDevice || null);
      console.log(`[ProfileCreator] Generated fingerprint on attempt ${attempt + 1}: timezone=${fingerprint.timezone}, language=${fingerprint.language}, userAgent=${fingerprint.userAgent ? fingerprint.userAgent.slice(0, 50) + '...' : 'none'}${fingerprint.deviceModel ? `, device=${fingerprint.deviceModel}` : ''}`);

      const validation = uniquenessValidator.validateFingerprint(fingerprint, existingProfiles);
      if (validation.unique) {
        uniquenessAchieved = true;
        break;
      }

      console.warn(
        `[ProfileCreator] Fingerprint uniqueness conflict on attempt ${attempt + 1}/${MAX_UNIQUENESS_RETRIES}` +
        (validation.conflictProfileId ? ` (conflicts with profile ${validation.conflictProfileId})` : '')
      );
    }

    if (!uniquenessAchieved) {
      return {
        code: -7,
        message: `Fingerprint uniqueness exhausted after ${MAX_UNIQUENESS_RETRIES} attempts — cannot generate a unique fingerprint`,
        data: null,
      };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 6: Build payload and call provider API (30s timeout)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const profileName = name || `Profile_${Date.now()}`;

    // Build proxy config based on proxyType
    let proxyConfig = null;
    if (proxy && proxy.type === 'multilogin_residential') {
      // Multilogin residential — pass the placeholder; provider will generate real credentials
      // Use the country from the proxy object (set above from proxyCountry option)
      proxyConfig = { type: 'multilogin_residential', country: normalizeProxyCountry(proxy.country) };
    } else if (proxy && proxy.server) {
      // SmartProxy — full credentials (explicit type so provider never confuses with Multilogin)
      proxyConfig = {
        type: 'smartproxy',
        server: proxy.server,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        protocol: 'http',
      };
    }
    // proxyType === 'none' → proxyConfig stays null → no proxy

    const resolvedFingerprintConfig = fingerprintConfig || {
      canvas: 'real',
      webrtc: 'real',
      timezone: 'real',
      screen: 'real',
      navigator: 'real',
    };

    const createOptions = {
      name: profileName,
      os,
      proxy: proxyConfig,
      fingerprint,
      groupId,
      fingerprintConfig: resolvedFingerprintConfig,
      profileMode: useQuickProfile ? 'quick' : 'cloud',
    };

    let providerResult;
    try {
      // Quick/Local: Multilogin → launcher API. MoreLogin → always local /api/env/create/quick.
      const useMultiloginQuick = useQuickProfile && browserType === 'multilogin'
        && typeof provider.createQuickProfile === 'function';

      if (useMultiloginQuick) {
        console.log('[ProfileCreator] Multilogin Quick Profile (local launcher — MLX desktop must be running)');
        providerResult = await this._callProviderWithTimeout(
          { createProfile: (opts) => provider.createQuickProfile(opts) },
          createOptions,
          PROVIDER_TIMEOUT_MS
        );
      } else if (browserType === 'morelogin') {
        console.log('[ProfileCreator] MoreLogin local API (MoreLogin app must be open on port 40000)');
        providerResult = await this._callProviderWithTimeout(provider, createOptions, PROVIDER_TIMEOUT_MS);
      } else {
        console.log('[ProfileCreator] Multilogin Cloud Profile (persistent)');
        providerResult = await this._callProviderWithTimeout(provider, createOptions, PROVIDER_TIMEOUT_MS);
      }
    } catch (err) {
      // Timeout error
      if (err.code === 'PROVIDER_TIMEOUT') {
        return {
          code: -10,
          message: `Provider API timeout: ${browserType} did not respond within ${PROVIDER_TIMEOUT_MS / 1000} seconds`,
          data: null,
        };
      }
      // Other unexpected errors
      return {
        code: -1,
        message: `Provider error: ${err.message}`,
        data: null,
      };
    }

    // Check provider response — no silent Quick fallback (temp profiles break YT trust / canvas)
    if (providerResult.code !== 0) {
      const hint = browserType === 'morelogin'
        ? ' — Is MoreLogin desktop running? (http://127.0.0.1:40000)'
        : useQuickProfile
          ? ' — Is Multilogin X desktop / launcher connected?'
          : /501|cloud profile\/create/i.test(providerResult.message || '')
            ? ' — Multilogin cloud create API is down. Use existing profiles for watch; create new ones in MLX app manually until API recovers.'
            : '';
      return {
        code: -1,
        message: (providerResult.message || `Provider API error from ${browserType}`) + hint,
        data: null,
      };
    }

    // Extract profile ID from provider response
    const profileId = providerResult.data && (
      providerResult.data.id
      || providerResult.data.profileId
      || providerResult.data.envId
    )
      ? String(providerResult.data.id || providerResult.data.profileId || providerResult.data.envId)
      : '';

    if (!profileId) {
      return {
        code: -1,
        message: `${browserType} returned success but no profile ID — check local app logs`,
        data: null,
      };
    }

    // Register the proxy assignment now that profile is created (only for SmartProxy)
    if (profileId && proxy && proxy.server) {
      proxyRotator.registerAssignment(profileId, proxy);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 7: Import cookies (non-blocking — failure doesn't prevent creation)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let cookiesImported = false;

    if (cookies && Array.isArray(cookies) && cookies.length > 0 && profileId) {
      try {
        const CookieImporter = require('./CookieImporter.cjs');
        const cookieImporter = new CookieImporter();
        const cookieResult = await cookieImporter.importCookies(profileId, browserType, cookies);
        cookiesImported = cookieResult.cookiesImported || false;
      } catch (err) {
        console.warn(`[ProfileCreator] Cookie import failed for profile ${profileId}: ${err.message}`);
        cookiesImported = false;
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 8: High CPC/RPM/CPM cookies — INSIDE create pipeline (before return)
    // Profile create → MLX metadata → live bake → cookies saved → then response
    // NOT a separate step after UI "Create" finishes
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let cookieWarmingSet = false;
    let cookieWarmDetails = null;
    if (browserType === 'multilogin' && profileId) {
      try {
        const { HighCPCCookieWarmer } = require('./HighCPCCookieWarmer.cjs');
        const warmer = new HighCPCCookieWarmer(provider);
        cookieWarmDetails = await warmer.warmOnCreate(profileId, {
          profileMode: useQuickProfile ? 'quick' : 'cloud',
        });
        cookieWarmingSet = cookieWarmDetails.metadataSet || cookieWarmDetails.liveBake;

        if (cookieWarmDetails.metadataSet) {
          console.log(
            `[ProfileCreator] High-CPC/RPM cookies metadata → ${cookieWarmDetails.metadataMessage}`
          );
        }
        if (cookieWarmDetails.liveBake) {
          console.log(
            `[ProfileCreator] Live cookie bake OK — ${cookieWarmDetails.cookieCount} cookies, ` +
            `sites: ${(cookieWarmDetails.sitesVisited || []).length} (Google/YouTube/Amazon/Facebook)`
          );
        } else if (cookieWarmDetails.bakeError && !useQuickProfile) {
          console.warn(`[ProfileCreator] Live cookie bake skipped/failed: ${cookieWarmDetails.bakeError}`);
        }
      } catch (err) {
        console.warn(`[ProfileCreator] Cookie warming error for ${profileId}: ${err.message}`);
      }
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Return unified result
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Build proxy info for response — handle SmartProxy vs Multilogin residential vs none
    const usedProxy = providerResult.data?.proxyUsed;
    let proxyResponseData = null;
    if (proxy) {
      if (proxy.type === 'multilogin_residential') {
        proxyResponseData = {
          type: 'multilogin_residential',
          country: normalizeProxyCountry(proxy.country),
          server: usedProxy?.host || 'gate.multilogin.com',
          port: usedProxy?.port || 1080,
        };
      } else {
        proxyResponseData = {
          type: 'smartproxy',
          server: proxy.server,
          port: proxy.port,
          sessionId: proxy.sessionId,
          state: proxy.state,
          city: proxy.city,
          life: proxy.life,
          assignedAt: proxy.assignedAt,
          expiresAt: proxy.expiresAt,
        };
      }
    }

    return {
      code: 0,
      message: 'Profile created successfully',
      data: {
        id: profileId,
        name: profileName,
        os,
        browserType,
        profileMode: useQuickProfile ? 'quick' : 'cloud',
        proxy: proxyResponseData,
        fingerprint,
        cookiesImported,
        cookieWarmingSet,
        cookieWarmDetails,
      },
    };
  }

  /**
   * Validate creation inputs.
   * @param {object} options
   * @returns {object|null} Error response or null if valid
   * @private
   */
  _validateInputs(options) {
    if (!options || typeof options !== 'object') {
      return {
        code: -5,
        message: 'Invalid options: must provide a valid options object',
        data: null,
      };
    }

    const { os, browserType } = options;

    // Validate browserType
    if (!browserType || !VALID_PROVIDERS.includes(browserType)) {
      return {
        code: -5,
        message: `Invalid browserType "${browserType}". Accepted values: ${VALID_PROVIDERS.join(', ')}`,
        data: null,
      };
    }

    // Validate OS
    if (!os || !VALID_OS.includes(os)) {
      return {
        code: -5,
        message: `Invalid OS "${os}". Accepted values: ${VALID_OS.join(', ')}`,
        data: null,
      };
    }

    if (options.proxyType === 'none' || normalizeProxyType(options.proxyType) === 'none') {
      return {
        code: -5,
        message: 'Proxy required — profiles must use US/UK proxy (SmartProxy or Multilogin). Real IP / India IP is not allowed.',
        data: null,
      };
    }

    return null;
  }

  /**
   * Call provider.createProfile with a timeout wrapper.
   * Rejects with a PROVIDER_TIMEOUT error if the provider doesn't respond in time.
   *
   * @param {object} provider - The BrowserProvider instance
   * @param {object} createOptions - Options to pass to provider.createProfile
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<object>} Provider response
   * @private
   */
  _callProviderWithTimeout(provider, createOptions, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        const err = new Error(`Provider API call timed out after ${timeoutMs}ms`);
        err.code = 'PROVIDER_TIMEOUT';
        reject(err);
      }, timeoutMs);

      provider.createProfile(createOptions)
        .then((result) => {
          if (!timedOut) {
            clearTimeout(timer);
            resolve(result);
          }
        })
        .catch((err) => {
          if (!timedOut) {
            clearTimeout(timer);
            reject(err);
          }
        });
    });
  }
}

module.exports = ProfileCreator;
