'use strict';

/** @typedef {'smartproxy'|'multilogin'|'none'} NormalizedProxyType */

const MULTILOGIN_ALIASES = new Set([
  'multilogin',
  'multilogin_residential',
  'multilogin-proxy',
  'mlx',
  'mlx_residential',
  'builtin',
  'built-in',
  'built_in',
]);

const SMARTPROXY_ALIASES = new Set([
  'smartproxy',
  'smart',
  'external',
  'custom',
]);

/**
 * @param {string} [input]
 * @returns {NormalizedProxyType|null}
 */
function normalizeProxyType(input) {
  const t = (input && typeof input === 'string') ? input.toLowerCase().trim() : '';
  if (!t || t === 'none') return t === 'none' ? 'none' : null;
  if (MULTILOGIN_ALIASES.has(t)) return 'multilogin';
  if (SMARTPROXY_ALIASES.has(t)) return 'smartproxy';
  return null;
}

function isMultiloginProxyType(input) {
  return normalizeProxyType(input) === 'multilogin';
}

function isSmartProxyType(input) {
  return normalizeProxyType(input) === 'smartproxy';
}

/**
 * Resolve proxy type for profile create (body wins, then saved settings, then smartproxy).
 * @param {string} [bodyProxyType]
 * @param {string} [settingsProxyType]
 * @returns {NormalizedProxyType}
 */
function resolveCreateProxyType(bodyProxyType, settingsProxyType) {
  return normalizeProxyType(bodyProxyType)
    || normalizeProxyType(settingsProxyType)
    || 'smartproxy';
}

function isSmartProxyHost(host) {
  return String(host || '').toLowerCase().includes('smartproxy.net');
}

function isMultiloginProxyHost(host) {
  const h = String(host || '').toLowerCase();
  return h.includes('multilogin.com') || h.includes('gate.multilogin');
}

module.exports = {
  normalizeProxyType,
  isMultiloginProxyType,
  isSmartProxyType,
  resolveCreateProxyType,
  isSmartProxyHost,
  isMultiloginProxyHost,
};
