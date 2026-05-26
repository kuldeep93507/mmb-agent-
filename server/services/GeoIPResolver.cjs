'use strict';

/**
 * GeoIPResolver — Resolves geographic location from proxy IP addresses.
 * 
 * Uses ip-api.com free GeoIP API to determine timezone, language,
 * latitude, longitude, country, region, and city from a proxy server address.
 * 
 * Features:
 * - 5-second timeout on HTTP requests
 * - Single retry after 2-second delay on rate-limit (HTTP 429)
 * - Fallback to defaults on any failure
 * - Uses COUNTRY_LANGUAGE_MAP for country-to-language mapping
 */

const http = require('http');
const { COUNTRY_LANGUAGE_MAP } = require('./fingerprintData.cjs');

/** Default GeoData used when resolution fails */
const DEFAULT_GEO_DATA = {
  timezone: 'America/New_York',
  language: 'en-US',
  latitude: 40.7128,
  longitude: -74.0060,
  country: 'US',
  region: 'NY',
  city: 'New York',
};

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 5000;

/** ip-api.com free tier: 45 requests per minute.
 *  On rate-limit we wait 65 seconds (full window reset + buffer) then retry once.
 *  A 2-second retry was useless — the rate-limit window is 60 seconds.
 */
const RATE_LIMIT_RETRY_DELAY_MS = 65000;

/**
 * In-process GeoIP cache — keyed by IP/hostname.
 * Bulk profile creation: 50 profiles may share the same proxy gateway (us.smartproxy.net).
 * Caching means only 1 real API call per unique host, regardless of how many profiles.
 * Cache TTL: 10 minutes (proxy geo doesn't change that fast).
 * @type {Map<string, { data: object, cachedAt: number }>}
 */
const _geoCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Extracts the IP/hostname from a proxy server string.
 * Handles formats like "host:port", "http://host:port", "host"
 * @param {string} proxyServer - The proxy server address
 * @returns {string} The extracted IP or hostname
 */
function extractHost(proxyServer) {
  if (!proxyServer) return '';
  // Remove protocol prefix if present
  let host = proxyServer.replace(/^https?:\/\//, '');
  // Remove port if present
  host = host.split(':')[0];
  // Remove path if present
  host = host.split('/')[0];
  return host.trim();
}

/**
 * Makes an HTTP GET request to ip-api.com with a timeout.
 * @param {string} ip - The IP address to look up
 * @returns {Promise<{statusCode: number, body: object|null}>}
 */
function fetchGeoIP(ip) {
  return new Promise((resolve, reject) => {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,lat,lon,timezone`;

    const req = http.get(url, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (err) {
          reject(new Error(`Failed to parse GeoIP response: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`GeoIP request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', (err) => {
      reject(new Error(`GeoIP request failed: ${err.message}`));
    });
  });
}

/**
 * Delays execution for the specified duration.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GeoIPResolver {
  /**
   * Resolves geographic location from a proxy server address.
   * 
   * @param {string} proxyServer - The proxy server address (e.g., "1.2.3.4:8080" or "proxy.example.com")
   * @returns {Promise<{success: boolean, data?: object, error?: string}>} GeoIP result
   */
  async resolve(proxyServer) {
    const ip = extractHost(proxyServer);

    if (!ip) {
      console.warn(`[GeoIPResolver] Warning: Empty proxy server address provided, using defaults`);
      return { success: true, data: { ...DEFAULT_GEO_DATA } };
    }

    // Cache check — prevents burning ip-api.com quota when bulk-creating profiles
    // that share the same proxy gateway (e.g. us.smartproxy.net → same geo every time)
    const cached = _geoCache.get(ip);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
      return { success: true, data: { ...cached.data } };
    }

    try {
      const result = await this._resolveWithRetry(ip);
      // Store in cache on success
      if (result.success && result.data) {
        _geoCache.set(ip, { data: result.data, cachedAt: Date.now() });
      }
      return result;
    } catch (err) {
      console.warn(`[GeoIPResolver] Warning: Failed to resolve GeoIP for "${ip}" — ${err.message}. Using defaults.`);
      return { success: true, data: { ...DEFAULT_GEO_DATA } };
    }
  }

  /**
   * Attempts GeoIP resolution with a single retry on rate-limit.
   * @param {string} ip - The IP to resolve
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   * @private
   */
  async _resolveWithRetry(ip) {
    let response;

    try {
      response = await fetchGeoIP(ip);
    } catch (err) {
      // First attempt failed (timeout, network error, parse error)
      console.warn(`[GeoIPResolver] Warning: GeoIP lookup failed for "${ip}" — ${err.message}. Using defaults.`);
      return { success: true, data: { ...DEFAULT_GEO_DATA } };
    }

    // Handle rate-limit: retry once after delay
    if (response.statusCode === 429) {
      console.warn(`[GeoIPResolver] Rate-limited on GeoIP lookup for "${ip}". Retrying after ${RATE_LIMIT_RETRY_DELAY_MS}ms...`);
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);

      try {
        response = await fetchGeoIP(ip);
      } catch (err) {
        console.warn(`[GeoIPResolver] Warning: GeoIP retry failed for "${ip}" — ${err.message}. Using defaults.`);
        return { success: true, data: { ...DEFAULT_GEO_DATA } };
      }

      // If still rate-limited after retry, fall back
      if (response.statusCode === 429) {
        console.warn(`[GeoIPResolver] Warning: Still rate-limited for "${ip}" after retry. Using defaults.`);
        return { success: true, data: { ...DEFAULT_GEO_DATA } };
      }
    }

    // Handle non-200 responses
    if (response.statusCode !== 200) {
      console.warn(`[GeoIPResolver] Warning: GeoIP returned HTTP ${response.statusCode} for "${ip}". Using defaults.`);
      return { success: true, data: { ...DEFAULT_GEO_DATA } };
    }

    // Validate response body
    const body = response.body;
    if (!body || body.status === 'fail') {
      const reason = body?.message || 'unknown error';
      console.warn(`[GeoIPResolver] Warning: GeoIP lookup failed for "${ip}" — ${reason}. Using defaults.`);
      return { success: true, data: { ...DEFAULT_GEO_DATA } };
    }

    // Validate required fields
    if (!body.timezone || body.lat == null || body.lon == null || !body.countryCode) {
      console.warn(`[GeoIPResolver] Warning: GeoIP response missing required fields for "${ip}". Using defaults.`);
      return { success: true, data: { ...DEFAULT_GEO_DATA } };
    }

    // Map country code to language using COUNTRY_LANGUAGE_MAP
    const language = COUNTRY_LANGUAGE_MAP[body.countryCode] || 'en-US';

    const geoData = {
      timezone: body.timezone,
      language: language,
      latitude: parseFloat(body.lat.toFixed(4)),
      longitude: parseFloat(body.lon.toFixed(4)),
      country: body.countryCode,
      region: body.region || '',
      city: body.city || '',
    };

    return { success: true, data: geoData };
  }
}

module.exports = GeoIPResolver;
