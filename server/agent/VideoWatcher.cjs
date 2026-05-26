/**
 * Video watching: duration discovery, ads, timed watch loop (+ mixed-in ProfileAgent methods).
 * Scroll/keyboard/mouse + description + related hover: HumanBehavior / YoutubeUi (agent.cjs → setBehaviorHelpers).
 * Traffic source routing (youtube UI search helpers) lives in TrafficRouter.cjs — separate from watcher.
 */

const { planWatchAction } = require('../agentBrain.cjs');

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAdConfig(config = {}) {
  const num = (value, fallback, min = 0, max = 7200) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  const adSkipAfterSec = num(config.adSkipAfterSec, 5, 0, 120);
  return {
    adSkipEnabled: config.adSkipEnabled !== false,
    adSkipAfterSec,
    midRollAdWaitSec: num(config.midRollAdWaitSec, adSkipAfterSec, 0, 120),
    maxAdsTimeoutSec: num(config.maxAdsTimeoutSec, 300, 60, 7200),
  };
}

async function clickPlayControl(page, isMobile, sl = sleep, rd = randomDelay) {
  if (isMobile) {
    const videoEl = await page.$('video').catch(() => null);
    if (videoEl) { await videoEl.click().catch(() => {}); await sl(rd(700, 1400)); return true; }
    const player = await page.$('.player-container, #player, ytm-player').catch(() => null);
    if (player) { await player.click().catch(() => {}); await sl(rd(700, 1400)); return true; }
    return false;
  }
  const replayBtn = await page.$('.ytp-play-button[aria-label*="Replay" i], .ytp-play-button[title*="Replay" i]').catch(() => null);
  if (replayBtn) return false;
  const playBtn = await page.$('.ytp-large-play-button, .ytp-play-button[aria-label*="Play" i], .ytp-play-button[title*="Play" i], .ytp-play-button').catch(() => null);
  if (playBtn) { await playBtn.click().catch(() => {}); await sl(rd(700, 1400)); return true; }
  const videoEl = await page.$('video').catch(() => null);
  if (videoEl) {
    const box = await videoEl.boundingBox().catch(() => null);
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    else await videoEl.click().catch(() => {});
    await sl(rd(700, 1400));
    return true;
  }
  const player = await page.$('#movie_player, .html5-video-player, #player').catch(() => null);
  if (player) { await player.click().catch(() => {}); await sl(rd(700, 1400)); return true; }
  return false;
}

async function verifyPlaybackStarted(page, { isMobile = false, timeoutMs = 10000, sl = sleep, rd = randomDelay, log = () => {} } = {}) {
  const start = Date.now();
  let first = await getVideoPlaybackState(page);
  if (!first.ok) return { ok: false, reason: 'no_video_element' };
  if (first.ended || first.nearEnd) return { ok: true, reason: 'already_at_end' };
  let lastTime = Number(first.currentTime || 0);
  let clicked = false;
  if (first.paused) clicked = await clickPlayControl(page, isMobile, sl, rd);

  while (Date.now() - start < timeoutMs) {
    const adInfo = await detectYouTubeAd(page);
    if (adInfo.hasAd) return { ok: true, reason: 'ad_playing' };
    const state = await getVideoPlaybackState(page);
    if (!state.ok) { await sl(500); continue; }
    if (state.ended || state.nearEnd) return { ok: true, reason: 'ended' };
    const cur = Number(state.currentTime || 0);
    if (!state.paused && cur > lastTime + 0.2) return { ok: true, reason: 'currentTime_advancing', currentTime: cur };
    if (state.paused && Date.now() - start > 2500) clicked = await clickPlayControl(page, isMobile, sl, rd) || clicked;
    lastTime = Math.max(lastTime, cur);
    await sl(700);
  }
  const finalState = await getVideoPlaybackState(page);
  log('warn', `[watchVideo] Playback did not start: paused=${finalState.paused}, currentTime=${Math.round(finalState.currentTime || 0)}s, readyState=${finalState.readyState ?? 'n/a'}`);
  return { ok: false, reason: finalState.ok ? 'not_advancing' : 'no_video_element', state: finalState, clicked };
}


/** Populated by agent.cjs via setBehaviorHelpers before ProfileAgent instances run watch flows. */
let behavior = {};

function setBehaviorHelpers(d) {
  behavior = d;
}

