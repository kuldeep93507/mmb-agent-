/**
 * Backend REST authentication.
 * Prefer BACKEND_API_KEY; MMB_API_TOKEN is supported as an alias during migration.
 * GET /api/settings returns the same secret as `apiToken` for local UI storage.
 */

'use strict';

let cachedExplicit = '';

function refreshBackendSecretCache() {
  cachedExplicit =
    String(process.env.BACKEND_API_KEY || process.env.MMB_API_TOKEN || '').trim();
}

function getBackendApiSecret() {
  if (!cachedExplicit) refreshBackendSecretCache();
  return cachedExplicit;
}

/** @deprecated Prefer getBackendApiSecret — retained for backward-compatible imports */
function getApiToken() {
  return getBackendApiSecret();
}

/**
 * Normalize credentials from inbound HTTP requests.
 * @returns {{ xApiKey: string; token: string }}
 */
function readRequestCredentials(req) {
  const xApiKeyHdr = req.headers['x-api-key'];
  const xApiKey =
    xApiKeyHdr != null && String(xApiKeyHdr).trim() ? String(xApiKeyHdr).trim() : '';

  const legacy = req.headers['x-mmb-token'];
  let token =
    legacy != null && String(legacy).trim() ? String(legacy).trim() : '';

  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) {
    token = auth.replace(/^Bearer\s+/i, '').trim();
  }

  return { xApiKey, token };
}

function readRequestToken(req) {
  const c = readRequestCredentials(req);
  return c.xApiKey || c.token || '';
}

function requireAuth(req, res, next) {
  const expected = getBackendApiSecret();
  const provided = readRequestToken(req);
  if (!expected) {
    console.error('[apiAuth] requireAuth called without configured BACKEND_API_KEY/MMB_API_TOKEN');
    res.status(503).json({
      error: 'Service unavailable',
      message: 'Backend auth secret is missing.',
    });
    return;
  }
  if (provided && provided === expected) return next();
  const ip =
    typeof req.ip === 'string' && req.ip
      ? req.ip
      : (typeof req.socket?.remoteAddress === 'string'
        ? req.socket.remoteAddress
        : '');
  console.warn(`[apiAuth] HTTP 401 ${req.method} ${req.originalUrl || req.path || ''} ip=${ip || '(unknown)'}`);
  res.status(401).json({
    error: 'Unauthorized',
    message: 'Provide X-MMB-Token, x-api-key, or Bearer token matching BACKEND_API_KEY / MMB_API_TOKEN.',
  });
}

module.exports = {
  getApiToken,
  getBackendApiSecret,
  refreshBackendSecretCache,
  readRequestCredentials,
  requireAuth,
};
