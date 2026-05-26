/**
 * CookieImporter — Imports cookies into newly created profiles via browser-specific APIs
 * 
 * Supports:
 *   - MoreLogin: POST /api/env/cookie/import
 *   - Multilogin: authenticated cloud cookie endpoints
 * 
 * Behavior:
 *   - Skips import if cookies array is empty/null/undefined (returns cookiesImported: false)
 *   - 10-second timeout on all cookie import requests
 *   - On failure: logs warning, returns { success: false, cookiesImported: false, error }
 *   - On success: returns { success: true, cookiesImported: true }
 *   - Cookie import failure does NOT block profile creation
 * 
 * Configuration (via environment variables):
 *   MORELOGIN_PORT — MoreLogin Local API port (default: 40000)
 *   MORELOGIN_API_KEY — MoreLogin API key for Authorization header
 *   MULTILOGIN_EMAIL — Multilogin account email (for token auth)
 *   MULTILOGIN_PASSWORD — Multilogin account password (for token auth)
 * 
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

// Timeout for cookie import requests (10 seconds per Req 5.1)
const COOKIE_IMPORT_TIMEOUT = 10000;

// Default provider URLs
const DEFAULT_MORELOGIN_PORT = 40000;

const MULTILOGIN_CLOUD_API = 'https://api.multilogin.com';

class CookieImporter {
  constructor() {
    // MoreLogin config
    this.moreloginPort = parseInt(process.env.MORELOGIN_PORT, 10) || DEFAULT_MORELOGIN_PORT;
    this.moreloginBaseUrl = `http://127.0.0.1:${this.moreloginPort}`;
    this.moreloginApiKey = String(process.env.MORELOGIN_API_KEY || '').trim();

    // Multilogin config
    this.multiloginEmail = process.env.MULTILOGIN_EMAIL || '';
    this.multiloginPassword = process.env.MULTILOGIN_PASSWORD || '';
    this.multiloginToken = null;
    this.multiloginTokenExpiresAt = 0;
  }

  /**
   * Import cookies into a profile via the appropriate browser provider API.
   * 
   * @param {string} profileId - The profile ID to import cookies into
   * @param {string} browserType - Provider type: 'morelogin' or 'multilogin'
   * @param {Array|null|undefined} cookies - Array of cookie objects to import
   * @returns {Promise<{success: boolean, cookiesImported: boolean, error?: string}>}
   */
  async importCookies(profileId, browserType, cookies) {
    // Skip import if cookies array is empty/null/undefined (Req 5.6)
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
      return { success: true, cookiesImported: false };
    }

    try {
      switch (browserType) {
        case 'morelogin':
          return await this._importMoreLogin(profileId, cookies);
        case 'multilogin':
          return await this._importMultilogin(profileId, cookies);
        default:
          const errMsg = `Unsupported browser type for cookie import: ${browserType}`;
          console.warn(`[CookieImporter] ${errMsg} (profileId: ${profileId})`);
          return { success: false, cookiesImported: false, error: errMsg };
      }
    } catch (error) {
      // On failure: log warning with profileId and error (Req 5.5)
      const errMsg = error.message || 'Unknown error during cookie import';
      console.warn(`[CookieImporter] Cookie import failed for profileId=${profileId}: ${errMsg}`);
      return { success: false, cookiesImported: false, error: errMsg };
    }
  }

  /**
   * Import cookies into a MoreLogin profile.
   * POST /api/env/cookie/import with envId and cookie data.
   * 
   * @param {string} profileId - MoreLogin envId
   * @param {Array} cookies - Cookie array
   * @returns {Promise<{success: boolean, cookiesImported: boolean, error?: string}>}
   * @private
   */
  async _importMoreLogin(profileId, cookies) {
    if (!this.moreloginApiKey) {
      const errMsg = 'MORELOGIN_API_KEY is missing — cookie import aborted';
      console.warn(`[CookieImporter] ${errMsg} (profileId: ${profileId})`);
      return { success: false, cookiesImported: false, error: errMsg };
    }
    const url = `${this.moreloginBaseUrl}/api/env/cookie/import`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': this.moreloginApiKey,
    };

    const body = {
      envId: profileId,
      cookies: cookies,
    };

    const response = await this._httpRequest(url, {
      method: 'POST',
      headers,
      body,
      timeout: COOKIE_IMPORT_TIMEOUT,
    });

    // MoreLogin returns { code: 0, msg: "success" } on success
    if (response.body && response.body.code === 0) {
      return { success: true, cookiesImported: true };
    }

    const errMsg = (response.body && (response.body.msg || response.body.message))
      || `MoreLogin cookie import failed (HTTP ${response.statusCode})`;
    console.warn(`[CookieImporter] MoreLogin cookie import failed for profileId=${profileId}: ${errMsg}`);
    return { success: false, cookiesImported: false, error: errMsg };
  }

  /**
   * Import cookies into a Multilogin profile.
   * POST /profile/{id}/cookies with cookie array.
   * Requires Bearer token authentication.
   * 
   * @param {string} profileId - Multilogin profile_id
   * @param {Array} cookies - Cookie array
   * @returns {Promise<{success: boolean, cookiesImported: boolean, error?: string}>}
   * @private
   */
  async _importMultilogin(profileId, cookies) {
    // Ensure we have a valid token
    await this._ensureMultiloginToken();

    if (!this.multiloginToken) {
      const errMsg = 'Multilogin authentication failed: unable to obtain token';
      console.warn(`[CookieImporter] ${errMsg} (profileId: ${profileId})`);
      return { success: false, cookiesImported: false, error: errMsg };
    }

    const url = `${MULTILOGIN_CLOUD_API}/profile/${profileId}/cookies`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.multiloginToken}`,
    };

    const body = cookies;

    const response = await this._httpRequest(url, {
      method: 'POST',
      headers,
      body,
      timeout: COOKIE_IMPORT_TIMEOUT,
    });

    // Multilogin returns 2xx on success
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { success: true, cookiesImported: true };
    }

    const errMsg = (response.body && (response.body.message || response.body.msg))
      || `Multilogin cookie import failed (HTTP ${response.statusCode})`;
    console.warn(`[CookieImporter] Multilogin cookie import failed for profileId=${profileId}: ${errMsg}`);
    return { success: false, cookiesImported: false, error: errMsg };
  }

  /**
   * Ensure a valid Multilogin token is available.
   * Authenticates if no token exists or token has expired.
   * 
   * @private
   */
  async _ensureMultiloginToken() {
    if (this.multiloginToken && Date.now() < this.multiloginTokenExpiresAt) {
      return; // Token still valid
    }

    if (!this.multiloginEmail || !this.multiloginPassword) {
      this.multiloginToken = null;
      return;
    }

    try {
      const url = `${MULTILOGIN_CLOUD_API}/user/signin`;
      const response = await this._httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { email: this.multiloginEmail, password: md5(this.multiloginPassword) },
        timeout: COOKIE_IMPORT_TIMEOUT,
      });

      if (response.statusCode === 200 && response.body) {
        const token = (response.body.data && response.body.data.token)
          || response.body.token
          || null;

        if (token) {
          this.multiloginToken = token;
          // Refresh at 25 minutes (token expires at 30 min)
          this.multiloginTokenExpiresAt = Date.now() + 25 * 60 * 1000;
          return;
        }
      }

      this.multiloginToken = null;
    } catch (error) {
      console.warn(`[CookieImporter] Multilogin authentication failed: ${error.message}`);
      this.multiloginToken = null;
    }
  }

  /**
   * Low-level HTTP/HTTPS request using Node.js built-in modules.
   * Supports both http and https protocols.
   * 
   * @param {string} url - Full URL to request
   * @param {object} options - Request options
   * @param {string} options.method - HTTP method
   * @param {object} options.headers - Request headers
   * @param {object|Array|string|null} options.body - Request body
   * @param {number} options.timeout - Request timeout in ms
   * @returns {Promise<{statusCode: number, headers: object, body: any}>}
   * @private
   */
  _httpRequest(url, options) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const payload = options.body
        ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
        : null;

      const requestHeaders = { ...options.headers };
      if (payload) {
        if (!requestHeaders['Content-Type']) {
          requestHeaders['Content-Type'] = 'application/json';
        }
        requestHeaders['Content-Length'] = Buffer.byteLength(payload);
      }

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'POST',
        headers: requestHeaders,
        timeout: options.timeout || COOKIE_IMPORT_TIMEOUT,
      };

      // For HTTPS requests to Multilogin, allow self-signed certs
      if (isHttps) {
        reqOptions.rejectUnauthorized = false;
      }

      const req = transport.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: body,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error(`Cookie import request timeout after ${options.timeout}ms for ${url}`);
        err.code = 'TIMEOUT';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }
}

module.exports = CookieImporter;
module.exports.CookieImporter = CookieImporter;
