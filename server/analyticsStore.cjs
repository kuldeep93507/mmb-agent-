/**
 * Serialized analytics mutations + atomic JSON persistence (crash-safe rename).
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const d = JSON.parse(raw);
    if (d && typeof d === 'object') return { ...fallback, ...d };
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('[analytics] load failed:', filePath, err.message);
    }
  }
  return { ...fallback };
}

function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  const rnd = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = path.join(dir, `.${path.basename(filePath)}.${rnd}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function defaultAnalyticsShape() {
  return {
    totalViews: 0,
    totalWatchTime: 0,
    totalSessions: 0,
    totalLikes: 0,
    totalSubscribes: 0,
    totalComments: 0,
    perProfile: {},
    recentActivity: [],
    dailyLog: [],
  };
}

function createAnalyticsStore(filePath) {
  const stateRef = loadJsonSafe(filePath, defaultAnalyticsShape());
  let tail = Promise.resolve();

  return {
    filePath,

    snapshotSync() {
      return JSON.parse(JSON.stringify(stateRef));
    },

    async flushPending() {
      await tail.catch((err) => {
        console.error('[analytics] queue flush error:', err.message);
      });
    },

    enqueue(mutator) {
      tail = tail.then(() => {
        mutator(stateRef);
        atomicWriteJson(filePath, stateRef);
      });
      return tail;
    },
  };
}

module.exports = {
  createAnalyticsStore,
  defaultAnalyticsShape,
  atomicWriteJson,
};
