'use strict';

/**
 * Central runtime config (no secrets). Env-first; safe defaults.
 * Secrets must live only in process.env / .env — never hardcode real keys here.
 */

function envInt(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(key) {
  const v = String(process.env[key] || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function getServerPort() {
  return envInt('SERVER_PORT', envInt('BACKEND_PORT', 3100));
}

/** Self HTTP base for worker → main process analytics (no trailing slash). */
function getInternalApiBaseUrl() {
  const host = process.env.INTERNAL_API_HOST || '127.0.0.1';
  const port = envInt('INTERNAL_API_PORT', getServerPort());
  return `http://${host}:${port}`;
}

function getMoreloginPort() {
  return envInt('MORELOGIN_PORT', 40000);
}

/**
 * DANGEROUS for anti-detection: enables document.visibilityState monkey-patch in page.
 * Default OFF. Set MMB_ALLOW_VISIBILITY_OVERRIDE=true only if you accept ban risk.
 */
function isVisibilityOverrideAllowed() {
  return boolEnv('MMB_ALLOW_VISIBILITY_OVERRIDE') || boolEnv('ALLOW_VISIBILITY_OVERRIDE');
}

function getAnalyticsTrackMaxRetries() {
  return Math.max(1, envInt('ANALYTICS_TRACK_MAX_RETRIES', 5));
}

function getAnalyticsTrackInitialBackoffMs() {
  return Math.max(100, envInt('ANALYTICS_TRACK_BACKOFF_MS', 400));
}

module.exports = {
  getServerPort,
  getInternalApiBaseUrl,
  getMoreloginPort,
  isVisibilityOverrideAllowed,
  getAnalyticsTrackMaxRetries,
  getAnalyticsTrackInitialBackoffMs,
};
