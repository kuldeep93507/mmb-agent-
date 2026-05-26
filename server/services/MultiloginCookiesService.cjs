/**
 * MultiloginCookiesService — Cookie warming metadata API for Multilogin X
 *
 * Uses https://cookies.multilogin.com/api/v1/cookies/
 * This is different from raw cookie import — it links a profile to a target
 * website so Multilogin automatically provides warm, authentic cookies for
 * that site when the profile is started.
 *
 * Available target websites: google, ebay, etsy, bing, mix, facebook, amazon
 *
 * Typical flow:
 *   1. Profile created → createCookieMetadata(profileId, 'google')
 *   2. On update → updateCookieMetadata(profileId, 'youtube')
 *   3. On query → getTargetWebsites()
 */

'use strict';

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const COOKIES_API_BASE = 'https://cookies.multilogin.com';
const CLOUD_API_BASE = 'https://api.multilogin.com';
const TOKEN_REFRESH_MS = 25 * 60 * 1000; // 25 min

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

class MultiloginCookiesService {
  constructor() {
    this.email = process.env.MULTILOGIN_EMAIL || '';
    this.password = process.env.MULTILOGIN_PASSWORD || '';
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PUBLIC METHODS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get list of available target websites for cookie warming.
   * GET https://cookies.multilogin.com/api/v1/cookies/metadata/websites
   *
   * @returns {Promise<{code: number, message: string, data: Array|null}>}
   */
  async getTargetWebsites() {
    try {
      const headers = await this._authHeaders();
      if (!headers) return this._err('Multilogin authentication failed');

      const res = await this._request(`${COOKIES_API_BASE}/api/v1/cookies/metadata/websites`, {
        method: 'GET',
        headers,
      });

      return this._parse(res, 'websites');
    } catch (err) {
      return this._err(err.message);
    }
  }

  /**
   * Create cookie warming metadata for a profile.
   * POST https://cookies.multilogin.com/api/v1/cookies/metadata
   *
   * @param {string} profileId - Multilogin profile_id
   * @param {string} [targetWebsite='mix'] - Target website key (google, facebook, mix, etc.)
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async createCookieMetadata(profileId, targetWebsite = 'mix') {
    if (!profileId) return this._err('profileId is required');

    try {
      const headers = await this._authHeaders();
      if (!headers) return this._err('Multilogin authentication failed');

      const res = await this._request(`${COOKIES_API_BASE}/api/v1/cookies/metadata`, {
        method: 'POST',
        headers,
        body: { profile_id: profileId, target_website: targetWebsite },
      });

      return this._parse(res, 'createCookieMetadata');
    } catch (err) {
      return this._err(err.message);
    }
  }

  /**
   * Update cookie warming target website for a profile.
   * PUT https://cookies.multilogin.com/api/v1/cookies/metadata
   *
   * @param {string} profileId - Multilogin profile_id
   * @param {string} targetWebsite - New target website key
   * @param {string} [additionalWebsite] - Optional additional website
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async updateCookieMetadata(profileId, targetWebsite, additionalWebsite) {
    if (!profileId || !targetWebsite) return this._err('profileId and targetWebsite are required');

    try {
      const headers = await this._authHeaders();
      if (!headers) return this._err('Multilogin authentication failed');

      const body = { profile_id: profileId, target_website: targetWebsite };
      if (additionalWebsite) body.additional_website = additionalWebsite;

      const res = await this._request(`${COOKIES_API_BASE}/api/v1/cookies/metadata`, {
        method: 'PUT',
        headers,
        body,
      });

      return this._parse(res, 'updateCookieMetadata');
    } catch (err) {
      return this._err(err.message);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INTERNAL HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async _authHeaders() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` };
    }

    if (!this.email || !this.password) return null;

    try {
      const res = await this._request(`${CLOUD_API_BASE}/user/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { email: this.email, password: md5(this.password) },
      });

      const token = (res.body && res.body.data && res.body.data.token) || null;
      if (!token) return null;

      this.token = token;
      this.tokenExpiresAt = Date.now() + TOKEN_REFRESH_MS;
      return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` };
    } catch {
      return null;
    }
  }

  _parse(res, context) {
    const body = res.body;
    const httpCode = (body && body.status && body.status.http_code) || res.statusCode;
    const msg = (body && body.status && body.status.message) || (body && body.message) || 'OK';

    if (httpCode >= 200 && httpCode < 300) {
      return { code: 0, message: msg, data: (body && body.data !== undefined) ? body.data : body };
    }
    return this._err(msg);
  }

  _err(msg) {
    return { code: -1, message: String(msg).slice(0, 256), data: null };
  }

  _request(url, options) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const payload = options.body
        ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
        : null;

      const headers = { ...options.headers };
      if (payload) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = https.request({
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers,
        timeout: 10000,
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let body;
          try { body = JSON.parse(data); } catch { body = data; }
          resolve({ statusCode: res.statusCode, body });
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { MultiloginCookiesService };
