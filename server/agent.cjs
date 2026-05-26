/**
 * Profile Agent — One agent per MoreLogin profile
 * Playwright CDP — Human-like behavior
 * 
 * FEATURES:
 * 1. Traffic Router: search / direct / suggested / random (./agent/TrafficRouter.cjs; watch flow uses searchEngine.openVideoSmart)
 * 2. Engagement: Like / Subscribe / Comment
 * 3. Auto-recovery: retry on fail, skip unavailable
 * 4. Dark Theme: multiple methods
 * 5. Search bar: multiple fallback methods
 * 6. Smooth scroll: small increments
 */

const { chromium } = require('playwright-core');
const http = require('http');
const { URL } = require('url');
const { openVideoSmart, openVideoViaBacklink, assignTrafficSource } = require('./searchEngine.cjs');
const {
  getInternalApiBaseUrl,
  getAnalyticsTrackMaxRetries,
  getAnalyticsTrackInitialBackoffMs,
  isVisibilityOverrideAllowed,
} = require('./utils/config.cjs');
const {
  detectPageBlock,
  verifyOpenedVideo,
  resolveTrafficMix,
  createProfilePersonality,
  computeWatchTimeMs,
  deriveSearchQuery,
} = require('./agentBrain.cjs');
const { AIBrain } = require('./AIBrain.cjs');
const { pickPersona } = require('./personas.cjs');

const { getBackendApiSecret } = require('./apiAuth.cjs');

async function postInternalJson(path, bodyJson) {
  const maxRetries = getAnalyticsTrackMaxRetries();
  let backoff = getAnalyticsTrackInitialBackoffMs();
  const body = JSON.stringify(bodyJson);
  const secret = getBackendApiSecret();
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (secret) headers['x-api-key'] = secret;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ok = await new Promise((resolve) => {
      try {
        const api = new URL(path, getInternalApiBaseUrl());
        const req = http.request(
          {
            hostname: api.hostname,
            port: api.port || (api.protocol === 'https:' ? 443 : 80),
            path: api.pathname + api.search,
            method: 'POST',
            headers,
            timeout: 8000,
          },
          () => resolve(true),
        );
        req.on('error', (e) => {
          console.error('[postInternalJson] request error:', e && e.message ? e.message : String(e));
          resolve(false);
        });
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.write(body);
        req.end();
      } catch (err) {
        console.error('[postInternalJson] caught:', err && err.message ? err.message : String(err));
        resolve(false);
      }
    });
    if (ok) return;
    await sleep(Math.min(30000, backoff));
    backoff *= 2;
  }
}

