'use strict';

const VERSION_RE = /^[a-zA-Z0-9._-]+$/;

function validateVersion(version) {
  const v = version != null ? String(version).trim() : '';
  if (!v) return { ok: false, error: 'version required' };
  if (!VERSION_RE.test(v)) {
    return {
      ok: false,
      error: 'version must match /^[a-zA-Z0-9._-]+$/ (no shell metacharacters)',
    };
  }
  return { ok: true, version: v };
}

/** Strip characters that must never reach git commit messaging / shell-expanded contexts. */
function sanitizeChangelogTextItem(item) {
  const s = String(item ?? '').replace(/[`"$;|&\n\r\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 200);
}

/** @param {unknown} changelog */
function normalizeChangelogArray(changelog) {
  let arr = [];
  if (Array.isArray(changelog)) {
    arr = changelog.map(sanitizeChangelogTextItem).filter(Boolean);
  } else if (changelog != null) {
    arr = [sanitizeChangelogTextItem(changelog)].filter(Boolean);
  }
  if (arr.length === 0) {
    return { ok: false, error: 'changelog must be non-empty after sanitization' };
  }
  return { ok: true, changelog: arr.slice(0, 25) };
}

function buildCommitMessage(version, changelogArr) {
  const safeSummary = changelogArr.slice(0, 3).join(', ');
  return `v${version}: ${safeSummary}`;
}

module.exports = {
  VERSION_RE,
  validateVersion,
  sanitizeChangelogTextItem,
  normalizeChangelogArray,
  buildCommitMessage,
};
