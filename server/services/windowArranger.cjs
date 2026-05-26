'use strict';

/**
 * Arrange Multilogin / CDP browser windows in a grid on one display.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CDP_CACHE = path.join(__dirname, '..', 'data', 'cdp_ports.json');

function readCdpCache() {
  try {
    return JSON.parse(fs.readFileSync(CDP_CACHE, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function gridLayout(total, screenW = 1920, screenH = 1080) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(total)));
  const rows = Math.max(1, Math.ceil(total / cols));
  const winW = Math.floor(screenW / cols);
  const winH = Math.floor(screenH / rows);
  return { cols, rows, winW, winH };
}

async function arrangeWindowAtPort(cdpPort, index, total, screenW = 1920, screenH = 1080) {
  const { cols, winW, winH } = gridLayout(total, screenW, screenH);
  const x = (index % cols) * winW;
  const y = Math.floor(index / cols) * winH;

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 8000 });
  try {
    const contexts = browser.contexts();
    const pages = contexts[0]?.pages() || [];
    const page = pages[pages.length - 1] || pages[0];
    if (!page) return { ok: false, error: 'no page' };

    const cdpSession = await page.context().newCDPSession(page);
    const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
    await cdpSession.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: x, top: y, width: winW, height: winH, windowState: 'normal' },
    });
    return { ok: true, x, y, width: winW, height: winH };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Arrange profile windows by CDP port list.
 * @param {Array<{ profileId: string, cdpPort: number }>} entries
 */
async function arrangeProfilesGrid(entries, screenW = 1920, screenH = 1080) {
  const list = (entries || []).filter((e) => e && e.cdpPort);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const { profileId, cdpPort } = list[i];
    try {
      const r = await arrangeWindowAtPort(cdpPort, i, list.length, screenW, screenH);
      results.push({
        profileId,
        status: r.ok ? 'ok' : 'error',
        action: r.ok ? `arranged at ${r.x},${r.y} (${r.width}x${r.height})` : r.error,
      });
    } catch (err) {
      results.push({ profileId, status: 'error', action: err.message });
    }
  }
  return results;
}

/**
 * Resolve running worker profile IDs + CDP ports from cache.
 */
function resolveRunningFromCache(profileIds) {
  const cache = readCdpCache();
  const ids = profileIds && profileIds.length ? profileIds : Object.keys(cache);
  return ids
    .filter((id) => cache[id])
    .map((id) => ({ profileId: id, cdpPort: parseInt(cache[id], 10) }))
    .filter((e) => Number.isFinite(e.cdpPort) && e.cdpPort > 0);
}

function loadAutoArrangeSetting() {
  try {
    const settingsFile = path.join(__dirname, '..', '..', 'user-settings.json');
    if (!fs.existsSync(settingsFile)) return false;
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return s.multiloginAutoArrangeWindows === true || s.multiloginAutoArrangeWindows === 'true';
  } catch {
    return false;
  }
}

module.exports = {
  arrangeProfilesGrid,
  arrangeWindowAtPort,
  resolveRunningFromCache,
  loadAutoArrangeSetting,
  readCdpCache,
};