// Track engagement to backend (updates rate limit dashboard)
async function trackEngagement(profileId, action, value) {
  await postInternalJson('/api/analytics/track', { profileId, action, value: value || 1 });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function randomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const {
  seekForwardKeyboard,
  humanType,
  humanMouseMove,
  smoothScroll,
  typeUrlInAddressBar,
} = require('./agent/HumanBehavior.cjs');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PAGE VISIBILITY OVERRIDE (HIGH RISK — DEFAULT OFF via env)
// Prevents YouTube from pausing when another profile window gets focus.
// document monkey-patching is a strong bot signal — enable ONLY with:
//   MMB_ALLOW_VISIBILITY_OVERRIDE=true
// Prefer OS-level layout / fewer concurrent focused players instead.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function overridePageVisibility(page) {
  if (!isVisibilityOverrideAllowed()) return;
  try {
    await page.evaluate(() => {
      try {
        // Override visibilityState — always 'visible'
        Object.defineProperty(document, 'visibilityState', {
          get: () => 'visible', configurable: true,
        });
        Object.defineProperty(document, 'hidden', {
          get: () => false, configurable: true,
        });
        // Block visibilitychange events from reaching YouTube's pause handler
        const _origAEL = document.addEventListener.bind(document);
        document.addEventListener = function(type, handler, opts) {
          if (type === 'visibilitychange') return; // drop it
          return _origAEL(type, handler, opts);
        };
        document.dispatchEvent(new Event('visibilitychange'));
      } catch {}
    });
  } catch {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// YOUTUBE UI (mobile, theme, search, quality, autoplay, popups — ./agent/YoutubeUi.cjs)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const {
  isMobileYouTube,
  isAndroidUA,
  mobileYouTubeSearch,
  mobileDirectWatch,
  forceDarkTheme,
  clickSearchAndType,
  setVideoQuality,
  disableAutoplay,
  verifyAutoplayOff,
  ensureAutoplayOff,
  dismissYouTubePopups,
  expandDescriptionAndRead,
  clickBellIcon,
  hoverRelatedVideos,
  verifyVideoQuality,
  ensureVideoQuality,
} = require('./agent/YoutubeUi.cjs');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TRAFFIC ROUTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TrafficRouter = require('./agent/TrafficRouter.cjs');
TrafficRouter.setTrafficRouterHelpers({
  sleep,
  randomDelay,
  humanMouseMove,
  smoothScroll,
  humanType,
  forceDarkTheme,
  clickSearchAndType,
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ENGAGEMENT ACTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function performEngagement(page, config) {
  if (!config) return;
  await sleep(randomDelay(5000, 15000)); // Wait before engaging

  // Detect mobile/Android for this page
  const isMobile = await isMobileYouTube(page).catch(() => false);

  // Like — setting ON = always attempt
  if (config.likeEnabled) {
    try {
      const likeSel = isMobile
        ? 'ytm-like-button-renderer button[aria-label*="like" i]:not([aria-label*="dislike" i]), button[aria-label*="like" i]:not([aria-label*="dislike" i])'
        : 'like-button-view-model button, ytd-toggle-button-renderer#top-level-buttons-computed button:first-child, button[aria-label*="like" i]:not([aria-label*="dislike" i])';
      const likeBtn = await page.$(likeSel);
      if (likeBtn) {
        const isLiked = await likeBtn.evaluate(el =>
          el.getAttribute('aria-pressed') === 'true' || (el.getAttribute('aria-label') || '').toLowerCase().includes('unlike'),
        ).catch(() => false);
        if (!isLiked) {
          await humanMouseMove(page);
          await sleep(randomDelay(500, 1500));
          await likeBtn.click();
          await sleep(randomDelay(1000, 2000));
        }
      }
    } catch {}
  }

  // Subscribe — setting ON = always attempt
  if (config.subscribeEnabled) {
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
        if (!alreadySub) {
          await humanMouseMove(page);
          await sleep(randomDelay(1000, 3000));
          await subBtn.click();
          await sleep(randomDelay(1000, 2000));
          // Bell icon after subscribe
          if (config.bellEnabled !== false) {
            await clickBellIcon(page, () => {}).catch(() => {});
          }
        }
      }
    } catch {}
  }

  // Comment — setting ON + text = always attempt
  if (config.commentEnabled && config.commentText) {
    try {
      await smoothScroll(page, randomDelay(400, 800), 'down');
      await sleep(randomDelay(2000, 4000));
      if (isMobile) {
        const mobileBox = await page.$(
          'ytm-comment-simplebox-renderer, .comment-simplebox-content, [aria-label*="comment" i][role="textbox"]',
        );
        if (mobileBox) {
          await mobileBox.click();
          await sleep(randomDelay(1000, 2000));
          const mobileInput = await page.$(
            'ytm-comment-simplebox-renderer [contenteditable="true"], [id*="comment-input"], textarea[aria-label*="comment" i]',
          ).catch(() => null) || mobileBox;
          await mobileInput.type(config.commentText, { delay: randomDelay(40, 80) });
          await sleep(randomDelay(1000, 2000));
          const mobileSubmit = await page.$(
            'ytm-comment-simplebox-renderer button[aria-label*="Comment" i], ytm-comment-simplebox-renderer button:last-child',
          );
          if (mobileSubmit) await mobileSubmit.click();
          await sleep(randomDelay(2000, 3000));
        }
      } else {
        const commentBox = await page.$('#simplebox-placeholder, #placeholder-area');
        if (commentBox) {
          await commentBox.click();
          await sleep(randomDelay(1000, 2000));
          await humanType(page, config.commentText);
          await sleep(randomDelay(1000, 2000));
          const submitBtn = await page.$('#submit-button button, tp-yt-paper-button#submit-button');
          if (submitBtn) await submitBtn.click();
          await sleep(randomDelay(2000, 3000));
        }
      }
    } catch {}
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIDEO WATCHER (durability timer, ads, scroll phases)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const VideoWatcher = require('./agent/VideoWatcher.cjs');
VideoWatcher.setBehaviorHelpers({
  sleep,
  randomDelay,
  smoothScroll,
  humanMouseMove,
  expandDescriptionAndRead,
  clickBellIcon,
  hoverRelatedVideos,
  humanType,
  seekForwardKeyboard,
  isMobileYouTube,
  trackEngagement,
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROFILE AGENT CLASS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class ProfileAgent {
  constructor(profileId, profileName, debugPort, options = {}) {
    this.profileId = profileId;
    this.profileName = profileName;
    this.debugPort = debugPort;
    this.browser = null;
    this.context = null;
    this.status = 'idle';
    this.currentVideo = null;
    this.options = options;
    this.cdpEndpoint = options.cdpEndpoint || null;
    this.logs = [];
    this.retryCount = 0;
    this.maxRetries = 3;
    
    // Per-profile personality (scroll curves, phases, typing) — stable per profileId
    this._personality = createProfilePersonality(profileId);
    this.typingSpeed = this._personality.typingSpeed;
    this.persona = pickPersona(profileId);
    this.ai = new AIBrain(profileId, this.persona.name);
    this._videoBehavior = null;
    this._videoIndex = 0;
    
    // Profile index for traffic source assignment
    const tail = parseInt(profileId.slice(-4), 16);
    this._profileIndex = Number.isFinite(tail) && tail > 0
      ? tail
      : this._personality.pickInt(0, 99);

    // Session-level flags — initialized ONCE per session (not per video)
    // _subscribedThisSession must NOT be reset on every video — subscribe should fire at most once per session
    this._subscribedThisSession = false;
    this._isAndroidProfile = false;
    this._blockRecoveryCount = 0;
    this._maxBlockRecoveries = 2;
    this._sessionSearchQueries = new Set();
    this._searchQueryByVideo = new Map();
    /** One traffic source per worker session (random/custom pick once). */
    this._sessionTrafficSource = null;
    /** Rare direct URL uses this session (max 1). */
    this._trafficSession = { directUrlUses: 0 };

    /** OS label from scheduler / manual control — used for keybindings (e.g. ⌘W). */
    this.profileOs =
      typeof options.profileOs === 'string' && options.profileOs.trim()
        ? options.profileOs.trim()
        : '';

    /** prevent duplicate crash/close listeners on the same tab */
    this._lastPageLifecycle = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  }

  /**
   * Keep `_lastPage` consistent when the Playwright tab closes/crashes (avoids dead handle reuse).
   */
  _attachLastPage(page) {
    try {
      if (!page) return;
      if (typeof page.isClosed === 'function' && page.isClosed()) return;
      this._lastPage = page;
      if (!this._lastPageLifecycle) return;
      if (this._lastPageLifecycle.has(page)) return;
      this._lastPageLifecycle.add(page);
      const detach = () => {
        try {
          if (this._lastPage === page) this._lastPage = null;
        } catch { /* ignore */ }
      };

      page.once('close', detach);
      page.on('crash', detach);
    } catch (e) {
      console.error('[ProfileAgent] _attachLastPage failed:', e && e.message ? e.message : String(e));
    }
  }



  /** Conservative tab hygiene: close only clearly blank/new-tab extras. */
  async _cleanupExtraPages(activePage = null) {
    try {
      if (!this.context) return;
      const pages = this.context.pages().filter((p) => p && (typeof p.isClosed !== 'function' || !p.isClosed()));
      if (pages.length <= 1) return;
      for (const p of pages) {
        if (activePage && p === activePage) continue;
        const url = (p.url && p.url()) || '';
        const blankish = !url || url === 'about:blank' || url.startsWith('chrome://newtab') || url.startsWith('edge://newtab');
        if (blankish) {
          await p.close({ runBeforeUnload: false }).catch(() => {});
        }
      }
    } catch (err) {
      this.log('warn', `[Tabs] cleanup skipped: ${err.message}`);
    }
  }

  /** Lock traffic source for entire session + pass session state to search engine. */
  _buildTrafficSearchOptions(runConfig) {
    const effectiveMix = resolveTrafficMix(runConfig);
    const pref = runConfig.trafficPreference || 'custom';
    if (!this._sessionTrafficSource) {
      this._sessionTrafficSource = assignTrafficSource(
        this._profileIndex,
        30,
        !!runConfig.videoUrl,
        effectiveMix,
        pref,
      );
      this.log('info', `[Traffic] Session locked to: ${this._sessionTrafficSource} (preference: ${pref})`);
    }
    return {
      strictTraffic: !!runConfig.qaTestMode,
      assignedSource: this._sessionTrafficSource,
      sessionState: this._trafficSession,
    };
  }

  async resolveWatchTimeMs(durationMs, config = {}) {
    const idx = this._videoIndex;
    let cfg = { ...config };
    const pMin = this.persona?.watchPercentMin ?? 40;
    const pMax = this.persona?.watchPercentMax ?? 100;
    cfg.watchTimeMin = cfg.watchTimeMin ?? pMin;
    cfg.watchTimeMax = cfg.watchTimeMax ?? pMax;

    if (this.ai?.isEnabled()) {
      const pct = await this.ai.decideWatchPercent(
        this.currentVideo || '',
        Math.max(1, Math.round(durationMs / 1000)),
        idx,
      );
      if (pct != null) {
        cfg.watchTimeMin = pct;
        cfg.watchTimeMax = pct;
        this.log('info', `[AI] Watch target: ${pct}%`);
      }
    }

    return computeWatchTimeMs(durationMs, cfg, this.profileId, this._videoIndex++);
  }

  async _shouldEngage(action, progress, title, config) {
    if (this.ai?.isEnabled()) {
      const ai = await this.ai.decideEngagement(action, progress, title || this.currentVideo || '');
      if (ai !== null) return ai;
    }
    const chance = this.persona?.engageChance ?? 0.25;
    const p = this._personality;
    if (action === 'like') return !!config.likeEnabled && p.chance(chance);
    if (action === 'subscribe') return !!config.subscribeEnabled && p.chance(chance * 0.5);
    if (action === 'comment') return !!config.commentEnabled && p.chance(chance * 0.3);
    return false;
  }

  // FIX Bug 5: accepts retryDepth — clears cached query on retry so a NEW variation is used
  async _prepareAiSessionConfig(videoTitle, channelName, config, retryDepth = 0) {
    const effective = { ...config };
    const videoKey = config.videoId || videoTitle;

    // FIX: On retry, delete the cached query so a fresh (different) variation is generated
    // This prevents the "keyword loop" where every retry uses the same bad search query
    if (retryDepth > 0) {
      this._searchQueryByVideo.delete(videoKey);
      this.log('info', `[Search] Retry #${retryDepth} — generating fresh search query variation`);
    }

    if (this._searchQueryByVideo.has(videoKey)) {
      return { effective, searchTitle: this._searchQueryByVideo.get(videoKey) };
    }

    const avoid = [...this._sessionSearchQueries].slice(-6).join(' | ');
    let searchTitle;

    if (!this.ai?.isEnabled()) {
      // FIX: Use videoIndex + retryDepth as offset so each retry gets a different seed → different words picked
      searchTitle = deriveSearchQuery(videoTitle, channelName, this._videoIndex + retryDepth, this.profileId);
    } else {
      const src = await this.ai.decideTrafficSource(videoTitle, this._lastTrafficSource || '');
      if (src === 'search') effective.trafficPreference = 'search';
      else if (src === 'google') effective.trafficPreference = 'google';
      else if (src === 'direct') effective.trafficPreference = 'direct';
      else if (src === 'homepage') effective.trafficPreference = 'channelPage';

      const aiQuery = await this.ai.decideYouTubeSearchQuery(videoTitle, channelName, avoid);
      searchTitle = aiQuery || deriveSearchQuery(videoTitle, channelName, this._videoIndex + retryDepth, this.profileId);
      if (this._sessionSearchQueries.has(searchTitle.toLowerCase())) {
        searchTitle = deriveSearchQuery(videoTitle, channelName, this._videoIndex + retryDepth + 1, this.profileId);
      }
      this._videoBehavior = await this.ai.decideVideoBehavior(
        videoTitle,
        this._videoIndex,
        config.sessionVideoCount || 5,
      );
    }

    this._searchQueryByVideo.set(videoKey, searchTitle);
    this._sessionSearchQueries.add(searchTitle.toLowerCase());
    this.log('info', `Search query: "${searchTitle}" → video: "${videoTitle.slice(0, 50)}"`);

    return { effective, searchTitle };
  }

  /**
   * Sign-in / captcha wall → clear cache or recreate via worker callback.
   */
  async recoverFromPageBlock(page, reason = 'block') {
    // In 24/7 mode, sign-in wall means the profile is logged out — go straight to recreate
    // via the recycle manager instead of the local clear_cache/recreate flow.
    if (reason === 'signin' && this.options.onSignInRequired) {
      this.log('warn', 'Sign-in wall detected — delegating recreate to 24/7 manager');
      try { await this.disconnect().catch(() => {}); } catch {}
      await this.options.onSignInRequired({ profileId: this.profileId });
      return false;
    }

    if (this._blockRecoveryCount >= this._maxBlockRecoveries) {
      this.log('error', `Max block recoveries (${this._maxBlockRecoveries}) reached`);
      return false;
    }
    if (!this.options.onRecoverProfile) {
      this.log('warn', 'No recovery handler — cannot clear cache / recreate');
      return false;
    }

    const strategy = this._blockRecoveryCount === 0 ? 'clear_cache' : 'recreate';
    this._blockRecoveryCount++;
    this.log('warn', `[Recovery ${this._blockRecoveryCount}] ${reason} → ${strategy}`);

    try {
      await this.disconnect().catch(() => {});
    } catch {}

    const result = await this.options.onRecoverProfile({
      profileId: this.profileId,
      strategy,
      profileName: this.profileName,
    });

    if (!result?.ok || !result.cdpPort) {
      this.log('error', `Recovery failed: ${result?.message || 'unknown'}`);
      return false;
    }

    if (result.profileId && result.profileId !== this.profileId) {
      this.log('info', `Profile ID updated after recreate: ${this.profileId} → ${result.profileId}`);
      this.profileId = result.profileId;
    }

    this.debugPort = result.cdpPort;
    this._warmedUp = false;
    this._lastPage = null;
    const connected = await this.connect();
    if (connected) {
      this.log('success', `Reconnected after recovery on port ${this.debugPort}`);
    }
    return connected;
  }

  async ensurePageNotBlocked(page, config) {
    const block = await detectPageBlock(page);
    if (!block.blocked) return true;
    this.log('warn', `Page block (${block.kind}): ${block.message}`);
    const recovered = await this.recoverFromPageBlock(page, block.kind);
    if (!recovered) return false;
    return true;
  }

  log(level, message) {
    const entry = { time: new Date().toISOString(), level, message, profileId: this.profileId };
    this.logs.push(entry);
    if (this.logs.length > 50) this.logs = this.logs.slice(-50);
    console.log(`[${this.profileName}] [${level}] ${message}`);
    // Forward to worker thread → main process → frontend UI
    if (this.options.onLog) this.options.onLog(level, message);
    return entry;
  }

  async connect() {
    this.status = 'connecting';
    const endpoint = this.cdpEndpoint || `http://127.0.0.1:${this.debugPort}`;
    this.log('info', `Connecting to CDP at ${endpoint}...`);
    try {
      this.browser = await chromium.connectOverCDP(endpoint);
      this.context = this.browser.contexts()[0];
      if (!this.context) this.context = await this.browser.newContext();
      this.status = 'running';
      this.log('success', `Connected! CDP: ${endpoint}`);
      return true;
    } catch (err) {
      this.status = 'error';
      this.log('error', `CDP connection failed: ${err.message}`);
      return false;
    }
  }

  /** Multilogin browser needs several seconds after launcher start before CDP accepts connections. */
  async connectWithRetry(maxAttempts = 10, delayMs = 4000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (await this.connect()) return true;
      if (attempt < maxAttempts) {
        this.log('warn', `CDP not ready (${attempt}/${maxAttempts}) — retry in ${Math.round(delayMs / 1000)}s...`);
        await sleep(delayMs);
      }
    }
    return false;
  }

  /**
   * Quick CDP health probe before heavy navigation (cheap best-effort).
   * Does not recreate browser — worker/recovery owns full reconnect.
   */
  async _pingBrowserAlive() {
    try {
      if (!this.browser || !this.context) return false;
      const probe = this.context.pages()[0];
      if (!probe || probe.isClosed()) return false;
      await Promise.race([
        probe.evaluate(() => document.documentElement && 1),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 5000)),
      ]);
      return true;
    } catch (err) {
      this.log('warn', `[CDP] ping failed — ${err.message}`);
      return false;
    }
  }

  // WARMUP — Browse homepage + maybe watch 1-2 shorts (like real user)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // WARMUP: High-CPM site pool for pre-YouTube browsing
  // Each profile gets 1-2 different sites based on profile ID seeding.
  // Categories: Finance / Tech / News / Shopping / Health — high ad-value signals.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  static _HIGH_CPM_POOL = [
    // Finance (highest CPM — $15-50 CPM range)
    { url: 'https://www.bankrate.com/', label: 'Bankrate', timeMs: [8000, 18000] },
    { url: 'https://www.nerdwallet.com/', label: 'NerdWallet', timeMs: [7000, 16000] },
    { url: 'https://www.investopedia.com/', label: 'Investopedia', timeMs: [8000, 20000] },
    { url: 'https://www.creditkarma.com/', label: 'CreditKarma', timeMs: [7000, 15000] },
    // Tech / Gadgets ($8-20 CPM)
    { url: 'https://www.techcrunch.com/', label: 'TechCrunch', timeMs: [6000, 14000] },
    { url: 'https://www.theverge.com/', label: 'The Verge', timeMs: [6000, 13000] },
    { url: 'https://www.cnet.com/', label: 'CNET', timeMs: [7000, 15000] },
    { url: 'https://www.wired.com/', label: 'Wired', timeMs: [6000, 13000] },
    // Business / News ($10-25 CPM)
    { url: 'https://www.forbes.com/', label: 'Forbes', timeMs: [7000, 16000] },
    { url: 'https://www.businessinsider.com/', label: 'BusinessInsider', timeMs: [6000, 14000] },
    { url: 'https://www.reuters.com/', label: 'Reuters', timeMs: [5000, 12000] },
    { url: 'https://www.bbc.com/news', label: 'BBC News', timeMs: [5000, 12000] },
    // Shopping ($5-15 CPM — signals buying intent)
    { url: 'https://www.amazon.com/deals', label: 'Amazon Deals', timeMs: [7000, 18000] },
    { url: 'https://www.bestbuy.com/', label: 'BestBuy', timeMs: [6000, 14000] },
    // Health ($10-30 CPM — insurance/pharma ad buyers)
    { url: 'https://www.webmd.com/', label: 'WebMD', timeMs: [6000, 15000] },
    { url: 'https://www.healthline.com/', label: 'Healthline', timeMs: [6000, 14000] },
  ];

  /**
   * Pick 1-2 high-CPM sites for this profile (deterministic per profile ID).
   * Different profiles always get different sites.
   * @returns {{ url: string, label: string, timeMs: number[] }[]}
   */
  _pickWarmupSites() {
    const pool = ProfileAgent._HIGH_CPM_POOL;
    // Use last 8 hex chars of profileId as seed integer (deterministic per profile)
    const tail = parseInt((this.profileId || '').slice(-8) || '0', 16) || 0;
    const idx1 = tail % pool.length;
    const idx2 = (tail + 5) % pool.length; // offset by 5 to ensure different site
    const count = (tail % 3 === 0) ? 2 : 1; // ~33% of profiles visit 2 sites, rest visit 1
    if (count === 2 && idx1 !== idx2) {
      return [pool[idx1], pool[idx2]];
    }
    return [pool[idx1]];
  }

  async warmup(_runConfig = {}) {
    // Warmup removed — profiles go directly to YouTube
    return;

    this.log('info', 'Warmup: Starting pre-YouTube browsing...');
    this.status = 'warmup';

    try {
      const page = this.context.pages()[0] || await this.context.newPage();
      this._attachLastPage(page);

      // Detect Android/mobile profile via User-Agent BEFORE navigating anywhere
      const isAndroid = await isAndroidUA(page);
      if (isAndroid) {
        this.log('info', 'Warmup: Android profile detected — using mobile YouTube (m.youtube.com)');
        this._isAndroidProfile = true;
      }

      // ── Phase 1: High-CPM site browsing (desktop only — mobile profile goes direct to YT) ──
      // Each profile visits 1-2 unique high-CPM sites to seed ad-interest signals.
      if (!isAndroid) {
        const sites = this._pickWarmupSites();
        for (const site of sites) {
          try {
            this.log('info', `Warmup: Browsing ${site.label} (high-CPM signal)...`);
            const navOk = await typeUrlInAddressBar(page, site.url, this.typingSpeed);
            if (!navOk) {
              await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            }
            await page.waitForLoadState('domcontentloaded', { timeout: 18000 }).catch(() => {});

            // Read page like a human: mouse move + scroll + wait
            await humanMouseMove(page);
            const readTime = randomDelay(site.timeMs[0], site.timeMs[1]);
            await sleep(Math.floor(readTime * 0.4));
            await smoothScroll(page, randomDelay(150, 400), 'down', this._personality);
            await sleep(Math.floor(readTime * 0.35));
            await smoothScroll(page, randomDelay(80, 250), 'down', this._personality);
            await sleep(Math.floor(readTime * 0.25));
          } catch (siteErr) {
            this.log('warn', `Warmup: ${site.label} skipped — ${siteErr.message.split('\n')[0]}`);
          }
        }
      }

      // ── Phase 2: Navigate to YouTube homepage ──
      const ytHome = isAndroid ? 'https://m.youtube.com' : 'https://www.youtube.com';
      this.log('info', 'Warmup: Navigating to YouTube...');
      const warmupNavOk = await typeUrlInAddressBar(page, ytHome, this.typingSpeed);
      if (!warmupNavOk) {
        await page.goto(ytHome, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await sleep(randomDelay(2000, 4000));

      // Dark theme only works on desktop YouTube
      if (!isAndroid) await forceDarkTheme(page);

      // Browse homepage (scroll around like real user)
      await humanMouseMove(page);
      await sleep(randomDelay(2000, 4000));
      await smoothScroll(page, randomDelay(200, 400), 'down');
      await sleep(randomDelay(3000, 6000));
      await smoothScroll(page, randomDelay(100, 300), 'down');
      await sleep(randomDelay(2000, 5000));
      await smoothScroll(page, randomDelay(200, 400), 'up');
      await sleep(randomDelay(1000, 3000));

      // 40% chance: Watch 1-3 Shorts — desktop AND mobile (Android uses m.youtube.com/shorts)
      if (this._personality.chance(0.4)) {
        try {
          this.log('info', 'Warmup: Watching a few Shorts...');
          const shortsUrl = isAndroid ? 'https://m.youtube.com/shorts' : 'https://www.youtube.com/shorts';
          const homeUrl  = isAndroid ? 'https://m.youtube.com' : 'https://www.youtube.com';
          const shortsNavOk = await typeUrlInAddressBar(page, shortsUrl, this.typingSpeed);
          if (!shortsNavOk) await page.goto(shortsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
          await sleep(randomDelay(2000, 4000));
          const shortsCount = randomDelay(1, 3);
          for (let i = 0; i < shortsCount; i++) {
            await sleep(randomDelay(5000, 15000)); // Watch short
            if (isAndroid) {
              // Mobile: swipe up via touch event to go to next short
              await page.evaluate(() => {
                const el = document.querySelector('ytm-shorts-player-renderer, ytm-shorts-video-renderer, video') || document.body;
                const rect = el.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                el.dispatchEvent(new TouchEvent('touchstart', { touches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy })], bubbles: true }));
                el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [new Touch({ identifier: 1, target: el, clientX: cx, clientY: cy - 200 })], bubbles: true }));
              }).catch(() => {});
              // Fallback: ArrowDown also works in Chromium even with Android UA
              await page.keyboard.press('ArrowDown').catch(() => {});
            } else {
              await page.keyboard.press('ArrowDown'); // Desktop: next short
            }
            await sleep(randomDelay(500, 1500));
          }
          // Go back to homepage
          const backNavOk = await typeUrlInAddressBar(page, homeUrl, this.typingSpeed);
          if (!backNavOk) await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
          await sleep(randomDelay(2000, 4000));
        } catch (shortsErr) {
          // Shorts failed — recover by going back to YouTube homepage
          this.log('warn', `Warmup Shorts skipped: ${shortsErr.message.split('\n')[0]}`);
          try {
            const homeUrl = isAndroid ? 'https://m.youtube.com' : 'https://www.youtube.com';
            const recoverNavOk = await typeUrlInAddressBar(page, homeUrl, this.typingSpeed);
            if (!recoverNavOk) await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
            await sleep(1000);
          } catch {
            // Page is unrecoverable — clear _lastPage so searchAndWatch opens a fresh page
            this.log('warn', 'Warmup: page unrecoverable — will open fresh page for video');
            this._lastPage = null;
          }
        }
      }

      this.log('success', 'Warmup complete — ready to watch videos');
    } catch (err) {
      this.log('warn', `Warmup failed (non-critical): ${err.message.split('\n')[0]}`);
      // Clear broken page reference so searchAndWatch always starts fresh
      this._lastPage = null;
    }
  }

  // Main watch function with traffic routing + engagement
  async searchAndWatch(videoTitle, channelName, config = {}, _retryDepth = 0) {
    if (!this.context) { this.log('error', 'No browser context'); return false; }
    if (!(await this._pingBrowserAlive())) {
      this.log('error', 'Browser/CDP ping failed — cannot run search/watch safely');
      return false;
    }

    // Reset per-video flags (like/comment are per-video, subscribe is per-SESSION so NOT reset here)
    this._likedThisVideo = false;
    this._commentedThisVideo = false;
    this._dislikedThisVideo = false;
    this._seekedForward = false;
    this._seekForwardCount = 0;
    this._descriptionOpened = false;
    this._relatedHovered = false;
    this._qaScrolledEarly = false;

    this.currentVideo = videoTitle;
    this.status = 'searching';
    // FIX Bug 5: pass _retryDepth so retry generates a different search query
    const { effective: effectiveConfig, searchTitle } = await this._prepareAiSessionConfig(videoTitle, channelName, config, _retryDepth);
    const runConfig = { ...config, ...effectiveConfig };
    const trafficType = runConfig.trafficPreference || 'search';
    this.log('info', `[${trafficType}] Query: "${searchTitle}" | Persona: ${this.persona.name} | AI: ${this.ai.isEnabled() ? 'on' : 'off'}`);

    // SESSION PERSISTENCE: Reuse existing page instead of opening new one every time
    // If _lastPage was cleared (e.g. warmup failed) always open a fresh page
    let page;
    try {
      const existingPages = this.context.pages();
      if (this._lastPage && existingPages.includes(this._lastPage)) {
        // Verify page is still alive (not crashed/closed)
        try {
          await this._lastPage.evaluate(() => true);
          page = this._lastPage;
        } catch {
          // Page is dead — create new one
          page = await this.context.newPage();
          this._attachLastPage(page);
        }
      } else if (!this._lastPage) {
        // Warmup cleared _lastPage — always open fresh page (avoid reusing broken pages)
        page = await this.context.newPage();
        this._attachLastPage(page);
      } else {
        page = existingPages.length > 0 ? existingPages[existingPages.length - 1] : await this.context.newPage();
        this._attachLastPage(page);
      }
    } catch {
      // Context might be broken — try new page
      page = await this.context.newPage();
      this._attachLastPage(page);
    }

    await this._cleanupExtraPages(page);

    try {
      // MOBILE DETECTION: Check User-Agent first — most reliable signal.
      // Antidetect browsers may not auto-redirect www.youtube.com → m.youtube.com
      // even for Android profiles, so URL-based detection alone is unreliable.
      //
      // Use cached result from warmup if available (avoids repeat UA evaluation)
      const isAndroid = this._isAndroidProfile || await isAndroidUA(page);
      if (isAndroid) this._isAndroidProfile = true; // cache for future videos

      if (isAndroid) {
        // Android profile: force navigation to mobile YouTube if not already there
        const currentUrl = page.url();
        if (!currentUrl.includes('m.youtube.com')) {
          this.log('info', '[Mobile] Navigating to m.youtube.com for Android profile...');
          await page.goto('https://m.youtube.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await sleep(randomDelay(1000, 2000));
        }
      } else {
        // Desktop profile: apply dark theme and check if somehow mobile
        await forceDarkTheme(page);
        const currentUrl = page.url();
        if (!currentUrl.includes('youtube.com') && !currentUrl.includes('google.com') && !currentUrl.includes('bing.com')) {
          // Fresh page — navigate to YouTube via address bar typing (human behavior)
          const desktopNavOk = await typeUrlInAddressBar(page, 'https://www.youtube.com', this.typingSpeed);
          if (!desktopNavOk) await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
          await sleep(randomDelay(800, 1500));
        }
      }

      const isMobile = isAndroid || await isMobileYouTube(page);

      const useBacklink = String(runConfig.trafficPreference || '').toLowerCase() === 'backlink'
        || !!runConfig.backlinkData?.sourceUrl;

      let searchResult;
      if (useBacklink) {
        if (!(await this.ensurePageNotBlocked(page, runConfig))) {
          return false;
        }
        searchResult = await openVideoViaBacklink(
          page,
          videoTitle,
          channelName,
          runConfig.videoUrl || '',
          runConfig.backlinkData,
          (level, msg) => this.log(level, msg),
        );
        if (!searchResult?.success && _retryDepth < this.maxRetries) {
          this.log('warn', '[Backlink] Referral failed — trying locked traffic source…');
          const effectiveMix = resolveTrafficMix(runConfig);
          searchResult = await openVideoSmart(
            page,
            videoTitle,
            channelName,
            runConfig.videoUrl || '',
            runConfig.expectedDuration || 0,
            this._profileIndex || 0,
            (p, text) => humanType(p, text, this.typingSpeed),
            (level, msg) => this.log(level, msg),
            effectiveMix,
            runConfig.trafficPreference === 'backlink' ? 'search' : (runConfig.trafficPreference || 'custom'),
            { ...this._buildTrafficSearchOptions(runConfig), searchQuerySeed: searchTitle },
          );
        }
      } else if (isMobile) {
        const trafficOpts = this._buildTrafficSearchOptions(runConfig);
        const locked = trafficOpts.assignedSource || 'youtube-search';
        this.log('info', `[Mobile] Android profile — locked traffic: ${locked}`);
        if (!(await this.ensurePageNotBlocked(page, runConfig))) {
          return false;
        }
        const effectiveMix = resolveTrafficMix(runConfig);
        if (locked === 'youtube-search' || locked === 'channel-page') {
          let mobileSuccess = await mobileYouTubeSearch(page, searchTitle, channelName, (level, msg) => this.log(level, msg));
          if (!mobileSuccess) {
            this.log('warn', '[Mobile] YouTube UI search failed — exact title + scroll via search engine...');
            searchResult = await openVideoSmart(
              page,
              videoTitle,
              channelName,
              runConfig.videoUrl || '',
              runConfig.expectedDuration || 0,
              this._profileIndex || 0,
              (p, text) => humanType(p, text, this.typingSpeed),
              (level, msg) => this.log(level, msg),
              effectiveMix,
              'youtube-search',
              { ...trafficOpts, assignedSource: 'youtube-search', searchQuerySeed: searchTitle },
            );
            mobileSuccess = !!searchResult?.success;
          }
          if (!searchResult) {
            searchResult = { success: mobileSuccess, source: 'mobile-youtube-search', intendedSource: locked };
          }
        } else {
          searchResult = await openVideoSmart(
            page,
            videoTitle,
            channelName,
            runConfig.videoUrl || '',
            runConfig.expectedDuration || 0,
            this._profileIndex || 0,
            (p, text) => humanType(p, text, this.typingSpeed),
            (level, msg) => this.log(level, msg),
            effectiveMix,
            locked,
            { ...trafficOpts, searchQuerySeed: searchTitle },
          );
        }
      } else {
        // DESKTOP: single locked traffic source — no cross-engine fallback
        const effectiveMix = resolveTrafficMix(runConfig);
        if (!(await this.ensurePageNotBlocked(page, runConfig))) {
          return false;
        }

        searchResult = await openVideoSmart(
          page,
          videoTitle,
          channelName,
          runConfig.videoUrl || '',
          runConfig.expectedDuration || 0,
          this._profileIndex || 0,
          (p, text) => humanType(p, text, this.typingSpeed),
          (level, msg) => this.log(level, msg),
          effectiveMix,
          runConfig.trafficPreference || 'custom',
          { ...this._buildTrafficSearchOptions(runConfig), searchQuerySeed: searchTitle },
        );
      }

      if (searchResult?.blocked && _retryDepth < this.maxRetries) {
        const recovered = await this.recoverFromPageBlock(page, searchResult.blockKind || 'blocked');
        if (recovered) {
          return await this.searchAndWatch(videoTitle, channelName, config, _retryDepth + 1);
        }
      }

      if (!searchResult || !searchResult.success) {
        if (searchResult?.skipped) {
          this.log('warn', `[Traffic] Skipping video — "${videoTitle}" (source: ${searchResult.intendedSource || searchResult.source})`);
          return false;
        }
        this.log('error', `Could not open video: "${videoTitle}"${searchResult?.verifyReason ? ` (${searchResult.verifyReason})` : ''}`);
        // Auto-recovery: retry with different approach
        if (_retryDepth < this.maxRetries) {
          this.log('warn', `Retrying (${_retryDepth + 1}/${this.maxRetries})...`);
          await sleep(randomDelay(3000, 8000));
          return await this.searchAndWatch(videoTitle, channelName, config, _retryDepth + 1);
        }
        return false;
      }
      
      // Track which source was used (for analytics)
      this._lastTrafficSource = searchResult.source;
      if (searchResult.intendedSource && searchResult.source !== searchResult.intendedSource) {
        this.log(
          'warn',
          `[Traffic] Intended: ${searchResult.intendedSource} → Actual: ${searchResult.source}${searchResult.usedFallback ? ' (fallback)' : ''}${searchResult.query ? ` | query: "${searchResult.query}"` : ''}`,
        );
      } else {
        this.log('success', `[Traffic] Opened via: ${searchResult.source}${searchResult.query ? ` | query: "${searchResult.query}"` : ''}`);
      }

      const postVerify = await verifyOpenedVideo(page, {
        title: videoTitle,
        channelName,
        videoUrl: config.videoUrl || '',
        videoId: config.videoId || (config.videoUrl || '').match(/[?&]v=([^&]+)/)?.[1] || '',
      });
      let verified = postVerify;
      if (!verified.ok) {
        const vid = config.videoId || (config.videoUrl || '').match(/[?&]v=([^&]+)/)?.[1] || '';
        if (vid && config.videoUrl) {
          this.log('warn', `[Verify] Wrong video (${verified.reason}) — direct URL recovery...`);
          try {
            await page.goto(config.videoUrl, { waitUntil: 'commit', timeout: 30000 });
            await sleep(randomDelay(2000, 4000));
            verified = await verifyOpenedVideo(page, {
              title: videoTitle,
              channelName,
              videoUrl: config.videoUrl,
              videoId: vid,
            });
          } catch (err) {
            this.log('warn', `[Verify] URL recovery failed: ${err.message}`);
          }
        }
      }
      if (!verified.ok) {
        this.log('error', `Wrong video after open (${verified.reason}) — "${verified.actual?.title}"`);
        if (_retryDepth < this.maxRetries) {
          await sleep(randomDelay(2000, 5000));
          return await this.searchAndWatch(videoTitle, channelName, config, _retryDepth + 1);
        }
        return false;
      }

      if (!(await this.ensurePageNotBlocked(page, config))) {
        return false;
      }

      // Install ad skipper early (runs as background interval)
      await VideoWatcher.ensureYouTubeAdSkipper(page, runConfig);
      await sleep(randomDelay(3000, 6000));
      await dismissYouTubePopups(page, (l, m) => this.log(l, m));
      await forceDarkTheme(page);
      await overridePageVisibility(page);

      this.status = 'watching';
      this.log('success', `Now watching: "${videoTitle}"`);

      // getVideoDuration handles pre-roll ads first (waitForAdsToClear inside)
      // Autoplay + quality are set AFTER ads finish — they apply to the actual video
      const duration = await this.getVideoDuration(page, runConfig);
      await ensureAutoplayOff(page, (l, m) => this.log(l, m));
      await ensureVideoQuality(page, this._videoBehavior?.quality || runConfig.videoQuality, (l, m) => this.log(l, m));

      let { watchTime, watchPercent } = await this.resolveWatchTimeMs(duration, runConfig);
      watchTime = await this._adjustWatchForPosition(page, duration, watchTime, watchPercent);
      this.log(
        'info',
        `Duration: ${Math.round(duration / 1000)}s — Profile watch ${watchPercent}% (${runConfig.watchTimeMin}–${runConfig.watchTimeMax}% range) = ${Math.round(watchTime / 1000)}s`,
      );

      await this.watchVideo(page, watchTime, runConfig);

      this.log('success', `Finished: "${videoTitle}" (${watchPercent}%)`);
      
      // Track view + watch time in analytics
      await trackEngagement(this.profileId, 'view').catch(() => {});
      await trackEngagement(this.profileId, 'watchTime', Math.round(watchTime / 1000)).catch(() => {});
      await trackEngagement(this.profileId, 'session').catch(() => {});
      // Track traffic source (youtube-search, google, bing, direct, channel-page)
      if (this._lastTrafficSource) {
        await trackEngagement(this.profileId, `traffic_${this._lastTrafficSource}`).catch(() => {});
      }
      
      // Track in watch history (prevents repeat)
      await this.trackWatchHistory(videoTitle, watchPercent, config.videoId || '').catch(() => {});
      
      // Don't close page — reuse for next video (session persistence); close blank extra tabs only
      await this._cleanupExtraPages(page);
      return true;
    } catch (err) {
      this.log('error', `Error: ${err.message}`);
      // Already on correct video — retry watch only, don't restart search mid-playback
      if (_retryDepth < this.maxRetries) {
        try {
          const expectedId = (config.videoId || '').trim()
            || (config.videoUrl || '').match(/[?&]v=([^&]+)/)?.[1]
            || '';
          const pageUrl = this._lastPage?.url() || '';
          const onCorrectVideo = expectedId && pageUrl.includes(expectedId);
          if (onCorrectVideo && this._lastPage) {
            this.log('warn', `Watch-phase retry (${_retryDepth + 1}/${this.maxRetries}) — staying on current video`);
            await sleep(randomDelay(3000, 6000));
            const duration = await this.getVideoDuration(this._lastPage, runConfig);
            let { watchTime, watchPercent } = await this.resolveWatchTimeMs(duration, runConfig);
            watchTime = await this._adjustWatchForPosition(this._lastPage, duration, watchTime, watchPercent);
            await this.watchVideo(this._lastPage, watchTime, runConfig);
            this.log('success', `Finished: "${videoTitle}" (${watchPercent}%)`);
            return true;
          }
        } catch { /* fall through to full retry */ }
        this.log('warn', `Auto-recovery retry (${_retryDepth + 1}/${this.maxRetries})...`);
        await sleep(randomDelay(5000, 10000));
        return await this.searchAndWatch(videoTitle, channelName, config, _retryDepth + 1);
      }
      return false;
    }
  }

  async watchByUrl(videoUrl, config = {}) {
    if (!this.context) { this.log('error', 'No browser context'); return false; }

    // WARMUP: First video of session
    // Reset per-video flags (subscribe is per-SESSION so NOT reset here)
    this._likedThisVideo = false;
    this._commentedThisVideo = false;
    this._dislikedThisVideo = false;
    this._seekedForward = false;
    this._seekForwardCount = 0;
    this._descriptionOpened = false;
    this._relatedHovered = false;
    this._qaScrolledEarly = false;

    this.currentVideo = videoUrl;
    this.status = 'watching';
    try {
      // Reuse existing page (session persistence) instead of new page every time
      let page;
      try {
        const existingPages = this.context.pages();
        if (this._lastPage && existingPages.includes(this._lastPage)) {
          try { await this._lastPage.evaluate(() => true); page = this._lastPage; } catch {}
        }
        if (!page) {
          page = existingPages.length > 0 ? existingPages[existingPages.length - 1] : await this.context.newPage();
          this._attachLastPage(page);
        }
      } catch {
        page = await this.context.newPage();
        this._attachLastPage(page);
      }

      await this._cleanupExtraPages(page);
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(randomDelay(3000, 6000));

      if (!(await this.ensurePageNotBlocked(page, config))) {
        return false;
      }

      const directVerify = await verifyOpenedVideo(page, {
        videoUrl,
        title: config.expectedTitle || '',
        channelName: config.channelName || '',
      });
      if (!directVerify.ok && config.expectedTitle) {
        this.log('error', `Direct URL wrong video (${directVerify.reason})`);
        return false;
      }

      await forceDarkTheme(page);
      await dismissYouTubePopups(page, (l, m) => this.log(l, m));
      await overridePageVisibility(page);

      // getVideoDuration handles pre-roll ads first
      // Autoplay + quality set AFTER ads — they apply to actual video, not ad
      const duration = await this.getVideoDuration(page, config);
      await ensureAutoplayOff(page, (l, m) => this.log(l, m));
      await ensureVideoQuality(page, config.videoQuality, (l, m) => this.log(l, m));

      let { watchTime, watchPercent } = await this.resolveWatchTimeMs(duration, config);
      watchTime = await this._adjustWatchForPosition(page, duration, watchTime, watchPercent);
      if (config.qaTestMode) {
        this.log('info', `[QA] Watch target: ${Math.round(watchTime / 1000)}s (${watchPercent}% + QA cap)`);
      } else {
        this.log(
          'info',
          `Duration: ${Math.round(duration / 1000)}s — Profile watch ${watchPercent}% (${config.watchTimeMin}–${config.watchTimeMax}%) = ${Math.round(watchTime / 1000)}s`,
        );
      }

      // BUG FIX: Pass config to watchVideo (was missing — ad skip, scroll etc. were ignored)
      // BUG FIX: Removed duplicate performEngagement — watchVideo phases handle engagement
      await this.watchVideo(page, watchTime, config);

      // Track analytics
      await trackEngagement(this.profileId, 'view').catch(() => {});
      await trackEngagement(this.profileId, 'watchTime', Math.round(watchTime / 1000)).catch(() => {});
      await trackEngagement(this.profileId, 'session').catch(() => {});

      const title = config.expectedTitle || videoUrl;
      await this.trackWatchHistory(title, watchPercent, config.videoId || '').catch(() => {});
      await this._cleanupExtraPages(page);

      return true;
    } catch (err) {
      this.log('error', `URL watch error: ${err.message}`);
      return false;
    }
  }

  async _adjustWatchForPosition(page, durationMs, watchTimeMs, watchPercent) {
    try {
      const state = await VideoWatcher.getVideoPlaybackState(page);
      if (!state.ok || !state.duration || state.duration < 10) return watchTimeMs;
      const watchedPct = (state.currentTime / state.duration) * 100;
      // Only trust position if video has played for > 10s
      // (avoids false "already watched" from buffering or ad-phase currentTime)
      if (state.currentTime > 10 && watchedPct >= watchPercent - 5) {
        this.log('info', `Video already at ${Math.round(watchedPct)}% @ ${Math.round(state.currentTime)}s (target ${watchPercent}%) — no extra watch needed`);
        return 0;
      }
      const remainingPct = Math.max(0, watchPercent - watchedPct);
      const adjusted = Math.round((durationMs * remainingPct) / 100);
      if (adjusted < watchTimeMs) {
        this.log('info', `Adjusting watch: ${Math.round(watchTimeMs / 1000)}s → ${Math.round(adjusted / 1000)}s (already at ${Math.round(state.currentTime)}s)`);
        return adjusted;
      }
    } catch { /* keep original */ }
    return watchTimeMs;
  }

  async disconnect() {
    try {
      if (this.context) {
        const pages = this.context.pages().filter((p) => p && (typeof p.isClosed !== 'function' || !p.isClosed()));
        for (const p of pages) {
          await VideoWatcher.clearYouTubePageAdIntervals(p);
        }
      }
    } catch (e) {
      console.error('[ProfileAgent] disconnect cleanup:', e && e.message ? e.message : String(e));
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
    }
    this._lastPage = null;
    this.status = 'done';
    this.log('info', 'Agent disconnected');
  }

  getStatus() {
    return { profileId: this.profileId, profileName: this.profileName, status: this.status, currentVideo: this.currentVideo, logs: this.logs.slice(-20) };
  }

  // Track watch history to backend (prevents same video repeat on same profile)
  async trackWatchHistory(videoTitle, watchPercent, videoId = '') {
    await postInternalJson('/api/history/add', {
      profileId: this.profileId,
      videoTitle,
      watchPercent,
      videoId: videoId || undefined,
    }).catch(() => {});
    if (videoId) {
      await postInternalJson('/api/watch-history/add', {
        profileId: this.profileId,
        videoId,
        videoTitle,
      }).catch(() => {});
    }
  }
}

VideoWatcher.mixinProfileAgent(ProfileAgent);

module.exports = { ProfileAgent };
