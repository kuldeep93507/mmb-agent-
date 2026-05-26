'use strict';

/**
 * Phase 2 full end-to-end smoke: Multilogin CDP + Smartproxy + split modules
 * (HumanBehavior, YoutubeUi, TrafficRouter, VideoWatcher via ProfileAgent).
 *
 * Usage: npm run test:full-bot
 * Env: same as production (.env + optional user-settings.json for proxy)
 * Optional: FULL_BOT_VIDEO_URL, FULL_BOT_SEARCH_TITLE, FULL_BOT_SEARCH_CHANNEL, FULL_BOT_BASELINE_IP
 * Summary table: 17 rows (inc. Ads Skip + Autoplay QA); exit 0 only if all pass.
 */

require('../providers/loadEnv.cjs')();
const path = require('path');
const fs = require('fs');
const https = require('https');

const SETTINGS_FILE = path.resolve(__dirname, '..', '..', 'user-settings.json');

/** Wire TrafficRouter + VideoWatcher + globals like production agent.mjs side effects */
const { ProfileAgent } = require('../agent.cjs');

const YoutubeUi = require('../agent/YoutubeUi.cjs');
const TrafficRouter = require('../agent/TrafficRouter.cjs');
const VideoWatcher = require('../agent/VideoWatcher.cjs');
const HumanBehavior = require('../agent/HumanBehavior.cjs');

const MS = {
  STEP: Number(process.env.FULL_BOT_STEP_TIMEOUT_MS) || 30000,
};

const VIDEO_URL = process.env.FULL_BOT_VIDEO_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const SEARCH_TITLE = process.env.FULL_BOT_SEARCH_TITLE || 'Me at the zoo';
const SEARCH_CHANNEL = process.env.FULL_BOT_SEARCH_CHANNEL || 'jawed';

function hydrateFromEnv() {
  if (process.env.PROXY_PASSWORD) process.env.PROXY_PASSWORD = process.env.PROXY_PASSWORD.trim();
  if (process.env.PROXY_PREFIX) process.env.PROXY_PREFIX = process.env.PROXY_PREFIX.trim();
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (!process.env.PROXY_PASSWORD && s.proxyPassword) process.env.PROXY_PASSWORD = s.proxyPassword;
    if (!process.env.PROXY_PREFIX && s.proxyPrefix) process.env.PROXY_PREFIX = s.proxyPrefix;
    if (s.anthropicApiKey) process.env.ANTHROPIC_API_KEY = s.anthropicApiKey;
  } catch { /* ignore */ }
}

async function wrapTimeout(ms, label, fn) {
  let to;
  const timer = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timer]);
  } finally {
    clearTimeout(to);
  }
}

