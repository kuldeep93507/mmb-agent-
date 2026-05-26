'use strict';

/** Allowed residential proxy countries — never India or other regions. */
const ALLOWED_PROXY_COUNTRIES = ['us', 'gb'];

/**
 * @param {string} [input] - ISO code (us, gb, uk)
 * @param {boolean} [randomPick=false] - pick random US/UK when invalid
 * @returns {'us'|'gb'}
 */
function normalizeProxyCountry(input, randomPick = false) {
  let c = (input && typeof input === 'string') ? input.toLowerCase().trim() : '';
  if (c === 'uk') c = 'gb';
  if (ALLOWED_PROXY_COUNTRIES.includes(c)) return c;
  if (randomPick) {
    return ALLOWED_PROXY_COUNTRIES[Math.floor(Math.random() * ALLOWED_PROXY_COUNTRIES.length)];
  }
  return 'us';
}

/**
 * Fingerprint geo aligned with proxy country (US state TZ or UK London).
 * @param {'us'|'gb'|string} country
 * @param {Record<string, string>} stateTimezoneMap
 */
function geoForProxyCountry(country, stateTimezoneMap) {
  const cc = normalizeProxyCountry(country);
  if (cc === 'gb') {
    return {
      country: 'GB',
      language: 'en-GB',
      timezone: 'Europe/London',
      city: 'London',
      region: 'England',
      latitude: 51.5074 + (Math.random() - 0.5) * 0.1,
      longitude: -0.1278 + (Math.random() - 0.5) * 0.1,
    };
  }
  const states = Object.keys(stateTimezoneMap || {});
  const randomState = states[Math.floor(Math.random() * states.length)] || 'NEWYORK';
  return {
    country: 'US',
    language: 'en-US',
    timezone: stateTimezoneMap[randomState] || 'America/New_York',
    city: randomState,
    region: randomState,
    latitude: 30 + Math.random() * 15,
    longitude: -115 + Math.random() * 25,
  };
}

module.exports = {
  ALLOWED_PROXY_COUNTRIES,
  normalizeProxyCountry,
  geoForProxyCountry,
};
