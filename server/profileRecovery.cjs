'use strict';

/**
 * Profile recovery when YouTube shows sign-in / captcha / consent walls.
 * 1) Stop browser → clear local cache (MoreLogin) → restart
 * 2) If still blocked → recreate profile (new ID) via RecreateHandler
 */

const { providerFactory } = require('./providers/ProviderFactory.cjs');
const RecreateHandler = require('./services/RecreateHandler.cjs');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} opts
 * @param {'morelogin'|'multilogin'} opts.browserType
 * @param {string} opts.profileId
 * @param {string} opts.profileName
 * @param {'clear_cache'|'recreate'} opts.strategy
 * @param {(level: string, msg: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, cdpPort?: number, profileId: string, message?: string }>}
 */
async function recoverProfile(opts) {
  const { browserType, profileId, profileName, strategy, log = () => {} } = opts;
  const provider = providerFactory.getProvider(browserType);
  let activeId = profileId;

  log('warn', `Recovery (${strategy}): stopping profile...`);
  await provider.stopProfile(activeId).catch(() => {});
  await sleep(2500);

  if (strategy === 'clear_cache') {
    if (typeof provider.clearProfileCache === 'function') {
      log('info', 'Clearing profile browser cache (cookies + storage)...');
      const cleared = await provider.clearProfileCache(activeId);
      if (cleared.code !== 0) {
        log('warn', `Cache clear: ${cleared.message || 'failed'} — continuing with restart`);
      } else {
        log('success', 'Profile cache cleared');
      }
    } else {
      log('info', 'Cache clear not supported for this provider — restarting browser only');
    }
  } else if (strategy === 'recreate') {
    log('warn', 'Recreating profile (delete + fresh browser)...');
    const handler = new RecreateHandler();
    const result = await handler.recreate({
      profileId: activeId,
      browserType,
      preserveName: true,
      originalProfile: {
        name: profileName || `Profile-${activeId.slice(-4)}`,
        os: 'Windows',
        browserType,
        status: 'idle',
      },
    });

    if (result.code !== 0 || !result.data?.newProfileId) {
      return { ok: false, profileId: activeId, message: result.message || 'Recreate failed' };
    }

    activeId = result.data.newProfileId;
    log('success', `Profile recreated: ${result.data.oldProfileId} → ${activeId}`);
    await sleep(3000);
  }

  log('info', 'Starting profile after recovery...');
  const startRes = await provider.startProfile(activeId);
  if (startRes.code === 0 && startRes.data?.cdpPort) {
    return {
      ok: true,
      profileId: activeId,
      cdpPort: startRes.data.cdpPort,
      message: 'Profile restarted',
    };
  }

  await sleep(8000);
  const retry = await provider.startProfile(activeId);
  if (retry.code === 0 && retry.data?.cdpPort) {
    return { ok: true, profileId: activeId, cdpPort: retry.data.cdpPort };
  }

  return {
    ok: false,
    profileId: activeId,
    message: retry.message || startRes.message || 'Start failed after recovery',
  };
}

module.exports = { recoverProfile };
