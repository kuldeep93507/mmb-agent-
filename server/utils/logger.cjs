'use strict';

/**
 * Lightweight structured logger for workers / services (profile-scoped prefix).
 */

const SEV = { FATAL: 'FATAL', ERROR: 'ERROR', WARN: 'WARN', INFO: 'INFO', DEBUG: 'DEBUG' };

function shortId(profileId) {
  if (!profileId) return 'global';
  const s = String(profileId);
  return s.length <= 10 ? s : s.slice(-10);
}

/**
 * @param {string} [profileId]
 * @param {string} [scope] e.g. 'Agent.watchVideo'
 */
function createProfileLogger(profileId, scope = '') {
  const pid = shortId(profileId);
  const sc = scope ? `[${scope}]` : '';

  function line(level, fn, extraScope, msg, err) {
    const fnTag = extraScope ? `[${extraScope}]` : sc;
    const errPart = err ? ` | ${err && err.stack ? err.stack : String(err)}` : '';
    fn(`${pid} [${level}] ${fnTag} ${msg}${errPart}`);
  }

  return {
    fatal: (fnName, msg, err) => line(SEV.FATAL, console.error, fnName, msg, err),
    error: (fnName, msg, err) => line(SEV.ERROR, console.error, fnName, msg, err),
    warn: (fnName, msg, err) => line(SEV.WARN, console.warn, fnName, msg, err),
    info: (fnName, msg) => line(SEV.INFO, console.log, fnName, msg, null),
    debug: (fnName, msg) => line(SEV.DEBUG, console.log, fnName, msg, null),
  };
}

module.exports = { createProfileLogger, SEV };
