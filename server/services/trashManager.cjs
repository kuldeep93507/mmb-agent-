'use strict';

/**
 * TrashManager — scheduled Multilogin trash cleanup.
 * Reads multiloginAutoEmptyTrash + multiloginAutoEmptyTrashHours from user-settings.json.
 */

const fs = require('fs');
const path = require('path');
const { providerFactory } = require('../providers/ProviderFactory.cjs');

const SETTINGS_FILE = path.resolve(__dirname, '..', '..', 'user-settings.json');

let intervalId = null;

function readTrashSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return { enabled: false, hoursMs: 6 * 60 * 60 * 1000 };
    }
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const enabled = s.multiloginAutoEmptyTrash === true || s.multiloginAutoEmptyTrash === 'true';
    const hours = parseFloat(s.multiloginAutoEmptyTrashHours);
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 6;
    return { enabled, hoursMs: safeHours * 60 * 60 * 1000 };
  } catch {
    return { enabled: false, hoursMs: 6 * 60 * 60 * 1000 };
  }
}

async function runEmptyTrash() {
  try {
    const provider = providerFactory.getProvider('multilogin');
    if (typeof provider.emptyTrash !== 'function') return { code: -5, message: 'Not supported' };

    const result = await provider.emptyTrash();
    if (result.code === 0) {
      const deleted = result.data?.deleted || 0;
      if (deleted > 0) {
        console.log(`[TrashManager] Auto-empty trash: ${deleted} profile(s) permanently removed`);
      }
    } else {
      console.warn(`[TrashManager] Auto-empty trash failed: ${result.message}`);
    }
    return result;
  } catch (err) {
    console.warn(`[TrashManager] Error: ${err.message}`);
    return { code: -1, message: err.message, data: null };
  }
}

function restartTrashJanitor() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  const { enabled, hoursMs } = readTrashSettings();
  if (!enabled) {
    console.log('[TrashManager] Auto-empty trash disabled');
    return;
  }

  const hours = hoursMs / (60 * 60 * 1000);
  console.log(`[TrashManager] Auto-empty trash enabled — every ${hours}h`);

  setTimeout(() => {
    runEmptyTrash().catch(() => {});
  }, 45000);

  intervalId = setInterval(() => {
    runEmptyTrash().catch(() => {});
  }, hoursMs);
}

module.exports = { restartTrashJanitor, runEmptyTrash, readTrashSettings };
