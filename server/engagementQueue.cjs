/**
 * engagementQueue.cjs
 * Manages Gmail-profile engagement jobs for a specific YouTube video.
 *
 * Flow per job:
 *   start profile → navigate via source (notification/search/direct)
 *   → watch video → ads wait → X% watch time
 *   → actions (like/dislike/subscribe/bell/comment/descriptionLinks)
 *   → stop profile
 */

'use strict';

const { chromium } = require('playwright-core');
const { providerFactory } = require('./providers/ProviderFactory.cjs');
const { humanType, smoothScroll, humanMouseMove, typeUrlInAddressBar } = require('./agent/HumanBehavior.cjs');
const {
  forceDarkTheme,
  clickSearchAndType,
  dismissYouTubePopups,
  isMobileYouTube,
} = require('./agent/YoutubeUi.cjs');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ── Job status ────────────────────────────────────────────────────────────────

const JOB_STATUS = {
  PENDING:   'pending',
  RUNNING:   'running',
  DONE:      'done',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
};

let _nextId = 1;
function genId() { return `eng_${Date.now()}_${_nextId++}`; }

// ── In-memory queue ───────────────────────────────────────────────────────────

/** @type {Map<string, EngagementJob>} */
const jobs = new Map();

// ── Main Queue Manager ────────────────────────────────────────────────────────

class EngagementQueue {
  constructor() {
    this._running = 0;
    this._maxConcurrent = 3; // max 3 profiles simultaneously
  }

  /**
   * Queue engagement jobs for a batch of profiles.
   * @param {object}   params
   * @param {object[]} params.profiles      - [{ profileId, profileName, browserType, source, delayMs, actions, videos }]
   *   where videos = [{ url, title, channelName }]  — one entry per tab to open
   * @param {number}   params.watchPct      - 0-100
   * @param {boolean}  params.adSkipEnabled - default true
   * @param {string}   params.videoQuality  - 'auto'|'144p'|'240p'|'360p'|'480p'|'720p'|'1080p'
   */
  enqueue(params) {
    const jobIds = [];
    for (const p of params.profiles) {
      const jobId = genId();
      const job = {
        id:            jobId,
        profileId:     p.profileId,
        profileName:   p.profileName,
        browserType:   p.browserType || 'morelogin',
        videos:        Array.isArray(p.videos) && p.videos.length > 0
                         ? p.videos
                         : [],
        source:        p.source || 'direct',
        delayMs:       p.delayMs || 0,
        actions:       p.actions || {},
        watchPct:      p.watchPct || params.watchPct || 40,
        adSkipEnabled: params.adSkipEnabled !== false,   // default true
        videoQuality:  params.videoQuality  || 'auto',
        maxConcurrent: Math.max(1, Number(params.maxConcurrent) || this._maxConcurrent),
        status:        JOB_STATUS.PENDING,
        scheduledAt:   Date.now() + (p.delayMs || 0),
        startedAt:     null,
        finishedAt:    null,
        error:         null,
        log:           [],
      };
      jobs.set(jobId, job);
      jobIds.push(jobId);
      setTimeout(() => this._runJob(jobId), p.delayMs || 0);
    }
    return jobIds;
  }