function bx() {
  return behavior;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AD DETECTION — strict (avoids false 5min "ad wait" + replay)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function detectYouTubeAd(page) {
  return page.evaluate(() => {
    const isMobile = location.hostname === 'm.youtube.com';
    const video = document.querySelector('video');

    if (isMobile) {
      // ── Mobile YouTube (m.youtube.com) ad detection ──
      const mobileSkipSel = 'ytm-skip-ad-renderer button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern, button[aria-label*="Skip" i]';
      const skipBtn = document.querySelector(mobileSkipSel);
      const skipVisible = !!(skipBtn && skipBtn.offsetParent !== null && window.getComputedStyle(skipBtn).display !== 'none');

      const player = document.querySelector('.player-container, .html5-video-player, ytm-player');
      const adShowingOnPlayer = player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting');

      if (!adShowingOnPlayer && video && video.currentTime > 5 && video.duration > 0) {
        return { hasAd: false, skipVisible: false };
      }
      if (adShowingOnPlayer) return { hasAd: true, skipVisible };

      const mobileAdOverlay = document.querySelector('ytm-skip-ad-renderer, .ytm-ad-action-interstitial-overlay, ytm-companion-ad-renderer, .ytm-ad-progress-overlay-renderer');
      if (mobileAdOverlay) return { hasAd: true, skipVisible };

      if (skipVisible && (!video || video.currentTime <= 2)) return { hasAd: true, skipVisible: true };

      return { hasAd: false, skipVisible: false };
    }

    // ── Desktop YouTube ad detection (unchanged) ──
    const skipSelectors = '.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button, button[aria-label*="Skip" i], .ytp-ad-skip-button-slot button';
    const skipBtn = document.querySelector(skipSelectors);
    const skipVisible = !!(skipBtn && skipBtn.offsetParent !== null
      && window.getComputedStyle(skipBtn).display !== 'none');

    const player = document.querySelector('#movie_player, .html5-video-player');

    // ── PRIORITY 1: Main video already playing properly ──────────────────────
    const adShowingOnPlayer = player?.classList.contains('ad-showing')
      || player?.classList.contains('ad-interrupting');
    if (!adShowingOnPlayer && video && video.currentTime > 5 && video.duration > 0) {
      return { hasAd: false, skipVisible: false };
    }

    // ── PRIORITY 2: Player explicitly in ad-showing state ────────────────────
    if (adShowingOnPlayer) {
      return { hasAd: true, skipVisible };
    }

    // ── PRIORITY 3: Ad overlay visible ───────────────────────────────────────
    const overlay = document.querySelector('.ytp-ad-player-overlay');
    if (overlay) {
      const rect = overlay.getBoundingClientRect();
      if (rect.width > 40 && rect.height > 40) {
        return { hasAd: true, skipVisible };
      }
    }

    // ── PRIORITY 4: Skip button visible (only if video hasn't started yet) ───
    if (skipVisible && (!video || video.currentTime <= 2)) {
      return { hasAd: true, skipVisible: true };
    }

    // ── PRIORITY 5: Ad text element present on short-duration video ──────────
    const adText = document.querySelector('.ytp-ad-text, .ytp-ad-preview-text');
    if (adText && video && video.duration > 0 && video.duration <= 70) {
      return { hasAd: true, skipVisible };
    }

    return { hasAd: false, skipVisible: false };
  }).catch(() => ({ hasAd: false, skipVisible: false }));
}

/** In-page ad skipper (page context click + seek/speedup for unskippable ads). */
async function ensureYouTubeAdSkipper(page, config = {}) {
  const adCfg = normalizeAdConfig(config);
  const enabled = adCfg.adSkipEnabled;
  const minWaitSec = adCfg.adSkipAfterSec;
  await page.evaluate(({ enabled, minWaitSec }) => {
    if (window.__mmbAdSkipperInstalled) return;
    window.__mmbAdSkipperInstalled = true;
    window.__mmbAdSkipStart = null;

    const isMobile = location.hostname === 'm.youtube.com';

    const isAdPlaying = () => {
      const player = document.querySelector(
        isMobile ? '.player-container, .html5-video-player, ytm-player' : '#movie_player, .html5-video-player',
      );
      if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) return true;
      if (isMobile) {
        return !!document.querySelector('ytm-skip-ad-renderer, .ytm-ad-action-interstitial-overlay, ytm-companion-ad-renderer, .ytp-skip-ad-button, button[aria-label*="Skip" i]');
      }
      return !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-preview-text, .ytp-skip-ad-button, .ytp-ad-skip-button');
    };

    const trySkip = () => {
      if (!enabled) return { action: 'disabled' };
      if (!isAdPlaying()) {
        window.__mmbAdSkipStart = null;
        return { action: 'none' };
      }
      if (!window.__mmbAdSkipStart) window.__mmbAdSkipStart = Date.now();
      const elapsedSec = (Date.now() - window.__mmbAdSkipStart) / 1000;
      if (elapsedSec < minWaitSec) return { action: 'waiting', elapsedSec };

      const selectors = isMobile ? [
        'ytm-skip-ad-renderer button',
        '.ytp-skip-ad-button',
        '.ytp-ad-skip-button-modern',
        'button[aria-label*="Skip ad" i]',
        'button[aria-label*="Skip" i]',
      ] : [
        '.ytp-skip-ad-button',
        '.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button',
        'button.ytp-ad-skip-button',
        'button[aria-label*="Skip ad" i]',
        'button[aria-label*="Skip" i]',
        '.ytp-ad-skip-button-slot button',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (!btn || btn.offsetParent === null) continue;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        btn.click();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return { action: 'clicked', selector: sel };
      }

      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (video && video.duration > 0 && isFinite(video.duration) && video.duration <= 180) {
        try {
          video.currentTime = Math.max(0, video.duration - 0.05);
          return { action: 'seeked' };
        } catch { /* ignore */ }
      }
      if (video && video.playbackRate < 8) {
        try { video.playbackRate = 16; return { action: 'speedup' }; } catch { /* ignore */ }
      }
      return { action: 'pending' };
    };

    if (window.__mmbAdSkipInterval) clearInterval(window.__mmbAdSkipInterval);
    window.__mmbAdSkipInterval = null;

    window.__mmbTrySkipAd = trySkip;
    window.__mmbAdSkipInterval = setInterval(trySkip, 400);

    // FIX Bug 3: On YouTube SPA navigation (new video/page), reset flag so skipper
    // reinstalls fresh — avoids stale interval after pushState navigation
    document.addEventListener('yt-navigate-finish', () => {
      window.__mmbAdSkipStart = null;
      // Allow re-installation on next ensureYouTubeAdSkipper call
      window.__mmbAdSkipperInstalled = false;
      // Restart interval immediately for the new page
      if (window.__mmbAdSkipInterval) clearInterval(window.__mmbAdSkipInterval);
      window.__mmbAdSkipInterval = setInterval(trySkip, 400);
      trySkip();
    }, true);
  }, { enabled, minWaitSec }).catch(() => {});
}

async function attemptSkipYouTubeAd(page, config = {}) {
  const adCfg = normalizeAdConfig(config);
  const adSkipEnabled = adCfg.adSkipEnabled;
  const adSkipAfterSec = adCfg.adSkipAfterSec;
  if (!adSkipEnabled) return { skipped: false, reason: 'disabled' };

  await ensureYouTubeAdSkipper(page, config);

  const result = await page.evaluate(({ adSkipAfterSec }) => {
    const isAdPlaying = () => {
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) return true;
      return !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-preview-text, .ytp-skip-ad-button, .ytp-ad-skip-button');
    };
    if (!isAdPlaying()) return { skipped: false, reason: 'no_ad' };

    if (typeof window.__mmbTrySkipAd === 'function') {
      const r = window.__mmbTrySkipAd();
      if (r?.action === 'clicked' || r?.action === 'seeked') return { skipped: true, method: r.action };
      if (r?.action === 'waiting') return { skipped: false, reason: 'waiting', waitSec: adSkipAfterSec };
    }

    const selectors = [
      '.ytp-skip-ad-button', '.ytp-ad-skip-button-modern', '.ytp-ad-skip-button',
      'button[aria-label*="Skip" i]', '.ytp-ad-skip-button-slot button',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return { skipped: true, method: 'click', selector: sel };
      }
    }
    const video = document.querySelector('video');
    if (video && video.duration > 0 && isFinite(video.duration) && video.duration <= 180) {
      video.currentTime = Math.max(0, video.duration - 0.05);
      return { skipped: true, method: 'seek' };
    }
    return { skipped: false, reason: 'no_button' };
  }, { adSkipAfterSec }).catch(() => ({ skipped: false, reason: 'error' }));

  return result;
}

