/**
 * AdsPowerProvider — Concrete BrowserProvider for AdsPower antidetect browser
 * 
 * Connects to the AdsPower Local API running on the user's machine.
 * Key differences from MoreLogin:
 *   - Uses GET requests for start/stop/list/status operations
 *   - Uses POST requests for create/delete operations
 *   - Response format: { code: 0, msg: "success", data: {...} }
 *   - Profile ID field is "user_id" (not envId)
 *   - CDP port is in "debug_port" field (not debugPort)
 *   - List uses query params (page, page_size) not request body
 *   - Requires API key (passed via Authorization Bearer header) when AdsPower
 *     Local API security is enabled
 * 
 * Configuration (via environment variables):
 *   ADSPOWER_API_URL — Base URL for AdsPower Local API
 *     (default: "http://local.adspower.com:50325")
 *   ADSPOWER_API_KEY — Local API key from AdsPower app → Settings → API
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 10.1
 */

'use strict';

const { BrowserProvider } = require('./BrowserProvider.cjs');

// Default AdsPower Local API URL
const DEFAULT_API_URL = 'http://local.adspower.com:50325';

// Timeout configuration
const CONNECT_TIMEOUT = 5000;   // 5s for connection checks
const START_TIMEOUT = 30000;    // 30s for browser start operations
const DEFAULT_TIMEOUT = 10000;  // 10s for standard requests

