'use strict';

const { providerFactory } = require('../providers/ProviderFactory.cjs');

/**
 * Push a rotated SmartProxy config into the antidetect browser profile.
 * @param {string} profileId
 * @param {'morelogin'|'multilogin'} browserType
 * @param {object} proxy - { server, port, username, password }
 */
async function updateProviderProxy(profileId, browserType, proxy) {
  if (!profileId || !browserType || !proxy) {
    return { success: false, error: 'Missing profileId, browserType, or proxy' };
  }

  const provider = providerFactory.getProvider(browserType);
  if (typeof provider.updateProfileProxy === 'function') {
    const result = await provider.updateProfileProxy(profileId, proxy);
    if (result && result.code === 0) {
      return { success: true, message: result.message || 'Provider proxy updated' };
    }
    return {
      success: false,
      error: (result && result.message) || 'Provider rejected proxy update',
    };
  }

  return { success: false, error: `${browserType} does not support live proxy update` };
}

module.exports = { updateProviderProxy };
