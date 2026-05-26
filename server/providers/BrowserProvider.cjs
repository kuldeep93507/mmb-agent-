/**
 * BrowserProvider — Abstract base class for antidetect browser providers
 * 
 * Browser providers (MoreLogin, Multilogin) extend this class.
 * Provides unified interface + shared utilities for HTTP requests, error handling,
 * retry logic, and proxy validation.
 * 
 * Response format: { code, message, data }
 *   code: 0 = success, negative = error
 *   message: human-readable string (max 256 chars)
 *   data: payload on success, null on failure
 * 
 * Error codes:
 *   -1: Connection error / timeout (provider app not running)
 *   -2: Authentication error (invalid credentials)
 *   -3: Rate limit exceeded (all retries exhausted)
 *   -4: Token refresh failed (Multilogin re-auth required)
 *   -5: Validation error (invalid input parameters)
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

class BrowserProvider {
  /**
   * @param {string} name - Provider identifier ("morelogin", "multilogin")
   */
  constructor(name) {
    if (new.target === BrowserProvider) {
      throw new Error('BrowserProvider is abstract and cannot be instantiated directly');
    }
    this.name = name;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ABSTRACT METHODS — Must be overridden by subclasses
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Create a new browser profile
   * @param {object} options - Profile creation options (name, os, proxy, browserType)
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async createProfile(options) {
    throw new Error(`[${this.name}] createProfile() not implemented`);
  }

  /**
   * Start a browser profile and return CDP port
   * @param {string} profileId - Profile identifier
   * @returns {Promise<{code: number, message: string, data: {profileId: string, cdpPort: number}|null}>}
   */
  async startProfile(profileId) {
    throw new Error(`[${this.name}] startProfile() not implemented`);
  }

  /**
   * Stop a running browser profile
   * @param {string} profileId - Profile identifier
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async stopProfile(profileId) {
    throw new Error(`[${this.name}] stopProfile() not implemented`);
  }

  /**
   * Delete a browser profile
   * @param {string} profileId - Profile identifier
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async deleteProfile(profileId) {
    throw new Error(`[${this.name}] deleteProfile() not implemented`);
  }

  /**
   * List browser profiles with pagination
   * @param {number} [pageNo=1] - Page number
   * @param {number} [pageSize=50] - Items per page
   * @param {{ enrichDetails?: boolean }} [options] - Provider-specific options (e.g. fetch proxy hints per profile)
   * @returns {Promise<{code: number, message: string, data: {profiles: Array}|null}>}
   */
  async listProfiles(pageNo = 1, pageSize = 50, options = {}) {
    throw new Error(`[${this.name}] listProfiles() not implemented`);
  }

  /**
   * Get the status of a specific profile
   * @param {string} profileId - Profile identifier
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async getProfileStatus(profileId) {
    throw new Error(`[${this.name}] getProfileStatus() not implemented`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SHARED UTILITIES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Make an HTTP/HTTPS request with timeout and retry logic for 429 responses.
   * Uses Node.js built-in http/https modules (no external dependencies).
   * 
   * Retry behavior:
   *   - Only retries on 429 (rate limit) responses
   *   - 3 retries with exponential backoff: 1s, 2s, 4s
   *   - Connection errors and timeouts are NOT retried (thrown immediately)
   * 
   * @param {string} url - Full URL to request
   * @param {object} [options={}] - Request options
   * @param {string} [options.method='GET'] - HTTP method
   * @param {object} [options.headers={}] - Request headers
   * @param {object|string|null} [options.body=null] - Request body (object will be JSON-stringified)
   * @param {number} [options.timeout=10000] - Request timeout in ms (default 10s)
   * @returns {Promise<{statusCode: number, headers: object, body: any}>}
   * @throws {Error} On connection error, timeout, or rate limit exhausted
   */
  async makeRequest(url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body = null,
      timeout = 10000,
    } = options;

    const maxRetries = 3;
    const baseDelay = 1000; // 1s, 2s, 4s exponential backoff

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this._httpRequest(url, { method, headers, body, timeout });

        // Rate limited — retry with exponential backoff
        if (response.statusCode === 429 && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt); // 1s, 2s, 4s
          console.log(`[${this.name}] Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
          await this._sleep(delay);
          continue;
        }

        // Rate limit exhausted after all retries
        if (response.statusCode === 429 && attempt >= maxRetries) {
          const err = new Error('Rate limit exceeded, all retries exhausted');
          err.code = 'RATE_LIMIT_EXHAUSTED';
          throw err;
        }

        return response;
      } catch (error) {
        // Connection errors and timeouts — don't retry, throw immediately
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' ||
            error.code === 'ECONNRESET' || error.code === 'TIMEOUT' ||
            error.code === 'ENOTFOUND') {
          throw error;
        }

        // Rate limit exhausted error — throw
        if (error.code === 'RATE_LIMIT_EXHAUSTED') {
          throw error;
        }

        // Other errors on last attempt — throw
        if (attempt >= maxRetries) {
          throw error;
        }

        // Other transient errors — retry
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`[${this.name}] Request error: ${error.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await this._sleep(delay);
      }
    }
  }

  /**
   * Map an error to a standardized error response with appropriate code.
   * 
   * Error code mapping:
   *   -1: Connection refused, timeout, network errors
   *   -2: Authentication errors (401, 403)
   *   -3: Rate limit exhausted (429 after all retries)
   *   -5: Validation errors (bad input)
   * 
   * @param {Error} error - The error to handle
   * @returns {{code: number, message: string, data: null}}
   */
  handleError(error) {
    // Connection / timeout errors → code -1
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' || error.code === 'TIMEOUT' ||
        error.code === 'ENOTFOUND') {
      const msg = `${this.name} application is not running or not reachable: ${error.message}`;
      return this._errorResponse(-1, msg);
    }

    // Authentication errors → code -2
    if (error.code === 'AUTH_ERROR' || error.statusCode === 401 || error.statusCode === 403) {
      const msg = `Authentication failed for ${this.name}: ${error.message || 'Invalid credentials'}`;
      return this._errorResponse(-2, msg);
    }

    // Rate limit exhausted → code -3
    if (error.code === 'RATE_LIMIT_EXHAUSTED') {
      const msg = `Rate limit exceeded for ${this.name}, all retries failed`;
      return this._errorResponse(-3, msg);
    }

    // Validation errors → code -5
    if (error.code === 'VALIDATION_ERROR') {
      return this._errorResponse(-5, error.message);
    }

    // Generic/unknown errors → code -1 (treat as connection issue)
    const msg = `${this.name} error: ${error.message || 'Unknown error'}`;
    return this._errorResponse(-1, msg);
  }

  /**
   * Validate proxy configuration before sending to provider API.
   * Checks that required fields (server, port) are present.
   * 
   * @param {object} proxy - Proxy configuration object
   * @param {string} proxy.server - Proxy server address (required)
   * @param {number} proxy.port - Proxy port (required)
   * @param {string} [proxy.username] - Proxy username
   * @param {string} [proxy.password] - Proxy password
   * @param {string} [proxy.protocol] - Proxy protocol ("http" or "socks5")
   * @returns {{valid: boolean, error: {code: number, message: string, data: null}|null}}
   */
  validateProxy(proxy) {
    if (!proxy) {
      // No proxy is valid (direct connection)
      return { valid: true, error: null };
    }

    const missing = [];
    if (!proxy.server) missing.push('server');
    if (proxy.port === undefined || proxy.port === null || proxy.port === '') missing.push('port');

    if (missing.length > 0) {
      const msg = `Proxy validation failed: missing required field(s): ${missing.join(', ')}`;
      return {
        valid: false,
        error: this._errorResponse(-5, msg),
      };
    }

    return { valid: true, error: null };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // RESPONSE HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Create a standardized success response
   * @param {string} message - Success message
   * @param {object} data - Response data
   * @returns {{code: number, message: string, data: object}}
   */
  _successResponse(message, data) {
    return {
      code: 0,
      message: String(message).slice(0, 256),
      data: data,
    };
  }

  /**
   * Create a standardized error response
   * @param {number} code - Error code (negative number)
   * @param {string} message - Error message
   * @returns {{code: number, message: string, data: null}}
   */
  _errorResponse(code, message) {
    return {
      code: code,
      message: String(message).slice(0, 256),
      data: null,
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INTERNAL HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Low-level HTTP/HTTPS request using Node.js built-in modules.
   * @param {string} url - Full URL
   * @param {object} options - Request options
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

      // Only disable TLS verification for localhost/127.0.0.1 — these are the local
      // browser launcher endpoints that use self-signed certs (Multilogin launcher, MoreLogin).
      // External cloud APIs (api.multilogin.com, etc.) must use proper TLS verification.
      const isLocalhost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '::1';
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: requestHeaders,
        timeout: options.timeout || 10000,
        rejectUnauthorized: !isLocalhost, // false only for localhost (self-signed certs), true for all external hosts
      };

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
        const err = new Error(`Request timeout after ${options.timeout || 10000}ms: ${url}`);
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

  /**
   * Sleep utility for retry delays
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BrowserProvider };