class AdsPowerProvider extends BrowserProvider {
  constructor() {
    super('adspower');

    // Read config from environment with default
    this.baseUrl = (process.env.ADSPOWER_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
    this.apiKey = (process.env.ADSPOWER_API_KEY || '').trim();
  }

  /**
   * Build common headers including Authorization if API key is configured.
   * @returns {object}
   * @private
   */
  _buildHeaders(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Make an AdsPower GET request with query parameters.
   * AdsPower uses GET for start, stop, list, and status endpoints.
   * 
   * @param {string} endpoint - API endpoint path (e.g., '/api/v1/browser/start')
   * @param {object} [params={}] - Query parameters to append to URL
   * @param {number} [timeout=DEFAULT_TIMEOUT] - Request timeout in ms
   * @returns {Promise<{code: number, message: string, data: any}>} Standardized response
   */
  async _adspowerGet(endpoint, params = {}, timeout = DEFAULT_TIMEOUT) {
    // Build URL with query string
    const queryParts = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    const url = `${this.baseUrl}${endpoint}${queryString}`;

    try {
      const response = await this.makeRequest(url, {
        method: 'GET',
        headers: this._buildHeaders(),
        timeout,
      });

      return this._parseResponse(response);
    } catch (error) {
      return this._handleAdsPowerError(error);
    }
  }

  /**
   * Make an AdsPower POST request with JSON body.
   * AdsPower uses POST for create and delete endpoints.
   * 
   * @param {string} endpoint - API endpoint path (e.g., '/api/v1/user/create')
   * @param {object} body - Request body to JSON-stringify
   * @param {number} [timeout=DEFAULT_TIMEOUT] - Request timeout in ms
   * @returns {Promise<{code: number, message: string, data: any}>} Standardized response
   */
  async _adspowerPost(endpoint, body = {}, timeout = DEFAULT_TIMEOUT) {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await this.makeRequest(url, {
        method: 'POST',
        headers: this._buildHeaders({ 'Content-Type': 'application/json' }),
        body,
        timeout,
      });

      return this._parseResponse(response);
    } catch (error) {
      return this._handleAdsPowerError(error);
    }
  }

  /**
   * Parse AdsPower API response into standardized format.
   * AdsPower returns: { code: 0, msg: "success", data: {...} }
   * 
   * @param {object} response - Raw HTTP response from makeRequest
   * @returns {{code: number, message: string, data: any}}
   * @private
   */
  _parseResponse(response) {
    const result = response.body;

    if (result && typeof result === 'object') {
      // AdsPower uses code 0 for success, non-zero for errors
      const code = result.code !== undefined ? result.code : -1;
      const message = (result.msg || result.message || 'OK').slice(0, 256);
      const data = result.data !== undefined ? result.data : null;

      return { code, message, data };
    }

    // Unexpected response format
    return this._errorResponse(-1, 'Invalid response from AdsPower API');
  }

  /**
   * Handle AdsPower-specific errors with appropriate messaging.
   * Maps connection errors to "AdsPower application must be started" message.
   * 
   * @param {Error} error - The error to handle
   * @returns {{code: number, message: string, data: null}}
   * @private
   */
  _handleAdsPowerError(error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' || error.code === 'TIMEOUT' ||
        error.code === 'ENOTFOUND') {
      return this._errorResponse(-1, 'AdsPower application must be started');
    }
    return this.handleError(error);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * List browser profiles with pagination
   * GET /api/v1/user/list?page={pageNo}&page_size={pageSize}
   * 
   * @param {number} [pageNo=1] - Page number
   * @param {number} [pageSize=100] - Items per page (AdsPower default: 100)
   * @returns {Promise<{code: number, message: string, data: {profiles: Array}|null}>}
   */
  async listProfiles(pageNo = 1, pageSize = 100) {
    const result = await this._adspowerGet('/api/v1/user/list', {
      page: pageNo,
      page_size: pageSize,
    });

    if (result.code === 0 && result.data) {
      // AdsPower returns data.list as the array of profiles
      const list = result.data.list || [];
      const profiles = list.map(item => ({
        id: item.user_id || '',
        name: item.name || '',
        status: this._mapStatus(item.status),
        debugPort: null,
        browserType: 'adspower',
      }));

      return this._successResponse('Profiles retrieved successfully', {
        profiles,
        total: result.data.page_count || profiles.length,
        pages: result.data.page_count ? Math.ceil(result.data.page_count / pageSize) : 1,
        current: pageNo,
      });
    }

    return result;
  }

  /**
   * Fetch the first available AdsPower group_id. AdsPower requires a group_id
   * for profile creation. If the user did not provide one, we look up the first
   * group from the user's account.
   *
   * @returns {Promise<string|null>} Group ID or null if none found
   * @private
   */
  async _getDefaultGroupId() {
    const result = await this._adspowerGet('/api/v1/group/list', { page: 1, page_size: 1 });
    if (result.code === 0 && result.data) {
      const list = result.data.list || [];
      if (list.length > 0) {
        return String(list[0].group_id || '');
      }
    }
    return null;
  }

  /**
   * Create a default group named "MMB-Agent" if no groups exist on the account.
   * @returns {Promise<string|null>} New group_id or null on failure
   * @private
   */
  async _createDefaultGroup() {
    const result = await this._adspowerPost('/api/v1/group/create', {
      group_name: 'MMB-Agent',
    });
    if (result.code === 0 && result.data) {
      return String(result.data.group_id || '');
    }
    return null;
  }

  /**
   * Create a new browser profile via AdsPower API
   * POST /api/v1/user/create
   * 
   * Maps proxy to user_proxy_config: {
   *   proxy_soft: protocol, proxy_type: protocol,
   *   proxy_host: server, proxy_port: port,
   *   proxy_user: username, proxy_password: password
   * }
   * 
   * @param {object} options - Profile creation options
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async createProfile(options) {
    // Validate proxy if provided
    if (options && options.proxy) {
      const proxyCheck = this.validateProxy(options.proxy);
      if (!proxyCheck.valid) return proxyCheck.error;
    }

    // Build AdsPower-specific request body
    const body = {};

    if (options && options.name) {
      body.name = options.name;
    }

    // Resolve group_id — explicitly provided, or auto-discovered/created
    let groupId = options && options.groupId ? String(options.groupId) : null;
    if (!groupId) {
      groupId = await this._getDefaultGroupId();
      if (!groupId) {
        groupId = await this._createDefaultGroup();
      }
    }
    if (groupId) {
      body.group_id = groupId;
    }

    // Map proxy fields to AdsPower user_proxy_config format.
    // If no proxy is provided, set proxy_soft to "no_proxy" so AdsPower
    // accepts the request (it requires user_proxy_config to be present).
    if (options && options.proxy) {
      body.user_proxy_config = {
        proxy_soft: 'other',
        proxy_type: options.proxy.protocol || 'http',
        proxy_host: options.proxy.server,
        proxy_port: String(options.proxy.port),
        proxy_user: options.proxy.username || '',
        proxy_password: options.proxy.password || '',
      };
    } else {
      body.user_proxy_config = { proxy_soft: 'no_proxy' };
    }

    // Include fingerprint_config when fingerprint data is provided
    if (options && options.fingerprint) {
      const fingerprintPayload = this.buildFingerprintPayload(options.fingerprint);
      if (Object.keys(fingerprintPayload).length > 0) {
        body.fingerprint_config = fingerprintPayload;
      }
    }

    const result = await this._adspowerPost('/api/v1/user/create', body);

    if (result.code === 0 && result.data) {
      return this._successResponse('Profile created successfully', {
        id: result.data.id || result.data.user_id || '',
      });
    }

    return result;
  }

  /**
   * Start a browser profile and return CDP port
   * GET /api/v1/browser/start?user_id={profileId}
   * 
   * Handles already-running case: returns existing port without launching new instance.
   * Uses 30s timeout for browser start operations.
   * 
   * @param {string} profileId - AdsPower user_id
   * @returns {Promise<{code: number, message: string, data: {profileId: string, cdpPort: number}|null}>}
   */
  async startProfile(profileId) {
    const result = await this._adspowerGet('/api/v1/browser/start', {
      user_id: profileId,
    }, START_TIMEOUT);

    if (result.code === 0 && result.data) {
      // AdsPower returns debug_port in the data object
      const debugPort = result.data.debug_port;
      const cdpPort = parseInt(debugPort, 10);

      return this._successResponse('Profile started successfully', {
        profileId: profileId,
        cdpPort: cdpPort,
      });
    }

    // Handle already-running case: AdsPower may return a specific error code
    // but still provide the debug_port in the data
    if (result.data && result.data.debug_port) {
      const cdpPort = parseInt(result.data.debug_port, 10);
      return this._successResponse('Profile already running', {
        profileId: profileId,
        cdpPort: cdpPort,
      });
    }

    return result;
  }

  /**
   * Stop a running browser profile
   * GET /api/v1/browser/stop?user_id={profileId}
   * 
   * @param {string} profileId - AdsPower user_id
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async stopProfile(profileId) {
    const result = await this._adspowerGet('/api/v1/browser/stop', {
      user_id: profileId,
    });

    if (result.code === 0) {
      return this._successResponse('Profile stopped successfully', {
        profileId: profileId,
      });
    }

    return result;
  }

  /**
   * Delete a browser profile
   * POST /api/v1/user/delete with { user_ids: [profileId] }
   * 
   * @param {string} profileId - AdsPower user_id
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async deleteProfile(profileId) {
    const result = await this._adspowerPost('/api/v1/user/delete', {
      user_ids: [profileId],
    });

    if (result.code === 0) {
      return this._successResponse('Profile deleted successfully', {
        profileId: profileId,
      });
    }

    return result;
  }

  /**
   * Get the status of a specific profile
   * GET /api/v1/browser/active?user_id={profileId}
   * 
   * @param {string} profileId - AdsPower user_id
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async getProfileStatus(profileId) {
    const result = await this._adspowerGet('/api/v1/browser/active', {
      user_id: profileId,
    });

    if (result.code === 0 && result.data) {
      const status = result.data.status || 'Active';
      const debugPort = result.data.debug_port
        ? parseInt(result.data.debug_port, 10)
        : null;

      return this._successResponse('Profile status retrieved', {
        id: profileId,
        name: result.data.name || '',
        status: this._mapStatus(status),
        debugPort: debugPort,
        browserType: 'adspower',
      });
    }

    // If code is non-zero, the profile may not be active
    if (result.code !== 0) {
      return this._successResponse('Profile status retrieved', {
        id: profileId,
        name: '',
        status: 'stopped',
        debugPort: null,
        browserType: 'adspower',
      });
    }

    return result;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FINGERPRINT PAYLOAD MAPPING
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Build AdsPower fingerprint_config payload from ExtendedFingerprintConfig.
   * Maps unified fingerprint fields to AdsPower-specific API field names.
   * Omits undefined or empty fields from the output payload.
   *
   * @param {import('../services/fingerprintData.cjs').ExtendedFingerprintConfig} config
   * @returns {object} AdsPower fingerprint_config object
   */
  buildFingerprintPayload(config) {
    if (!config || typeof config !== 'object') {
      return {};
    }

    const payload = {};

    // WebRTC mode — AdsPower accepts: forward, proxy, local, disabled, disable_udp
    // Map our values: 'disabled' → 'disabled', 'real' → 'local', 'forward' → 'forward'
    if (config.webRTC !== undefined && config.webRTC !== '') {
      const webrtcMap = { 'disabled': 'disabled', 'real': 'local', 'forward': 'forward' };
      payload.webrtc = webrtcMap[config.webRTC] || 'disabled';
    }

    // User-agent
    if (config.userAgent !== undefined && config.userAgent !== '') {
      payload.ua = config.userAgent;
    }

    // Screen resolution — AdsPower uses width_height format (underscore separator)
    if (config.resolution !== undefined && config.resolution !== '') {
      payload.screen_resolution = config.resolution.replace('x', '_');
    }

    // Language (AdsPower expects an array)
    if (config.language !== undefined && config.language !== '') {
      payload.language = [config.language];
    }

    // Timezone (AdsPower expects an object)
    if (config.timezone !== undefined && config.timezone !== '') {
      payload.timezone = { timezone: config.timezone };
    }

    // Canvas noise
    if (config.canvasNoise && typeof config.canvasNoise === 'object') {
      if (config.canvasNoise.enabled !== undefined) {
        payload.canvas = config.canvasNoise.enabled ? '1' : '0';
      }
      if (config.canvasNoise.seed !== undefined && config.canvasNoise.seed !== '') {
        payload.canvas_seed = config.canvasNoise.seed;
      }
    }

    // WebGL image noise
    if (config.webGLNoise && typeof config.webGLNoise === 'object') {
      if (config.webGLNoise.enabled !== undefined) {
        payload.webgl_image = config.webGLNoise.enabled ? '1' : '0';
      }
      if (config.webGLNoise.seed !== undefined && config.webGLNoise.seed !== '') {
        payload.webgl_image_seed = config.webGLNoise.seed;
      }
    }

    // AudioContext noise
    if (config.audioContextNoise && typeof config.audioContextNoise === 'object') {
      if (config.audioContextNoise.enabled !== undefined) {
        payload.audio = config.audioContextNoise.enabled ? '1' : '0';
      }
      if (config.audioContextNoise.seed !== undefined && config.audioContextNoise.seed !== '') {
        payload.audio_seed = config.audioContextNoise.seed;
      }
    }

    // Geolocation — AdsPower uses location_switch + latitude/longitude fields
    if (config.geolocation && typeof config.geolocation === 'object') {
      const { lat, lng } = config.geolocation;
      if (lat !== undefined && lng !== undefined) {
        payload.location_switch = 1; // 1 = allow/custom, 0 = ask, -1 = block
        payload.latitude = String(lat);
        payload.longitude = String(lng);
        payload.accuracy = '1000';
      }
    }

    // Fonts
    if (Array.isArray(config.fonts) && config.fonts.length > 0) {
      payload.fonts = config.fonts;
    }

    // Media devices — AdsPower expects a single number: 0=real, 1=fake, 2=custom
    // We set to 1 (fake/noise) when mediaDevices config is provided
    if (config.mediaDevices && typeof config.mediaDevices === 'object') {
      payload.media_devices = '1';
      // AdsPower uses media_devices_num for custom counts
      const { audioInputs, videoInputs, audioOutputs } = config.mediaDevices;
      if (audioInputs !== undefined || videoInputs !== undefined || audioOutputs !== undefined) {
        payload.media_devices_num = {
          audioinput: audioInputs || 1,
          videoinput: videoInputs || 1,
          audiooutput: audioOutputs || 1,
        };
      }
    }

    return payload;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INTERNAL HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Map AdsPower status strings to standardized status enum
   * @param {string} status - AdsPower status value
   * @returns {'running'|'stopped'|'error'|'unknown'}
   * @private
   */
  _mapStatus(status) {
    if (!status) return 'unknown';
    const s = String(status).toLowerCase();
    if (s === 'active' || s === 'running') return 'running';
    if (s === 'stopped' || s === 'closed' || s === 'idle') return 'stopped';
    if (s === 'error' || s === 'failed') return 'error';
    return 'unknown';
  }
}

// Standalone buildFingerprintPayload for direct access
function buildFingerprintPayload(config) {
  const instance = new AdsPowerProvider();
  return instance.buildFingerprintPayload(config);
}

module.exports = { AdsPowerProvider, buildFingerprintPayload };
