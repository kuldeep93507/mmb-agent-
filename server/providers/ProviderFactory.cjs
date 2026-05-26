/**
 * ProviderFactory — Singleton factory for antidetect browser providers
 * 
 * Resolves the correct BrowserProvider implementation based on:
 *   1. Explicit parameter passed to getProvider()
 *   2. BROWSER_PROVIDER environment variable
 *   3. Default: "morelogin"
 * 
 * Caches provider instances (one per provider name) and validates
 * required environment variables before instantiation.
 * 
 * Usage:
 *   const { providerFactory } = require('./ProviderFactory.cjs');
 *   const provider = providerFactory.getProvider(); // uses env or default
 *   const provider = providerFactory.getProvider('multilogin'); // explicit
 */

'use strict';

/** Maps removed/legacy provider ids so old .env values keep working. */
function normalizeProviderId(raw) {
  const n = (raw && String(raw).trim()) || '';
  if (n === 'adspower') return 'multilogin';
  return n;
}

const VALID_PROVIDERS = ['morelogin', 'multilogin', 'adspower'];

/**
 * Required environment variables per provider.
 * Empty array means no strictly required vars (has defaults or uses local API).
 *
 * Note: MoreLogin has MORELOGIN_API_KEY default in MoreLoginProvider.
 * Multilogin requires MULTILOGIN_* + folder ID.
 */
const REQUIRED_ENV_VARS = {
  morelogin: [], // MORELOGIN_API_KEY has a hardcoded default in MoreLoginProvider
  // Multilogin: FOLDER_ID always required; auth = TOKEN **or** EMAIL+PASSWORD
  multilogin: ['MULTILOGIN_FOLDER_ID'],
};

class ProviderFactory {
  constructor() {
    /** @type {Map<string, import('./BrowserProvider.cjs').BrowserProvider>} */
    this.instances = new Map();
  }

  /**
   * Get a provider instance by name. Uses caching (singleton per provider name).
   * 
   * Resolution order:
   *   1. providerName parameter (if provided and non-empty)
   *   2. process.env.BROWSER_PROVIDER (if set and non-empty)
   *   3. Default: "morelogin"
   * 
   * @param {string} [providerName] - Provider name override
   * @returns {import('./BrowserProvider.cjs').BrowserProvider}
   * @throws {Error} If provider name is invalid or required env vars are missing
   */
  getProvider(providerName) {
    // Resolve provider name: param > env > default (legacy adspower → multilogin)
    const name = normalizeProviderId(
      (providerName && providerName.trim()) ||
        (process.env.BROWSER_PROVIDER && process.env.BROWSER_PROVIDER.trim()) ||
        'morelogin',
    );

    // Validate provider name
    if (!VALID_PROVIDERS.includes(name)) {
      throw new Error(
        `Invalid browser provider "${name}". Accepted values: ${VALID_PROVIDERS.join(', ')}`,
      );
    }

    // Return cached instance if available
    if (this.instances.has(name)) {
      return this.instances.get(name);
    }

    // Validate configuration before creating instance
    this.validateConfig(name);

    // Create and cache the provider instance
    const instance = this._createProvider(name);
    this.instances.set(name, instance);
    return instance;
  }

  /**
   * Validate that all required environment variables are set for a provider.
   * Treats empty string values the same as missing.
   * 
   * @param {string} providerName - Provider to validate config for
   * @throws {Error} If any required env var is missing or empty
   */
  validateConfig(providerName) {
    const name = normalizeProviderId(providerName || process.env.BROWSER_PROVIDER || 'morelogin');

    if (!VALID_PROVIDERS.includes(name)) {
      throw new Error(
        `Invalid browser provider "${name}". Accepted values: ${VALID_PROVIDERS.join(', ')}`,
      );
    }

    const requiredVars = REQUIRED_ENV_VARS[name] || [];
    const missing = [];

    for (const varName of requiredVars) {
      const value = process.env[varName];
      // Treat empty string same as missing
      if (!value || value.trim() === '') {
        missing.push(varName);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variable(s) for ${name} provider: ${missing.join(', ')}. ` +
        `Please set ${missing.length === 1 ? 'this variable' : 'these variables'} in your .env file.`
      );
    }

    // Multilogin-specific: need either TOKEN or EMAIL+PASSWORD
    if (name === 'multilogin') {
      const hasToken = !!(process.env.MULTILOGIN_TOKEN && process.env.MULTILOGIN_TOKEN.trim());
      const hasCredentials =
        !!(process.env.MULTILOGIN_EMAIL && process.env.MULTILOGIN_EMAIL.trim()) &&
        !!(process.env.MULTILOGIN_PASSWORD && process.env.MULTILOGIN_PASSWORD.trim());
      if (!hasToken && !hasCredentials) {
        throw new Error(
          'Multilogin auth missing: set MULTILOGIN_TOKEN (30-day token) ' +
          'OR both MULTILOGIN_EMAIL + MULTILOGIN_PASSWORD in Settings.'
        );
      }
    }
  }

  /**
   * Create a new provider instance. Uses lazy require to allow providers
   * to be implemented in later tasks.
   * 
   * @param {string} name - Provider name
   * @returns {import('./BrowserProvider.cjs').BrowserProvider}
   * @private
   */
  _createProvider(name) {
    switch (name) {
      case 'morelogin': {
        try {
          const { MoreLoginProvider } = require('./MoreLoginProvider.cjs');
          return new MoreLoginProvider();
        } catch (err) {
          throw new Error(
            `Failed to load MoreLoginProvider: ${err.message}. ` +
            `Ensure server/providers/MoreLoginProvider.cjs exists.`
          );
        }
      }
      case 'multilogin': {
        try {
          const { MultiloginProvider } = require('./MultiloginProvider.cjs');
          return new MultiloginProvider();
        } catch (err) {
          throw new Error(
            `Failed to load MultiloginProvider: ${err.message}. ` +
            `Ensure server/providers/MultiloginProvider.cjs exists.`
          );
        }
      }
      default:
        throw new Error(
          `Invalid browser provider "${name}". Accepted values: ${VALID_PROVIDERS.join(', ')}`
        );
    }
  }

  /**
   * Clear cached instances. Useful for testing or reconfiguration.
   */
  clearCache() {
    this.instances.clear();
  }
}

// Export a pre-instantiated singleton
const providerFactory = new ProviderFactory();

module.exports = { providerFactory, ProviderFactory, VALID_PROVIDERS, REQUIRED_ENV_VARS };