async function waitForAdsToClear(page, config = {}, logFn = () => {}, maxWaitSec = 300) {
  const adCfg = normalizeAdConfig(config);
  const adSkipEnabled = adCfg.adSkipEnabled;
  const adSkipAfterSec = adCfg.adSkipAfterSec;
  await ensureYouTubeAdSkipper(page, { ...config, ...adCfg });

  let adSeen = false;
  let skippedCount = 0;
  let adFirstSeen = 0; // track when THIS ad first appeared
  const start = Date.now();

  while ((Date.now() - start) / 1000 < maxWaitSec) {
    const adInfo = await detectYouTubeAd(page);
    if (!adInfo.hasAd) {
      if (adSeen) logFn('info', `Ads cleared after ${Math.round((Date.now() - start) / 1000)}s`);
      break;
    }

    // Record when this ad first appeared
    if (!adSeen || adFirstSeen === 0) adFirstSeen = Date.now();
    adSeen = true;

    // Time since THIS ad started (not since function start)
    const adElapsed = (Date.now() - adFirstSeen) / 1000;

    if (adSkipEnabled && adInfo.skipVisible) {
      // Wait adSkipAfterSec from when the ad appeared, then skip
      if (adElapsed >= adSkipAfterSec) {
        const attempt = await attemptSkipYouTubeAd(page, config);
        if (attempt.skipped) {
          skippedCount++;
          logFn('info', `⏭ Ad skipped (${attempt.method || 'auto'}) after ${Math.round(adElapsed)}s`);
          await sleep(randomDelay(600, 1200));
          adFirstSeen = 0; // reset for next ad
          const after = await detectYouTubeAd(page);
          if (!after.hasAd) break;
          adFirstSeen = Date.now(); // next ad started
        }
      }
    } else if (adSkipEnabled && adElapsed >= adSkipAfterSec) {
      // Unskippable ad — wait configured delay before attempting any configured ad action
      const attempt = await attemptSkipYouTubeAd(page, config);
      if (attempt.skipped) {
        skippedCount++;
        logFn('info', `⏭ Ad bypassed (${attempt.method || 'seek/speed'}) after ${Math.round(adElapsed)}s`);
        await sleep(randomDelay(600, 1200));
        adFirstSeen = 0;
        const after = await detectYouTubeAd(page);
        if (!after.hasAd) break;
        adFirstSeen = Date.now();
      }
    }

    await sleep(450);
  }

  return { adSeen, skippedCount, waitedMs: Date.now() - start };
}

async function getVideoPlaybackState(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return { ok: false };
    const dur = v.duration || 0;
    const cur = v.currentTime || 0;
    return {
      ok: true,
      paused: v.paused,
      ended: v.ended,
      nearEnd: dur > 0 && cur >= Math.max(0, dur - 3),
      currentTime: cur,
      duration: dur,
      readyState: v.readyState || 0,
    };
  }).catch(() => ({ ok: false }));
}

