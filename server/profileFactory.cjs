'use strict';

/**
 * ProfileFactory — Ephemeral Multilogin profiles for MMB YT AGENT 24/7
 */

const { MultiloginProvider } = require('./providers/MultiloginProvider.cjs');
const { normalizeProxyCountry } = require('./services/proxyCountry.cjs');

const COUNTRIES = ['us', 'gb'];

function randomCountry() {
  return COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startWithReadiness(provider, profileId, attempts = 4) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    last = await provider.startProfile(profileId);
    if (last.code === 0 && last.data?.cdpPort) {
      console.log(`[ProfileFactory] start ready on attempt ${attempt} (${Date.now() - startedAt}ms)`);
      return last;
    }
    if (attempt < attempts) {
      const delay = Math.min(2500, 500 * attempt);
      console.warn(`[ProfileFactory] start attempt ${attempt}/${attempts} not ready: ${last?.message || 'pending'} — retry in ${delay}ms`);
      await sleep(delay);
    }
  }
  return last;
}

class ProfileFactory {
  constructor(options = {}) {
    this.provider = new MultiloginProvider();
    this.proxyType = options.proxyType || 'smartproxy';
  }

  setProxyType(type) {
    this.proxyType = type === 'multilogin' ? 'multilogin' : 'smartproxy';
  }

  async createAndStart(agentName) {
    const profileName = agentName || `MMB YT AGENT ${Date.now()}`;
    const country = normalizeProxyCountry(randomCountry());

    const proxyOpts = this.proxyType === 'multilogin'
      ? { type: 'multilogin_residential', country }
      // Fix Bug 18: use actual randomCountry value, not hardcoded 'us'
      : { type: 'smartproxy', country };

    console.log(`[ProfileFactory] Creating ${profileName} (proxy: ${this.proxyType}/${String(proxyOpts.country || country).toUpperCase()})`);

    const createResult = await this.provider.createProfile({
      name: profileName,
      os: 'Windows',
      browserType: 'mimic',
      proxy: proxyOpts,
    });

    if (createResult.code !== 0 || !createResult.data?.id) {
      throw new Error(`Profile create failed: ${createResult.message}`);
    }

    const profileId = createResult.data.id;
    const startResult = await startWithReadiness(this.provider, profileId, 4);

    if (!startResult || startResult.code !== 0 || !startResult.data?.cdpPort) {
      await this.provider.deleteProfile(profileId).catch(() => {});
      throw new Error(`Profile start failed: ${startResult?.message || 'No CDP port'}`);
    }

    const { cdpPort, cdpEndpoint } = startResult.data;
    return { profileId, cdpPort, cdpEndpoint };
  }

  async stopAndDelete(profileId) {
    if (!profileId) return false;

    try {
      await this.provider.stopProfile(profileId);
      await sleep(2000);
    } catch (err) {
      console.warn(`[ProfileFactory] Stop warning: ${err.message}`);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await this.provider.deleteProfile(profileId);
        if (result.code === 0) return true;
      } catch (err) {
        console.warn(`[ProfileFactory] Delete attempt ${attempt}: ${err.message}`);
      }
      if (attempt < 3) await sleep(3000);
    }
    return false;
  }
}

module.exports = { ProfileFactory };
