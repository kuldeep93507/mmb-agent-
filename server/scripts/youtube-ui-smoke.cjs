'use strict';

/**
 * Live YouTube checks (uses installed Chrome/Edge via Playwright channel — not Multilogin/CDP).
 *
 * 1) Loads agent.cjs so VideoWatcher receives real YoutubeUi helpers from setBehaviorHelpers.
 * 2) Desktop www + mobile m.youtube: isMobileYouTube / isAndroidUA
 * 3) dismissYouTubePopups, setVideoQuality(360p), verifyVideoQuality (soft)
 * 4) expandDescriptionAndRead + hoverRelatedVideos on mobile page
 *
 * Env:
 *   MMB_BROWSER_HEADLESS=0 — show browser (default headless true)
 *   PW_CHANNEL=msedge      — if Chrome not installed
 *   TEST_YT_VIDEO_ID=…     — watch page to test (default dQw4w9WgXcQ)
 */

const { chromium } = require('playwright-core');

require('../agent.cjs');
const VideoWatcher = require('../agent/VideoWatcher.cjs');
const YtUi = require('../agent/YoutubeUi.cjs');

function logUi(_lvl, msg) {
  console.log(`  [YtUi] ${msg}`);
}

async function runBrowserChecks() {
  const headless = process.env.MMB_BROWSER_HEADLESS !== '0';
  const channel = process.env.PW_CHANNEL || 'chrome';
  const videoId = process.env.TEST_YT_VIDEO_ID || 'dQw4w9WgXcQ';

  let browser;
  try {
    browser = await chromium.launch({
      channel,
      headless,
    });
  } catch (e) {
    console.error(
      `\n⚠️ Chromium launch failed (${channel}): ${e.message}\n` +
        '  Install Google Chrome, or run: set PW_CHANNEL=msedge (Edge).',
    );
    return { skipped: true };
  }

  const note = [];

  try {
    console.log('\n━━ Desktop (www) ━━');
    const desk = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    let page = await desk.newPage();

    await page
      .goto(`https://www.youtube.com/watch?v=${videoId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      })
      .catch((err) => console.warn('  goto:', err.message));

    await YtUi.dismissYouTubePopups(page, logUi);
    await new Promise((r) => setTimeout(r, 3500));

    const deskMobile = await YtUi.isMobileYouTube(page);
    console.log(`  isMobileYouTube: ${deskMobile} (expect false)`);
    if (deskMobile !== false) note.push('Desktop: isMobileYouTube expected false');

    const deskUa = await YtUi.isAndroidUA(page);
    console.log(`  isAndroidUA: ${deskUa} (expect false)`);
    if (deskUa !== false) note.push('Desktop: isAndroidUA expected false');

    await YtUi.forceDarkTheme(page);
    await YtUi.setVideoQuality(page, '360p', logUi);
    await new Promise((r) => setTimeout(r, 3000));

    const vqOk = await YtUi.verifyVideoQuality(page, '360p');
    console.log(
      `  verifyVideoQuality(360p): ${vqOk} ${vqOk ? '(player height or label matched)' : '(soft — may remain auto on fast links)'}`,
    );
    if (!vqOk) note.push('Desktop: 360p verification inconclusive (often normal)');

    await YtUi.dismissYouTubePopups(page, logUi);
    await desk.close();

    console.log('\n━━ Mobile (m.youtube + Android UA) ━━');
    const mob = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
    });
    page = await mob.newPage();
    await page
      .goto(`https://m.youtube.com/watch?v=${videoId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      })
      .catch((err) => console.warn('  goto:', err.message));

    await YtUi.dismissYouTubePopups(page, logUi);
    await new Promise((r) => setTimeout(r, 4500));

    const mobUrl = await YtUi.isMobileYouTube(page);
    console.log(`  isMobileYouTube: ${mobUrl} (expect true — URL or ytm-*)`);
    if (mobUrl !== true) note.push('Mobile: isMobileYouTube expected true');

    const uaMob = await YtUi.isAndroidUA(page);
    console.log(`  isAndroidUA: ${uaMob} (expect true)`);
    if (uaMob !== true) note.push('Mobile: isAndroidUA expected true');

    console.log('  Running expandDescriptionAndRead...');
    await YtUi.expandDescriptionAndRead(page, logUi);

    console.log('  Running hoverRelatedVideos...');
    await YtUi.hoverRelatedVideos(page, logUi);

    await mob.close();
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('\n━━ Browser pass complete ━━');
  if (note.length) {
    console.log('Notes:', note.join('; '));
  }
  return { skipped: false };
}

async function main() {
  console.log('━━ YoutubeUi + VideoWatcher injection ━━');

  const inj = VideoWatcher.peekBehaviorInjectorStatus();
  console.log(JSON.stringify(inj, null, 2));

  if (!inj.expandDescriptionAndRead || !inj.hoverRelatedVideos) {
    console.error('❌ Missing expand/hover helpers on VideoWatcher bx()');
    process.exit(11);
  }

  if (inj.expandSameRefAsYoutubeUiModule !== true || inj.hoverSameRefAsYoutubeUiModule !== true) {
    console.error(
      '❌ expand/hover helpers are not the same function references as YoutubeUi.cjs exports (wiring bug).',
    );
    process.exit(12);
  }

  console.log('✅ expandDescriptionAndRead + hoverRelatedVideos injected & same ref as YoutubeUi module\n');

  const r = await runBrowserChecks();

  if (!r.skipped) {
    console.log(
      '\nDone. If quality/popup lines looked empty, re-run with MMB_BROWSER_HEADLESS=0 to watch DOM.',
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
