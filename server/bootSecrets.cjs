'use strict';

/**
 * After user-settings.json + env are applied to process.env, validate mandatory secrets.
 * Multilogin-only installs skip MORELOGIN requirement (default browserProvider is multilogin).
 */
function assertRequiredSecretsOrExit(appSettings) {
  const browserBt = (
    process.env.BROWSER_PROVIDER
    || appSettings?.browserProvider
    || ''
  ).toString().trim().toLowerCase();
  const multiloginOnly = browserBt === 'multilogin' || browserBt === 'adspower';
  const moreloginKey = String(process.env.MORELOGIN_API_KEY || appSettings?.moreloginApiKey || '').trim();

  if (!multiloginOnly && !moreloginKey) {
    // Non-fatal: user can set MORELOGIN_API_KEY via the Settings page after server starts.
    // MoreLogin calls will return error until the key is configured.
    console.warn('[boot] ⚠  MORELOGIN_API_KEY not set — open Settings and enter your MoreLogin API key.');
    console.warn('       (Or set BROWSER_PROVIDER=multilogin in .env for Multilogin-only usage.)');
  }

  const backendSecret = String(process.env.BACKEND_API_KEY || process.env.MMB_API_TOKEN || '').trim();
  if (!backendSecret) {
    // Fatal — without this the API auth middleware blocks all frontend calls.
    console.error('[FATAL] BACKEND_API_KEY (or legacy MMB_API_TOKEN) must be set in .env.');
    console.error('        Add: BACKEND_API_KEY=mmb-local-dev-2025');
    console.error('        Frontend .env also needs: VITE_BACKEND_API_KEY=mmb-local-dev-2025');
    process.exit(1);
  }

  console.log('[boot] ✓ Secrets validated.');
}

module.exports = { assertRequiredSecretsOrExit };
