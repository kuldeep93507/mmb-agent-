'use strict';

/**
 * ProxyRotator — Assigns unique proxies from the SmartProxy residential pool.
 *
 * All proxies share the same server:port but differ by session ID in the username.
 * Uniqueness is enforced by session ID — each profile gets a unique session ID
 * that routes to a different exit IP.
 *
 * Uses environment variables:
 *   PROXY_SERVER  — SmartProxy server (default: 'us.smartproxy.net')
 *   PROXY_PORT    — SmartProxy port (default: 3120)
 *   PROXY_PASSWORD — SmartProxy password
 *   PROXY_PREFIX  — Username prefix (e.g., 'smart-pwgbkxcy3lyi')
 *
 * @module ProxyRotator
 */

const loadEnv = require('../providers/loadEnv.cjs');
loadEnv();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROXY DATA (replicated from src/data/proxyData.ts for server-side use)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// SmartProxy format: full state names + cities
// Username: PREFIX_area-US_state-STATE_city-CITY_life-MINUTES_session-ID
//
// Timezone distribution — balanced across 6 US zones so profiles get varied timezones:
//   Eastern  (America/New_York)        — 4 states
//   Central  (America/Chicago)         — 5 states
//   Pacific  (America/Los_Angeles)     — 4 states
//   Mountain (America/Denver)          — 3 states
//   Arizona  (America/Phoenix, no DST) — 2 states
//   Alaska   (America/Anchorage)       — 1 state
//   Hawaii   (Pacific/Honolulu)        — 1 state
const US_STATE_CITIES = {
  // ── Eastern (America/New_York) ──────────────────
  NEWYORK:        ['NEWYORK', 'BUFFALO', 'ROCHESTER', 'YONKERS', 'SYRACUSE'],
  FLORIDA:        ['MIAMI', 'ORLANDO', 'TAMPA', 'JACKSONVILLE', 'STPETERSBURG'],
  GEORGIA:        ['ATLANTA', 'AUGUSTA', 'SAVANNAH', 'MACON', 'COLUMBUS'],
  NORTHCAROLINA:  ['CHARLOTTE', 'RALEIGH', 'GREENSBORO', 'DURHAM', 'WINSTON'],

  // ── Central (America/Chicago) ───────────────────
  TEXAS:          ['AUSTIN', 'DALLAS', 'HOUSTON', 'SANANTONIO', 'FORTWORTH'],
  ILLINOIS:       ['CHICAGO', 'AURORA', 'JOLIET', 'ROCKFORD', 'NAPERVILLE'],
  TENNESSEE:      ['NASHVILLE', 'MEMPHIS', 'KNOXVILLE', 'CHATTANOOGA', 'CLARKSVILLE'],
  MISSOURI:       ['KANSASCITY', 'STLOUIS', 'SPRINGFIELD', 'COLUMBIA', 'INDEPENDENCE'],
  MINNESOTA:      ['MINNEAPOLIS', 'STPAUL', 'ROCHESTER', 'DULUTH', 'BLOOMINGTON'],

  // ── Pacific (America/Los_Angeles) ──────────────
  CALIFORNIA:     ['LOSANGELES', 'SANDIEGO', 'SACRAMENTO', 'FRESNO', 'SANJOSE'],
  WASHINGTON:     ['SEATTLE', 'SPOKANE', 'TACOMA', 'BELLEVUE', 'KENT'],
  OREGON:         ['PORTLAND', 'SALEM', 'EUGENE', 'GRESHAM', 'HILLSBORO'],
  NEVADA:         ['LASVEGAS', 'HENDERSON', 'RENO', 'NORTHLASVEGAS', 'SPARKS'],

  // ── Mountain (America/Denver) ──────────────────
  COLORADO:       ['DENVER', 'COLORADOSPRINGS', 'AURORA', 'FORTCOLLINS', 'LAKEWOOD'],
  UTAH:           ['SALTLAKECITY', 'WESTVALLEY', 'PROVO', 'WESTJORDAN', 'OREM'],
  NEWMEXICO:      ['ALBUQUERQUE', 'LASCRUCES', 'ROSWELL', 'SANTAFE', 'RIO RANCHO'],

  // ── Arizona / Mountain no-DST (America/Phoenix) ─
  ARIZONA:        ['PHOENIX', 'TUCSON', 'MESA', 'CHANDLER', 'SCOTTSDALE'],
  IDAHO:          ['BOISE', 'MERIDIAN', 'NAMPA', 'IDAHOFALLS', 'POCATELLO'],

  // ── Alaska (America/Anchorage) ──────────────────
  ALASKA:         ['ANCHORAGE', 'FAIRBANKS', 'JUNEAU', 'SITKA', 'KETCHIKAN'],

  // ── Hawaii (Pacific/Honolulu) ───────────────────
  HAWAII:         ['HONOLULU', 'PEARLCITY', 'HILO', 'KAILUA', 'WAIPAHU'],
};

// Life values in minutes — SmartProxy format: life-120, life-240, etc.
const PROXY_LIVES = ['60', '120', '240', '480', '1440'];

