'use strict';

const { getBackendApiSecret, readRequestCredentials } = require('./apiAuth.cjs');

function isTruthyUrlPath(p) {
  return p === '/api/health';
}

/** @type {express.RequestHandler} */
function requireBackendApiKey(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  /** @type {string} */
  const pathRaw = typeof req.path === 'string' ? req.path : '';
  /** Some mounts use req.originalUrl */
  try {
    const u = req.originalUrl ? new URL(req.originalUrl, 'http://localhost') : null;
    const pathnameOnly = u ? u.pathname : pathRaw;

    if (isTruthyUrlPath(pathnameOnly) || isTruthyUrlPath(pathRaw)) {
      return next();
    }
  } catch (_) {
    if (isTruthyUrlPath(pathRaw)) return next();
  }

  const expected = getBackendApiSecret();
  if (!expected) {
    console.error('[backendApiKeyAuth] BUG: middleware active without BACKEND_API_KEY/MMB_API_TOKEN');
    res.status(503).json({
      error: 'Service unavailable',
      message: 'Backend is misconfigured — missing BACKEND_API_KEY.',
    });
    return;
  }

  const creds = readRequestCredentials(req);
  if ((creds.xApiKey && creds.xApiKey === expected)
    || (creds.token && creds.token === expected)) {
    return next();
  }

  const fwd = typeof req.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : '';
  const ip =
    typeof req.ip === 'string' && req.ip
      ? req.ip
      : fwd || '(unknown)';
  console.warn(`[backendApiKeyAuth] HTTP 403 ${req.method} ${pathRaw || req.originalUrl || ''} ip=${ip}`);

  res.status(403).json({
    error: 'Forbidden',
    message: 'Missing or invalid x-api-key header (same value as BACKEND_API_KEY / MMB_API_TOKEN).',
  });
}

module.exports = { requireBackendApiKey };