const videoWatcherPrototype = {
  async getVideoDuration(page, config = {}) {
    const adCfg = normalizeAdConfig(config);
    const adSkipEnabled = adCfg.adSkipEnabled;
    const adSkipAfterSec = adCfg.adSkipAfterSec;
    this.log('info', `Waiting for ads to finish (adSkip: ${adSkipEnabled ? 'ON' : 'OFF'}, wait ${adSkipAfterSec}s before skip)...`);
    await waitForAdsToClear(page, { ...config, ...adCfg }, (l, m) => this.log(l, m), adCfg.maxAdsTimeoutSec);

    await sleep(2000);

    for (let i = 0; i < 20; i++) {
      try {
        const duration = await page.evaluate(() => {
          const adOverlay = document.querySelector('.ytp-ad-player-overlay, .ad-showing, [class*="ad-showing"]');
          if (adOverlay) return 0;

          const video = document.querySelector('video');
          if (video && video.duration && isFinite(video.duration) && video.duration > 10) {
            return Math.round(video.duration * 1000);
          }

          const el = document.querySelector('.ytp-time-duration');
          if (el && el.textContent && !el.textContent.includes('Ad')) {
            const parts = el.textContent.trim().split(':').map(Number);
            if (parts.length === 3 && parts.every(p => !isNaN(p))) {
              return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
            }
            if (parts.length === 2 && parts.every(p => !isNaN(p)) && parts[0] >= 0) {
              return (parts[0] * 60 + parts[1]) * 1000;
            }
          }

          const metaDuration = document.querySelector('ytd-watch-metadata span.ytd-badge-and-author-renderer');
          if (metaDuration?.textContent) {
            const parts = metaDuration.textContent.trim().split(':').map(Number);
            if (parts.length === 2 && parts.every(p => !isNaN(p))) {
              return (parts[0] * 60 + parts[1]) * 1000;
            }
          }

          return 0;
        });

        if (duration > 10000) {
          this.log('info', `Real video duration: ${Math.round(duration / 1000)}s`);
          return duration;
        }
      } catch {}
      await sleep(500);
    }

    this.log('warn', 'Could not read duration — using 5min default');
    return 300000;
  },

  async handleAds(page, config = {}) {
    const { sleep: sl, randomDelay: rd, trackEngagement } = bx();
    const adCfg = normalizeAdConfig(config);
    const adSkipEnabled = adCfg.adSkipEnabled;
    const adSkipAfterSec = adCfg.adSkipAfterSec;
    let totalAdTime = 0;
    let adsCount = 0;
    let adsSkipped = 0;

    const maxPasses = Number.isFinite(config.maxAdsTimeoutSec)
      ? Math.max(20, Math.min(200, Math.round(Number(adCfg.maxAdsTimeoutSec) / 18)))
      : Math.max(20, Math.min(200, Math.round(adCfg.maxAdsTimeoutSec / 18)));

    for (let attempt = 0; attempt < maxPasses; attempt++) {      try {
        const adInfo = await detectYouTubeAd(page).then((r) => ({
          hasAd: r.hasAd,
          adDurationSec: 0,
          hasSkipBtn: r.skipVisible,
          countdownText: '',
        }));
        if (adInfo.hasAd) {
          const fullAdInfo = await page.evaluate(() => {
            const video = document.querySelector('video');
            const adDurationSec = (video && video.duration && isFinite(video.duration))
              ? Math.round(video.duration)
              : 0;
            return { adDurationSec };
          }).catch(() => ({ adDurationSec: 0 }));
          adInfo.adDurationSec = fullAdInfo.adDurationSec;
        }

        if (!adInfo.hasAd) break;

        adsCount++;
        const adStartTime = Date.now();
        this.log('info', `📺 Ad #${adsCount} detected — duration: ${adInfo.adDurationSec}s, skippable: ${adInfo.hasSkipBtn}`);

        if (!adSkipEnabled) {
          const waitMs = adInfo.adDurationSec > 0
            ? (adInfo.adDurationSec * 1000 + 2000)
            : 60000;
          this.log('info', `Ad Skip OFF — watching full ad (${Math.round(waitMs / 1000)}s)`);
          await this._waitForAdToFinish(page, waitMs);
          totalAdTime += Date.now() - adStartTime;
          continue;
        }

        await ensureYouTubeAdSkipper(page, { ...config, ...adCfg });
        const skipDeadline = Date.now() + (adSkipAfterSec * 1000) + rd(300, 1000);
        while (Date.now() < skipDeadline) await sl(400);

        let skipped = false;
        for (let poll = 0; poll < 40; poll++) {
          // FIX Bug 4: renamed inner variable to avoid shadowing outer 'attempt' loop counter
          const skipResult = await attemptSkipYouTubeAd(page, { ...config, ...adCfg });
          if (skipResult.skipped) {
            skipped = true;
            break;
          }
          const stillAd = await detectYouTubeAd(page);
          if (!stillAd.hasAd) break;
          await sl(450);
        }

        if (skipped) {
          adsSkipped++;
          this.log('info', `✓ Ad skipped after ${adSkipAfterSec}s`);
          totalAdTime += Date.now() - adStartTime;
          await sl(rd(1000, 2000));
          continue;
        }

        const seekAttempt = await attemptSkipYouTubeAd(page, { ...config, ...adCfg });
        if (seekAttempt.skipped && (seekAttempt.method === 'seek' || seekAttempt.method === 'speedup')) {
          adsSkipped++;
          this.log('info', `✓ Unskippable ad bypassed via ${seekAttempt.method}`);
          totalAdTime += Date.now() - adStartTime;
          await sl(rd(1000, 2000));
          continue;
        }
        this.log('info', `Unskippable ad — waiting for it to finish naturally (${adInfo.adDurationSec}s)`);
        const unskippableWait = adInfo.adDurationSec > 0
          ? (adInfo.adDurationSec * 1000 + 3000)
          : 120000;
        await this._waitForAdToFinish(page, unskippableWait);
        totalAdTime += Date.now() - adStartTime;
      } catch (err) {
        this.log('warn', `Ad handling error: ${err.message}`);
        break;
      }
    }

    if (adsCount > 0) {
      this.log('info', `Ads done — total: ${adsCount}, skipped: ${adsSkipped}, time: ${Math.round(totalAdTime / 1000)}s`);
      await trackEngagement(this.profileId, 'ads_total', adsCount).catch(() => {});
      await trackEngagement(this.profileId, 'ads_skipped', adsSkipped).catch(() => {});
      await trackEngagement(this.profileId, 'ads_watched_full', adsCount - adsSkipped).catch(() => {});
      await trackEngagement(this.profileId, 'ad_watch_time', Math.round(totalAdTime / 1000)).catch(() => {});
    }

    return { totalAdTime, adsCount, adsSkipped };
  },

  async _waitForAdToFinish(page, maxWaitMs) {
    const { sleep: sl } = bx();
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      await sl(1000);
      try {
        const stillHasAd = await page.evaluate(() => {
          return !!(
            document.querySelector('.ytp-ad-player-overlay')
            || document.querySelector('.ad-showing')
            || document.querySelector('.ytp-ad-text')
          );
        });
        if (!stillHasAd) {
          this.log('info', `Ad finished after ${Math.round((Date.now() - startTime) / 1000)}s`);
          return;
        }
      } catch { break; }
    }
  },

  async watchVideo(page, durationMs, config = {}) {
    const {
      sleep: sl,
      randomDelay: rd,
      smoothScroll,
      humanMouseMove,
      expandDescriptionAndRead,
      clickBellIcon,
      hoverRelatedVideos,
      humanType,
      seekForwardKeyboard,
      isMobileYouTube,
      trackEngagement,
    } = bx();

    // Detect mobile/Android once at the start of watchVideo
    const isMobile = typeof isMobileYouTube === 'function'
      ? await isMobileYouTube(page).catch(() => false)
      : false;

    const adCfg = normalizeAdConfig(config);
    await this.handleAds(page, { ...config, ...adCfg });

    if (durationMs <= 0) {
      this.log('info', '✅ Watch target already met — skipping timer (prevents replay)');
      return;
    }

    const playback = await verifyPlaybackStarted(page, {
      isMobile,
      timeoutMs: Number(config.playStartTimeoutMs) || 10000,
      sl,
      rd,
      log: (level, message) => this.log(level, message),
    });
    if (!playback.ok) {
      throw new Error(`Video playback did not start (${playback.reason})`);
    }
    this.log('info', `[watchVideo] Playback verified (${playback.reason}) — starting watch timer`);

    const startTime = Date.now();
    let totalAdTime = 0;
    let adPlaying = false;
    let adStartTime = 0;
    let totalPausedTime = 0;
    let pausedStartTime = 0;
    let lastVideoTime = 0;
    let lastProgressAt = Date.now();
    let stallRecoveries = 0;
    let partialHistoryMarked = false;
    const partialHistoryThreshold = Math.max(0.25, Math.min(0.9, Number(config.partialWatchHistoryPercent ?? 35) / 100));

    const markPaused = (state) => {
      if (!state?.ok || state.ended || state.nearEnd || adPlaying) return;
      if (state.paused) {
        if (!pausedStartTime) {
          pausedStartTime = Date.now();
          this.log('info', '⏸ Video paused — watch timer paused');
        }
      } else if (pausedStartTime) {
        const pausedFor = Date.now() - pausedStartTime;
        totalPausedTime += pausedFor;
        this.log('info', `▶ Video resumed — excluded ${Math.round(pausedFor / 1000)}s paused time`);
        pausedStartTime = 0;
      }
    };

    const adsCapSec = Number.isFinite(config.maxAdsTimeoutSec)
      ? Math.min(7200, Math.max(60, Number(adCfg.maxAdsTimeoutSec)))
      : adCfg.maxAdsTimeoutSec;
    /** Wall-clock failsafe — long mid-roll bursts cannot stall automation forever */

    const absoluteDeadline = Date.now() + durationMs + adsCapSec * 1000 + 45000;


    let playCheckCancelled = false;
    const playCheckTimers = new Set();
    const schedulePlayCheck = () => {
      if (playCheckCancelled) return;
      const nextDelay = rd(4000, 7000);
      const tid = setTimeout(async () => {
        playCheckTimers.delete(tid);
        if (playCheckCancelled) return;
        try {
          const adInfo = await detectYouTubeAd(page);
          const hasAd = adInfo.hasAd;

          if (hasAd) {
            if (!adPlaying) {
              adPlaying = true;
              adStartTime = Date.now();
              this.log('info', '📺 Mid-roll ad shuru — timer paused');
              this.adPlaying = true;
              this.adCount = (this.adCount || 0) + 1;
            }

            if (config?.adSkipEnabled !== false) {
              const midWait = adCfg.midRollAdWaitSec;
              const baseDelay = midWait * 1000;
              const jitter = rd(-1500, 2500);
              await sl(Math.max(2000, baseDelay + jitter));
              const attempt = await attemptSkipYouTubeAd(page, { ...config, ...adCfg });
              if (attempt.skipped) {
                this.log('info', `⏭ Mid-roll ad skipped after ${midWait}s (${attempt.method || 'auto'})`);
              }
            }

            await trackEngagement(this.profileId, 'ads_total', 1).catch(() => {});
            if (!playCheckCancelled) schedulePlayCheck();
            return;
          }

          if (adPlaying) {
            const adDuration = Date.now() - adStartTime;
            totalAdTime += adDuration;
            adPlaying = false;
            this.adPlaying = false;
            this.log('info', `📺 Ad khatam — ${Math.round(adDuration / 1000)}s tha. Total ad time: ${Math.round(totalAdTime / 1000)}s. Timer resume.`);
          }

          const vState = await getVideoPlaybackState(page);
          markPaused(vState);

          if (vState.ok && (vState.ended || vState.nearEnd)) {
            this.log('info', 'Video end detected — not clicking replay');
            playCheckCancelled = true;
            return;
          }

          if (vState.ok && vState.paused) {
            try {
              if (isMobile) {
                // Mobile: tap video element to resume; ended check already passed above
                const videoEl = await page.$('video').catch(() => null);
                if (videoEl) await videoEl.click().catch(() => {});
              } else {
                const replayBtn = await page.$('.ytp-play-button[aria-label*="Replay" i], .ytp-play-button[title*="Replay" i]').catch(() => null);
                if (replayBtn) {
                  this.log('info', 'Replay button visible — watch done, not restarting');
                  playCheckCancelled = true;
                  return;
                }
                const playBtn = await page.$('.ytp-play-button[aria-label*="Play"], .ytp-play-button[title*="Play"]').catch(() => null);
                if (playBtn) {
                  await playBtn.click();
                } else {
                  const player = await page.$('#movie_player, .html5-video-player').catch(() => null);
                  if (player) await player.click().catch(() => {});
                }
              }
              this.log('info', 'Video paused tha — resume kiya');
            } catch (playErr) {
              this.log('warn', `[watchVideo] resume UI: ${playErr.message}`);
            }
          }
        } catch (loopErr) {
          this.log('warn', `[watchVideo] play-check: ${loopErr.message}`);
        }
        if (!playCheckCancelled) schedulePlayCheck();
      }, nextDelay);
      playCheckTimers.add(tid);
    };
    schedulePlayCheck();

    try {
      const pers = this._personality;
      const commentScrollChance = pers?.commentScrollChance ?? 0.4;
      const relatedPeekChance = pers?.relatedPeekChance ?? 0.2;
      const mouseMoveChance = pers?.mouseMoveChance ?? 0.3;
      const scrollAmount = pers ? pers.pickInt(180, 520) : rd(200, 500);
      const pauseDuration = pers ? pers.pickInt(1000, 4000) : rd(1000, 4000);

      const phase1End = pers?.phase1End ?? 0.08;
      const phase2End = pers?.phase2End ?? 0.22;
      const phase3End = pers?.phase3End ?? 0.48;
      const phase4End = pers?.phase4End ?? 0.68;
      const phase5End = pers?.phase5End ?? 0.85;

      while (true) {
        if (Date.now() > absoluteDeadline) {
          const elapsedSec = Math.round((Date.now() - startTime) / 1000);
          const capSec = Math.round((absoluteDeadline - startTime) / 1000);
          this.log('warn', `[watchVideo] Stopping — exceeded safe wall-clock limit (elapsed ${elapsedSec}s ≥ cap ~${capSec}s)`);
          break;
        }

        if (adPlaying) {
          await sl(1000);
          continue;
        }

        const vState = await getVideoPlaybackState(page);
        markPaused(vState);

        if (vState.ok && (vState.ended || vState.nearEnd)) {
          this.log('info', '✅ Video reached end — watch complete (no replay)');
          break;
        }

        if (vState.ok && !vState.paused && !adPlaying) {
          const cur = Number(vState.currentTime || 0);
          if (cur > lastVideoTime + 0.25) {
            lastVideoTime = cur;
            lastProgressAt = Date.now();
            stallRecoveries = 0;
          } else if (Date.now() - lastProgressAt > 30000) {
            stallRecoveries += 1;
            if (stallRecoveries === 1) {
              this.log('warn', '[watchVideo] Playback stalled ~30s — bringToFront + resume attempt');
              await page.bringToFront().catch(() => {});
              await clickPlayControl(page, isMobile, sl, rd);
              lastProgressAt = Date.now();
              await sl(1200);
              continue;
            }
            if (stallRecoveries === 2) {
              this.log('warn', '[watchVideo] Playback still stalled — one safe page reload');
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
              await sl(rd(2000, 3500));
              const restart = await verifyPlaybackStarted(page, {
                isMobile,
                timeoutMs: 10000,
                sl,
                rd,
                log: (level, message) => this.log(level, message),
              });
              if (!restart.ok) throw new Error(`Playback stalled and reload did not recover (${restart.reason})`);
              const afterReload = await getVideoPlaybackState(page);
              lastVideoTime = Number(afterReload.currentTime || 0);
              lastProgressAt = Date.now();
              await sl(1200);
              continue;
            }
            throw new Error('Playback stalled for too long after recovery attempts');
          }
        }

        if (vState.ok && vState.paused && !adPlaying) {
          await clickPlayControl(page, isMobile, sl, rd);
          await sl(1000);
          continue;
        }

        const totalElapsed = Date.now() - startTime;
        const activeAdElapsed = adPlaying ? (Date.now() - adStartTime) : 0;
        const activePausedElapsed = pausedStartTime ? (Date.now() - pausedStartTime) : 0;
        const actualWatched = Math.max(0, totalElapsed - totalAdTime - activeAdElapsed - totalPausedTime - activePausedElapsed);
        const remaining = durationMs - actualWatched;

        if (remaining <= 0) {
          this.log('info', `✅ Video complete! Watched: ${Math.round(actualWatched / 1000)}s | Ad time: ${Math.round((totalAdTime + activeAdElapsed) / 1000)}s | Paused excluded: ${Math.round((totalPausedTime + activePausedElapsed) / 1000)}s | Total elapsed: ${Math.round(totalElapsed / 1000)}s`);
          break;
        }

        const progress = actualWatched / durationMs;
        if (!partialHistoryMarked && progress >= partialHistoryThreshold && typeof this.trackWatchHistory === 'function') {
          partialHistoryMarked = true;
          const pct = Math.round(progress * 100);
          await this.trackWatchHistory(this.currentVideo || config.expectedTitle || 'partial-watch', pct, config.videoId || '').catch(() => {});
          this.log('info', `[watchVideo] Partial watch history marked at ${pct}%`);
        }

        // ── Engagement actions — phase-independent, checked every iteration ──
        // Bugs 10/11/12/14 fix: decoupled from phase boundaries so they always fire
        // at the correct progress thresholds regardless of personality phase ranges.

        // Like (40–60%) — mutually exclusive with dislike (Bug 12)
        if (progress >= 0.4 && progress < 0.6 && config?.likeEnabled && !this._likedThisVideo && !this._dislikedThisVideo) {
          const shouldLike = await this._shouldEngage('like', progress, this.currentVideo, config);
          if (shouldLike) {
            try {
              const likeSel = isMobile
                ? 'ytm-like-button-renderer button[aria-label*="like" i]:not([aria-label*="dislike" i]), button[aria-label*="like" i]:not([aria-label*="dislike" i])'
                : 'like-button-view-model button, ytd-toggle-button-renderer#top-level-buttons-computed button:first-child, button[aria-label*="like" i]:not([aria-label*="dislike" i])';
              const likeBtn = await page.$(likeSel);
              if (likeBtn) {
                const isLiked = await likeBtn.evaluate(el =>
                  el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-label')?.toLowerCase().includes('unlike'),
                ).catch(() => false);
                if (!isLiked) {
                  await humanMouseMove(page);
                  await sl(rd(500, 1500));
                  await likeBtn.click();
                  this._likedThisVideo = true;
                  this.log('info', `👍 Liked at ~${Math.round(progress * 100)}% (${isMobile ? 'mobile' : 'desktop'})`);
                  await trackEngagement(this.profileId, 'like').catch(() => {});
                }
              }
            } catch (err) {
              // Fix Bug 23: log engagement errors instead of silently swallowing
              this.log('warn', `[Engagement] Like failed: ${err.message}`);
            }
          }
        }

        // Dislike (35–50%) — gated and mutually exclusive with like. If both are enabled,
        // skip dislike by default to avoid conflicting engagement on the same video.
        if (config?.dislikeEnabled && !config?.likeEnabled && !this._dislikedThisVideo && !this._likedThisVideo && progress >= 0.35 && progress < 0.5) {
          const shouldDislike = await this._shouldEngage('dislike', progress, this.currentVideo, config);
          if (shouldDislike) {
            try {
              const dislikeSel = isMobile
                ? 'button[aria-label*="dislike" i]'
                : 'like-button-view-model button:nth-of-type(2), ytd-toggle-button-renderer#top-level-buttons-computed button:nth-of-type(2), button[aria-label*="dislike" i]';
              const dislikeBtn = await page.$(dislikeSel);
              if (dislikeBtn) {
                await humanMouseMove(page);
                await sl(rd(500, 1200));
                await dislikeBtn.click();
                this._dislikedThisVideo = true;
                this.log('info', `👎 Dislike clicked at ~${Math.round(progress * 100)}% (${isMobile ? 'mobile' : 'desktop'})`);
              } else {
                this.log('warn', '[Engagement] Dislike enabled but button not found');
              }
            } catch (err) {
              this.log('warn', `[Engagement] Dislike failed: ${err.message}`);
            }
          }
        } else if (config?.dislikeEnabled && config?.likeEnabled && !this._dislikeConflictLogged) {
          this._dislikeConflictLogged = true;
          this.log('warn', '[Engagement] Like and dislike both enabled — skipping dislike to avoid conflict');
        }

        // Subscribe (>= 70%) — Bug 10 fix: was inside phase4End block (max 0.699), impossible
        if (progress >= 0.7 && config?.subscribeEnabled && !this._subscribedThisSession) {
          const shouldSub = await this._shouldEngage('subscribe', progress, this.currentVideo, config);
          if (shouldSub) {
            try {
              const subSel = isMobile
                ? 'ytm-subscribe-button-renderer button, .yt-spec-button-shape-next[aria-label*="Subscribe" i], button[aria-label*="Subscribe" i]:not([aria-label*="Unsubscribe" i])'
                : '#subscribe-button button, ytd-subscribe-button-renderer button';
              const subBtn = await page.$(subSel);
              if (subBtn) {
                const text = await subBtn.textContent().catch(() => '');
                const label = await subBtn.getAttribute('aria-label').catch(() => '');
                const alreadySub = (text && text.toLowerCase().includes('subscribed'))
                  || (label && label.toLowerCase().includes('unsubscribe'));
                if (alreadySub) {
                  this._subscribedThisSession = true;
                  this.log('info', '🔔 Already subscribed — skipping subscribe action');
                } else {
                  await humanMouseMove(page);
                  await sl(rd(1000, 3000));
                  await subBtn.click();
                  this._subscribedThisSession = true;
                  this.log('info', `🔔 Subscribed at ~${Math.round(progress * 100)}% (${isMobile ? 'mobile' : 'desktop'})`);
                  await trackEngagement(this.profileId, 'subscribe').catch(() => {});
                  if (config?.bellEnabled !== false && typeof clickBellIcon === 'function') {
                    await sl(rd(800, 1500));
                    await clickBellIcon(page, (l, m) => this.log(l, m));
                  }
                }
              }
            } catch {}
          }
        }

        // Comment (>= 85%) — Bug 11 fix: was inside phase5End block (max 0.839), impossible
        const _commentAt = config?.qaTestMode ? 0.5 : 0.85;
        if (progress >= _commentAt && config?.commentEnabled && config?.commentText && !this._commentedThisVideo) {
          try {
            await smoothScroll(page, pers ? pers.pickInt(400, 800) : rd(400, 800), 'down', pers);
            await sl(rd(2000, 4000));
            if (isMobile) {
              const mobileCommentBox = await page.$(
                'ytm-comment-simplebox-renderer, .comment-simplebox-content, [aria-label*="comment" i][role="textbox"], ytm-comment-section-renderer input, ytm-comment-section-renderer textarea',
              );
              if (mobileCommentBox) {
                await mobileCommentBox.click();
                await sl(rd(1000, 2000));
                const mobileInput = await page.$(
                  'ytm-comment-simplebox-renderer [contenteditable="true"], [id*="comment-input"], textarea[aria-label*="comment" i]',
                ).catch(() => null) || mobileCommentBox;
                // Ensure the actual input field is focused before typing
                await mobileInput.click().catch(() => {});
                await sl(rd(300, 600));
                await humanType(page, config.commentText);
                await sl(rd(1000, 2000));
                const mobileSubmit = await page.$(
                  'ytm-comment-simplebox-renderer button[aria-label*="Comment" i], ytm-comment-simplebox-renderer button:last-child, [aria-label*="Post comment" i]',
                );
                const canSubmit = mobileSubmit && await mobileSubmit.evaluate((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true').catch(() => true);
                if (!canSubmit) {
                  this.log('warn', '[Comment] Mobile submit button missing/disabled — not marking posted');
                } else {
                  await mobileSubmit.click();
                  await sl(rd(1200, 2200));
                  this._commentedThisVideo = true;
                  this.log('info', `💬 Comment posted at ~${Math.round(progress * 100)}% (mobile)`);
                  await trackEngagement(this.profileId, 'comment').catch(() => {});
                  await sl(rd(1000, 1800));
                }
              }
            } else {
              const commentBox = await page.$('#simplebox-placeholder, #placeholder-area');
              if (commentBox) {
                await commentBox.click();
                await sl(rd(1000, 2000));
                await humanType(page, config.commentText);
                await sl(rd(1000, 2000));
                const submitBtn = await page.$('#submit-button button, tp-yt-paper-button#submit-button');
                const canSubmit = submitBtn && await submitBtn.evaluate((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true').catch(() => true);
                if (!canSubmit) {
                  this.log('warn', '[Comment] Submit button missing/disabled — not marking posted');
                } else {
                  await submitBtn.click();
                  await sl(rd(1200, 2200));
                  this._commentedThisVideo = true;
                  this.log('info', `💬 Comment posted at ~${Math.round(progress * 100)}%`);
                  await trackEngagement(this.profileId, 'comment').catch(() => {});
                  await sl(rd(1000, 1800));
                }
              }
            }
            await smoothScroll(page, rd(400, 800), 'up');
          } catch (err) {
            this.log('warn', `[Comment] Failed: ${err.message}`);
          }
        }

        if (progress < phase1End) {
          await sl(Math.min(rd(8000, 20000), remaining));
          continue;
        }

        if (progress < phase2End) {
          if (config?.qaTestMode && !this._qaScrolledEarly) {
            this._qaScrolledEarly = true;
            await smoothScroll(page, pers.pickInt(200, 450), 'down', pers);
            await sl(rd(1500, 3000));
            await smoothScroll(page, pers.pickInt(150, 300), 'up', pers);
            this.log('info', '[QA] Early scroll on watch page');
          }
          if (pers.chance(mouseMoveChance)) {
            const x = rd(150, 900);
            const y = rd(100, 400);
            await page.mouse.move(x, y, { steps: rd(5, 15) }).catch(() => {});
            await sl(rd(500, 2000));
          }
          await sl(Math.min(rd(10000, 25000), remaining));
          continue;
        }

        if (progress < phase3End) {
          const humanOn = config?.humanEngagementEnabled !== false;
          if (humanOn && !this._descriptionOpened && progress >= 0.22 && progress < 0.42) {
            this._descriptionOpened = true;
            await expandDescriptionAndRead(page, (l, m) => this.log(l, m));
          }

          const scrollPlan = planWatchAction(progress, config, 3, pers);
          if (scrollPlan.scroll) {
            const px = scrollPlan.intensity || scrollAmount;
            await smoothScroll(page, px + (pers ? pers.pickInt(50, 200) : rd(50, 200)), 'down', pers);
            await sl(scrollPlan.pauseMs || rd(2000, 6000));
            if (humanOn && !this._relatedHovered && pers.chance(0.55)) {
              await hoverRelatedVideos(page, (l, m) => this.log(l, m));
              this._relatedHovered = true;
            }
            if (pers.chance(0.35)) {
              await smoothScroll(page, pers ? pers.pickInt(50, 150) : rd(50, 150), 'down', pers);
              await sl(pauseDuration);
            }
            await smoothScroll(page, px + (pers ? pers.pickInt(50, 200) : rd(50, 200)), 'up', pers);
            await sl(rd(500, 1500));
          } else if (config?.scrollDuringWatch !== false && pers.chance(commentScrollChance * 0.5)) {
            const scrollDown = pers ? pers.pickInt(160, 480) : rd(160, 480);
            const scrollUp = Math.round(scrollDown * (0.6 + Math.random() * 0.5));
            await smoothScroll(page, scrollDown, 'down', pers);
            await sl(rd(1500, 4000));
            if (humanOn) await hoverRelatedVideos(page, (l, m) => this.log(l, m));
            await smoothScroll(page, scrollUp, 'up', pers);
          }

          const seekMax = config?.seekForwardMax ?? 2;
          const seekCount = this._seekForwardCount || 0;
          if (
            seekCount < seekMax
            && progress >= 0.2
            && progress < 0.55
            && (config?.humanEngagementEnabled !== false || config?.qaTestMode)
            && (config?.qaTestMode || pers.chance(0.35))
          ) {
            const sec = config?.seekForwardSec || 10;
            try {
              if (isMobile) {
                // Mobile: keyboard L doesn't work, use JS currentTime manipulation
                await page.evaluate((seekSec) => {
                  const v = document.querySelector('video');
                  if (v && v.duration > 0 && isFinite(v.duration)) {
                    v.currentTime = Math.min(v.duration - 5, v.currentTime + seekSec);
                  }
                }, sec);
                this.log('info', `[Human] ⏩ Forward ~${sec}s via JS (mobile) (${seekCount + 1}/${seekMax})`);
              } else {
                await seekForwardKeyboard(page, sec, pers);
                this.log('info', `[Human] ⏩ Forward ~${sec}s via keyboard (${seekCount + 1}/${seekMax})`);
              }
              this._seekForwardCount = seekCount + 1;
              this._seekedForward = true;
              await sl(pers ? pers.pickInt(1500, 2800) : rd(1500, 2800));
            } catch (seekErr) {
              this.log('warn', `[Human] Seek forward failed: ${seekErr.message}`);
            }
          }

          await sl(Math.min(rd(15000, 35000), remaining));
          continue;
        }

        if (progress < phase4End) {
          if (pers.chance(mouseMoveChance)) {
            const x = rd(200, 750);
            const y = rd(80, 300);
            await page.mouse.move(x, y, { steps: rd(8, 20) }).catch(() => {});
          }

          await sl(Math.min(rd(12000, 28000), remaining));
          continue;
        }

        if (progress < phase5End) {
          const peekPlan = planWatchAction(progress, config, 5, pers);
          if (peekPlan.scroll || (config?.scrollDuringWatch !== false && pers.chance(relatedPeekChance))) {
            const peekDown = peekPlan.intensity || (pers ? pers.pickInt(100, 300) : rd(100, 300));
            const peekUp = Math.round(peekDown * (0.55 + Math.random() * 0.55));
            await smoothScroll(page, peekDown, 'down', pers);
            await sl(peekPlan.pauseMs || rd(1500, 4000));
            await smoothScroll(page, peekUp, 'up', pers);
          }

          await sl(Math.min(rd(15000, 30000), remaining));
          continue;
        }

        await sl(Math.min(rd(10000, 25000), remaining));
      }
    } finally {
      playCheckCancelled = true;
      for (const t of playCheckTimers) clearTimeout(t);
      this.adPlaying = false;
    }
  },
};

function mixinProfileAgent(ProfileAgent) {
  Object.assign(ProfileAgent.prototype, videoWatcherPrototype);
}

function peekBehaviorInjectorStatus() {
  const b = bx();
  let ytExports = null;
  try {
    ytExports = require('./YoutubeUi.cjs');
  } catch {
    /* ignore */
  }
  return {
    helperKeys: Object.keys(b),
    expandDescriptionAndRead: typeof b.expandDescriptionAndRead === 'function',
    hoverRelatedVideos: typeof b.hoverRelatedVideos === 'function',
    humanType: typeof b.humanType === 'function',
    smoothScroll: typeof b.smoothScroll === 'function',
    expandSameRefAsYoutubeUiModule: ytExports
      ? b.expandDescriptionAndRead === ytExports.expandDescriptionAndRead
      : null,
    hoverSameRefAsYoutubeUiModule: ytExports
      ? b.hoverRelatedVideos === ytExports.hoverRelatedVideos
      : null,
  };
}

async function clearYouTubePageAdIntervals(page) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return;
  await page
    .evaluate(() => {
      if (typeof window.__mmbAdSkipInterval === 'number') {
        clearInterval(window.__mmbAdSkipInterval);
        window.__mmbAdSkipInterval = null;
      }
      window.__mmbAdSkipperInstalled = false;
      window.__mmbTrySkipAd = null;
      window.__mmbAdSkipStart = null;
    })
    .catch((e) => {
      console.warn('[VideoWatcher] clearYouTubePageAdIntervals:', e && e.message ? e.message : String(e));
    });
}

module.exports = {
  setBehaviorHelpers,
  mixinProfileAgent,
  detectYouTubeAd,
  ensureYouTubeAdSkipper,
  attemptSkipYouTubeAd,
  waitForAdsToClear,
  getVideoPlaybackState,
  clearYouTubePageAdIntervals,
  /** Diagnostics: verify agent.cjs wired expand/hover + deps into VideoWatcher (scripts/tests only). */
  peekBehaviorInjectorStatus,
};