  async _runJob(jobId) {
    const job = jobs.get(jobId);
    if (!job || job.status === JOB_STATUS.CANCELLED) return;

    // Wait if too many running
    while (this._running >= (job.maxConcurrent || this._maxConcurrent)) {
      await sleep(5000);
      if (!jobs.has(jobId) || jobs.get(jobId).status === JOB_STATUS.CANCELLED) return;
    }

    job.status  = JOB_STATUS.RUNNING;
    job.startedAt = Date.now();
    this._running++;

    const addLog = (msg) => {
      job.log.push({ t: new Date().toISOString(), msg });
      console.log(`[Engagement][${job.profileName}] ${msg}`);
    };

    let browser = null;

    try {
      addLog(`Starting profile via ${job.browserType}...`);
      // ── IMPORTANT: pass job.browserType so the correct provider is used ──
      const provider = providerFactory.getProvider(job.browserType);
      let startRes = null;
      let cdpPort     = null;
      let cdpEndpoint = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        startRes = await provider.startProfile(job.profileId);
        if (startRes.code === 0 && startRes.data?.cdpPort) {
          cdpPort     = startRes.data.cdpPort;
          cdpEndpoint = startRes.data.cdpEndpoint || null;
          break;
        }
        if (attempt < 3) {
          const waitMs = Math.min(2500, 700 * attempt);
          addLog(`Start pending (${startRes?.message || '...'}) — retry ${attempt + 1}/3 in ${waitMs}ms...`);
          await sleep(waitMs);
        }
      }

      if (!cdpPort) throw new Error(`Profile start failed: ${startRes.message || 'No CDP port returned'}`);

      job.cdpPort = cdpPort;
      addLog(`Profile started! CDP port: ${cdpPort}`);
      await sleep(3000);

      const cdpUrl = cdpEndpoint || `http://127.0.0.1:${cdpPort}`;
      browser = await chromium.connectOverCDP(cdpUrl);
      const contexts = browser.contexts();
      const ctx = contexts[0] || await browser.newContext();

      // Normalise video list — backward compat if old payload
      const videos = job.videos && job.videos.length > 0
        ? job.videos
        : [{ url: job.videoUrl || '', title: job.videoTitle || '', channelName: job.channelName || '' }];

      addLog(`Videos to process: ${videos.length}`);

      for (let vi = 0; vi < videos.length; vi++) {
        const video = videos[vi];
        if (!video.url) { addLog(`Video ${vi + 1}: no URL — skipping`); continue; }

        addLog(`── Video ${vi + 1}/${videos.length}: "${video.title || video.url}" ──`);

        // First video: reuse existing page. Subsequent: open new tab
        let page;
        if (vi === 0) {
          page = ctx.pages()[0] || await ctx.newPage();
        } else {
          await sleep(rand(1500, 3000));
          page = await ctx.newPage();
        }

        await forceDarkTheme(page).catch(() => {});
        await dismissYouTubePopups(page).catch(() => {});

        const mobile = await isMobileYouTube(page).catch(() => false);
        const videoJob = { ...job, videoUrl: video.url, videoTitle: video.title, channelName: video.channelName };

        // ── STEP 1: Navigate ──────────────────────────────────────────────
        addLog(`Traffic source: ${job.source}`);
        if (job.source === 'notification') {
          // Returns the page to use (may be a new tab opened by notification click)
          page = await this._navigateViaNotification(page, ctx, videoJob, addLog, mobile);
        } else if (job.source === 'search') {
          page = await this._navigateViaSearch(page, ctx, videoJob, addLog, mobile);
        } else {
          addLog(`Navigating directly to: ${video.url}`);
          await typeUrlInAddressBar(page, video.url).catch(() => {});
          await page.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        // Verify page is still alive after navigation
        const pageAlive = await page.evaluate(() => true).catch(() => false);
        if (!pageAlive) {
          addLog(`❌ Page closed after navigation — skipping this video`);
          continue;
        }

        await sleep(rand(2000, 4000));
        await dismissYouTubePopups(page).catch(() => {});

        // ── STEP 2: Pre-set autoplay off in localStorage before video loads ─
        await page.evaluate(() => {
          try {
            // YouTube reads this key to set initial autoplay state
            localStorage.setItem('yt-player-autoplay', '{"data":"false"}');
          } catch {}
        }).catch(() => {});

        // ── STEP 3: Wait for player + handle ads ─────────────────────────
        addLog('Waiting for video player...');
        // Track: new session + view started
        this._trackAnalytics(job.profileId, 'session');
        this._trackAnalytics(job.profileId, 'view');
        this._trackAnalytics(job.profileId, 'ads_total');
        await this._waitForVideoAndSkipAds(page, addLog, job.adSkipEnabled !== false, job.profileId);

        // ── STEP 4: Set quality (if not auto) ────────────────────────────
        if (job.videoQuality && job.videoQuality !== 'auto') {
          await this._setVideoQuality(page, job.videoQuality, addLog).catch(() => {});
        }

        // ── STEP 5: Watch X% ─────────────────────────────────────────────
        addLog(`Watching for ${job.watchPct}% before actions...`);
        // Get video duration before watching for accurate watchTime tracking
        const vidDuration = await page.evaluate(() => {
          const v = document.querySelector('video'); return v ? Math.round(v.duration || 0) : 0;
        }).catch(() => 0);
        await this._watchForPercent(page, job.watchPct, addLog);
        // Track watch time: duration * watchPct%
        if (vidDuration > 0) {
          const watchedSecs = Math.round(vidDuration * (job.watchPct / 100));
          this._trackAnalytics(job.profileId, 'watchTime', watchedSecs);
          addLog(`Analytics: tracked ${watchedSecs}s watch time`);
        }

        // ── STEP 6: Engagement actions ────────────────────────────────────
        addLog('Starting engagement actions...');
        await this._doEngagementActions(page, videoJob, addLog, mobile);

        // ── STEP 7: Autoplay off (after video player is ready) ────────────
        await this._disableAutoplay(page, addLog);

        // ── STEP 8: Natural cool-down — wait 5s before closing/next tab ───
        addLog('Cooling down (5s) before closing...');
        await sleep(rand(5000, 8000));

        addLog(`Video ${vi + 1}/${videos.length} complete ✓`);
      }

      job.status = JOB_STATUS.DONE;
      addLog('All videos done ✓');

    } catch (err) {
      job.status = JOB_STATUS.FAILED;
      job.error  = err.message || String(err);
      addLog(`FAILED: ${job.error}`);
    } finally {
      job.finishedAt = Date.now();
      this._running = Math.max(0, this._running - 1);

      // Stop profile via correct provider
      try {
        const provider = providerFactory.getProvider(job.browserType);
        await provider.stopProfile(job.profileId, { cdpPort: job.cdpPort || null });
        addLog('Profile stopped.');
      } catch {}

      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  // ── Helper: wait for nav to video page, handle new-tab case ─────────────
  // Some YT links open in a new tab. We detect the new tab and return it.
  async _resolvePageAfterClick(page, ctx, addLog, fallbackUrl) {
    // Race: either current page navigates, or a new tab opens (within 8s)
    const newTabPromise = ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    const navPromise   = page.waitForURL(/watch\?v=/, { timeout: 8000 }).catch(() => null);

    const [newTab] = await Promise.all([newTabPromise, navPromise]);

    if (newTab) {
      addLog('Video opened in new tab — switching to it ✓');
      await newTab.waitForLoadState('domcontentloaded').catch(() => {});
      // Close the old YouTube tab to keep things clean
      await page.close().catch(() => {});
      return newTab;
    }

    // Check if current page navigated to a video
    const currentUrl = page.url();
    if (currentUrl.includes('watch?v=')) {
      addLog('Navigated to video on same tab ✓');
      return page;
    }

    // Neither worked — fall back to direct
    addLog(`Navigation did not reach video — falling back to direct: ${fallbackUrl}`);
    await page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    return page;
  }

  // ── Navigate via YouTube Notification ─────────────────────────────────────
  async _navigateViaNotification(page, ctx, job, addLog, mobile) {
    try {
      addLog('Going to YouTube homepage...');
      await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(rand(2000, 3500));
      await dismissYouTubePopups(page).catch(() => {});

      // ── Click the notification bell ──
      const bellSelectors = [
        'button[aria-label*="notification" i]',
        '#notification-button button',
        'yt-icon-button#notification-button',
        '.ytd-notification-topbar-button-renderer button',
      ];

      let bellClicked = false;
      for (const sel of bellSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            await humanMouseMove(page);
            await sleep(rand(500, 1000));
            await btn.click();
            bellClicked = true;
            addLog(`Clicked notification bell (${sel})`);
            break;
          }
        } catch {}
      }

      if (!bellClicked) {
        addLog('Notification bell not found — falling back to direct');
        await page.goto(job.videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return page;
      }

      await sleep(rand(1500, 2500));

      // ── Count notifications visible ──
      const notifCount = await page.evaluate(() =>
        document.querySelectorAll('ytd-notification-renderer').length
      ).catch(() => 0);
      addLog(`Notifications visible: ${notifCount}`);

      if (notifCount === 0) {
        addLog('No notifications found — falling back to direct');
        await page.goto(job.videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return page;
      }

      // ── Find matching notification by title keywords ──
      const titleWords = (job.videoTitle || '').toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 4);
      const videoId    = (job.videoUrl || '').match(/[?&]v=([^&]+)/)?.[1] || '';

      const linkHref = await page.evaluate(({ words, vid }) => {
        const items = document.querySelectorAll('ytd-notification-renderer');
        for (const item of items) {
          const text = item.textContent?.toLowerCase() || '';
          const link = item.querySelector('a[href*="watch"]');
          if (!link) continue;
          // Try exact video ID match first
          if (vid && link.href.includes(vid)) return link.href;
          // Fuzzy title match
          const matches = words.filter(w => text.includes(w)).length;
          if (matches >= Math.min(2, words.length)) return link.href;
        }
        // Fallback: first notification with a watch link
        const firstLink = document.querySelector('ytd-notification-renderer a[href*="watch"]');
        return firstLink ? firstLink.href : null;
      }, { words: titleWords, vid: videoId }).catch(() => null);

      if (!linkHref) {
        addLog('Target video not found in notifications — falling back to direct');
        await page.goto(job.videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return page;
      }

      addLog(`Found notification link: ${linkHref.slice(0, 80)}`);

      // Navigate directly to the href (safer than clicking — avoids new-tab issues)
      await page.goto(linkHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
      addLog('Opened video via notification URL ✓');
      return page;

    } catch (err) {
      addLog(`Notification nav failed (${err.message}) — direct fallback`);
      await page.goto(job.videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return page;
    }
  }

  // ── Navigate via Search ───────────────────────────────────────────────────
  async _navigateViaSearch(page, ctx, job, addLog, mobile) {
    try {
      addLog('Going to YouTube for search...');
      await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(rand(2000, 3500));
      await dismissYouTubePopups(page).catch(() => {});

      const shortTitle = (job.videoTitle || '').split(' ').slice(0, 5).join(' ');
      const query      = job.channelName ? `${job.channelName} ${shortTitle}` : shortTitle;
      addLog(`Searching YouTube: "${query}"`);

      if (mobile) {
        await page.goto(
          `https://m.youtube.com/results?search_query=${encodeURIComponent(query)}`,
          { waitUntil: 'domcontentloaded', timeout: 20000 }
        );
      } else {
        await clickSearchAndType(page, query);
        await sleep(rand(1000, 2000));
        await page.keyboard.press('Enter');
      }

      await sleep(rand(2500, 4000));

      const videoId   = (job.videoUrl || '').match(/[?&]v=([^&]+)/)?.[1] || '';
      const titleWords = (job.videoTitle || '').toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);

      // Get the best matching video href from results (don't click — navigate directly)
      const videoHref = await page.evaluate(({ vid, words }) => {
        // Exact video ID match
        if (vid) {
          const exact = document.querySelector(`a[href*="v=${vid}"]`);
          if (exact) return exact.href;
        }
        // Fuzzy title match
        const cards = document.querySelectorAll(
          'ytd-video-renderer a#video-title, ytd-compact-video-renderer a#video-title'
        );
        for (const card of cards) {
          const text = card.textContent?.toLowerCase() || '';
          const matches = words.filter(w => text.includes(w)).length;
          if (matches >= Math.min(3, words.length)) return card.href;
        }
        return null;
      }, { vid: videoId, words: titleWords }).catch(() => null);

      if (videoHref) {
        addLog(`Found video in search results ✓ — navigating`);
        await page.goto(videoHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return page;
      }

      addLog('Video not in search results — falling back to direct');
      await page.goto(job.videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return page;

    } catch (err) {
      addLog(`Search nav failed (${err.message}) — direct fallback`);
      await page.goto(job.videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return page;
    }
  }

  // ── Wait for video + handle ads ──────────────────────────────────────────
  async _waitForVideoAndSkipAds(page, addLog, adSkipEnabled = true, profileId = null) {
    /** Returns true if any ad indicator is visible on page */
    const isAdPlaying = async () => {
      return page.evaluate(() => {
        return !!(
          document.querySelector('.ytp-ad-player-overlay') ||
          document.querySelector('.ytp-ad-preview-container') ||
          document.querySelector('.ytp-ad-module') ||
          document.querySelector('.ytp-ad-badge') ||
          document.querySelector('.ytp-ad-text') ||
          document.querySelector('[class*="ad-showing"]')
        );
      }).catch(() => false);
    };

    try {
      // 1. Wait for video element
      await page.waitForSelector('video, #movie_player', { timeout: 25000 }).catch(() => {});
      await sleep(rand(2000, 3500));

      // 2. Handle ads
      if (adSkipEnabled) {
        addLog('Checking for ads...');
        for (let i = 0; i < 10; i++) {
          const adOn = await isAdPlaying();
          if (!adOn) { addLog('No ad detected — continuing'); break; }

          // Try skip button
          const skipped = await page.evaluate(() => {
            const btn = document.querySelector(
              '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[class*="skip"]'
            );
            if (btn) { btn.click(); return true; }
            return false;
          }).catch(() => false);

          if (skipped) {
            addLog(`Ad skipped (${i + 1})`);
            if (profileId) this._trackAnalytics(profileId, 'ads_skipped');
            await sleep(rand(1500, 2500));
          } else {
            addLog(`Ad playing — waiting for skip button (${i + 1}/10)...`);
            await sleep(rand(4000, 7000));
          }
        }
      } else {
        addLog('Ad skip disabled — waiting for ads to finish naturally...');
        for (let i = 0; i < 25; i++) {
          const adOn = await isAdPlaying();
          if (!adOn) { addLog('Ads finished ✓'); if (profileId) this._trackAnalytics(profileId, 'ads_watched_full'); break; }
          addLog(`Ad still playing (${i + 1}) — waiting...`);
          await sleep(rand(5000, 8000));
        }
      }

      // 3. ── CRITICAL: Wait for MAIN video to actually START playing ──
      // This ensures actions never fire during an ad or before the real video begins
      addLog('Waiting for main video to begin playing...');
      const videoStarted = await page.waitForFunction(() => {
        const video = document.querySelector('video');
        if (!video) return false;
        // Video must have duration, be playing, and NOT show any ad indicator
        const adShowing = !!(
          document.querySelector('.ytp-ad-player-overlay') ||
          document.querySelector('.ytp-ad-module') ||
          document.querySelector('.ytp-ad-badge')
        );
        return (
          !adShowing &&
          video.readyState >= 3 &&      // HAVE_FUTURE_DATA or better
          video.duration > 0 &&
          !video.paused &&
          video.currentTime > 0.5        // at least 0.5s in = definitely playing
        );
      }, { timeout: 40000 }).catch(() => null);

      if (videoStarted) {
        addLog('Main video is playing ✓ — proceeding');
      } else {
        addLog('Video start timeout — proceeding anyway (video may still be loading)');
        await sleep(3000);
      }

      // 4. Small human-like pause before any interaction
      await sleep(rand(1500, 3000));

    } catch (e) {
      addLog(`Ad/video wait error: ${e.message} — proceeding`);
      await sleep(3000);
    }
  }

  // ── Disable autoplay ─────────────────────────────────────────────────────
  async _disableAutoplay(page, addLog) {
    try {
      const result = await page.evaluate(() => {
        // 1. localStorage — persists for this profile session
        try { localStorage.setItem('yt-player-autoplay', '{"data":"false"}'); } catch {}

        // 2. Click the toggle button if it's currently ON
        const selectors = [
          '.ytp-autonav-toggle-button',
          'button[data-tooltip-target-id="ytp-autonav-toggle-button"]',
          'button[aria-label*="autoplay" i]',
          'button[aria-label*="Autoplay" i]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (!btn) continue;
          // Check if autoplay is currently ON
          const isOn =
            btn.getAttribute('aria-checked') === 'true' ||
            btn.classList.contains('ytp-autonav-toggle-button-enabled') ||
            btn.querySelector('[class*="enabled"]') !== null;
          if (isOn) {
            btn.click();
            return `autoplay OFF via ${sel}`;
          }
          return `autoplay already off (${sel})`;
        }
        return 'toggle button not found — localStorage set';
      }).catch(() => 'evaluate failed');

      addLog(`Autoplay: ${result}`);
    } catch (e) {
      addLog(`Autoplay disable failed: ${e.message}`);
    }
  }

  // ── Set video quality ─────────────────────────────────────────────────────
  async _setVideoQuality(page, quality, addLog) {
    try {
      // Click the settings (gear) button in the player
      const settingsBtn = await page.$('.ytp-settings-button');
      if (!settingsBtn) { addLog('Quality: settings button not found'); return; }
      await settingsBtn.click();
      await sleep(rand(600, 1000));

      // Click "Quality" menu item
      const qualityClicked = await page.evaluate(() => {
        const items = document.querySelectorAll('.ytp-menuitem, .ytp-panel-menu .ytp-menuitem');
        for (const item of items) {
          if (item.textContent?.toLowerCase().includes('quality')) {
            item.click(); return true;
          }
        }
        return false;
      });

      if (!qualityClicked) {
        addLog(`Quality: menu item not found — pressing Escape`);
        await page.keyboard.press('Escape').catch(() => {});
        return;
      }
      await sleep(rand(500, 900));

      // Click the desired quality option
      const picked = await page.evaluate((targetQuality) => {
        const items = document.querySelectorAll('.ytp-menuitem, .ytp-quality-menu .ytp-menuitem');
        for (const item of items) {
          const text = item.textContent || '';
          if (text.includes(targetQuality)) { item.click(); return true; }
        }
        return false;
      }, quality);

      if (picked) {
        addLog(`Quality set to ${quality} ✓`);
      } else {
        addLog(`Quality ${quality} not available — using default`);
        await page.keyboard.press('Escape').catch(() => {});
      }
      await sleep(rand(400, 700));
    } catch (e) {
      addLog(`Quality set failed: ${e.message}`);
    }
  }

  // ── Watch video for X% ───────────────────────────────────────────────────
  async _watchForPercent(page, watchPct, addLog) {
    try {
      const totalSeconds = await page.evaluate(() => {
        const video = document.querySelector('video');
        return video ? video.duration : 0;
      }).catch(() => 0);

      if (!totalSeconds || totalSeconds <= 0) {
        addLog('Could not get video duration — waiting 60s flat');
        await sleep(60000);
        return;
      }

      const watchSeconds = Math.floor(totalSeconds * (watchPct / 100));
      addLog(`Video is ${Math.floor(totalSeconds)}s — watching ${watchSeconds}s (${watchPct}%)`);

      // Scroll a bit while watching (human behaviour)
      const chunkMs = 15000; // check every 15s
      let waited = 0;
      while (waited < watchSeconds * 1000) {
        await sleep(Math.min(chunkMs, watchSeconds * 1000 - waited));
        waited += chunkMs;

        // Small scroll to simulate engagement
        if (Math.random() > 0.6) {
          await smoothScroll(page, rand(100, 300), 'down').catch(() => {});
          await sleep(rand(500, 1500));
          await smoothScroll(page, rand(100, 300), 'up').catch(() => {});
        }
      }
    } catch {
      await sleep(50000); // fallback flat wait
    }
  }

  // ── Engagement actions ────────────────────────────────────────────────────
  async _doEngagementActions(page, job, addLog, _mobile) {
    const a = job.actions || {};
    const profileId = job.profileId;
    await sleep(rand(2000, 5000));

    // ── Like ──────────────────────────────────────────────────────────────
    if (a.like) {
      try {
        const liked = await page.evaluate(() => {
          const btn = document.querySelector(
            'like-button-view-model button, ytd-toggle-button-renderer#top-level-buttons-computed button:first-child, button[aria-label*="like" i]:not([aria-label*="dislike" i])'
          );
          if (!btn) return 'not_found';
          const pressed = btn.getAttribute('aria-pressed') === 'true';
          if (!pressed) { btn.click(); return 'liked'; }
          return 'already_liked';
        });
        addLog(`Like: ${liked}`);
        if (liked === 'liked') this._trackAnalytics(profileId, 'like');
        await sleep(rand(1000, 2500));
      } catch (e) { addLog(`Like failed: ${e.message}`); }
    }

    // ── Dislike ───────────────────────────────────────────────────────────
    if (a.dislike) {
      try {
        const result = await page.evaluate(() => {
          const btn = document.querySelector(
            'dislike-button-view-model button, button[aria-label*="dislike" i]'
          );
          if (!btn) return 'not_found';
          const pressed = btn.getAttribute('aria-pressed') === 'true';
          if (!pressed) { btn.click(); return 'disliked'; }
          return 'already_disliked';
        });
        addLog(`Dislike: ${result}`);
        await sleep(rand(1000, 2500));
      } catch (e) { addLog(`Dislike failed: ${e.message}`); }
    }

    // ── Subscribe ─────────────────────────────────────────────────────────
    if (a.subscribe) {
      try {
        const result = await page.evaluate(() => {
          const btn = document.querySelector('#subscribe-button button, ytd-subscribe-button-renderer button');
          if (!btn) return 'not_found';
          const text = btn.textContent?.toLowerCase() || '';
          if (text.includes('subscribed') || text.includes('unsubscribe')) return 'already_subscribed';
          btn.click();
          return 'subscribed';
        });
        addLog(`Subscribe: ${result}`);
        if (result === 'subscribed') this._trackAnalytics(profileId, 'subscribe');
        await sleep(rand(1500, 3000));

        // ── Bell (only after fresh subscribe) ─────────────────────────────
        if (a.bell && result === 'subscribed') {
          await sleep(rand(1000, 2000));
          try {
            const bellResult = await page.evaluate(() => {
              // After subscribing, YouTube shows notification bell button
              const bellBtn = document.querySelector(
                '#notification-preference-button button, ytd-notification-topbar-button-renderer button, button[aria-label*="notification" i][aria-label*="All" i]'
              );
              if (bellBtn) { bellBtn.click(); return 'bell_clicked'; }
              // Try the dropdown bell inside subscribe area
              const bellIcon = document.querySelector('yt-icon-button.ytd-subscription-notification-toggle-button-renderer');
              if (bellIcon) { bellIcon.click(); return 'bell_icon_clicked'; }
              return 'bell_not_found';
            });
            addLog(`Bell: ${bellResult}`);

            // If dropdown opened, click "All"
            await sleep(rand(500, 1000));
            await page.evaluate(() => {
              const items = document.querySelectorAll('ytd-menu-service-item-renderer, tp-yt-paper-item');
              for (const item of items) {
                if (item.textContent?.toLowerCase().includes('all')) { item.click(); return; }
              }
            }).catch(() => {});
          } catch (e) { addLog(`Bell failed: ${e.message}`); }
        }
      } catch (e) { addLog(`Subscribe failed: ${e.message}`); }
    }

    // ── Comment ───────────────────────────────────────────────────────────
    if (a.comment && a.commentText) {
      try {
        await smoothScroll(page, rand(400, 800), 'down');
        await sleep(rand(2000, 4000));

        // Click comment box
        const commentBox = await page.$('#simplebox-placeholder, #placeholder-area');
        if (commentBox) {
          await humanMouseMove(page);
          await commentBox.click();
          await sleep(rand(800, 1500));

          await humanType(page, a.commentText);
          await sleep(rand(1000, 2000));

          // Submit
          const submitBtn = await page.$('#submit-button button, tp-yt-paper-button#submit-button');
          if (submitBtn) {
            await submitBtn.click();
            addLog(`Comment posted: "${a.commentText.slice(0, 40)}..."`);
            this._trackAnalytics(profileId, 'comment');
            await sleep(rand(2000, 3000));
          }
        } else {
          addLog('Comment box not found');
        }
      } catch (e) { addLog(`Comment failed: ${e.message}`); }
    }

    // ── Description Links ─────────────────────────────────────────────────
    if (a.descriptionLinks) {
      try {
        // Expand description first
        const expandBtn = await page.$('#expand, #description #expand-sizer, ytd-text-inline-expander #expand');
        if (expandBtn) {
          await expandBtn.click();
          await sleep(rand(1000, 2000));
        }

        // Find links in description
        const links = await page.evaluate(() => {
          const desc = document.querySelector('#description-inner, #description ytd-text-inline-expander, #meta #description');
          if (!desc) return [];
          return Array.from(desc.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(h => h && !h.includes('youtube.com') && h.startsWith('http'))
            .slice(0, 2); // max 2 links
        }).catch(() => []);

        if (links.length > 0) {
          addLog(`Found ${links.length} external link(s) in description`);
          for (const link of links) {
            try {
              const newPage = await page.context().newPage();
              await newPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              await sleep(rand(8000, 15000)); // browse for a bit
              await newPage.close().catch(() => {});
              addLog(`Visited description link: ${link.slice(0, 60)}`);
            } catch {}
          }
        } else {
          addLog('No external links in description');
        }
      } catch (e) { addLog(`Description links failed: ${e.message}`); }
    }

    addLog('All actions done ✓');
  }

  // ── Analytics tracking helper ─────────────────────────────────────────────────
  /**
   * Track engagement actions in analytics store.
   * Uses global.mmbAnalyticsStore set by index.cjs (same process, no HTTP overhead).
   */
  _trackAnalytics(profileId, action, value = undefined) {
    try {
      const store = global.mmbAnalyticsStore;
      if (!store) return;
      store.enqueue((data) => {
        if (!data.perProfile[profileId]) {
          data.perProfile[profileId] = { views: 0, watchTime: 0, likes: 0, subscribes: 0, comments: 0 };
        }
        const p = data.perProfile[profileId];
        switch (action) {
          case 'view':        data.totalViews++;       p.views++;                              break;
          case 'watchTime':   data.totalWatchTime += (value || 0); p.watchTime += (value || 0); break;
          case 'like':        data.totalLikes++;       p.likes++;                              break;
          case 'subscribe':   data.totalSubscribes++;  p.subscribes++;                         break;
          case 'comment':     data.totalComments++;    p.comments++;                           break;
          case 'session':     data.totalSessions++;                                             break;
          case 'ads_total':   data.totalAds = (data.totalAds || 0) + (value || 1);             break;
          case 'ads_skipped': data.adsSkipped = (data.adsSkipped || 0) + (value || 1);         break;
          case 'ads_watched_full': data.adsWatchedFull = (data.adsWatchedFull || 0) + (value || 1); break;
          default: break;
        }
        if (!data.recentActivity) data.recentActivity = [];
        data.recentActivity.push({ profileId, action, value, time: Date.now() });
        if (data.recentActivity.length > 500) data.recentActivity = data.recentActivity.slice(-500);
        if (!data.dailyLog) data.dailyLog = [];
        data.dailyLog.push({ profileId, action, value: value || 1, time: Date.now() });
        const ago30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
        if (data.dailyLog.length > 50000) data.dailyLog = data.dailyLog.filter(e => e.time > ago30d);
      }).catch(() => {});
    } catch { /* non-critical */ }
  }

  // ── Status API ────────────────────────────────────────────────────────────
  getStatus() {
    const all = [...jobs.values()];
    return {
      total:     all.length,
      pending:   all.filter(j => j.status === JOB_STATUS.PENDING).length,
      running:   all.filter(j => j.status === JOB_STATUS.RUNNING).length,
      done:      all.filter(j => j.status === JOB_STATUS.DONE).length,
      failed:    all.filter(j => j.status === JOB_STATUS.FAILED).length,
      cancelled: all.filter(j => j.status === JOB_STATUS.CANCELLED).length,
      jobs:      all.map(j => ({
        id:          j.id,
        profileName: j.profileName,
        profileId:   j.profileId,
        source:      j.source,
        status:      j.status,
        scheduledAt: j.scheduledAt,
        startedAt:   j.startedAt,
        finishedAt:  j.finishedAt,
        error:       j.error,
        log:         j.log.slice(-50),
        actions:     j.actions,
        videoCount:  j.videos ? j.videos.length : 1,
      })),
    };
  }

  cancelAll() {
    for (const job of jobs.values()) {
      if (job.status === JOB_STATUS.PENDING) {
        job.status = JOB_STATUS.CANCELLED;
      }
    }
  }

  clearFinished() {
    for (const [id, job] of jobs.entries()) {
      if (job.status === JOB_STATUS.DONE || job.status === JOB_STATUS.CANCELLED || job.status === JOB_STATUS.FAILED) {
        jobs.delete(id);
      }
    }
  }
}

const engagementQueue = new EngagementQueue();
module.exports = { engagementQueue };