const LIFE_MS = {
  '60':   3600000,
  '120':  7200000,
  '240':  14400000,
  '480':  28800000,
  '1440': 86400000,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Select a random element from an array.
 * @template T
 * @param {T[]} arr
 * @returns {T}
 */
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a 6-character uppercase alphanumeric session ID (A-Z, 0-9).
 * SmartProxy examples show uppercase IDs like GGXTUE.
 * @returns {string}
 */
function generateSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROXY ROTATOR CLASS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class ProxyRotator {
  constructor() {
    /**
     * Active proxy assignments: profileId → ProxyConfig
     * @type {Map<string, object>}
     */
    this._assignments = new Map();
  }

  /**
   * Get proxy configuration from environment variables with defaults.
   * @returns {{ server: string, port: number, password: string, prefix: string }}
   */
  _getProxyEnv() {
    return {
      server: process.env.PROXY_SERVER || 'us.smartproxy.net',
      port: parseInt(process.env.PROXY_PORT, 10) || 3120,
      password: process.env.PROXY_PASSWORD || '',
      prefix: process.env.PROXY_PREFIX || '',
    };
  }

  /**
   * Generate a unique session ID that doesn't conflict with any active assignment.
   * Retries up to 100 times to avoid collisions (extremely unlikely with 36^8 space).
   * @returns {string} Unique 8-character session ID
   * @throws {Error} If unable to generate a unique session ID after max attempts
   */
  _generateUniqueSessionId() {
    const maxAttempts = 100;
    const activeSessionIds = new Set();

    for (const config of this._assignments.values()) {
      activeSessionIds.add(config.sessionId);
    }

    for (let i = 0; i < maxAttempts; i++) {
      const sessionId = generateSessionId();
      if (!activeSessionIds.has(sessionId)) {
        return sessionId;
      }
    }

    throw new Error('Failed to generate unique session ID after maximum attempts');
  }

  /**
   * Assign a new proxy with a unique session ID not matching any active profile.
   *
   * @param {string} [life] - Proxy life duration ('1hr', '2hr', '4hr', '8hr', '24hr').
   *                          If not provided, a random life is selected.
   * @returns {{ success: boolean, proxy?: object, error?: string }}
   */
  assignProxy(life) {
    try {
      const { server, port, password, prefix } = this._getProxyEnv();

      if (!password || !prefix) {
        return {
          success: false,
          error: 'Proxy credentials not configured. Set PROXY_PASSWORD and PROXY_PREFIX in .env',
        };
      }

      // Select random US state + city (full names as required by SmartProxy)
      const states = Object.keys(US_STATE_CITIES);
      const state = randomFrom(states);
      const city = randomFrom(US_STATE_CITIES[state]);

      // Select life duration (in minutes — SmartProxy format: life-120)
      const selectedLife = life && LIFE_MS[life] ? life : randomFrom(PROXY_LIVES);

      // Generate unique session ID (uppercase alphanumeric, 6 chars)
      const sessionId = this._generateUniqueSessionId();

      // SmartProxy correct username format (confirmed working):
      // PREFIX_area-US_life-MINUTES_session-SESSIONID
      // NOTE: state/city targeting removed — Multilogin launcher validation rejects those formats
      const username = `${prefix}_area-US_life-${selectedLife}_session-${sessionId}`;

      const now = Date.now();

      const proxyConfig = {
        server,
        port,
        username,
        password,
        state,
        city,
        life: selectedLife,
        sessionId,
        assignedAt: now,
        expiresAt: now + LIFE_MS[selectedLife],
      };

      return { success: true, proxy: proxyConfig };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Register a proxy assignment for a profile.
   * Call this after successfully creating a profile to track the assignment.
   *
   * @param {string} profileId - The profile ID to associate with the proxy
   * @param {object} proxyConfig - The proxy configuration to assign
   */
  registerAssignment(profileId, proxyConfig) {
    this._assignments.set(profileId, proxyConfig);
  }

  /**
   * Release a proxy assignment for a profile, returning the session ID to the available pool.
   *
   * @param {string} profileId - The profile ID whose proxy should be released
   * @returns {boolean} True if the assignment was found and released, false otherwise
   */
  releaseProxy(profileId) {
    return this._assignments.delete(profileId);
  }

  /**
   * Check if a session ID is available (not currently assigned to any active profile).
   *
   * @param {string} sessionId - The session ID to check
   * @returns {boolean} True if the session ID is available (not in use)
   */
  isProxyAvailable(sessionId) {
    for (const config of this._assignments.values()) {
      if (config.sessionId === sessionId) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get all active proxy assignments.
   *
   * @returns {Map<string, object>} Map of profileId → ProxyConfig
   */
  getActiveAssignments() {
    return new Map(this._assignments);
  }

  /**
   * Get the number of active assignments.
   *
   * @returns {number}
   */
  getActiveCount() {
    return this._assignments.size;
  }

  /**
   * Clear all assignments (useful for testing or reset scenarios).
   */
  clearAll() {
    this._assignments.clear();
  }
}

// Export a singleton instance and the class for testing.
//
// ARCHITECTURE NOTE — Worker Thread Isolation:
// Node.js worker_threads give each thread its own module scope. If a worker thread
// requires this file, it gets a SEPARATE ProxyRotator instance (not this singleton).
//
// CURRENT DESIGN IS SAFE because:
//   - Profile creation (ProfileCreator.cjs) ONLY runs in the main Express thread.
//   - Worker threads (worker.cjs) only START already-created profiles — they never
//     call proxyRotator.assignProxy() directly.
//   - Therefore proxy uniqueness is fully enforced in the main thread singleton.
//
// If you ever move profile creation into worker threads, you must switch to
// an IPC-based proxy registry (e.g., SharedArrayBuffer or a main-thread proxy queue).
const proxyRotator = new ProxyRotator();

module.exports = proxyRotator;
module.exports.ProxyRotator = ProxyRotator;
