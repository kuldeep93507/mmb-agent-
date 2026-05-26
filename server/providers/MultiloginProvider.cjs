/**
 * MultiloginProvider — Concrete BrowserProvider for Multilogin X antidetect browser
 * 
 * Multilogin uses TWO different API endpoints:
 *   1. Cloud API: https://api.multilogin.com (for CRUD — create, delete, list, search)
 *   2. Local Launcher base URL (optional override MULTILOGIN_LAUNCHER_BASE — default https://launcher.mlx.yt:45001 )
 *      Stop profiles per docs:
 *      - GET /api/v1/profile/stop?profile_id=<uuid>
 *      - GET /api/v1/profile/stop/p/<uuid> (automation guides)
 *      - GET /api/v2/profile/f/<folder_id>/p/<profile_id>/stop (symmetric with v2 start)
 * 
 * Token management:
 *   - Bearer token: POST /user/signin OR MULTILOGIN_TOKEN (automation token, long-lived).
 *   - SHORT session token from sign-in expires (~30min) — proactively refresh ~25min when using password flow only.
 *   - Automation token MULTILOGIN_TOKEN: may be revoked/expired anytime — code cannot know until cloud/launcher rejects it.
 *   - On launcher "Profile Authorization" / 401 cloud: retry once via email+password sign-in + fresh automation_token (if configured).
 * 
 * Configuration (via environment variables):
 *   MULTILOGIN_EMAIL — Account email for signin
 *   MULTILOGIN_PASSWORD — Account password for signin
 *   MULTILOGIN_FOLDER_ID — Folder ID for profile organization (required)
 *   MULTILOGIN_LAUNCHER_BASE — Launcher host (optional, default MLX cloud launcher)
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 10.2
 */

'use strict';

const { BrowserProvider } = require('./BrowserProvider.cjs');
const https = require('https');
const crypto = require('crypto');
const { normalizeProxyCountry } = require('../services/proxyCountry.cjs');
const {
  isMultiloginProxyType,
  isSmartProxyType,
  isSmartProxyHost,
  isMultiloginProxyHost,
} = require('../services/proxyType.cjs');

function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// API endpoints
const CLOUD_API_BASE = 'https://api.multilogin.com';
const LAUNCHER_BASE = String(process.env.MULTILOGIN_LAUNCHER_BASE || 'https://launcher.mlx.yt:45001').replace(/\/+$/, '');
const PROXY_API_BASE = 'https://profile-proxy.multilogin.com'; // Multilogin residential proxy service

// Token timing
const TOKEN_EXPIRY_MS = 30 * 60 * 1000;       // 30 minutes actual expiry
const TOKEN_REFRESH_MS = 25 * 60 * 1000;       // Refresh proactively at 25 minutes

// Timeout configuration
const DEFAULT_TIMEOUT = 25000;  // 25s for standard requests (proxy gen can be slow)
const START_TIMEOUT = 30000;    // 30s for browser start operations
const STOP_TIMEOUT = 15000;     // 15s for browser stop operations

class MultiloginProvider extends BrowserProvider {
  constructor() {
    super('multilogin');

    // Read config from environment
    this.email = process.env.MULTILOGIN_EMAIL || '';
    this.password = process.env.MULTILOGIN_PASSWORD || '';
    this.folderId = process.env.MULTILOGIN_FOLDER_ID || '';
    // Multiple folder IDs — comma-separated in MULTILOGIN_FOLDER_IDS env var
    // Used for listing profiles from all folders + round-robin profile creation
    this._folderIds = [];
    this._folderRoundRobinIdx = 0;
    this._loadFolderIds();

    // AUTOMATION TOKEN — permanent long-lived token (up to 1 month).
    // If MULTILOGIN_TOKEN is set in .env, use it directly — no email/password signin needed.
    // Get it from: GET https://api.multilogin.com/workspace/automation_token?expiration_period=720h
    // Set it in .env: MULTILOGIN_TOKEN=your_token_here
    const staticToken = process.env.MULTILOGIN_TOKEN || '';
    if (staticToken) {
      this.token = staticToken;
      // Set expiry far in future — static tokens don't expire via code (managed manually in .env)
      this.tokenExpiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days
      console.log('[multilogin] Using MULTILOGIN_TOKEN from .env (static automation token)');
    } else {
      this.token = null;
      this.tokenExpiresAt = 0;
    }

    // Validate MULTILOGIN_FOLDER_ID at construction time
    if (!this.folderId) {
      console.error('[multilogin] MULTILOGIN_FOLDER_ID environment variable is not set');
    }
  }

  // ── Multi-folder helpers ──────────────────────────────────────────────────────
  /** Load/refresh folder IDs from env vars. Called on construction and can be called on settings update. */
  _loadFolderIds() {
    const multi = (process.env.MULTILOGIN_FOLDER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const primary = process.env.MULTILOGIN_FOLDER_ID || '';
    const all = [...new Set([...(primary ? [primary] : []), ...multi])];
    this._folderIds = all.length ? all : (primary ? [primary] : []);
    // Update primary folderId in case it changed
    if (primary) this.folderId = primary;
    else if (this._folderIds.length) this.folderId = this._folderIds[0];
  }

  /** Get all folder IDs (primary + additional). Falls back to single folderId. */
  _getAllFolderIds() {
    this._loadFolderIds(); // refresh from env in case settings were updated
    return this._folderIds.length ? this._folderIds : (this.folderId ? [this.folderId] : []);
  }

  /** Round-robin folder selection for profile creation. */
  _getNextFolderId() {
    const ids = this._getAllFolderIds();
    if (!ids.length) return this.folderId || '';
    const idx = this._folderRoundRobinIdx % ids.length;
    this._folderRoundRobinIdx = (idx + 1) % ids.length;
    return ids[idx];
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TOKEN MANAGEMENT
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Authenticate with Multilogin Cloud API.
   * POST https://api.multilogin.com/user/signin with {email, password}
   * If MULTILOGIN_TOKEN is set, returns it immediately UNLESS options.skipStaticToken is true
   * (used to recover from launcher/cloud rejecting a stale automation token).
   *
   * @param {{ skipStaticToken?: boolean }} [options]
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async authenticate(options = {}) {
    const skipStaticToken = options.skipStaticToken === true;

    if (!skipStaticToken && process.env.MULTILOGIN_TOKEN && String(process.env.MULTILOGIN_TOKEN).trim()) {
      this.token = process.env.MULTILOGIN_TOKEN;
      this.tokenExpiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
      return this._successResponse('Using static automation token', { authenticated: true });
    }

    if (!this.email || !this.password) {
      if (skipStaticToken) {
        return this._errorResponse(
          -4,
          'Multilogin automation token was rejected but email/password are not set — cannot mint a new token automatically. '
          + 'In Multilogin X: Workspace → create a new Automation API token and put it in Settings as MULTILOGIN_TOKEN, '
          + 'OR add MULTILOGIN_EMAIL + MULTILOGIN_PASSWORD so the server can sign in and refresh the token.',
        );
      }
      return this._errorResponse(-2, 'Multilogin credentials not configured: MULTILOGIN_EMAIL and MULTILOGIN_PASSWORD required');
    }

    // ── Retry loop — 501 is intermittent on Multilogin's cloud API ──
    // Retry up to 3 times with backoff before giving up
    const maxAttempts = 3;
    const backoff = [0, 3000, 6000]; // ms between retries

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        console.log(`[multilogin] Signin retry ${attempt}/${maxAttempts - 1} in ${backoff[attempt] / 1000}s...`);
        await new Promise(r => setTimeout(r, backoff[attempt]));
      }

      try {
        const url = `${CLOUD_API_BASE}/user/signin`;
        const response = await this._makeCloudRequest(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { email: this.email, password: md5(this.password) },
          timeout: DEFAULT_TIMEOUT,
        });

        if (response.statusCode === 200 && response.body) {
          // Multilogin returns { status: {...}, data: { token: "...", refresh_token: "..." } }
          const token = (response.body.data && response.body.data.token)
            ? response.body.data.token
            : response.body.token || null;

          if (token) {
            this.token = token;
            this.tokenExpiresAt = Date.now() + TOKEN_REFRESH_MS; // Refresh at 25 min
            console.log('[multilogin] Authenticated successfully — fetching permanent automation token...');

            // ── AUTO-FETCH PERMANENT TOKEN ──
            // Now that we have a short-lived token, immediately fetch a 30-day
            // automation token and save it to .env so future restarts skip signin entirely.
            try {
              const autoRes = await this._makeCloudRequest(
                `${CLOUD_API_BASE}/workspace/automation_token?expiration_period=720h`,
                {
                  method: 'GET',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                  timeout: DEFAULT_TIMEOUT,
                }
              );
              const autoToken = autoRes.body && autoRes.body.data && autoRes.body.data.token
                ? autoRes.body.data.token
                : null;

              if (autoToken) {
                // Switch to permanent token immediately
                this.token = autoToken;
                this.tokenExpiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days

                // Save to .env file so future server restarts skip signin
                this._saveTokenToEnv(autoToken);
                console.log('[multilogin] ✅ Permanent automation token saved to .env (valid 30 days) — no more signin needed!');
              }
            } catch (autoErr) {
              // Non-critical — short-lived token still works for this session
              console.warn(`[multilogin] Could not fetch automation token: ${autoErr.message}`);
            }

            return this._successResponse('Authenticated successfully', { authenticated: true });
          }

          return this._errorResponse(-2, 'Multilogin signin response did not contain a token');
        }

        // 501 — server intermittently rejects POST /user/signin — retry
        if (response.statusCode === 501) {
          console.warn(`[multilogin] Signin returned 501 (attempt ${attempt + 1}/${maxAttempts}) — Multilogin cloud API glitch, will retry`);
          continue; // next attempt
        }

        // Other non-200 response — don't retry
        const msg = response.body && response.body.message
          ? response.body.message
          : `Signin failed with status ${response.statusCode}`;
        return this._errorResponse(-2, `Multilogin authentication failed: ${msg}`);

      } catch (error) {
        if (attempt < maxAttempts - 1) {
          console.warn(`[multilogin] Signin attempt ${attempt + 1} error: ${error.message} — retrying...`);
          continue;
        }
        return this._handleMultiloginError(error, 'authenticate');
      }
    }

