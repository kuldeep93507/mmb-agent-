/**
 * profileRouter — Express router for /api/profiles/* endpoints
 * 
 * Routes profile operations (list, create, start, stop, delete) to the
 * correct BrowserProvider via ProviderFactory. Accepts a `provider` query
 * parameter to select the provider at runtime.
 * 
 * HTTP status mapping:
 *   200 — success (provider returned code === 0)
 *   400 — invalid provider name
 *   502 — provider error (code !== 0)
 * 
 * Logging format:
 *   [timestamp] [provider] [operation] profile=xxx result=success/error
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { providerFactory, VALID_PROVIDERS } = require('./ProviderFactory.cjs');
const ProfileCreator = require('../services/ProfileCreator.cjs');
const RecreateHandler = require('../services/RecreateHandler.cjs');
const { ANDROID_DEVICES } = require('../services/fingerprintData.cjs');
const { resolveCreateProxyType, isMultiloginProxyType } = require('../services/proxyType.cjs');

function loadSettingsProxyType() {
  try {
    const settingsFile = path.join(__dirname, '..', '..', 'user-settings.json');
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).ytProxyType;
    }
  } catch { /* ignore */ }
  return null;
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

function trashNotSupported(res, providerName) {
  return res.status(400).json({
    code: -5,
    message: `Trash management is only supported for Multilogin (got "${providerName}")`,
    data: null,
  });
}

const router = express.Router();

/**
 * GET /api/providers/status — quick check if local APIs are reachable
 */
/** GET /api/android-devices — live list from backend fingerprint pool */
router.get('/api/android-devices', (_req, res) => {
  const devices = ANDROID_DEVICES.map(d => ({
    label: d.model,
    value: d.model,
    desc: `Android ${d.androidVersion} · ${d.modelCode}`,
  }));
  res.json({ code: 0, data: { devices, total: devices.length } });
});