function fetchBaselineIpViaNodeHttps() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', { timeout: 8000 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          resolve(j.ip || null);
        } catch {
          resolve(buf.trim() || null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

const SUM_W = 34;

/** One content line inside the box (between ║ and ║). */
function sumLine(text) {
  const t = text.replace(/\s+$/,'');
  const c = t.length > SUM_W ? t.slice(0, SUM_W) : t + ' '.repeat(SUM_W - t.length);
  console.log(`║${c}║`);
}

function printSummary(rows) {
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  const bar = '═'.repeat(SUM_W);
  console.log(`\n╔${bar}╗`);
  sumLine('      FULL BOT TEST RESULTS');
  console.log(`╠${bar}╣`);
  for (const r of rows) {
    const emoji = r.ok ? '✅' : '❌';
    if (r.key === 'pip') {
      const raw = r.detail && r.detail !== '-' ? String(r.detail) : 'n/a';
      const ipShow = raw.length > 18 ? `${raw.slice(0, 16)}…` : raw;
      sumLine(`Proxy IP: ${ipShow} ${emoji}`.slice(0, SUM_W).padEnd(SUM_W));
      continue;
    }
    if (r.key === 'ads') {
      sumLine(`Ads Skip: ON (path) ${emoji}`.slice(0, SUM_W).padEnd(SUM_W));
      continue;
    }
    if (r.key === 'autoplay') {
      sumLine(`Autoplay: ON (QA stop) ${emoji}`.slice(0, SUM_W).padEnd(SUM_W));
      continue;
    }
    const lbl = `${r.emojiLabel}`;
    sumLine(`${lbl}${' '.repeat(Math.max(0, SUM_W - lbl.length - 2))}${emoji}`);
  }
  sumLine('                                ');
  sumLine(`TOTAL PASS: ${pass}/${rows.length}`.padEnd(SUM_W));
  sumLine(`TOTAL FAIL: ${fail}/${rows.length}`.padEnd(SUM_W));
  console.log(`╚${bar}╝`);
}

async function main() {
  hydrateFromEnv();

  const rows = [
    { key: 'mlx', label: 'Multilogin Connection', ok: false, detail: '-', emojiLabel: 'Multilogin Connection:' },
    { key: 'proxy', label: 'Proxy Working', ok: false, detail: '-', emojiLabel: 'Proxy Working:' },
    { key: 'pip', label: 'Proxy IP fetched', ok: false, detail: '-', emojiLabel: 'Proxy IP:' },
    { key: 'mouse', label: 'humanMouseMove', ok: false, detail: '-', emojiLabel: 'humanMouseMove:' },
    { key: 'scroll', label: 'smoothScroll', ok: false, detail: '-', emojiLabel: 'smoothScroll:' },
    { key: 'type', label: 'humanType', ok: false, detail: '-', emojiLabel: 'humanType:' },
    { key: 'mobile', label: 'isMobileYouTube', ok: false, detail: '-', emojiLabel: 'isMobileYouTube:' },
    { key: 'pop', label: 'Popup dismiss', ok: false, detail: '-', emojiLabel: 'Popup Dismiss:' },
    { key: 'qual', label: 'Quality 360p', ok: false, detail: '-', emojiLabel: 'Video Quality Set:' },
    { key: 'desc', label: 'Description expand', ok: false, detail: '-', emojiLabel: 'Description Expand:' },
    { key: 'rel', label: 'Related hover', ok: false, detail: '-', emojiLabel: 'Related Hover:' },
    { key: 'searchRt', label: 'Search TrafficRouter', ok: false, detail: '-', emojiLabel: 'Search Traffic Route:' },
    { key: 'directRt', label: 'Direct TrafficRouter', ok: false, detail: '-', emojiLabel: 'Direct Traffic Route:' },
    { key: 'watch', label: 'VideoWatcher watch', ok: false, detail: '-', emojiLabel: 'Video Watch (45s):' },
    { key: 'clean', label: 'Cleanup', ok: false, detail: '-', emojiLabel: 'Cleanup:' },
    { key: 'ads', label: 'Ads Skip', ok: false, detail: '-', emojiLabel: 'Ads Skip (watch path): ' },
    { key: 'autoplay', label: 'Autoplay QA', ok: false, detail: '-', emojiLabel: 'Autoplay control:' },
  ];

  const setRow = (key, ok, detail = '') => {
    const r = rows.find((x) => x.key === key);
    if (r) {
      r.ok = ok;
      r.detail = detail;
    }
  };

  console.log('\n━━━ FULL BOT SMOKE (Multilogin + Smartproxy + split modules) ━━━\n');
  console.log(`Proxy prefix: ${process.env.PROXY_PREFIX ? `${process.env.PROXY_PREFIX.slice(0, 12)}…` : 'MISSING'}`);
  console.log(`Proxy password: ${process.env.PROXY_PASSWORD ? 'SET' : 'MISSING'}`);
  console.log(`Multilogin folder: ${process.env.MULTILOGIN_FOLDER_ID ? 'SET' : 'MISSING'}`);

  if (!process.env.PROXY_PASSWORD || !process.env.PROXY_PREFIX) {
    console.error('\n❌ Smartproxy credentials missing — set .env or user-settings.json');
    setRow('clean', false, 'Skipped — no credentials');
    printSummary(rows);
    process.exit(1);
  }

  if (!process.env.MULTILOGIN_FOLDER_ID) {
    console.error('\n❌ MULTILOGIN_FOLDER_ID missing');
    printSummary(rows);
    process.exit(1);
  }

  try {
    const inj = VideoWatcher.peekBehaviorInjectorStatus();
    console.log(
      `[VideoWatcher] helpers wired via agent.cjs: ${inj.helperKeys.length} slots (${
        inj.expandSameRefAsYoutubeUiModule === true ? 'expand ref OK' : 'expand ref ?'
      })`,
    );
  } catch (e) {
    console.warn(`[VideoWatcher] peek: ${e.message}`);
  }

  /** @type {{ profileId?: string }} */
  let state = {};
  let agent = null;
  let baselineIpNode = await fetchBaselineIpViaNodeHttps();

  try {
    const { ProfileFactory } = require('../profileFactory.cjs');
    const factory = new ProfileFactory({ proxyType: 'smartproxy' });
    const agentName = process.env.FULL_BOT_AGENT_NAME || 'MMB Full Bot Smoke TEST';

    console.log('\n━━ Step 1: Multilogin + CDP (+ proxy IP in browser) ━━');
    let profileData;
    try {
      profileData = await factory.createAndStart(agentName);
      state.profileId = profileData.profileId;
      console.log(`  Profile created/started: ${profileData.profileId} CDP port ${profileData.cdpPort}`);
    } catch (e) {
      console.error(`  [Step1] create/start: ${e.message}`);
      setRow('mlx', false, e.message);
      setRow('proxy', false, 'start failed');
      printSummary(rows);
      process.exit(1);
    }

    agent = new ProfileAgent(state.profileId, agentName, profileData.cdpPort, {
      cdpEndpoint: profileData.cdpEndpoint,
      browserType: 'multilogin',
    });

    let connected = false;
    try {
      connected = await wrapTimeout(120000, 'connectWithRetry', async () => agent.connectWithRetry(12, 4000));
    } catch (e) {
      console.error(`  [CDP] ${e.message}`);
    }
    setRow('mlx', connected, connected ? 'CDP linked' : 'CDP failed');
    if (!connected) {
      setRow('proxy', false, 'no browser');
      try {
        await factory.stopAndDelete(state.profileId);
      } catch { /* ignore */ }
      printSummary(rows);
      process.exit(1);
    }

    const page = agent.context.pages()[0] || (await agent.context.newPage());
    agent._lastPage = page;
    agent.currentVideo = 'Full Bot Smoke';

    let browserIp = '';
    try {
      await wrapTimeout(MS.STEP, 'ipify', async () => {
        await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 25000 });
        const txt = await page.textContent('body');
        const j = JSON.parse(txt);
        browserIp = j.ip || txt;
      });
    } catch (e) {
      console.warn(`  [Proxy IP] ${e.message}`);
    }

    const baselineHint = process.env.FULL_BOT_BASELINE_IP || baselineIpNode || '';
    let proxyOk = !!browserIp;
    if (proxyOk && baselineHint && browserIp === baselineHint) {
      console.warn(`  [Proxy] Browser IP equals baseline (${browserIp}) — may not be exit proxy (or same egress).`);
      proxyOk = false;
    }
    setRow('proxy', proxyOk, proxyOk ? 'IP via browser' : 'IP missing or matches baseline');
    setRow('pip', !!browserIp, browserIp || 'none');

    console.log(`  Node script egress IP (reference only): ${baselineIpNode || 'n/a'}`);
    console.log(`  Browser (Multilogin) IP: ${browserIp || 'FAILED'}`);

    console.log('\n━━ Step 2: HumanBehavior (example.com) ━━');
    try {
      await wrapTimeout(MS.STEP, 'example', async () => {
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 25000 });
      });
    } catch (e) {
      console.warn(`  [example] ${e.message}`);
    }

    try {
      await wrapTimeout(MS.STEP, 'humanMouseMove', async () => {
        await HumanBehavior.humanMouseMove(page);
      });
      setRow('mouse', true, 'ok');
      console.log('  humanMouseMove: ok');
    } catch (e) {
      setRow('mouse', false, e.message);
      console.warn(`  humanMouseMove: ${e.message}`);
    }

    try {
      await wrapTimeout(MS.STEP, 'smoothScroll', async () => {
        await HumanBehavior.smoothScroll(page, 200, 'down', null);
      });
      setRow('scroll', true, 'ok');
      console.log('  smoothScroll: ok');
    } catch (e) {
      setRow('scroll', false, e.message);
      console.warn(`  smoothScroll: ${e.message}`);
    }

    try {
      await wrapTimeout(MS.STEP, 'humanType', async () => {
        await page.click('body', { position: { x: 50, y: 50 } }).catch(() => {});
        await HumanBehavior.humanType(page, 'smoke test', agent.typingSpeed);
      });
      setRow('type', true, 'ok');
      console.log('  humanType: ok');
    } catch (e) {
      setRow('type', false, e.message);
      console.warn(`  humanType: ${e.message}`);
    }

    try {
      await wrapTimeout(15000, 'seekForwardKeyboard', async () => {
        await HumanBehavior.seekForwardKeyboard(page, 5, agent._personality);
      });
      console.log('  seekForwardKeyboard: ok (keys sent; no video on example.com)');
    } catch (e) {
      console.warn(`  seekForwardKeyboard: ${e.message}`);
    }

    console.log('\n━━ Step 3: YoutubeUi ━━');
    try {
      await wrapTimeout(MS.STEP, 'youtube open', async () => {
        await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 28000 });
        await new Promise((r) => setTimeout(r, 4000));
      });
    } catch (e) {
      console.warn(`  [YT open] ${e.message}`);
    }

    try {
      const mob = await wrapTimeout(15000, 'isMobileYouTube', async () => YoutubeUi.isMobileYouTube(page));
      setRow('mobile', true, String(mob));
      console.log(`  isMobileYouTube: ${mob}`);
    } catch (e) {
      setRow('mobile', false, e.message);
      console.warn(`  isMobileYouTube: ${e.message}`);
    }

    let popupLog = '';
    try {
      await wrapTimeout(15000, 'dismissYouTubePopups', async () => {
        await YoutubeUi.dismissYouTubePopups(page, (_l, m) => { popupLog = m; });
      });
      setRow('pop', true, popupLog || 'no match');
      console.log(`  dismissYouTubePopups: ${popupLog || '(nothing clicked)'}`);
    } catch (e) {
      setRow('pop', false, e.message);
      console.warn(`  dismissYouTubePopups: ${e.message}`);
    }

    try {
      let qmsg = '';
      await wrapTimeout(25000, 'setVideoQuality', async () => {
        await YoutubeUi.setVideoQuality(page, '360p', (_lvl, m) => { qmsg = m; });
      });
      const vq = await YoutubeUi.verifyVideoQuality(page, '360p');
      setRow('qual', vq, qmsg || 'set attempted');
      console.log(`  setVideoQuality: ${qmsg} | verifyVideoQuality(360p): ${vq}`);
    } catch (e) {
      setRow('qual', false, e.message);
      console.warn(`  quality: ${e.message}`);
    }

    try {
      await wrapTimeout(25000, 'expandDescriptionAndRead', async () => {
        await YoutubeUi.expandDescriptionAndRead(page, (l, m) => console.log(`    [desc] ${m}`));
      });
      setRow('desc', true, 'ok');
      console.log('  expandDescriptionAndRead: ok');
    } catch (e) {
      setRow('desc', false, e.message);
      console.warn(`  expandDescriptionAndRead: ${e.message}`);
    }

    try {
      await wrapTimeout(20000, 'hoverRelatedVideos', async () => {
        await YoutubeUi.hoverRelatedVideos(page, (l, m) => console.log(`    [rel] ${m}`));
      });
      setRow('rel', true, 'ok');
      console.log('  hoverRelatedVideos: ok');
    } catch (e) {
      setRow('rel', false, e.message);
      console.warn(`  hoverRelatedVideos: ${e.message}`);
    }

    console.log('\n━━ Step 4: TrafficRouter ━━');
    console.log(`  Logs: Youtube opened? → typed query? → results? → clicked watch (trafficType='search').`);
    let searchOpened = false;
    let searchOk = false;
    try {
      await wrapTimeout(Math.max(MS.STEP, 60000), 'openVideoByTraffic(search)', async () => {
        searchOpened = true;
        const ok = await TrafficRouter.openVideoByTraffic(
          page,
          SEARCH_TITLE,
          SEARCH_CHANNEL,
          'search',
          VIDEO_URL,
          null,
        );
        searchOk = !!ok;
        if (!ok) throw new Error('openVideoByTraffic(search) returned false');
      });
      const u = await page.url();
      setRow('searchRt', true, `url: ${u.slice(0, 80)}`);
      console.log(`  openVideoByTraffic('search'): ok | url=${u.slice(0, 140)}`);
    } catch (e) {
      setRow('searchRt', false, e.message);
      console.warn(`  openVideoByTraffic('search'): invoked=${searchOpened} success=${searchOk} err=${e.message}`);
    }

    let directOpened = false;
    try {
      await wrapTimeout(MS.STEP, 'openVideoByTraffic direct', async () => {
        await TrafficRouter.openVideoByTraffic(
          page,
          SEARCH_TITLE,
          SEARCH_CHANNEL,
          'direct',
          VIDEO_URL,
          null,
        );
        directOpened = true;
        const playing = await page.evaluate(() => {
          const v = document.querySelector('video');
          return !!(v && !v.paused);
        }).catch(() => false);
        if (!playing) console.log('  (direct) video paused — attempting play tap');
      });
      setRow('directRt', directOpened && (await page.url()).includes('watch'), (await page.url()));
      console.log(`  openVideoByTraffic(direct): ${(await page.url()).slice(0, 120)}`);
    } catch (e) {
      setRow('directRt', false, e.message);
      console.warn(`  Direct route: ${e.message}`);
    }

    console.log('\n━━ Step 5: Autoplay QA (YoutubeUi.ensureAutoplayOff) ━━');
    try {
      await wrapTimeout(25000, 'ensureAutoplayOff', async () => {
        await YoutubeUi.ensureAutoplayOff(page, (level, msg) => console.log(`  [QA autoplay] ${msg}`));
      });
      const off = await YoutubeUi.verifyAutoplayOff(page).catch(() => false);
      setRow('autoplay', !!off, off ? 'autoplay suppressed' : 'unverified UI');
      console.log(`  verifyAutoplayOff: ${off}`);
    } catch (e) {
      setRow('autoplay', false, e.message);
      console.warn(`  Autoplay QA: ${e.message}`);
    }

    console.log('\n━━ Step 6: VideoWatcher.watchVideo (≈45s, adSkip ON) ━━');
    agent._qaScrolledEarly = false;
    agent._descriptionOpened = false;
    agent._relatedHovered = false;
    agent._seekForwardCount = 0;
    try {
      await wrapTimeout(240000, 'watchVideo', async () => agent.watchVideo(page, 45000, {
        qaTestMode: true,
        adSkipEnabled: true,
        humanEngagementEnabled: true,
        likeEnabled: false,
        subscribeEnabled: false,
        commentEnabled: false,
        scrollDuringWatch: true,
        seekForwardMax: 1,
      }));
      setRow('watch', true, 'completed without throw');
      console.log('  watchVideo: finished interval');
    } catch (e) {
      setRow('watch', false, e.message);
      console.warn(`  watchVideo: ${e.message}`);
    }

    const watchPass = rows.find((x) => x.key === 'watch')?.ok;
    const adErr = agent.logs.some((e) => /[Aa]d handling error/i.test(e.message));
    setRow('ads', !!watchPass && !adErr, adErr ? 'ad handler error' : 'adSkipEnabled + watch ok');

    console.log('\n━━ Step 7: Cleanup ━━');
    try {
      await agent.disconnect().catch(() => {});
      await factory.stopAndDelete(state.profileId).catch(() => {});
      state.profileId = null;
      setRow('clean', true, 'disconnect + stop/delete');
      console.log('  Cleanup: ok');
    } catch (e) {
      setRow('clean', false, e.message);
      console.warn(`  Cleanup: ${e.message}`);
    }
  } catch (err) {
    console.error('\n❌ Fatal:', err.message);
    let cleanupOk = false;
    let cleanupErrMsg = '';
    try {
      if (agent) await agent.disconnect().catch(() => {});
      const { ProfileFactory } = require('../profileFactory.cjs');
      const fx = new ProfileFactory({ proxyType: 'smartproxy' });
      if (state.profileId) await fx.stopAndDelete(state.profileId).catch(() => {});
      state.profileId = null;
      cleanupOk = true;
    } catch (ce) {
      cleanupErrMsg = ce.message;
      console.warn('[Cleanup-after-fatal]', cleanupErrMsg);
    }
    setRow('clean', cleanupOk, cleanupOk ? 'after fatal' : cleanupErrMsg);
  }

  printSummary(rows);

  const pass = rows.filter((r) => r.ok).length;
  process.exit(pass === rows.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
