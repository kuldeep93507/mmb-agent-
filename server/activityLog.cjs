/**
 * Central activity log — in-memory ring buffer + debounced file persist.
 * Used by API routes, orchestrator worker logs, and schedule events.
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, '..', 'activity_logs.json');
const MAX_ENTRIES = 2000;
const VALID_LEVELS = new Set(['info', 'warn', 'error', 'success']);
const VALID_SOURCES = new Set([
  'profile', 'worker', 'scheduler', 'shuffle', 'backlink', 'manual', 'settings', 'system', 'yt-agent',
]);

let entries = [];
let saveTimer = null;

function loadFromDisk() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    if (Array.isArray(raw.entries)) {
      entries = raw.entries.slice(-MAX_ENTRIES);
    }
  } catch {
    entries = [];
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(LOG_FILE, JSON.stringify({ entries: entries.slice(-MAX_ENTRIES) }, null, 2));
    } catch (err) {
      console.error('[ActivityLog] Save failed:', err.message);
    }
  }, 2000);
}

function normalizeLevel(level) {
  const l = String(level || 'info').toLowerCase();
  return VALID_LEVELS.has(l) ? l : 'info';
}

function normalizeSource(source) {
  const s = String(source || 'system').toLowerCase();
  return VALID_SOURCES.has(s) ? s : 'system';
}

function parseTime(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function append(payload) {
  const entry = {
    id: payload.id || genId(),
    level: normalizeLevel(payload.level),
    message: String(payload.message || '').slice(0, 4000),
    profileId: payload.profileId || undefined,
    profileName: payload.profileName || undefined,
    source: normalizeSource(payload.source),
    timestamp: parseTime(payload.timestamp),
  };
  if (!entry.message) return null;

  if (entry.id) {
    const existing = entries.findIndex((e) => e.id === entry.id);
    if (existing >= 0) {
      entries[existing] = { ...entries[existing], ...entry };
      scheduleSave();
      return entry;
    }
  }

  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
  scheduleSave();
  return entry;
}

function getLogs(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 500, 1), MAX_ENTRIES);
  const since = opts.since ? parseTime(opts.since) : 0;
  const level = opts.level && opts.level !== 'all' ? normalizeLevel(opts.level) : null;
  const source = opts.source && opts.source !== 'all' ? normalizeSource(opts.source) : null;
  const profileId = opts.profileId ? String(opts.profileId) : null;
  const search = opts.search ? String(opts.search).toLowerCase() : '';

  let list = entries.filter((e) => e.timestamp >= since);
  if (level) list = list.filter((e) => e.level === level);
  if (source) list = list.filter((e) => e.source === source);
  if (profileId) list = list.filter((e) => e.profileId === profileId);
  if (search) {
    list = list.filter(
      (e) =>
        e.message.toLowerCase().includes(search) ||
        (e.profileName && e.profileName.toLowerCase().includes(search)),
    );
  }

  const stats = { info: 0, warn: 0, error: 0, success: 0 };
  for (const e of entries) {
    if (stats[e.level] != null) stats[e.level]++;
  }

  return { entries: list.slice(0, limit), total: entries.length, stats, filtered: list.length };
}

function clear() {
  entries = [];
  scheduleSave();
}

function inferScheduleSource(schedule) {
  if (!schedule) return 'scheduler';
  if (schedule.trafficType === 'backlink') return 'backlink';
  const id = String(schedule.id || '');
  const name = String(schedule.name || '').toLowerCase();
  if (id.startsWith('shuffle_') || name.includes('shuffle')) return 'shuffle';
  return 'scheduler';
}

loadFromDisk();

module.exports = {
  append,
  getLogs,
  clear,
  inferScheduleSource,
  MAX_ENTRIES,
};