router.get('/api/providers/status', async (req, res) => {
  const status = { morelogin: { ok: false, message: '' }, multilogin: { ok: false, message: '' } };

  try {
    const ml = providerFactory.getProvider('morelogin');
    const page = await ml.listProfiles(1, 1);
    status.morelogin.ok = page.code === 0;
    status.morelogin.message = page.message || (page.code === 0 ? 'OK' : 'Error');
  } catch (err) {
    status.morelogin.message = err.message;
  }

  try {
    const mx = providerFactory.getProvider('multilogin');
    const auth = await mx.authenticate();
    status.multilogin.ok = auth.code === 0;
    status.multilogin.message = auth.message || (auth.code === 0 ? 'Cloud auth OK' : 'Auth failed');
  } catch (err) {
    status.multilogin.message = err.message;
  }

  res.json({ code: 0, data: status });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LOGGING HELPER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Log a profile operation with standardized format.
 * @param {string} provider - Provider name
 * @param {string} operation - Operation type (list, create, start, stop, delete)
 * @param {string|null} profileId - Profile ID (null for list operations)
 * @param {string} result - "success" or "error"
 * @param {string} [detail] - Optional detail (cdpPort, error message, etc.)
 */
function logOperation(provider, operation, profileId, result, detail) {
  const timestamp = new Date().toISOString();
  const profileStr = profileId ? `profile=${profileId}` : '';
  const detailStr = detail ? ` ${detail}` : '';
  console.log(`[${timestamp}] [${provider}] [${operation}] ${profileStr} result=${result}${detailStr}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROVIDER RESOLUTION HELPER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Resolve provider from query param. Returns provider instance or sends 400 error.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {import('./BrowserProvider.cjs').BrowserProvider|null}
 */
function resolveProvider(req, res) {
  const providerName = req.query.provider || undefined;
  try {
    return providerFactory.getProvider(providerName);
  } catch (err) {
    // Invalid provider name — return 400
    const provider = providerName || 'unknown';
    logOperation(provider, req._profileOperation || 'unknown', null, 'error', `message="${err.message}"`);
    res.status(400).json({
      code: -5,
      message: err.message,
      data: null,
    });
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/profiles/list
 * Lists profiles from the selected provider.
 * Query: ?provider=morelogin|multilogin
 * Body (optional): { pageNo, pageSize }
 */
router.post('/api/profiles/list', async (req, res) => {
  req._profileOperation = 'list';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  const { pageNo, pageSize, enrichDetails } = req.body || {};
  const listOptions = { enrichDetails: enrichDetails !== false };

  try {
    const result = await provider.listProfiles(pageNo, pageSize, listOptions);

    if (result.code === 0) {
      logOperation(provider.name, 'list', null, 'success');
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'list', null, 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'list', null, 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * POST /api/profiles/create
 * Creates a new profile on the selected provider.
 * Query: ?provider=morelogin|multilogin
 * Body: { name, os, proxy, browserType } (CreateProfileOptions)
 */
router.post('/api/profiles/create', async (req, res) => {
  req._profileOperation = 'create';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  try {
    const body = { ...(req.body || {}) };
    if (body.proxy && isMultiloginProxyType(body.proxy.type)) {
      body.proxy = {
        type: 'multilogin_residential',
        country: body.proxy.country || 'us',
        city: body.proxy.city,
        region: body.proxy.region,
      };
    }
    const result = await provider.createProfile(body);

    const profileId = result.data?.id || result.data?.profileId || null;
    if (result.code === 0) {
      logOperation(provider.name, 'create', profileId, 'success');
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'create', profileId, 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'create', null, 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * POST /api/profiles/start
 * Starts a profile and returns CDP port.
 * Query: ?provider=morelogin|multilogin
 * Body: { profileId }
 */
router.post('/api/profiles/start', async (req, res) => {
  req._profileOperation = 'start';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  const { profileId } = req.body || {};

  try {
    const result = await provider.startProfile(profileId);

    if (result.code === 0) {
      const cdpPort = result.data?.cdpPort || null;
      logOperation(provider.name, 'start', profileId, 'success', cdpPort ? `cdpPort=${cdpPort}` : '');
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'start', profileId, 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'start', profileId, 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * POST /api/profiles/stop
 * Stops a running profile.
 * Query: ?provider=morelogin|multilogin
 * Body: { profileId }
 */
router.post('/api/profiles/stop', async (req, res) => {
  req._profileOperation = 'stop';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  const { profileId } = req.body || {};

  try {
    const result = await provider.stopProfile(profileId);

    if (result.code === 0) {
      logOperation(provider.name, 'stop', profileId, 'success');
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'stop', profileId, 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'stop', profileId, 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * POST /api/profiles/delete
 * Deletes a profile.
 * Query: ?provider=morelogin|multilogin
 * Body: { profileId }
 */
router.post('/api/profiles/delete', async (req, res) => {
  req._profileOperation = 'delete';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  const { profileId, permanently } = req.body || {};
  const forcePermanent = permanently === true
    || (provider.name === 'multilogin' && loadMultiloginPurgeOnDelete());

  try {
    const result = await provider.deleteProfile(profileId, { permanently: forcePermanent });

    if (result.code === 0) {
      logOperation(provider.name, 'delete', profileId, 'success', forcePermanent ? 'permanent' : 'trash');
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'delete', profileId, 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'delete', profileId, 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * GET /api/profiles/trash
 * List Multilogin trash profiles.
 * Query: ?provider=multilogin&pageNo=1&pageSize=50
 */
router.get('/api/profiles/trash', async (req, res) => {
  req._profileOperation = 'trash-list';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  if (typeof provider.listTrashProfiles !== 'function') {
    return trashNotSupported(res, provider.name);
  }

  const pageNo = parseInt(req.query.pageNo, 10) || 1;
  const pageSize = parseInt(req.query.pageSize, 10) || 50;

  try {
    const result = await provider.listTrashProfiles(pageNo, pageSize);
    if (result.code === 0) {
      logOperation(provider.name, 'trash-list', null, 'success', `count=${result.data?.profiles?.length || 0}`);
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'trash-list', null, 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'trash-list', null, 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * POST /api/profiles/trash/delete
 * Permanently delete profile(s) from Multilogin trash.
 * Query: ?provider=multilogin
 * Body: { profileIds: string[] }
 */
router.post('/api/profiles/trash/delete', async (req, res) => {
  req._profileOperation = 'trash-delete';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  if (typeof provider.deleteProfilesPermanently !== 'function') {
    return trashNotSupported(res, provider.name);
  }

  const { profileIds } = req.body || {};
  const ids = Array.isArray(profileIds) ? profileIds.filter(Boolean) : [];
  if (!ids.length) {
    return res.status(400).json({ code: -5, message: 'profileIds array required', data: null });
  }

  try {
    const result = await provider.deleteProfilesPermanently(ids);
    if (result.code === 0) {
      logOperation(provider.name, 'trash-delete', ids.join(','), 'success');
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'trash-delete', ids.join(','), 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'trash-delete', ids.join(','), 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * POST /api/profiles/trash/empty
 * Permanently delete ALL profiles in Multilogin trash.
 * Query: ?provider=multilogin
 */
router.post('/api/profiles/trash/empty', async (req, res) => {
  req._profileOperation = 'trash-empty';
  const provider = resolveProvider(req, res);
  if (!provider) return;

  if (typeof provider.emptyTrash !== 'function') {
    return trashNotSupported(res, provider.name);
  }

  try {
    const result = await provider.emptyTrash();
    if (result.code === 0) {
      logOperation(provider.name, 'trash-empty', null, 'success', `deleted=${result.data?.deleted || 0}`);
      res.status(200).json(result);
    } else {
      logOperation(provider.name, 'trash-empty', null, 'error', `message="${result.message}"`);
      res.status(502).json(result);
    }
  } catch (err) {
    const errorResult = provider.handleError(err);
    logOperation(provider.name, 'trash-empty', null, 'error', `message="${errorResult.message}"`);
    res.status(502).json(errorResult);
  }
});

/**
 * POST /api/profiles/list-all
 * Lists profiles from ALL configured providers in parallel.
 * Failed providers are reported in the `errors` array but don't block the response.
 * Each profile retains its `browserType` field.
 * Body (optional): { pageNo, pageSize }
 */
router.post('/api/profiles/list-all', async (req, res) => {
  const { pageNo, pageSize, enrichDetails } = req.body || {};
  const listOptions = { enrichDetails: enrichDetails !== false };
  const allProfiles = [];
  const errors = [];

  // Fan out to all providers in parallel with a 10s per-provider timeout
  const results = await Promise.allSettled(
    VALID_PROVIDERS.map(async (providerName) => {
      try {
        const provider = providerFactory.getProvider(providerName);
        const result = await provider.listProfiles(pageNo || 1, pageSize || 100, listOptions);
        return { providerName, result };
      } catch (err) {
        return { providerName, result: { code: -1, message: err.message, data: null } };
      }
    })
  );

  for (const settled of results) {
    if (settled.status === 'fulfilled') {
      const { providerName, result } = settled.value;
      if (result.code === 0 && result.data && result.data.profiles) {
        allProfiles.push(...result.data.profiles);
        logOperation(providerName, 'list-all', null, 'success', `count=${result.data.profiles.length}`);
      } else {
        errors.push({ provider: providerName, message: result.message || 'Unknown error' });
        logOperation(providerName, 'list-all', null, 'error', `message="${result.message}"`);
      }
    } else {
      // Promise rejected (shouldn't happen with our try/catch, but just in case)
      errors.push({ provider: 'unknown', message: settled.reason?.message || 'Unknown' });
    }
  }

  res.status(200).json({
    code: 0,
    message: `Aggregated ${allProfiles.length} profiles from ${VALID_PROVIDERS.length - errors.length}/${VALID_PROVIDERS.length} providers`,
    data: {
      profiles: allProfiles,
      total: allProfiles.length,
      errors,
    },
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ERROR CODE → HTTP STATUS MAPPING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Maps internal error codes to HTTP status codes.
 * @param {number} code - Internal error code from ProfileCreator/RecreateHandler
 * @returns {number} HTTP status code
 */
function mapErrorCodeToHttpStatus(code) {
  switch (code) {
    case 0:   return 200; // success
    case -1:  return 502; // provider error
    case -5:  return 400; // invalid input
    case -6:  return 409; // proxy exhausted
    case -7:  return 409; // fingerprint uniqueness exhausted
    case -8:  return 408; // recreate stop timeout
    case -9:  return 500; // recreate creation failed after deletion
    case -10: return 504; // provider timeout
    default:  return 500; // unknown error
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// FULL PROFILE CREATION & RECREATE ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * POST /api/profiles/create-full
 * Creates a profile with the full pipeline (proxy + fingerprint + cookies).
 * Body: { name?, os, browserType, proxyLife?, cookies?, groupId?, proxyType? }
 * proxyType: 'smartproxy' (default) | 'multilogin' | 'none'
 */
router.post('/api/profiles/create-full', async (req, res) => {
  const { name, os, browserType, proxyLife, cookies, groupId, proxyType, proxyCountry, fingerprintConfig, profileMode, androidDevice } = req.body || {};

  // Basic request body validation
  if (!os || !browserType) {
    logOperation(browserType || 'unknown', 'create-full', null, 'error', 'message="Missing required fields: os and browserType"');
    return res.status(400).json({
      code: -5,
      message: 'Missing required fields: os and browserType are required',
      data: null,
    });
  }

  // Log which mode is being used
  const resolvedProxyType = resolveCreateProxyType(proxyType, loadSettingsProxyType());
  if (resolvedProxyType === 'none') {
    return res.status(400).json({
      code: -5,
      message: 'Proxy required — US/UK proxy only. Real IP (India) is not allowed.',
      data: null,
    });
  }
  const resolvedProfileMode = profileMode || 'cloud';
  const deviceLog = (os === 'Android' && androidDevice) ? ` androidDevice="${androidDevice}"` : '';
  const countryLog = resolvedProxyType === 'multilogin' && proxyCountry ? ` proxyCountry=${proxyCountry}` : '';
  logOperation(browserType, 'create-full', null, 'info',
    `proxyType=${resolvedProxyType} profileMode=${resolvedProfileMode}${deviceLog}${countryLog}`);

  try {
    const profileCreator = new ProfileCreator();
    const result = await profileCreator.createProfile({
      name,
      os,
      browserType,
      proxyLife,
      cookies,
      groupId,
      proxyType: resolvedProxyType,   // 'smartproxy' | 'multilogin' | 'none'
      proxyCountry: proxyCountry || undefined, // us | gb | uk (Multilogin residential only)
      profileMode: resolvedProfileMode, // 'cloud' (persistent) | 'quick' (local launcher, full fingerprint)
      androidDevice: androidDevice || null, // specific Android device model or null (auto-random)
      fingerprintConfig: fingerprintConfig || {
        canvas: 'real',
        webrtc: 'real',
        timezone: 'real',
        screen: 'real',
        navigator: 'real',
      },
    });

    const httpStatus = mapErrorCodeToHttpStatus(result.code);
    const profileId = result.data?.id || null;

    if (result.code === 0) {
      logOperation(browserType, 'create-full', profileId, 'success');
    } else {
      logOperation(browserType, 'create-full', profileId, 'error', `message="${result.message}"`);
    }

    return res.status(httpStatus).json(result);
  } catch (err) {
    logOperation(browserType || 'unknown', 'create-full', null, 'error', `message="${err.message}"`);
    return res.status(500).json({
      code: -1,
      message: `Unexpected error during profile creation: ${err.message}`,
      data: null,
    });
  }
});

/**
 * POST /api/profiles/recreate
 * Deletes an existing profile and creates a fresh replacement.
 * Body: { profileId, browserType, cookies? }
 */
router.post('/api/profiles/recreate', async (req, res) => {
  const { profileId, browserType, cookies, os, name, fingerprintConfig, proxyType } = req.body || {};

  // Basic request body validation
  if (!profileId || !browserType) {
    logOperation(browserType || 'unknown', 'recreate', profileId || null, 'error', 'message="Missing required fields: profileId and browserType"');
    return res.status(400).json({
      code: -5,
      message: 'Missing required fields: profileId and browserType are required',
      data: null,
    });
  }

  // Validate browserType
  if (!VALID_PROVIDERS.includes(browserType)) {
    logOperation(browserType, 'recreate', profileId, 'error', `message="Invalid browserType: ${browserType}"`);
    return res.status(400).json({
      code: -5,
      message: `Invalid browserType "${browserType}". Accepted values: ${VALID_PROVIDERS.join(', ')}`,
      data: null,
    });
  }

  try {
    const recreateHandler = new RecreateHandler();

    // Fetch original profile info from provider to get name, os, status, groupId
    let originalProfile;
    try {
      const provider = providerFactory.getProvider(browserType);
      // Attempt to get profile details from provider
      // If provider has a getProfile method, use it; otherwise use minimal defaults
      if (typeof provider.getProfile === 'function') {
        const profileResult = await provider.getProfile(profileId);
        if (profileResult && profileResult.code === 0 && profileResult.data) {
          originalProfile = {
            name: profileResult.data.name || `Profile_${profileId}`,
            os: profileResult.data.os || 'Windows',
            browserType,
            groupId: profileResult.data.groupId || undefined,
            status: profileResult.data.status || 'stopped',
          };
        }
      }
    } catch (fetchErr) {
      // If we can't fetch profile details, use defaults
      console.warn(`[profileRouter] Could not fetch profile details for ${profileId}: ${fetchErr.message}`);
    }

    // Fallback if we couldn't get profile details — use what frontend sent
    if (!originalProfile) {
      originalProfile = {
        name: name || `Profile_${profileId}`,
        os: os || 'Windows',
        browserType,
        groupId: undefined,
        status: 'stopped',
      };
    }

    const result = await recreateHandler.recreate({
      profileId,
      browserType,
      preserveName: true,
      originalProfile,
      cookies: cookies || undefined,
      proxyType: resolveCreateProxyType(proxyType, loadSettingsProxyType()),
      fingerprintConfig: fingerprintConfig || {
        canvas: 'real',
        webrtc: 'real',
        timezone: 'real',
        screen: 'real',
        navigator: 'real',
      },
    });

    const httpStatus = mapErrorCodeToHttpStatus(result.code);
    const newProfileId = result.data?.newProfileId || null;

    if (result.code === 0) {
      logOperation(browserType, 'recreate', profileId, 'success', `newProfile=${newProfileId}`);
    } else {
      logOperation(browserType, 'recreate', profileId, 'error', `message="${result.message}"`);
    }

    return res.status(httpStatus).json(result);
  } catch (err) {
    logOperation(browserType || 'unknown', 'recreate', profileId, 'error', `message="${err.message}"`);
    return res.status(500).json({
      code: -1,
      message: `Unexpected error during profile recreation: ${err.message}`,
      data: null,
    });
  }
});

module.exports = { profileRouter: router };
