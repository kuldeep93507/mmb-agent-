/**
 * MoreLoginProvider — Concrete BrowserProvider for MoreLogin antidetect browser
 * 
 * Delegates all API calls to the existing MoreLogin Local API pattern:
 *   - HTTP POST to http://127.0.0.1:{port}
 *   - JSON body with Authorization header
 *   - Same endpoints as the existing moreloginRequest() in server/index.cjs
 * 
 * This provider wraps the existing MoreLogin integration without modifying
 * any existing code, ensuring full backward compatibility.
 * 
 * Configuration (via environment variables):
 *   MORELOGIN_API_KEY — API key for Authorization header (required — no fallback)
 *   MORELOGIN_PORT — Local API port (default: 40000)
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 10.4
 */

'use strict';

const { BrowserProvider } = require('./BrowserProvider.cjs');

const DEFAULT_PORT = 40000;

class MoreLoginProvider extends BrowserProvider {
  constructor() {
    super('morelogin');

    const apiKey = String(process.env.MORELOGIN_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('MORELOGIN_API_KEY is required — set it in project root .env or save in Settings');
    }
    this.apiKey = apiKey;
    this.port = parseInt(process.env.MORELOGIN_PORT, 10) || DEFAULT_PORT;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  /**
   * Make a MoreLogin API request using the same pattern as the existing
   * moreloginRequest() function in server/index.cjs:
   *   - POST method
   *   - JSON body
   *   - Authorization header with API key
   *   - Content-Type: application/json
   * 
   * @param {string} endpoint - API endpoint path (e.g., '/api/env/start')
   * @param {object} body - Request body to JSON-stringify
   * @param {number} [timeout=60000] - Request timeout in ms
   * @returns {Promise<{code: number, message: string, data: any}>} Standardized response
   */
  async _moreloginRequest(endpoint, body = {}, timeout = 60000) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': this.apiKey,
    };