    return this._errorResponse(-2, 'Multilogin authentication failed after 3 attempts (status 501 — server-side issue). Add MULTILOGIN_TOKEN to .env to bypass signin permanently.');
  }

  /**
   * Save MULTILOGIN_TOKEN to .env file — called after successfully fetching automation token.
   * Updates the existing MULTILOGIN_TOKEN= line (or adds it if missing).
   * @private
   */
  _saveTokenToEnv(token) {
    try {
      const fs = require('fs');
      const path = require('path');
      const envPath = path.resolve(__dirname, '..', '..', '.env');
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

      if (content.match(/^MULTILOGIN_TOKEN=.*/m)) {
        // Update existing line
        content = content.replace(/^MULTILOGIN_TOKEN=.*/m, `MULTILOGIN_TOKEN=${token}`);
      } else {
        // Append new line
        content += `\nMULTILOGIN_TOKEN=${token}\n`;
      }

      fs.writeFileSync(envPath, content, 'utf8');
      // Also update process.env so current process uses it immediately
      process.env.MULTILOGIN_TOKEN = token;
      console.log('[multilogin] MULTILOGIN_TOKEN saved to .env');
    } catch (err) {
      console.warn(`[multilogin] Could not save token to .env: ${err.message}`);
    }
  }

  /**
   * Refresh the Bearer token by re-authenticating.
   * Called on 401 response — retries signin once.
   * Returns code -4 if refresh fails.
   * 
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async refreshToken() {
    console.log('[multilogin] Token expired or rejected — clearing cache and refreshing...');

    this.token = null;
    this.tokenExpiresAt = 0;

    // Prefer NEW session from password; skip re-using stale MULTILOGIN_TOKEN (common cause of "Profile Authorization error").
    if (this.email && this.password) {
      const pwdResult = await this.authenticate({ skipStaticToken: true });
      if (pwdResult.code === 0) {
        console.log('[multilogin] Token refreshed via cloud sign-in (automation token may have been rewritten to .env).');
        return pwdResult;
      }
      console.error(`[multilogin] Password-based refresh failed: ${pwdResult.message}`);
      return pwdResult.code === -2 ? pwdResult : this._errorResponse(-4, pwdResult.message || 'Multilogin token refresh failed');
    }

    // No password on file — cannot mint a new token; reloading MULTILOGIN_TOKEN from env would just re-use the same stale value.
    return this._errorResponse(
      -4,
      'Multilogin token refresh failed: add MULTILOGIN_EMAIL + MULTILOGIN_PASSWORD in Settings/.env so the server can sign in, '
      + 'or replace MULTILOGIN_TOKEN with a new Automation API token from Multilogin X (then restart the server if you only edited .env).',
    );
  }

  /**
   * Get authorization headers for Multilogin API requests.
   * Auto-authenticates on first call or when token is expired/about to expire.
   * 
   * @returns {Promise<{headers: object|null, error: {code: number, message: string, data: null}|null}>}
   */
  async getAuthHeaders() {
    // Validate folder_id first
    if (!this.folderId) {
      return {
        headers: null,
        error: this._errorResponse(-5, 'MULTILOGIN_FOLDER_ID environment variable is not set'),
      };
    }

    // Check if token needs refresh (expired or about to expire)
    if (!this.token || Date.now() >= this.tokenExpiresAt) {
      const authResult = await this.authenticate();
      if (authResult.code !== 0) {
        return { headers: null, error: authResult };
      }
    }

    return {
      headers: { Authorization: `Bearer ${this.token}` },
      error: null,
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CLOUD API HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Make an authenticated request to the Multilogin Cloud API.
   * Handles 401 responses by refreshing the token and retrying once.
   * 
   * @param {string} endpoint - API endpoint path (e.g., '/profile/search')
   * @param {object} [options={}] - Request options
   * @param {string} [options.method='POST'] - HTTP method
   * @param {object} [options.body=null] - Request body
   * @param {number} [options.timeout=DEFAULT_TIMEOUT] - Request timeout in ms
   * @returns {Promise<{code: number, message: string, data: any}>} Standardized response
   */
  async _authenticatedCloudRequest(endpoint, options = {}) {
    const { method = 'POST', body = null, timeout = DEFAULT_TIMEOUT } = options;

    // Get auth headers (auto-authenticates if needed)
    const auth = await this.getAuthHeaders();
    if (auth.error) return auth.error;

    const url = `${CLOUD_API_BASE}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...auth.headers,
    };

    try {
      const response = await this._makeCloudRequest(url, { method, headers, body, timeout });

      // Handle 401 — token expired, refresh and retry once
      if (response.statusCode === 401) {
        const refreshResult = await this.refreshToken();
        if (refreshResult.code !== 0) {
          return this._errorResponse(-4, 'Multilogin token refresh failed: re-authentication required');
        }

        // Retry with new token
        const retryHeaders = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        };

        const retryResponse = await this._makeCloudRequest(url, {
          method, headers: retryHeaders, body, timeout,
        });

        return this._parseCloudResponse(retryResponse);
      }

      return this._parseCloudResponse(response);
    } catch (error) {
      return this._handleMultiloginError(error, 'cloud');
    }
  }

  /** Default MLX cloud flags (required on create/update since API v12). */
  _defaultCloudFlags(proxyMasking = 'disabled') {
    return {
      audio_masking: 'natural',
      fonts_masking: 'natural',
      geolocation_masking: 'mask',
      geolocation_popup: 'allow',
      graphics_masking: 'natural',
      graphics_noise: 'natural',
      localization_masking: 'mask',
      media_devices_masking: 'natural',
      navigator_masking: 'mask',
      ports_masking: 'mask',
      proxy_masking: proxyMasking,
      screen_masking: 'natural',
      timezone_masking: 'mask',
      webrtc_masking: 'mask',
      canvas_noise: 'natural',
    };
  }

  _defaultCloudStorage() {
    return {
      is_local: false,
      save_service_worker: true,
      bookmarks: true,
      cookies: true,
      extensions: true,
      history: true,
      local_storage: true,
      passwords: true,
    };
  }

  _getCoreVersion() {
    const fromEnv = parseInt(process.env.MULTILOGIN_CORE_VERSION, 10);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 148;
  }

  _isCloud501Message(msg) {
    return /501|unsupported method/i.test(String(msg || ''));
  }

  /**
   * Retry cloud POST when Multilogin returns intermittent HTTP 501.
   * @private
   */
  async _authenticatedCloudRequestWithRetry(endpoint, options = {}, maxAttempts = 5) {
    const backoff = [0, 1500, 3000, 5000, 8000];
    let lastResult = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        console.log(`[multilogin] Cloud retry ${attempt}/${maxAttempts - 1} for ${endpoint} in ${backoff[attempt] / 1000}s...`);
        await new Promise(r => setTimeout(r, backoff[attempt]));
      }

      lastResult = await this._authenticatedCloudRequest(endpoint, options);
      if (lastResult.code === 0) return lastResult;

      if (!this._isCloud501Message(lastResult.message)) {
        return lastResult;
      }
    }

    return lastResult;
  }

  /** Pick a seed profile for clone fallback (env override or first in folder). */
  async _getTemplateProfileId() {
    const fromEnv = process.env.MULTILOGIN_TEMPLATE_PROFILE_ID || '';
    if (fromEnv.trim()) return fromEnv.trim();

    const search = await this._authenticatedCloudRequest('/profile/search', {
      body: { search_text: '', limit: 10, offset: 0, is_removed: false },
    });
    if (search.code !== 0 || !search.data) return '';

    const list = search.data.profiles || search.data || [];
    const first = Array.isArray(list) && list.length > 0 ? list[0] : null;
    return first ? String(first.id || first.profile_id || first.uuid || '') : '';
  }

  /**
   * Clone an existing cloud profile when /profile/create is unavailable.
   * @param {object} options
   * @param {object|null} proxyResult - from _resolveProxy
   */
  async cloneProfile(options, proxyResult = null) {
    if (!this.folderId) {
      return this._errorResponse(-5, 'MULTILOGIN_FOLDER_ID environment variable is not set');
    }

    const templateId = await this._getTemplateProfileId();
    if (!templateId) {
      return this._errorResponse(-1, 'No template profile found for clone fallback — create one profile manually in Multilogin X first');
    }

    const body = {
      profile_id: templateId,
      name: (options && options.name) || `Profile ${Date.now()}`,
      folder_id: this._getNextFolderId(),
      include_cookies: false,
      include_extensions: false,
      include_bookmarks: false,
    };

    console.log(`[multilogin] cloneProfile fallback → template ${templateId.slice(0, 8)}...`);
    const result = await this._authenticatedCloudRequestWithRetry('/profile/clone', { body }, 3);

    if (result.code !== 0 || !result.data) return result;

    const newId = result.data.cloned_profile_id
      || result.data.profile_id
      || result.data.id
      || '';

    if (!newId) {
      return this._errorResponse(-1, 'Clone succeeded but no profile ID returned');
    }

    if (proxyResult && proxyResult.success && proxyResult.proxy) {
      const proxyUpdate = await this.updateProfileProxy(newId, {
        server: proxyResult.proxy.host,
        host: proxyResult.proxy.host,
        port: proxyResult.proxy.port,
        username: proxyResult.proxy.username,
        password: proxyResult.proxy.password,
        type: proxyResult.proxy.type || 'socks5',
      });
      if (proxyUpdate.code !== 0) {
        console.warn(`[multilogin] Cloned ${newId} but proxy update failed: ${proxyUpdate.message}`);
      }
    }

    return this._successResponse('Profile cloned successfully', {
      id: newId,
      clonedFrom: templateId,
      proxyUsed: proxyResult?.proxy || null,
      proxySource: proxyResult?.source || null,
    });
  }

  /**
   * MLX flags aligned with fingerprint payload — full anti-detect set.
   * WebRTC + geolocation use `mask` so MLX syncs with proxy (no public_ip required).
   */
  _flagsForFingerprintPayload(fingerprintPayload, includeProxy, fpConfig) {
    const fp = fingerprintPayload || {};
    const cfg = fpConfig || {};
    const flags = this._defaultCloudFlags(includeProxy ? 'custom' : 'disabled');

    flags.webrtc_masking = 'mask';
    flags.geolocation_masking = 'mask';
    flags.geolocation_popup = 'allow';
    flags.ports_masking = 'mask';
    flags.proxy_masking = includeProxy ? 'custom' : 'disabled';

    if (fp.canvas) {
      flags.canvas_noise = 'mask';
    } else {
      flags.canvas_noise = cfg.canvas === 'real' ? 'natural' : 'mask';
    }

    if (fp.webgl && fp.webgl.seed) {
      flags.graphics_noise = 'mask';
    } else {
      flags.graphics_noise = cfg.canvas === 'real' ? 'natural' : 'mask';
    }

    flags.graphics_masking = fp.graphic ? 'custom' : 'natural';
    flags.audio_masking = fp.audio ? 'mask' : 'natural';
    flags.navigator_masking = fp.navigator ? 'custom' : (cfg.navigator === 'real' ? 'custom' : 'mask');
    flags.screen_masking = fp.screen ? 'custom' : (cfg.screen === 'real' ? 'natural' : 'mask');
    flags.timezone_masking = fp.timezone ? 'custom' : (cfg.timezone === 'real' ? 'custom' : 'mask');
    flags.localization_masking = (fp.language || fp.localization) ? 'custom' : 'mask';
    flags.fonts_masking = (fp.fonts && fp.fonts.length) ? 'custom' : 'natural';
    flags.media_devices_masking = fp.media_devices ? 'custom' : 'natural';

    return flags;
  }

  /** Build full parameters.flags + parameters.fingerprint for Cloud and Quick. */
  _buildAntidetectParameters(options, includeProxy) {
    if (!options || !options.fingerprint) {
      return {
        flags: this._defaultCloudFlags(includeProxy ? 'custom' : 'disabled'),
        fingerprint: {},
      };
    }

    const fp = options.fingerprint;
    const fingerprintPayload = this.buildFingerprintPayload({ ...fp, os: options.os });
    const fpConfig = options.fingerprintConfig || {
      canvas: 'real',
      webrtc: 'real',
      timezone: 'real',
      screen: 'real',
      navigator: 'real',
    };
    const flags = this._flagsForFingerprintPayload(fingerprintPayload, includeProxy, fpConfig);

    const canvasSeed = fp.canvasNoise && fp.canvasNoise.seed;
    if (canvasSeed) {
      console.log(
        `[multilogin] antidetect → canvas:${canvasSeed.slice(0, 8)} webgl:${(fp.webGLNoise && fp.webGLNoise.seed || '').slice(0, 8)} audio:${(fp.audioContextNoise && fp.audioContextNoise.seed || '').slice(0, 8)}`
      );
    }

    return { flags, fingerprint: fingerprintPayload };
  }

  /** Merge generated fingerprint into cloud create body. */
  _applyFingerprintToCloudBody(body, options, osType) {
    if (!options || !options.fingerprint) return;

    const { flags, fingerprint } = this._buildAntidetectParameters(
      options,
      !!(body.parameters && body.parameters.proxy)
    );
    if (Object.keys(fingerprint).length > 0) {
      body.parameters.fingerprint = fingerprint;
      body.parameters.flags = flags;
    }

    const fp = options.fingerprint;
    // Legacy top-level navigator/screen (some MLX versions read these)
    if (fp.userAgent) {
      const platformMap = { windows: 'Win32', macos: 'MacIntel', android: 'Linux armv8l' };
      const rawRam = fp.ram || 8;
      const devMemory = rawRam >= 16 ? 8 : rawRam >= 8 ? 8 : rawRam >= 4 ? 4 : 2;
      body.parameters.navigator = {
        user_agent: fp.userAgent,
        hardware_concurrency: fp.cpu || 4,
        device_memory: devMemory,
        platform: platformMap[osType] || 'Win32',
      };
    }
    if (fp.resolution) {
      const parts = String(fp.resolution).split('x');
      if (parts.length === 2) {
        const dpr = fp.pixelRatio || (osType === 'android' ? 2.625 : 1);
        body.parameters.screen = {
          width: parseInt(parts[0], 10),
          height: parseInt(parts[1], 10),
          pixel_ratio: dpr,
        };
      }
    }
  }

  /**
   * Heuristic: MLX cloud launcher refused the Bearer / automation session (manual app works because it uses GUI login, not necessarily the API token).
   * @private
   */
  _launcherMessageSuggestsTokenRejection(parsed) {
    if (!parsed || parsed.code === 0 || parsed.code === -6) return false;
    const m = String(parsed.message || '').toLowerCase();
    const needles = [
      'profile authorization',
      'authorization error',
      'unauthorized',
      'invalid token',
      'invalid jwt',
      'token expired',
      'access denied',
      'wrong token',
      'authentication required',
      'not authenticated',
      'bearer',
      'forbidden',
    ];
    return needles.some((n) => m.includes(n));
  }

  /**
   * One screen-friendly block for operators (logs + API message field).
   * @private
   */
  _buildLauncherAuthFailureMessage(originalMessage, extra = {}) {
    const { refreshFailed, afterPasswordRefreshRetry } = extra;
    const parts = [
      String(originalMessage || 'Multilogin launcher refused this request').trim(),
      'Why: The Automation API Bearer token is missing, expired, revoked, or not allowed for this workspace/profile; the Multilogin desktop app can still open profiles using its own login — that does not prove the API token is valid.',
      'Do: (1) Multilogin X → Workspace → generate a new Automation API token → paste into app Settings / MULTILOGIN_TOKEN in .env. (2) Or set MULTILOGIN_EMAIL + MULTILOGIN_PASSWORD so the server can sign in once and mint a fresh automation token (saved to .env when possible). (3) Verify MULTILOGIN_FOLDER_ID matches the folder that contains this profile UUID. (4) Keep Multilogin logged into the same account as the API token.',
    ];
    if (refreshFailed) {
      parts.push(`Token refresh failed: ${refreshFailed}. No further automatic retry this call.`);
    } else if (afterPasswordRefreshRetry) {
      parts.push('After one automatic sign-in + retry, launcher still failed — check folder ID, profile ownership, and generate a new automation token in the Multilogin UI.');
    } else {
      parts.push('Automatic retry: if email/password are configured, the server will try one cloud sign-in and re-hit the launcher once.');
    }
    return parts.join(' | ');
  }

  /**
   * Make an authenticated request to the Multilogin Launcher (local).
   * Uses HTTPS with rejectUnauthorized: false for self-signed cert.
   * 
   * @param {string} endpoint - Full launcher URL path
   * @param {object} [options={}] - Request options
   * @param {string} [options.method='GET'] - HTTP method
   * @param {number} [options.timeout=START_TIMEOUT] - Request timeout in ms
   * @returns {Promise<{code: number, message: string, data: any}>} Standardized response
   */
  async _launcherRequest(endpoint, options = {}) {
    const { method = 'GET', body = null, timeout = START_TIMEOUT } = options;

    const url = `${LAUNCHER_BASE}${endpoint}`;

    // STRATEGY: Send launcher request with Bearer when we have token.
    // HTTP 401 OR body "Profile Authorization" → refresh token (password-first) once, retry once.
    try {
      const sendToLauncher = async () => {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token && Date.now() < this.tokenExpiresAt) {
          headers.Authorization = `Bearer ${this.token}`;
        }

        const response = await this._makeLauncherRequest(url, {
          method, headers, body, timeout,
        });

        if (response.statusCode === 401) {
          console.log('[multilogin] Launcher returned HTTP 401 — refreshToken() then retry with Bearer...');
          const refresh = await this.refreshToken();
          if (refresh.code !== 0) {
            return this._errorResponse(
              -4,
              this._buildLauncherAuthFailureMessage(
                `Launcher HTTP 401; could not refresh API token: ${refresh.message}`,
                { refreshFailed: refresh.message },
              ),
            );
          }
          const authHeaders = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
          };
          const retryResponse = await this._makeLauncherRequest(url, {
            method, headers: authHeaders, body, timeout,
          });
          return this._parseLauncherResponse(retryResponse);
        }

        return this._parseLauncherResponse(response);
      };

      let parsed = await sendToLauncher();

      if (parsed.code !== 0 && this._launcherMessageSuggestsTokenRejection(parsed)) {
        console.warn('[multilogin] Launcher auth/session message — refreshToken() once and retry launcher...');
        const refresh = await this.refreshToken();
        if (refresh.code !== 0) {
          return this._errorResponse(
            -4,
            this._buildLauncherAuthFailureMessage(parsed.message, { refreshFailed: refresh.message }),
          );
        }
        parsed = await sendToLauncher();
        if (parsed.code !== 0 && this._launcherMessageSuggestsTokenRejection(parsed)) {
          return this._errorResponse(
            -4,
            this._buildLauncherAuthFailureMessage(parsed.message, { afterPasswordRefreshRetry: true }),
          );
        }
      }

      return parsed;
    } catch (error) {
      // Launcher-specific connection error
      if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNRESET' || error.code === 'TIMEOUT' ||
          error.code === 'ENOTFOUND') {
        return this._errorResponse(-1, 'Multilogin launcher must be connected');
      }
      return this._handleMultiloginError(error, 'launcher');
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // MULTILOGIN RESIDENTIAL PROXY GENERATION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Generate Multilogin residential proxy credentials.
   * Calls https://profile-proxy.multilogin.com/v1/proxy/connection_url
   * Returns host:port:username:password parsed into object.
   *
   * @param {string} [country='us'] - Country code (us or gb only)
   * @param {string} [city=''] - City name (optional)
   * @param {string} [region=''] - Region/state name (optional)
   * @returns {Promise<{success: boolean, proxy?: object, error?: string}>}
   */
  async _generateMultiloginProxy(country = 'us', city = '', region = '') {
    const requested = String(country || 'us').toLowerCase();
    country = normalizeProxyCountry(country);
    if (requested !== country && requested !== 'uk') {
      console.warn(`[multilogin] Proxy country "${requested}" blocked — using ${country} (US/UK only)`);
    }

    const auth = await this.getAuthHeaders();
    if (auth.error) {
      return { success: false, error: auth.error.message || 'Auth failed' };
    }

    const url = `${PROXY_API_BASE}/v1/proxy/connection_url`;
    const payload = {
      country,
      region: region || '',
      city: city || '',
      protocol: 'socks5',   // socks5 handles all traffic types
      sessionType: 'sticky', // sticky = same IP for session duration
      IPTTL: 0,              // 0 = keep as long as possible (up to 24h)
      quality: 'medium',     // medium = balance of speed and quality
    };

    try {
      const response = await this._makeCloudRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...auth.headers,
        },
        body: payload,
        timeout: DEFAULT_TIMEOUT,
      });

      // Response: { data: "host:port:username:password" }
      if (response.statusCode === 201 && response.body && response.body.data) {
        const parts = String(response.body.data).split(':');
        if (parts.length >= 4) {
          const proxy = {
            host: parts[0],
            port: parseInt(parts[1], 10),
            username: parts[2],
            password: parts.slice(3).join(':'), // password may contain colons
            type: 'socks5',
            protocol: 'socks5',
            server: parts[0], // alias for compatibility
          };
          console.log(`[multilogin] Generated residential proxy: ${proxy.host}:${proxy.port} (${country})`);
          return { success: true, proxy };
        }
      }

      const errMsg = (response.body && response.body.message)
        || `Proxy generation failed (status ${response.statusCode})`;
      console.error(`[multilogin] Proxy generation failed: ${errMsg}`);
      return { success: false, error: errMsg };
    } catch (err) {
      console.error(`[multilogin] Proxy generation error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // FINGERPRINT PAYLOAD MAPPING
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Build Multilogin-specific fingerprint payload from ExtendedFingerprintConfig.
   * Maps unified config fields to Multilogin's nested fingerprint object structure.
   * Omits undefined/empty fields from the payload so the provider applies its own defaults.
   * 
   * Validates: Requirements 4.3, 4.4, 4.6
   * 
   * @param {import('../services/fingerprintData.cjs').ExtendedFingerprintConfig} config - Unified fingerprint config
   * @returns {object} Multilogin fingerprint payload object
   */
  /**
   * BUG FIX: Build Multilogin X flags from fingerprintConfig
   * Determines what values are real vs masked
   * @param {object} fpConfig - Fingerprint configuration (canvas, webrtc, timezone, screen, navigator)
   * @returns {object} Multilogin X flags for the profile
   */
  buildFlagsFromConfig(fpConfig) {
    // Complete flags set — sourced from official Multilogin GitHub example
    // Values: 'mask' = spoofed/hidden, 'natural' = real noise, 'custom' = our value, 'disabled' = off
    const isReal = !fpConfig || (
      fpConfig.canvas === 'real' &&
      fpConfig.webrtc === 'real' &&
      fpConfig.timezone === 'real' &&
      fpConfig.screen === 'real' &&
      fpConfig.navigator === 'real'
    );

    if (isReal) {
      // "Real" mode — YouTube-friendly: natural noise, custom timezone/location
      return {
        audio_masking: 'natural',        // Real audio with natural noise
        fonts_masking: 'natural',        // Real fonts
        geolocation_masking: 'custom',   // Use our geo coordinates
        geolocation_popup: 'allow',      // Don't block geo prompts
        graphics_masking: 'natural',     // Real GPU info with natural noise
        graphics_noise: 'natural',       // Natural WebGL noise
        localization_masking: 'custom',  // Use our language/locale
        media_devices_masking: 'natural',// Real media devices
        navigator_masking: 'custom',     // Use our user agent
        ports_masking: 'mask',           // Hide open ports (security)
        screen_masking: 'natural',       // Real screen resolution
        timezone_masking: 'custom',      // Use proxy state timezone
        webrtc_masking: 'natural',       // Natural WebRTC (real IP via proxy)
        proxy_masking: 'custom',         // Show proxy info normally
        canvas_noise: 'natural',         // Natural canvas noise (was: disabled)
      };
    }

    // Custom config — apply per-field settings
    return {
      audio_masking: 'natural',
      fonts_masking: fpConfig.navigator === 'real' ? 'natural' : 'mask',
      geolocation_masking: 'custom',
      geolocation_popup: 'allow',
      graphics_masking: fpConfig.canvas === 'real' ? 'natural' : 'mask',
      graphics_noise: fpConfig.canvas === 'real' ? 'natural' : 'mask',
      localization_masking: fpConfig.timezone === 'real' ? 'custom' : 'mask',
      media_devices_masking: 'natural',
      navigator_masking: fpConfig.navigator === 'real' ? 'custom' : 'mask',
      ports_masking: 'mask',
      screen_masking: fpConfig.screen === 'real' ? 'natural' : 'mask',
      timezone_masking: fpConfig.timezone === 'real' ? 'custom' : 'mask',
      webrtc_masking: fpConfig.webrtc === 'real' ? 'natural' : 'mask',
      proxy_masking: 'custom',
      canvas_noise: fpConfig.canvas === 'real' ? 'natural' : 'mask',
    };
  }

  buildFingerprintPayload(config) {
    if (!config) return {};

    const fingerprint = {};

    // timezone.zone — Multilogin X requires { zone: "..." } not { value: "..." }
    if (config.timezone) {
      fingerprint.timezone = { zone: config.timezone };
    }

    // language — Cloud API uses list; Quick v3 also accepts localization block
    if (config.language) {
      const lang = config.language;
      const base = lang.split('-')[0];
      fingerprint.language = { list: [lang] };
      fingerprint.localization = {
        languages: lang,
        locale: lang,
        accept_languages: `${lang},${base};q=0.9`,
      };
    }

    // WebGL vendor/renderer metadata (Quick: graphic; seeds in webgl)
    if (config.webGLMeta && (config.webGLMeta.vendor || config.webGLMeta.renderer)) {
      fingerprint.graphic = {
        vendor: config.webGLMeta.vendor || '',
        renderer: config.webGLMeta.renderer || '',
      };
    }

    // WebGPU device IDs (optional, OS-specific)
    if (config.webGPU && (config.webGPU.vendor || config.webGPU.adapter)) {
      fingerprint.webgpu = {
        vendor: config.webGPU.vendor || '',
        adapter: config.webGPU.adapter || '',
      };
    }

    // Media device counts — mic/cam/speaker enumeration fingerprint
    if (config.mediaDevices) {
      fingerprint.media_devices = {
        audio_inputs: config.mediaDevices.audioInputs ?? 1,
        audio_outputs: config.mediaDevices.audioOutputs ?? 2,
        video_inputs: config.mediaDevices.videoInputs ?? 1,
      };
    }

    // Geolocation + WebRTC: use flags `mask` — MLX aligns with proxy exit IP (no public_ip)

    // canvas (mode + seed)
    if (config.canvasNoise && config.canvasNoise.seed) {
      fingerprint.canvas = { mode: 'noise', seed: config.canvasNoise.seed };
    }

    // webgl (mode + seed)
    if (config.webGLNoise && config.webGLNoise.seed) {
      fingerprint.webgl = { mode: 'noise', seed: config.webGLNoise.seed };
    }

    // audio (mode + seed)
    if (config.audioContextNoise && config.audioContextNoise.seed) {
      fingerprint.audio = { mode: 'noise', seed: config.audioContextNoise.seed };
    }

    // navigator — user_agent, hardware_concurrency, platform, device_memory (RAM)
    if (config.userAgent) {
      const platformMap = { Windows: 'Win32', macOS: 'MacIntel', Android: 'Linux armv8l', Linux: 'Linux x86_64' };
      const osKey = config.os || (config.userAgent.includes('Windows') ? 'Windows' : config.userAgent.includes('Mac') ? 'macOS' : config.userAgent.includes('Android') ? 'Android' : 'Windows');
      // device_memory must be a power of 2: 2, 4, 8 (browsers report limited values)
      const rawRam = config.ram || 8;
      const deviceMemory = rawRam >= 16 ? 8 : rawRam >= 8 ? 8 : rawRam >= 4 ? 4 : 2;
      fingerprint.navigator = {
        user_agent: config.userAgent,
        hardware_concurrency: config.cpu || 4,
        platform: platformMap[osKey] || 'Win32',
        device_memory: deviceMemory,
      };
    }

    // battery — unique per profile (level 0.0–1.0 float, charging bool)
    if (config.battery != null) {
      fingerprint.battery = {
        charging: config.batteryCharging !== undefined ? config.batteryCharging : false,
        level: parseFloat((config.battery / 100).toFixed(2)),
      };
    }

    // screen — requires width, height, AND pixel_ratio
    if (config.resolution) {
      const parts = String(config.resolution).split('x');
      if (parts.length === 2) {
        fingerprint.screen = {
          width: parseInt(parts[0], 10),
          height: parseInt(parts[1], 10),
          pixel_ratio: config.pixelRatio || 1,
        };
      }
    }

    // fonts — Multilogin X expects a flat array, not { families: [...] }
    if (config.fonts && Array.isArray(config.fonts) && config.fonts.length > 0) {
      fingerprint.fonts = config.fonts;
    }

    return fingerprint;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PROXY BUILDER HELPER
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Build a normalized proxy object ready for Multilogin API.
   * Handles both SmartProxy (pre-filled credentials) and Multilogin residential
   * (type = 'multilogin_residential' — must generate credentials first).
   *
   * @param {object} proxyOptions - options.proxy from createProfile/createQuickProfile
   * @param {string} [apiFormat='cloud'] - 'cloud' (HTTP type uppercase) or 'quick' (socks5 lowercase)
   * @returns {Promise<{success: boolean, proxy?: object, error?: string}>}
   */
  async _resolveProxy(proxyOptions, apiFormat = 'cloud') {
    if (!proxyOptions) return { success: true, proxy: null, source: 'none' };

    const explicitType = proxyOptions.type;

    // Multilogin residential — ALWAYS generate MLX proxy (never SmartProxy .env)
    if (isMultiloginProxyType(explicitType)) {
      console.log('[multilogin] Resolving Multilogin residential proxy (built-in)...');
      const requested = String(proxyOptions.country || 'us').toLowerCase();
      const country = normalizeProxyCountry(proxyOptions.country, !proxyOptions.country);
      if (requested && requested !== country && requested !== 'uk') {
        console.warn(`[multilogin] Proxy country "${requested}" blocked — using ${country} (US/UK only)`);
      }
      const city = proxyOptions.city || '';
      const region = proxyOptions.region || '';
      const result = await this._generateMultiloginProxy(country, city, region);
      if (!result.success) {
        return { success: false, error: `Multilogin proxy generation failed: ${result.error}`, source: 'multilogin' };
      }
      const p = result.proxy;
      const proxyType = apiFormat === 'quick' ? 'socks5' : 'SOCKS5';
      console.log(`[multilogin] Multilogin proxy ready: ${p.host}:${p.port} (${country.toUpperCase()})`);
      return {
        success: true,
        source: 'multilogin',
        proxy: {
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
          type: proxyType,
        },
      };
    }

    // SmartProxy — explicit type OR legacy credential object from ProfileCreator
    const hostHint = proxyOptions.server || proxyOptions.host || '';
    const wantsSmartProxy = isSmartProxyType(explicitType)
      || (!explicitType && isSmartProxyHost(hostHint))
      || (!explicitType && proxyOptions.username && proxyOptions.password && !isMultiloginProxyHost(hostHint));

    if (wantsSmartProxy && !isMultiloginProxyType(explicitType)) {
      if (proxyOptions.server && proxyOptions.port && proxyOptions.username && proxyOptions.password) {
        const rawType = (proxyOptions.protocol || 'http').toLowerCase();
        const typeMap = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS4' };
        const quickType = rawType === 'socks5' ? 'socks5' : 'http';
        console.log(`[multilogin] Using SmartProxy credentials: ${proxyOptions.server}:${proxyOptions.port}`);
        if (apiFormat === 'quick') {
          return {
            success: true,
            source: 'smartproxy',
            proxy: {
              host: proxyOptions.server,
              port: Number(proxyOptions.port),
              username: proxyOptions.username,
              password: proxyOptions.password,
              type: quickType,
            },
          };
        }
        return {
          success: true,
          source: 'smartproxy',
          proxy: {
            host: proxyOptions.server,
            port: Number(proxyOptions.port),
            username: proxyOptions.username,
            password: proxyOptions.password,
            type: typeMap[rawType] || 'HTTP',
          },
        };
      }

      const server = process.env.PROXY_SERVER || 'us.smartproxy.net';
      const port = parseInt(process.env.PROXY_PORT || '3120', 10);
      const prefix = process.env.PROXY_PREFIX || '';
      const password = process.env.PROXY_PASSWORD || '';
      if (!password || !prefix) {
        return { success: false, error: 'Smartproxy credentials missing — set PROXY_PASSWORD and PROXY_PREFIX in Settings or .env', source: 'smartproxy' };
      }
      const sessionId = Math.random().toString(36).slice(2, 12);
      const lifeMin = parseInt(process.env.PROXY_LIFE_MINUTES || '120', 10);
      const username = `${prefix}_area-US_life-${lifeMin}_session-${sessionId}`;
      console.log(`[multilogin] Using SmartProxy from env: ${server}:${port}`);
      if (apiFormat === 'quick') {
        return { success: true, source: 'smartproxy', proxy: { host: server, port, username, password, type: 'http' } };
      }
      return { success: true, source: 'smartproxy', proxy: { host: server, port, username, password, type: 'HTTP' } };
    }

    // External/custom proxy with host+port (must not be SmartProxy when Multilogin was requested)
    const host = proxyOptions.server || proxyOptions.host;
    if (host && proxyOptions.port) {
      if (isMultiloginProxyType(explicitType) && isSmartProxyHost(host)) {
        return {
          success: false,
          error: 'Multilogin proxy requested but SmartProxy host was supplied — check proxyType parameter',
          source: 'error',
        };
      }
      const rawType = (proxyOptions.protocol || proxyOptions.type || 'http').toLowerCase();
      if (apiFormat === 'quick') {
        return {
          success: true,
          source: 'custom',
          proxy: {
            host,
            port: Number(proxyOptions.port),
            username: proxyOptions.username || '',
            password: proxyOptions.password || '',
            type: rawType,
          },
        };
      }
      const typeMap = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS4' };
      return {
        success: true,
        source: 'custom',
        proxy: {
          host,
          port: Number(proxyOptions.port),
          username: proxyOptions.username || '',
          password: proxyOptions.password || '',
          type: typeMap[rawType] || 'HTTP',
        },
      };
    }

    return { success: false, error: 'Invalid proxy options — set type to multilogin or smartproxy', source: 'error' };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ABSTRACT METHOD IMPLEMENTATIONS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Create a PERSISTENT profile via Multilogin Cloud API.
   * POST https://api.multilogin.com/profile/create
   *
   * Supports both SmartProxy AND Multilogin residential proxy.
   * NOTE: Cloud API does not support fingerprint flags — profile persists after close.
   *
   * @param {object} options - Profile creation options
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async createProfile(options) {
    // Validate folder_id
    if (!this.folderId) {
      return this._errorResponse(-5, 'MULTILOGIN_FOLDER_ID environment variable is not set');
    }

    // Resolve proxy — handles SmartProxy AND Multilogin residential
    const proxyResult = await this._resolveProxy(options && options.proxy, 'cloud');
    if (!proxyResult.success) {
      return this._errorResponse(-6, proxyResult.error);
    }

    // Map os string to Multilogin os_type (must be lowercase)
    const osMap = { Windows: 'windows', macOS: 'macos', Android: 'android', Linux: 'linux' };
    const osType = (options && options.os && osMap[options.os]) || 'windows';

    // browser_type must be 'mimic' (Chromium) or 'stealthfox' (Firefox)
    const browserType = (options && options.browserType === 'stealthfox') ? 'stealthfox' : 'mimic';

    const body = {
      folder_id: this._getNextFolderId(),
      browser_type: browserType,
      os_type: osType,
      core_version: this._getCoreVersion(),
      name: (options && options.name) || `Profile ${Date.now()}`,
      parameters: {
        flags: this._defaultCloudFlags(proxyResult.proxy ? 'custom' : 'disabled'),
        storage: this._defaultCloudStorage(),
      },
    };

    // Add resolved proxy
    if (proxyResult.proxy) {
      body.parameters.proxy = proxyResult.proxy;
    }

    this._applyFingerprintToCloudBody(body, options, osType);

    if (options && options.fingerprint && options.fingerprint.userAgent && !body.parameters.navigator) {
      console.log(`[multilogin] createProfile (Cloud) → UA: ${options.fingerprint.userAgent.slice(0, 70)}...`);
    }
    if (options && options.fingerprint && options.fingerprint.resolution && body.parameters.screen) {
      console.log(`[multilogin] createProfile (Cloud) → screen: ${options.fingerprint.resolution} @ ${body.parameters.screen.pixel_ratio}x`);
    }

    console.log(`[multilogin] createProfile (Cloud) → proxy: ${proxyResult.proxy ? proxyResult.proxy.host + ':' + proxyResult.proxy.port + ' (' + (proxyResult.source || 'unknown') + ')' : 'none'}`);

    if (isMultiloginProxyType(options?.proxy?.type) && proxyResult.proxy && isSmartProxyHost(proxyResult.proxy.host)) {
      return this._errorResponse(-6, 'Multilogin proxy requested but SmartProxy was resolved — profile not created');
    }

    let result = await this._authenticatedCloudRequestWithRetry('/profile/create', { body }, 5);

    if (result.code === 0 && result.data) {
      const newId = (result.data.ids && result.data.ids[0])
        || result.data.profile_id
        || result.data.uuid
        || '';
      console.log(`[multilogin] Cloud profile created: ${newId}`);
      return this._successResponse('Profile created successfully', {
        id: newId,
        proxyUsed: proxyResult.proxy || null,
        proxySource: proxyResult.source || null,
      });
    }

    // Cloud /profile/create often returns HTTP 501 after MLX platform updates — try clone fallback
    if (this._isCloud501Message(result.message)) {
      console.warn('[multilogin] Cloud create unavailable (501) — trying clone fallback...');
      const cloned = await this.cloneProfile(options, proxyResult);
      if (cloned.code === 0) return cloned;

      return this._errorResponse(-1,
        'Multilogin cloud profile/create is down (HTTP 501). '
        + 'Create a profile manually in Multilogin X app → Refresh here, '
        + 'or use Quick/Local mode (Multilogin desktop must be running). '
        + 'Clone fallback also failed: ' + (cloned.message || 'unknown'));
    }

    return result;
  }

  /**
   * Build launcher v3 quick-profile body (MLX 12+ — v2 is deprecated).
   * @private
   */
  _buildQuickProfileV3Body(options, proxyResult, osType, includeProxy) {
    const { flags, fingerprint: fingerprintPayload } = this._buildAntidetectParameters(options, includeProxy);

    const body = {
      browser_type: (options && options.browserType === 'stealthfox') ? 'stealthfox' : 'mimic',
      os_type: osType,
      core_version: this._getCoreVersion(),
      is_headless: false,
      automation: 'playwright',
      parameters: {
        flags,
        fingerprint: fingerprintPayload,
        storage: this._defaultCloudStorage(),
      },
    };

    if (includeProxy && proxyResult && proxyResult.success && proxyResult.proxy) {
      const p = proxyResult.proxy;
      body.parameters.proxy = {
        host: p.host,
        port: Number(p.port),
        username: p.username || '',
        password: p.password || '',
        type: (p.type || 'http').toLowerCase(),
        save_traffic: false,
      };
    }

    return body;
  }

  /**
   * Create a QUICK profile via Local Launcher API v3.
   * POST https://launcher.mlx.yt:45001/api/v3/profile/quick
   *
   * Supports full fingerprint flags + both SmartProxy AND Multilogin residential proxy.
   * NOTE: Quick profiles are session-based — they disappear when closed.
   * Returns CDP port for automation.
   *
   * @param {object} options - Profile creation options
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async createQuickProfile(options) {
    // Resolve proxy — handles SmartProxy AND Multilogin residential
    const proxyResult = await this._resolveProxy(options && options.proxy, 'quick');
    if (!proxyResult.success) {
      return this._errorResponse(-6, proxyResult.error);
    }

    // Map os string
    const osMap = { Windows: 'windows', macOS: 'macos', Android: 'android', Linux: 'linux' };
    const osType = (options && options.os && osMap[options.os]) || 'windows';

    const hasProxy = !!(proxyResult.proxy && proxyResult.proxy.host);
    let body = this._buildQuickProfileV3Body(options, proxyResult, osType, hasProxy);

    console.log(`[multilogin] createQuickProfile (v3) → proxy: ${hasProxy ? proxyResult.proxy.host + ':' + proxyResult.proxy.port + ' (' + (proxyResult.source || 'unknown') + ')' : 'none'}`);

    if (isMultiloginProxyType(options?.proxy?.type) && proxyResult.proxy && isSmartProxyHost(proxyResult.proxy.host)) {
      return this._errorResponse(-6, 'Multilogin proxy requested but SmartProxy was resolved — quick profile not created');
    }

    const result = await this._launcherRequest('/api/v3/profile/quick', {
      method: 'POST',
      body,
      timeout: START_TIMEOUT,
    });

    if (result.code !== 0 && hasProxy) {
      return this._errorResponse(
        result.code || -1,
        (result.message || 'Quick profile with proxy failed')
          + ' — profile was NOT created without proxy (real IP blocked). Use Cloud mode or fix SmartProxy credentials.'
      );
    }

    if (result.code === 0 && result.data) {
      const cdpPort = result.data.port || result.data.cdp_port || result.data.cdpPort;
      const profileId = result.data.uuid || result.data.profile_id || result.data.id || '';
      console.log(`[multilogin] Quick profile created: uuid=${profileId}, cdpPort=${cdpPort}`);
      return this._successResponse('Quick profile created successfully', {
        id: profileId,
        cdpPort: parseInt(cdpPort, 10),
        isQuick: true,
      });
    }

    return result;
  }

  /**
   * Start a browser profile via Multilogin Launcher
   * GET https://launcher.mlx.yt:45001/api/v2/profile/f/{folder_id}/p/{profile_id}/start?automation_type=playwright
   *
   * @param {string} profileId - Multilogin profile_id
   * @returns {Promise<{code: number, message: string, data: {profileId: string, cdpPort: number}|null}>}
   */
  /**
   * Parse CDP port / URL from Multilogin launcher start response (shape varies by MLX version).
   * @private
   */
  _extractCdpFromLauncherData(data) {
    if (!data || typeof data !== 'object') {
      return { cdpPort: 0, cdpEndpoint: null };
    }

    const tryPort = (v) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };

    let cdpPort =
      tryPort(data.port)
      || tryPort(data.cdp_port)
      || tryPort(data.cdpPort)
      || tryPort(data.debug_port)
      || tryPort(data.debugPort);

    if (data.automation && typeof data.automation === 'object') {
      cdpPort = cdpPort || tryPort(data.automation.port) || tryPort(data.automation.cdp_port);
    }

    const wsRaw = data.web_socket_url
      || data.webSocketDebuggerUrl
      || data.ws_endpoint
      || data.wsEndpoint
      || data.browser_wse
      || data.browserWSE;

    let cdpEndpoint = null;
    if (typeof wsRaw === 'string' && wsRaw.length > 0) {
      if (wsRaw.startsWith('ws://') || wsRaw.startsWith('wss://')) {
        const m = wsRaw.match(/:(\d+)(?:\/|$)/);
        if (m) cdpPort = cdpPort || parseInt(m[1], 10);
        cdpEndpoint = `http://127.0.0.1:${cdpPort || m[1]}`;
      } else if (wsRaw.startsWith('http')) {
        cdpEndpoint = wsRaw;
        const m = wsRaw.match(/:(\d+)/);
        if (m) cdpPort = cdpPort || parseInt(m[1], 10);
      }
    }

    if (!cdpEndpoint && cdpPort > 0) {
      cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
    }

    return { cdpPort, cdpEndpoint };
  }

  async startProfile(profileId) {
    // Validate folder_id
    if (!this.folderId) {
      return this._errorResponse(-5, 'MULTILOGIN_FOLDER_ID environment variable is not set');
    }

    const endpoint = `/api/v2/profile/f/${this.folderId}/p/${profileId}/start?automation_type=playwright`;
    const result = await this._launcherRequest(endpoint, { timeout: START_TIMEOUT });

    if (result.code === 0 && result.data) {
      const { cdpPort, cdpEndpoint } = this._extractCdpFromLauncherData(result.data);
      if (!cdpPort || !cdpEndpoint) {
        console.error('[MultiloginProvider] Launcher response missing CDP port field. data:', JSON.stringify(result.data));
        return this._errorResponse(-1, 'Profile started but no CDP port in launcher response. Automation cannot attach — close profile in MLX and retry.');
      }
      // Persist CDP port so stopProfile (and UI Stop button) can find it later
      this._saveCdpPort(profileId, cdpPort);

      return this._successResponse('Profile started successfully', {
        profileId: profileId,
        cdpPort,
        cdpEndpoint,
      });
    }

    // Profile already open (code -6 or "browser process is running" message)
    const alreadyRunning = result.code === -6 ||
      (result.message && /browser process is running|already running|already open/i.test(result.message));

    if (alreadyRunning) {
      console.log(`[MultiloginProvider] Profile ${profileId.slice(-4)} already open — recovering...`);

      // Strategy 1: Try launcher status to get CDP port of already-running profile
      try {
        const statusResult = await this._launcherRequest(
          `/api/v2/profile/f/${this.folderId}/p/${profileId}`,
          { method: 'GET', timeout: DEFAULT_TIMEOUT }
        );
        if (statusResult.code === 0 && statusResult.data) {
          const { cdpPort, cdpEndpoint } = this._extractCdpFromLauncherData(statusResult.data);
          if (cdpPort && cdpEndpoint) {
            console.log(`[MultiloginProvider] CDP port ${cdpPort} from status`);
            this._saveCdpPort(profileId, cdpPort);
            return this._successResponse('Attached to running profile', { profileId, cdpPort, cdpEndpoint });
          }
        }
      } catch {}

      // Strategy 2: Stop via v1, wait, restart
      console.log(`[MultiloginProvider] Stopping profile ${profileId.slice(-4)} and restarting...`);
      try {
        const q = `/api/v1/profile/stop?profile_id=${encodeURIComponent(profileId)}`;
        let st = await this._launcherRequest(q, { method: 'GET', timeout: STOP_TIMEOUT });
        if (st.code !== 0) {
          st = await this._launcherRequest(`/api/v1/profile/stop/p/${profileId}`, { method: 'GET', timeout: STOP_TIMEOUT });
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));

      const retry = await this._launcherRequest(endpoint, { timeout: START_TIMEOUT });
      if (retry.code === 0 && retry.data) {
        const { cdpPort, cdpEndpoint } = this._extractCdpFromLauncherData(retry.data);
        if (cdpPort && cdpEndpoint) {
          return this._successResponse('Profile started (after stop+retry)', { profileId, cdpPort, cdpEndpoint });
        }
      }

      // Strategy 3: Stale state — check if actual browser process is running by scanning CDP ports
      // If no browser found, the Multilogin state is stale (zombie). Wait 10s and force-retry.
      console.log(`[MultiloginProvider] Stale state detected — waiting 10s for Multilogin to clear and retrying...`);
      await new Promise((r) => setTimeout(r, 10000));
      const forceRetry = await this._launcherRequest(endpoint, { timeout: START_TIMEOUT });
      if (forceRetry.code === 0 && forceRetry.data) {
        const { cdpPort, cdpEndpoint } = this._extractCdpFromLauncherData(forceRetry.data);
        if (cdpPort && cdpEndpoint) {
          return this._successResponse('Profile started (force retry)', { profileId, cdpPort, cdpEndpoint });
        }
      }

      return this._errorResponse(-6, 'Profile is open in Multilogin but CDP port could not be determined. Please close the profile manually in Multilogin app and retry.');
    }

    return result;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CDP PORT CACHE (for reliable stop after automation)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  _cdpCachePath() {
    const path = require('path');
    return path.join(__dirname, '..', 'data', 'cdp_ports.json');
  }

  _readCdpCache() {
    const fs = require('fs');
    try {
      const raw = fs.readFileSync(this._cdpCachePath(), 'utf8');
      const parsed = JSON.parse(raw || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  _saveCdpPort(profileId, cdpPort) {
    if (!profileId || !cdpPort) return;
    const fs = require('fs');
    const path = require('path');
    try {
      const file = this._cdpCachePath();
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const cache = this._readCdpCache();
      cache[profileId] = cdpPort;
      const tmp = `${file}.${Date.now().toString(36)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[multilogin] Could not save CDP port cache:', err.message);
    }
  }

  _removeCdpFromCache(profileId) {
    const fs = require('fs');
    try {
      const file = this._cdpCachePath();
      const cache = this._readCdpCache();
      if (!cache[profileId]) return;
      delete cache[profileId];
      const tmp = `${file}.${Date.now().toString(36)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
      fs.renameSync(tmp, file);
    } catch { /* ignore */ }
  }

  async _closeBrowserViaCdp(port) {
    if (!port || port <= 0) return false;
    try {
      const { chromium } = require('playwright-core');
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
      await browser.close();
      console.log(`[multilogin] stopProfile: Closed via CDP port ${port}`);
      return true;
    } catch {
      return false;
    }
  }

  async _isProfileRunningOnLauncher(profileId) {
    if (!this.folderId) return null;
    try {
      const statusResult = await this._launcherRequest(
        `/api/v2/profile/f/${this.folderId}/p/${profileId}`,
        { method: 'GET', timeout: DEFAULT_TIMEOUT },
      );
      if (statusResult.code !== 0 || !statusResult.data) return null;
      const { cdpPort } = this._extractCdpFromLauncherData(statusResult.data);
      const rawStatus = String(statusResult.data.status || statusResult.data.state || '').toLowerCase();
      if (cdpPort > 0) return true;
      if (/running|started|active|automation/.test(rawStatus)) return true;
      if (/stopped|idle|closed/.test(rawStatus)) return false;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Stop a running browser profile via Multilogin Launcher (primary) + CDP fallback.
   * @param {string} profileId
   * @param {{ cdpPort?: number }} [options] - Known CDP port from worker (fastest close path)
   */
  async stopProfile(profileId, options = {}) {
    const hintPort = parseInt(options.cdpPort, 10) || null;
    const cache = this._readCdpCache();
    const cachedPort = parseInt(cache[profileId], 10) || null;
    const portsToTry = [...new Set([hintPort, cachedPort].filter((p) => p && p > 0))];

    let launcherStopped = false;
    const pidEnc = encodeURIComponent(profileId);

    /** Order: Postman‑documented v1 query → path form (help examples) → v2 folder stop (matches v2 start) → force */
    const stopEndpoints = [
      `/api/v1/profile/stop?profile_id=${pidEnc}`,
      `/api/v1/profile/stop/p/${profileId}`,
    ];
    if (this.folderId) {
      stopEndpoints.push(`/api/v2/profile/f/${this.folderId}/p/${profileId}/stop`);
    }
    stopEndpoints.push(`/api/v1/profile/stop?profile_id=${pidEnc}&force=true`);

    for (const endpoint of stopEndpoints) {
      try {
        const result = await this._launcherRequest(endpoint, { method: 'GET', timeout: STOP_TIMEOUT });
        if (result.code === 0) {
          launcherStopped = true;
          console.log(`[multilogin] stopProfile OK via ${endpoint.split('?')[0]}`);
          break;
        }
        console.warn(`[multilogin] stopProfile ${endpoint}: code=${result.code} ${result.message || ''}`);
      } catch (err) {
        console.warn(`[multilogin] stopProfile ${endpoint}: ${err.message}`);
      }
    }

    await sleep(1500);

    let stillRunning = await this._isProfileRunningOnLauncher(profileId);
    if (stillRunning === true && portsToTry.length) {
      for (const port of portsToTry) {
        await this._closeBrowserViaCdp(port);
      }
      await sleep(1200);
      stillRunning = await this._isProfileRunningOnLauncher(profileId);
    }

    if (stillRunning === false || launcherStopped) {
      this._removeCdpFromCache(profileId);
      return this._successResponse('Profile stopped successfully', { profileId, launcherStopped, verified: stillRunning === false });
    }

    if (launcherStopped && stillRunning === null) {
      this._removeCdpFromCache(profileId);
      return this._successResponse('Profile stop sent (status unverified)', { profileId, launcherStopped, verified: false });
    }

    this._removeCdpFromCache(profileId);
    return this._errorResponse(-1, 'Could not stop profile — browser may still be open in Multilogin');
  }

  /**
   * Build /profile/remove body (supports legacy `ids` + documented `profile_ids`).
   * @private
   */
  _buildRemoveBody(profileIds, permanently = false) {
    const ids = (Array.isArray(profileIds) ? profileIds : [profileIds])
      .filter(Boolean)
      .map(String);
    return {
      profile_ids: ids,
      ids,
      permanently: !!permanently,
    };
  }

  /**
   * Remove one or more profiles (soft delete → trash, or permanent purge).
   * @private
   */
  async _removeProfiles(profileIds, permanently = false) {
    const body = this._buildRemoveBody(profileIds, permanently);
    if (!body.profile_ids.length) {
      return this._errorResponse(-5, 'No profile IDs provided');
    }
    return this._authenticatedCloudRequest('/profile/remove', { body });
  }

  /**
   * Delete a browser profile via Multilogin Cloud API
   * POST https://api.multilogin.com/profile/remove
   *
   * @param {string|string[]} profileId - Multilogin profile_id(s)
   * @param {{ permanently?: boolean }} [options] - permanently=true skips trash / purges from trash
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async deleteProfile(profileId, options = {}) {
    const permanently = options.permanently === true;
    const result = await this._removeProfiles(profileId, permanently);

    if (result.code === 0) {
      const ids = this._buildRemoveBody(profileId, permanently).profile_ids;
      return this._successResponse(
        permanently ? 'Profile permanently deleted' : 'Profile moved to trash',
        { profileId: ids[0], profileIds: ids, permanently },
      );
    }

    return result;
  }

  /**
   * Permanently delete profiles from Multilogin trash (frees subscription quota).
   * @param {string|string[]} profileIds
   */
  async deleteProfilesPermanently(profileIds) {
    const result = await this._removeProfiles(profileIds, true);
    if (result.code === 0) {
      const ids = this._buildRemoveBody(profileIds, true).profile_ids;
      return this._successResponse('Profile(s) permanently deleted from trash', {
        profileIds: ids,
        deleted: result.data?.removed || ids.length,
      });
    }
    return result;
  }

  /**
   * Map raw Multilogin search rows to standardized profile objects.
   * @private
   */
  _mapSearchProfiles(profileList) {
    return (Array.isArray(profileList) ? profileList : []).map((item) => {
      const osHint = item.os_type || item.os || null;
      const params = item.parameters && typeof item.parameters === 'object' ? item.parameters : {};
      const proxy = params.proxy || item.proxy || null;
      const nav = params.fingerprint?.navigator || params.navigator || item.fingerprint?.navigator || null;
      const proxyHost = proxy?.host || proxy?.server || proxy?.hostname || '';
      const proxyPort = proxy?.port ? parseInt(proxy.port, 10) : undefined;
      const proxyUsername = proxy?.username || proxy?.user || '';
      const userAgentHint = nav?.user_agent || nav?.userAgent || item.user_agent || '';

      return {
        id: item.id || item.profile_id || item.uuid || '',
        name: item.name || '',
        status: item.in_use_by ? 'running' : 'stopped',
        debugPort: null,
        browserType: 'multilogin',
        osName: osHint,
        os: osHint,
        proxyHost: proxyHost || undefined,
        proxyPort: Number.isFinite(proxyPort) ? proxyPort : undefined,
        proxyUsername: proxyUsername || undefined,
        userAgentHint: userAgentHint || undefined,
        removedAt: item.removed_at || item.deleted_at || null,
      };
    });
  }

  /**
   * Search profiles in folder (active or trash).
   * @private
   */
  async _searchProfiles(pageNo = 1, pageSize = 50, isRemoved = false, folderId = null) {
    const effectiveFolderId = folderId || this.folderId;
    if (!effectiveFolderId) {
      return this._errorResponse(-5, 'MULTILOGIN_FOLDER_ID environment variable is not set');
    }

    const limit = Math.max(1, Math.min(100, pageSize));
    const offset = (pageNo - 1) * limit;

    const body = {
      folder_id: effectiveFolderId,
      search_text: '',
      offset,
      limit,
      is_removed: !!isRemoved,
    };

    return this._authenticatedCloudRequest('/profile/search', { body });
  }

  /**
   * List profiles currently in Multilogin trash for this folder.
   */
  async listTrashProfiles(pageNo = 1, pageSize = 50) {
    const result = await this._searchProfiles(pageNo, pageSize, true);

    if (result.code === 0 && result.data) {
      const profileList = result.data.profiles || [];
      const profiles = this._mapSearchProfiles(profileList);
      const total = result.data.total_count || result.data.total || profiles.length;
      return this._successResponse('Trash profiles retrieved successfully', {
        profiles,
        total,
        pages: Math.ceil(total / Math.max(1, Math.min(100, pageSize))) || 1,
        current: pageNo,
      });
    }

    return result;
  }

  /**
   * Permanently delete all profiles in Multilogin trash (paginated batches).
   */
  async emptyTrash() {
    let totalDeleted = 0;
    const batchSize = 50;
    const maxRounds = 200;

    for (let round = 0; round < maxRounds; round++) {
      const list = await this.listTrashProfiles(1, batchSize);
      if (list.code !== 0) {
        if (totalDeleted > 0) {
          return this._successResponse(`Partial trash cleanup — ${totalDeleted} deleted`, {
            deleted: totalDeleted,
            warning: list.message,
          });
        }
        return list;
      }

      const profiles = list.data?.profiles || [];
      if (!profiles.length) {
        break;
      }

      const ids = profiles.map((p) => p.id).filter(Boolean);
      const del = await this.deleteProfilesPermanently(ids);
      if (del.code !== 0) {
        if (totalDeleted > 0) {
          return this._successResponse(`Partial trash cleanup — ${totalDeleted} deleted`, {
            deleted: totalDeleted,
            warning: del.message,
          });
        }
        return del;
      }

      totalDeleted += del.data?.deleted || ids.length;
      if (profiles.length < batchSize) break;
    }

    return this._successResponse(
      totalDeleted > 0 ? `Trash emptied — ${totalDeleted} profile(s) removed` : 'Trash is already empty',
      { deleted: totalDeleted },
    );
  }

  /**
   * List browser profiles with pagination via Multilogin Cloud API
   * POST https://api.multilogin.com/profile/search
   * 
   * @param {number} [pageNo=1] - Page number
   * @param {number} [pageSize=50] - Items per page (1-100)
   * @returns {Promise<{code: number, message: string, data: {profiles: Array}|null}>}
   */
  async listProfiles(pageNo = 1, pageSize = 50) {
    // Validate folder_id
    if (!this.folderId) {
      return this._errorResponse(-5, 'MULTILOGIN_FOLDER_ID environment variable is not set');
    }

    const limit = Math.max(1, Math.min(100, pageSize));
    const allFolderIds = this._getAllFolderIds();

    // Single folder — standard paginated fetch
    if (allFolderIds.length <= 1) {
      const result = await this._searchProfiles(pageNo, limit, false);
      if (result.code === 0 && result.data) {
        const profileList = result.data.profiles || [];
        const profiles = this._mapSearchProfiles(profileList);
        const total = result.data.total_count || result.data.total || profiles.length;
        return this._successResponse('Profiles retrieved successfully', {
          profiles,
          total,
          pages: Math.ceil(total / limit) || 1,
          current: pageNo,
        });
      }
      return result;
    }

    // Multiple folders — fetch from ALL folders (up to 100 each), combine, then paginate
    const allProfiles = [];
    for (const fid of allFolderIds) {
      try {
        const body = { folder_id: fid, search_text: '', offset: 0, limit: 100, is_removed: false };
        const res = await this._authenticatedCloudRequest('/profile/search', { body });
        if (res.code === 0 && res.data) {
          const list = res.data.profiles || [];
          const mapped = this._mapSearchProfiles(list);
          allProfiles.push(...mapped);
        }
      } catch { /* skip failed folder */ }
    }

    // Deduplicate by profile ID
    const seen = new Set();
    const unique = allProfiles.filter(p => {
      const id = p.id || p.profile_id;
      if (!id || seen.has(id)) return false;
      seen.add(id); return true;
    });

    // Apply pagination to combined list
    const total = unique.length;
    const offset = (pageNo - 1) * limit;
    const page = unique.slice(offset, offset + limit);

    return this._successResponse(`Profiles from ${allFolderIds.length} folders`, {
      profiles: page,
      total,
      pages: Math.ceil(total / limit) || 1,
      current: pageNo,
    });
  }

  /**
   * Get the status of a specific profile
   * @param {string} profileId - Multilogin profile_id
   * @returns {Promise<{code: number, message: string, data: object|null}>}
   */
  async getProfileStatus(profileId) {
    // Use profile search with specific ID to get status
    const body = {
      folder_id: this.folderId,
      search_text: '',
      profile_ids: [profileId],
      offset: 0,
      limit: 1,
    };

    const result = await this._authenticatedCloudRequest('/profile/search', { body });

    if (result.code === 0 && result.data) {
      const profileList = result.data.profiles || result.data || [];
      const profile = Array.isArray(profileList) && profileList.length > 0 ? profileList[0] : null;

      if (profile) {
        return this._successResponse('Profile status retrieved', {
          id: profile.id || profile.profile_id || profile.uuid || profileId,
          name: profile.name || '',
          status: profile.in_use_by ? 'running' : 'stopped',
          debugPort: null,
          browserType: 'multilogin',
        });
      }

      return this._errorResponse(-1, `Profile ${profileId} not found`);
    }

    return result;
  }

  /**
   * Update proxy on a cloud profile without full recreate.
   * POST https://api.multilogin.com/profile/update
   */
  async updateProfileProxy(profileId, proxy) {
    const host = proxy?.server || proxy?.host;
    const port = proxy?.port;
    if (!proxy || !host || !port) {
      return this._errorResponse(-5, 'Invalid proxy: host/server and port required');
    }
    const rawType = String(proxy.type || proxy.protocol || 'http').toLowerCase();
    const typeMap = { http: 'http', https: 'https', socks5: 'socks5', socks4: 'socks4' };
    const apiType = typeMap[rawType] || 'http';

    // Fetch current profile data — Multilogin cloud API requires name, browser_type,
    // os_type, core_version, storage, and fingerprint even for proxy-only updates.
    let profileName = `Profile_${profileId.slice(-4)}`;
    let browserType = 'mimic';
    let osType = 'windows';
    let coreVersion = this._getCoreVersion();
    try {
      const search = await this._searchProfiles(1, 1, false);
      if (search.code === 0 && search.data) {
        const found = (search.data.profiles || []).find(p => p.id === profileId || p.profile_id === profileId);
        if (found) {
          profileName = found.name || profileName;
          browserType = found.browser_type || browserType;
          osType = found.os_type || osType;
          coreVersion = found.core_version || coreVersion;
        }
      }
    } catch (_) { /* use defaults if search fails */ }

    const body = {
      profile_id: profileId,
      name: profileName,
      browser_type: browserType,
      os_type: osType,
      core_version: coreVersion,
      parameters: {
        flags: this._defaultCloudFlags('custom'),
        fingerprint: {},
        storage: this._defaultCloudStorage(),
        proxy: {
          host,
          port: Number(port),
          username: proxy.username || '',
          password: proxy.password || '',
          type: apiType,
          save_traffic: false,
        },
      },
    };
    const result = await this._authenticatedCloudRequest('/profile/update', { body });
    if (result.code === 0) {
      console.log(`[multilogin] Proxy updated for profile ${profileId}`);
    }
    return result;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // INTERNAL HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Make an HTTPS request to the Multilogin Cloud API.
   * Uses standard HTTPS (valid cert on api.multilogin.com).
   * 
   * @param {string} url - Full URL
   * @param {object} options - Request options
   * @returns {Promise<{statusCode: number, headers: object, body: any}>}
   * @private
   */
  async _makeCloudRequest(url, options) {
    return this.makeRequest(url, options);
  }

  /**
   * Make an HTTPS request to the Multilogin Launcher.
   * Uses rejectUnauthorized: false for self-signed certificate.
   * 
   * @param {string} url - Full launcher URL
   * @param {object} options - Request options
   * @returns {Promise<{statusCode: number, headers: object, body: any}>}
   * @private
   */
  _makeLauncherRequest(url, options) {
    return new Promise((resolve, reject) => {
      const { URL } = require('url');
      const parsedUrl = new URL(url);

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
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: requestHeaders,
        timeout: options.timeout || START_TIMEOUT,
        rejectUnauthorized: false, // Self-signed cert on launcher
      };

      const req = https.request(reqOptions, (res) => {
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
        const err = new Error(`Launcher request timeout after ${options.timeout || START_TIMEOUT}ms: ${url}`);
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
   * Parse Multilogin Cloud API response into standardized format.
   * 
   * @param {object} response - Raw HTTP response
   * @returns {{code: number, message: string, data: any}}
   * @private
   */
  _parseCloudResponse(response) {
    const result = response.body;

    // Log only on errors to avoid leaking credentials/profile data in production logs
    if (response.statusCode >= 400) {
      console.warn('[multilogin] Cloud API error:', response.statusCode, result?.status?.message || '');
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (result && typeof result === 'object') {
        // Multilogin format: { status: { http_code, message, error_code }, data: {...} }
        const httpCode = result.status && result.status.http_code
          ? result.status.http_code
          : response.statusCode;
        const msg = (result.status && result.status.message) || result.message || 'OK';
        if (httpCode >= 200 && httpCode < 300) {
          return {
            code: 0,
            message: msg.slice(0, 256),
            data: result.data !== undefined ? result.data : result,
          };
        }
        return this._errorResponse(-1, msg.slice(0, 256));
      }
      return this._successResponse('OK', result);
    }

    // Error response
    const msg = (result && result.status && result.status.message)
      || (result && result.message)
      || `Multilogin API error (HTTP ${response.statusCode})`;
    return this._errorResponse(-1, msg);
  }

  /**
   * Parse Multilogin Launcher response into standardized format.
   * 
   * @param {object} response - Raw HTTP response
   * @returns {{code: number, message: string, data: any}}
   * @private
   */
  _parseLauncherResponse(response) {
    const result = response.body;

    // Log launcher errors only (not full body — avoids leaking proxy credentials)
    if (response.statusCode >= 400 || (result && result.status && result.status.http_code >= 400)) {
      console.warn('[multilogin] Launcher error:', response.statusCode, result?.status?.message || result?.status?.error_code || '');
    }

    // Multilogin launcher returns { status: { error_code, http_code, message }, data: {...} }
    const httpCode = (result && result.status && result.status.http_code)
      ? result.status.http_code
      : response.statusCode;
    const errorCode = (result && result.status && result.status.error_code) || '';
    const msg = (result && result.status && result.status.message)
      || (result && result.message)
      || (response.statusCode >= 200 && response.statusCode < 300 ? 'OK' : `Launcher error HTTP ${response.statusCode}`);

    if (httpCode >= 200 && httpCode < 300) {
      return {
        code: 0,
        message: msg.slice(0, 256),
        data: (result && result.data) ? result.data : result,
      };
    }

    // Special error codes
    return this._errorResponse(errorCode === 'PROFILE_ALREADY_RUNNING' ? -6 : -1, msg);
  }

  /**
   * Handle Multilogin-specific errors with appropriate messaging.
   * 
   * @param {Error} error - The error to handle
   * @param {string} context - Context string ('cloud', 'launcher', 'authenticate')
   * @returns {{code: number, message: string, data: null}}
   * @private
   */
  _handleMultiloginError(error, context) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNRESET' || error.code === 'TIMEOUT' ||
        error.code === 'ENOTFOUND') {
      if (context === 'launcher') {
        return this._errorResponse(-1, 'Multilogin launcher must be connected');
      }
      return this._errorResponse(-1, 'Multilogin API is not reachable');
    }
    return this.handleError(error);
  }

  /**
   * Map Multilogin status strings to standardized status enum
   * @param {string} status - Multilogin status value
   * @returns {'running'|'stopped'|'error'|'unknown'}
   * @private
   */
  _mapStatus(status) {
    if (!status) return 'unknown';
    const s = String(status).toLowerCase();
    if (s === 'running' || s === 'active' || s === 'started') return 'running';
    if (s === 'stopped' || s === 'closed' || s === 'idle' || s === 'ready') return 'stopped';
    if (s === 'error' || s === 'failed') return 'error';
    return 'unknown';
  }
}

// Standalone buildFingerprintPayload for direct access
function buildFingerprintPayload(config) {
  const instance = new MultiloginProvider();
  return instance.buildFingerprintPayload(config);
}

module.exports = { MultiloginProvider, buildFingerprintPayload };