    try {
      const response = await this.makeRequest(url, {
        method: 'POST',
        headers,
        body,
        timeout,
      });

      // MoreLogin API returns { code, msg, data }
      // Map to standardized format: { code, message, data }
      const result = response.body;

      if (result && typeof result === 'object') {
        return {
          code: result.code !== undefined ? result.code : -1,
          message: (result.msg || result.message || 'OK').slice(0, 256),
          data: result.data !== undefined ? result.data : null,
        };
      }

      // Unexpected response format
      return this._errorResponse(-1, 'Invalid response from MoreLogin API');
    } catch (error) {
      // Override connection refused message for MoreLogin-specific wording (Req 4.5)
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNRESET' || error.code === 'TIMEOUT' ||
          error.code === 'ENOTFOUND') {
        return this._errorResponse(-1, 'MoreLogin application must be started');
      }
      return this.handleError(error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FINGERPRINT PAYLOAD MAPPING
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Build MoreLogin-specific fingerprint payload from unified ExtendedFingerprintConfig.
   * Maps the application's fingerprint config to MoreLogin's flat field format.
   * Omits undefined/empty fields so the provider applies its own defaults (Req 4.6).
   * 
   * @param {import('../services/fingerprintData.cjs').ExtendedFingerprintConfig} config - Unified fingerprint config
   * @returns {object} MoreLogin-formatted fingerprint fields (flat object to merge into creation body)
   */
  buildFingerprintPayload(config) {
    if (!config) return {};

    const payload = {};

    // Timezone
    if (config.timezone) {
      payload.timezone = config.timezone;
    }

    // Language
    if (config.language) {
      payload.language = config.language;
    }

    // Resolution
    if (config.resolution) {
      payload.resolution = config.resolution;
    }

    // WebRTC mode: disabled=0, real=1, forward=2
    if (config.webRTC !== undefined && config.webRTC !== '') {
      payload.webrtcType = config.webRTC === 'disabled' ? 0 : config.webRTC === 'real' ? 1 : 2;
    }

    // Canvas noise
    if (config.canvasNoise && config.canvasNoise.seed) {
      payload.canvasType = 1;
      payload.canvasSeed = config.canvasNoise.seed;
    }

    // WebGL noise
    if (config.webGLNoise && config.webGLNoise.seed) {
      payload.webglType = 1;
      payload.webglSeed = config.webGLNoise.seed;
    }

    // AudioContext noise
    if (config.audioContextNoise && config.audioContextNoise.seed) {
      payload.audioType = 1;
      payload.audioSeed = config.audioContextNoise.seed;
    }

    // Geolocation
    if (config.geolocation) {
      if (config.geolocation.lat !== undefined && config.geolocation.lat !== null) {
        payload.latitude = config.geolocation.lat;
      }
      if (config.geolocation.lng !== undefined && config.geolocation.lng !== null) {
        payload.longitude = config.geolocation.lng;
      }
    }

    // User-agent
    if (config.userAgent) {
      payload.ua = config.userAgent;
    }

    // Fonts
    if (Array.isArray(config.fonts) && config.fonts.length > 0) {
      payload.fontList = config.fonts;
    }

    return payload;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Create a new browser profile via MoreLogin quick-create API.
   * When options.fingerprint is provided, includes fingerprint fields in the POST body.
   * 
   * @param {object} options - Profile creation options
   * @param {object} [options.fingerprint] - ExtendedFingerprintConfig to include in payload
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  /**
   * Map app OS name → MoreLogin operatorSystemId (Local API).
   * 1=Windows, 2=macOS, 3=Android, 4=iOS
   */
  _mapOsToOperatorSystemId(os) {
    const map = { Windows: 1, macOS: 2, Android: 3, Linux: 1 };
    return map[os] || 1;
  }

  async createProfile(options) {
    // Validate proxy if provided
    if (options && options.proxy) {
      const proxyCheck = this.validateProxy(options.proxy);
      if (!proxyCheck.valid) return proxyCheck.error;
    }

    const os = (options && options.os) || 'Windows';

    // Build MoreLogin-specific request body
    const body = {
      browserTypeId: (options && options.browserTypeId) || 1, // 1=Chrome
      operatorSystemId: (options && options.operatorSystemId)
        || this._mapOsToOperatorSystemId(os),
      quantity: (options && options.quantity) || 1,
    };

    if (options && options.name) {
      body.envName = options.name;
    }

    if (options && options.groupId) {
      body.groupId = options.groupId;
    }

    // Map proxy fields to MoreLogin format
    if (options && options.proxy) {
      body.proxyIp = options.proxy.server;
      body.proxyPort = options.proxy.port;
      body.username = options.proxy.username || '';
      body.password = options.proxy.password || '';
      body.proxyType = options.proxy.protocol || 'http';
    }

    // Include fingerprint fields when provided (Req 4.2)
    if (options && options.fingerprint) {
      const fingerprintFields = this.buildFingerprintPayload(options.fingerprint);
      Object.assign(body, fingerprintFields);
    }

    const result = await this._moreloginRequest('/api/env/create/quick', body);

    if (result.code !== 0) {
      return result;
    }

    // Normalize IDs — MoreLogin may return string[], object, or envId field
    const raw = result.data;
    let id = '';
    if (Array.isArray(raw)) {
      id = String(raw[0] || '');
    } else if (typeof raw === 'string') {
      id = raw;
    } else if (raw && typeof raw === 'object') {
      id = String(raw.envId || raw.id || raw[0] || '');
    }

    if (!id) {
      return this._errorResponse(-1, 'MoreLogin created profile but returned no env ID');
    }

    return this._successResponse(result.message || 'Profile created successfully', {
      id,
      profileId: id,
      envId: id,
    });
  }

  /** MoreLogin has no separate quick API — same local create/quick endpoint. */
  async createQuickProfile(options) {
    return this.createProfile(options);
  }

  /**
   * Start a browser profile and return CDP port
   * @param {string} profileId - MoreLogin envId
   * @returns {Promise<{code: number, message: string, data: {profileId: string, cdpPort: number}|null}>}
   */
  async startProfile(profileId) {
    const result = await this._moreloginRequest('/api/env/start', { envId: profileId });

    if (result.code === 0 && result.data) {
      // Map MoreLogin response to standardized format
      const cdpPort = parseInt(result.data.debugPort, 10);
      return this._successResponse('Profile started successfully', {
        profileId: result.data.envId || profileId,
        cdpPort: cdpPort,
      });
    }

    return result;
  }

  /**
   * Stop a running browser profile
   * @param {string} profileId - MoreLogin envId
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async stopProfile(profileId) {
    const result = await this._moreloginRequest('/api/env/close', { envId: profileId });
    return result;
  }

  /**
   * Clear local browser data for profile (cookies, storage, cache).
   * Used when YouTube sign-in / captcha wall appears.
   */
  async clearProfileCache(profileId) {
    const result = await this._moreloginRequest('/api/env/removeLocalCache', {
      envId: profileId,
      localStorage: true,
      indexedDB: true,
      cookie: true,
      extension: false,
    });
    return result;
  }

  /**
   * Delete a browser profile
   * @param {string} profileId - MoreLogin envId
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async deleteProfile(profileId) {
    const result = await this._moreloginRequest('/api/env/removeToRecycleBin/batch', {
      envIds: [profileId],
      removeEnvData: true,
    });
    return result;
  }

  /**
   * List browser profiles with pagination
   * @param {number} [pageNo=1] - Page number
   * @param {number} [pageSize=50] - Items per page
   * @returns {Promise<{code: number, message: string, data: {profiles: Array}|null}>}
   */
  async listProfiles(pageNo = 1, pageSize = 50) {
    const result = await this._moreloginRequest('/api/env/page', { pageNo, pageSize });

    if (result.code === 0 && result.data) {
      // Map MoreLogin dataList to standardized profile array
      const dataList = result.data.dataList || [];
      const profiles = dataList.map(item => ({
        id: item.id || item.envId || '',
        name: item.envName || item.name || '',
        status: this._mapStatus(item.status),
        debugPort: item.debugPort ? parseInt(item.debugPort, 10) : null,
        browserType: 'morelogin',
        osId: item.osId || item.os_id || null,
        osName: item.osName || item.os_name || null,
      }));

      return this._successResponse('Profiles retrieved successfully', {
        profiles,
        total: result.data.total || profiles.length,
        pages: result.data.pages || 1,
        current: result.data.current || pageNo,
      });
    }

    return result;
  }

  /**
   * Get the status of a specific profile
   * @param {string} profileId - MoreLogin envId
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async getProfileStatus(profileId) {
    const result = await this._moreloginRequest('/api/env/status', { envId: profileId });

    if (result.code === 0 && result.data) {
      return this._successResponse('Profile status retrieved', {
        id: result.data.envId || profileId,
        name: result.data.envName || '',
        status: this._mapStatus(result.data.status || result.data.localStatus),
        debugPort: result.data.debugPort ? parseInt(result.data.debugPort, 10) : null,
        browserType: 'morelogin',
      });
    }

    return result;
  }

  /**
   * Update proxy on an existing profile (must be stopped).
   * POST /api/env/update — MoreLogin local API
   */
  async updateProfileProxy(profileId, proxy) {
    if (!proxy || !proxy.server || !proxy.port) {
      return this._errorResponse(-5, 'Invalid proxy: server and port required');
    }
    const body = {
      envId: profileId,
      proxyIp: proxy.server,
      proxyPort: Number(proxy.port),
      username: proxy.username || '',
      password: proxy.password || '',
      proxyType: (proxy.protocol || 'http').toLowerCase(),
    };
    const result = await this._moreloginRequest('/api/env/update', body);
    if (result.code === 0) {
      console.log(`[morelogin] Proxy updated for env ${profileId}`);
    }
    return result;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INTERNAL HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Map MoreLogin status strings to standardized status enum
   * @param {string} status - MoreLogin status value
   * @returns {'running'|'stopped'|'error'|'unknown'}
   * @private
   */
  _mapStatus(status) {
    if (!status) return 'unknown';
    const s = String(status).toLowerCase();
    if (s === 'running' || s === 'active') return 'running';
    if (s === 'stopped' || s === 'closed' || s === 'idle') return 'stopped';
    if (s === 'error' || s === 'failed') return 'error';
    return 'unknown';
  }
}

// Standalone buildFingerprintPayload for direct access
function buildFingerprintPayload(config) {
  const instance = new MoreLoginProvider();
  return instance.buildFingerprintPayload(config);
}

module.exports = { MoreLoginProvider, buildFingerprintPayload };
