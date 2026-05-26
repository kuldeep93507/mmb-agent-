'use strict';

/**
 * Agent brain — page checks, config normalization, watch-time decisions.
 * Rule-based (no LLM): sign-in/captcha detection, post-open verify, traffic prefs, scroll plan.
 */

const { verifyVideoMatch } = require('./utils/videoMatch.cjs');

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractVideoIdFromUrl(url) {
  if (!url) return '';
  const m = String(url).match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : '';
}

/**
 * Map Profile Settings trafficPreference → effective trafficMix (when not "custom").
 */
function resolveTrafficMix(config = {}) {
  const pref = String(config.trafficPreference || 'custom').toLowerCase();
  const base = config.trafficMix && typeof config.trafficMix === 'object'
    ? { ...config.trafficMix }
    : {
      youtubeSearch: 50,
      channelPage: 15,
      google: 15,
      bing: 5,
      duckduckgo: 5,
      yahoo: 5,
      direct: 5,
    };

  switch (pref) {
    case 'search':
      return { youtubeSearch: 100, channelPage: 0, google: 0, bing: 0, duckduckgo: 0, yahoo: 0, direct: 0 };
    case 'google':
      return { youtubeSearch: 0, channelPage: 0, google: 100, bing: 0, duckduckgo: 0, yahoo: 0, direct: 0 };
    case 'bing':
      return { youtubeSearch: 0, channelPage: 0, google: 0, bing: 100, duckduckgo: 0, yahoo: 0, direct: 0 };
    case 'duckduckgo':
      return { youtubeSearch: 0, channelPage: 0, google: 0, bing: 0, duckduckgo: 100, yahoo: 0, direct: 0 };
    case 'yahoo':
      return { youtubeSearch: 0, channelPage: 0, google: 0, bing: 0, duckduckgo: 0, yahoo: 100, direct: 0 };
    case 'direct':
      return { youtubeSearch: 0, channelPage: 0, google: 0, bing: 0, duckduckgo: 0, yahoo: 0, direct: 100 };
    case 'suggested':
      return { youtubeSearch: 30, channelPage: 70, google: 0, bing: 0, duckduckgo: 0, yahoo: 0, direct: 0 };
    case 'backlink':
      return { youtubeSearch: 0, channelPage: 0, google: 0, bing: 0, duckduckgo: 0, yahoo: 0, direct: 0 };
    case 'random':
      return null; // assignTrafficSource uses full random list
    case 'custom':
    default:
      return base;
  }
}

/**
 * Build worker/orchestrator config from schedule profile row + schedule defaults.
 */
function buildAgentConfig(profileConfig = {}, scheduleDefaults = {}) {
  const pc = profileConfig || {};
  const delayMin = pc.startDelayMin != null ? pc.startDelayMin : (scheduleDefaults.profileDelayMin ?? 5);
  const delayMax = pc.startDelayMax != null ? pc.startDelayMax : (scheduleDefaults.profileDelayMax ?? 20);

  const trafficPreference = pc.trafficPreference || 'custom';
  const trafficMix = resolveTrafficMix({ trafficPreference, trafficMix: pc.trafficMix });

  return {
    trafficPreference,
    trafficMix,
    watchTimeMin: pc.watchTimeMin ?? 70,
    watchTimeMax: pc.watchTimeMax ?? 100,
    likeEnabled: !!pc.likeEnabled,
    likeDailyCap: pc.likeDailyCap ?? 5,
    subscribeEnabled: !!pc.subscribeEnabled,
    subscribeDailyCap: pc.subscribeDailyCap ?? 1,
    commentEnabled: !!pc.commentEnabled,
    commentDailyCap: pc.commentDailyCap ?? 3,
    commentText: (pc.commentText && String(pc.commentText).trim())
      ? String(pc.commentText).trim()
      : (scheduleDefaults.commentText || ''),
    tabDelayMin: scheduleDefaults.tabDelayMin ?? 30,
    tabDelayMax: scheduleDefaults.tabDelayMax ?? 120,
    adSkipEnabled: pc.adSkipEnabled !== undefined ? pc.adSkipEnabled : true,
    adSkipAfterSec: pc.adSkipAfterSec ?? 15,
    midRollAdWaitSec: pc.midRollAdWaitSec ?? 15,
    videoQuality: pc.videoQuality || 'auto',
    scrollDuringWatch: pc.scrollDuringWatch !== undefined ? pc.scrollDuringWatch : true,
    humanEngagementEnabled: pc.humanEngagementEnabled !== false,
    seekForwardMax: pc.seekForwardMax ?? 2,
    startDelayMin: delayMin,
    startDelayMax: delayMax,
    browserType: pc.browserType,
    /** QA: force like/comment/seek/dislike, shorter watch %, verbose logs */
    qaTestMode: !!pc.qaTestMode || !!scheduleDefaults.qaTestMode,
    dislikeEnabled: !!pc.dislikeEnabled,
    seekForwardSec: pc.seekForwardSec ?? 10,
    qaMinWatchSec: pc.qaMinWatchSec ?? 90,
    qaMaxWatchSec: pc.qaMaxWatchSec ?? 600,
    /** Wall-clock ceiling for aggregated ad bursts (many mid-rolls); default 300s */
    maxAdsTimeoutSec: pc.maxAdsTimeoutSec != null && Number.isFinite(Number(pc.maxAdsTimeoutSec))
      ? Number(pc.maxAdsTimeoutSec)
      : 300,
    /** OS hint for shortcuts (passed to worker/agent) */

    profileOs: typeof pc.profileOs === 'string' && pc.profileOs.trim()
      ? pc.profileOs.trim()
      : (typeof pc.osName === 'string' && pc.osName.trim() ? pc.osName.trim() : ''),
  };
}

/** Stable numeric seed from profile UUID (same profile = same behavior every run). */
function hashProfileSeed(profileId, salt = 0) {
  let h = salt >>> 0;
  const s = String(profileId || 'default');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

function createSeededRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Per-profile "personality" — scroll style, phase timing, typing (deterministic per profileId).
 */
function createProfilePersonality(profileId) {
  const rng = createSeededRng(hashProfileSeed(profileId));
  const pickInt = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const pick = () => rng();
  const chance = (p) => rng() < p;

  const speedRoll = pick();
  let typingSpeed;
  if (speedRoll < 0.3) {
    typingSpeed = { min: 120, max: 280, pauseChance: 0.12 };
  } else if (speedRoll < 0.7) {
    typingSpeed = { min: 70, max: 180, pauseChance: 0.08 };
  } else {
    typingSpeed = { min: 40, max: 120, pauseChance: 0.04 };
  }

  return {
    pick,
    pickInt,
    chance,
    typingSpeed,
    scrollStepsMin: pickInt(7, 12),
    scrollStepsMax: pickInt(14, 24),
    scrollCurve: 0.18 + pick() * 0.32,
    scrollIntensityBase: pickInt(140, 480),
    commentScrollChance: 0.28 + pick() * 0.42,
    relatedPeekChance: 0.14 + pick() * 0.26,
    mouseMoveChance: 0.22 + pick() * 0.33,
    phase1End: 0.05 + pick() * 0.1,
    phase2End: 0.15 + pick() * 0.12,
    phase3End: 0.35 + pick() * 0.18,
    phase4End: 0.55 + pick() * 0.15,
    phase5End: 0.72 + pick() * 0.12,
  };
}

/** Watch % from Profile Settings (min–max); same profile + video index = same % in range. */
function resolveWatchPercent(config = {}, profileId = '', videoIndex = 0) {
  let min = Number(config.watchTimeMin);
  let max = Number(config.watchTimeMax);
  if (!Number.isFinite(min)) min = 70;
  if (!Number.isFinite(max)) max = 100;
  min = Math.max(1, Math.min(100, Math.round(min)));
  max = Math.max(min, Math.min(100, Math.round(max)));
  if (min === max) return min;
  const rng = createSeededRng(hashProfileSeed(profileId, videoIndex * 997 + 1));
  return min + Math.floor(rng() * (max - min + 1));
}

function computeWatchTimeMs(durationMs, config = {}, profileId = '', videoIndex = 0) {
  const watchPercent = resolveWatchPercent(config, profileId, videoIndex);
  let watchTime = Math.round(durationMs * (watchPercent / 100));
  if (config.qaTestMode) {
    const qaMin = (config.qaMinWatchSec || 90) * 1000;
    const qaMax = (config.qaMaxWatchSec || 600) * 1000;
    watchTime = Math.min(Math.max(watchTime, qaMin), qaMax);
  }
  return { watchTime, watchPercent };
}

function validateProfileConfig(config = {}) {
  const errors = [];
  let min = Number(config.watchTimeMin ?? 70);
  let max = Number(config.watchTimeMax ?? 100);
  if (!Number.isFinite(min) || min < 1 || min > 100) errors.push('watchTimeMin must be 1–100');
  if (!Number.isFinite(max) || max < 1 || max > 100) errors.push('watchTimeMax must be 1–100');
  if (min > max) errors.push('watchTimeMin cannot exceed watchTimeMax');
  const adSec = Number(config.adSkipAfterSec ?? 15);
  if (config.adSkipEnabled !== false && (!Number.isFinite(adSec) || adSec < 0 || adSec > 120)) {
    errors.push('adSkipAfterSec must be 0–120');
  }
  if (config.commentEnabled && !(config.commentText && String(config.commentText).trim())) {
    errors.push('commentEnabled but commentText is empty');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Detect sign-in walls, captcha, consent, bot checks on current page.
 */
async function detectPageBlock(page) {
  try {
    const info = await page.evaluate(() => {
      const url = location.href || '';
      const bodyText = (document.body?.innerText || '').slice(0, 8000).toLowerCase();
      const title = (document.title || '').toLowerCase();

      const signInPhrases = [
        'sign in to confirm',
        'confirm you\'re not a bot',
        'verify it\'s you',
        'unusual traffic',
        'not a robot',
        'sign in to continue',
        'account recovery',
        'couldn\'t sign you in',
      ];
      const captchaHints = !!(
        document.querySelector('iframe[src*="recaptcha"]') ||
        document.querySelector('#captcha-form') ||
        document.querySelector('[id*="captcha"]') ||
        bodyText.includes('captcha')
      );
      const signInHints = signInPhrases.some((p) => bodyText.includes(p))
        || url.includes('accounts.google.com')
        || url.includes('/ServiceLogin')
        || !!document.querySelector('input[type="email"][name="identifier"]')
        || !!document.querySelector('#identifierId');

      const consentHints = bodyText.includes('before you continue to youtube')
        || (bodyText.includes('accept all') && bodyText.includes('reject all'))
        || url.includes('consent.youtube');

      const unavailable = bodyText.includes('video unavailable')
        || bodyText.includes('this video isn\'t available')
        || bodyText.includes('private video');

      return { url, title, captchaHints, signInHints, consentHints, unavailable };
    });

    if (info.captchaHints) {
      return { blocked: true, kind: 'captcha', message: 'Captcha / bot check detected' };
    }
    if (info.signInHints) {
      return { blocked: true, kind: 'signin', message: 'Google / YouTube sign-in wall detected' };
    }
    if (info.consentHints) {
      return { blocked: true, kind: 'consent', message: 'Cookie / consent interstitial' };
    }
    if (info.unavailable) {
      return { blocked: true, kind: 'unavailable', message: 'Video unavailable on this account' };
    }
    return { blocked: false, kind: null, message: '' };
  } catch (err) {
    return { blocked: false, kind: null, message: err.message };
  }
}

/**
 * Read what is actually playing on the watch page.
 * FIX Bug 8: Polls up to 4s for the title to load — YouTube SPA loads title asynchronously
 * Without this, verifyOpenedVideo reads empty/old title → false mismatch → unnecessary retries
 */
async function readPlaybackContext(page) {
  const TITLE_WAIT_MS = 4000;
  const POLL_INTERVAL = 350;
  const start = Date.now();

  const readOnce = () => page.evaluate(() => {
    const url = location.href || '';
    const idMatch = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const videoId = idMatch ? idMatch[1] : '';

    const titleEl =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('h1 yt-formatted-string') ||
      document.querySelector('#title h1') ||
      document.querySelector('meta[property="og:title"]');
    const title = titleEl?.textContent?.trim()
      || titleEl?.getAttribute?.('content')?.trim()
      || document.title.replace(' - YouTube', '').trim();

    const channelEl =
      document.querySelector('ytd-channel-name a') ||
      document.querySelector('#owner #channel-name a') ||
      document.querySelector('yt-formatted-string.ytd-channel-name') ||
      document.querySelector('span.ytd-video-owner-renderer a') ||
      document.querySelector('.slim-owner-icon-and-title a') ||
      document.querySelector('ytm-slim-owner-renderer a') ||
      document.querySelector('.ytm-slim-owner-renderer a') ||
      document.querySelector('[class*="slim-owner"] a') ||
      document.querySelector('ytm-channel-name-renderer a');
    const channel = channelEl?.textContent?.trim() || '';

    const onWatch = url.includes('/watch') || url.includes('/shorts/');
    return { url, videoId, title, channel, onWatch };
  }).catch(() => null);

  try {
    let ctx = null;
    while (Date.now() - start < TITLE_WAIT_MS) {
      ctx = await readOnce();
      if (!ctx) break;
      // Title loaded and meaningful — done
      if (ctx.title && ctx.title.length > 3 && ctx.title.toLowerCase() !== 'youtube') break;
      // On watch page with video ID in URL — good enough even if title not loaded yet
      if (ctx.videoId && ctx.onWatch) break;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    return ctx || { url: '', videoId: '', title: '', channel: '', onWatch: false };
  } catch {
    return { url: '', videoId: '', title: '', channel: '', onWatch: false };
  }
}

/**
 * After navigation, confirm we opened the intended video (not wrong channel/title).
 */
async function verifyOpenedVideo(page, expected = {}) {
  const expectedTitle = expected.title || expected.videoTitle || '';
  const expectedChannel = expected.channelName || '';
  const expectedVideoId = expected.videoId || extractVideoIdFromUrl(expected.videoUrl || '');

  const ctx = await readPlaybackContext(page);

  // Video ID in URL = correct video (title/channel can load late on slow proxy)
  if (expectedVideoId) {
    const urlId = ctx.videoId || extractVideoIdFromUrl(ctx.url);
    if (urlId === expectedVideoId || (ctx.url && ctx.url.includes(expectedVideoId))) {
      return { ok: true, reason: 'verified_by_video_id', actual: ctx, expectedVideoId };
    }
  }

  if (!ctx.onWatch && !ctx.videoId) {
    return { ok: false, reason: 'not_on_watch_page', actual: ctx, expectedVideoId };
  }

  if (expectedVideoId && ctx.videoId && expectedVideoId !== ctx.videoId) {
    return {
      ok: false,
      reason: 'video_id_mismatch',
      actual: ctx,
      expectedVideoId,
    };
  }

  if (expectedTitle) {
    // FIXED: correct parameter order — (resultTitle, resultChannel, resultDuration, expectedTitle, expectedChannel, expectedDuration)
    // ctx.title/channel = what is ACTUALLY playing; expectedTitle/Channel = what we WANTED
    const verification = verifyVideoMatch(
      ctx.title,       // resultTitle   — what's actually playing
      ctx.channel,     // resultChannel — channel that's actually playing
      0,               // resultDuration — unknown at verify stage
      expectedTitle,   // expectedTitle  — what we wanted
      expectedChannel, // expectedChannel — channel we wanted
      0                // expectedDuration — unknown
    );
    if (!verification.isMatch) {
      return {
        ok: false,
        reason: 'title_channel_mismatch',
        actual: ctx,
        score: verification.score,
      };
    }
  } else if (expectedChannel) {
    const exp = normalizeText(expectedChannel);
    const act = normalizeText(ctx.channel);
    if (exp && act && !act.includes(exp) && !exp.includes(act)) {
      return { ok: false, reason: 'channel_mismatch', actual: ctx };
    }
  }

  return { ok: true, reason: 'verified', actual: ctx };
}

/**
 * Context-aware scroll during watch (progress + profile scroll toggle).
 */
function planWatchAction(progress, config = {}, phaseIndex, personality = null) {
  const scrollOn = config.scrollDuringWatch !== false;
  if (!scrollOn) {
    return { scroll: false, intensity: 0, pauseMs: 0 };
  }

  const p = personality;
  const base = p?.scrollIntensityBase || 300;
  const ri = (a, b) => (p ? p.pickInt(a, b) : randomInt(a, b));
  const ch = (prob) => (p ? p.chance(prob) : Math.random() < prob);

  if (progress < 0.12) {
    return { scroll: ch(0.08), intensity: ri(80, 160), pauseMs: ri(1500, 3500) };
  }
  if (progress < 0.35) {
    return { scroll: ch(0.22), intensity: ri(base - 80, base + 120), pauseMs: ri(2000, 5000) };
  }
  if (progress < 0.55) {
    return { scroll: ch(0.45), intensity: ri(base, base + 200), pauseMs: ri(2500, 6500) };
  }
  if (progress < 0.78) {
    return { scroll: ch(0.28), intensity: ri(base - 120, base + 60), pauseMs: ri(1500, 4000) };
  }
  if (progress < 0.92) {
    return { scroll: ch(0.35), intensity: ri(100, 280), pauseMs: ri(1200, 3500) };
  }
  return { scroll: ch(0.1), intensity: ri(60, 120), pauseMs: ri(1000, 2000) };
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Unique natural search query per video — title keywords that match search results */
function deriveSearchQuery(videoTitle, channelName = '', videoIndex = 0, profileId = '') {
  const stop = new Set(['the', 'and', 'for', 'with', 'video', 'official', 'full', 'hd', 'new', 'latest', 'my', 'how', 'what']);
  const words = normalizeText(videoTitle).split(' ').filter(w => w.length > 2 && !stop.has(w));
  const seed = hashProfileSeed(profileId || 'x', videoIndex + 1);
  const rng = createSeededRng(seed);

  // Prefer 3–5 consecutive meaningful words from title (better list match)
  if (words.length >= 3) {
    const startMax = Math.max(0, words.length - 4);
    const start = Math.floor(rng() * (startMax + 1));
    const slice = words.slice(start, start + Math.min(5, words.length - start));
    if (slice.length >= 3) {
      const q = slice.join(' ');
      if (q.length >= 8) return q.slice(0, 70);
    }
  }

  const pick = (arr, n) => {
    const copy = [...arr];
    const out = [];
    while (out.length < n && copy.length) {
      out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
    }
    return out;
  };
  const kw = pick(words, Math.min(4, Math.max(3, words.length)));
  // FIX Bug 6: Removed random suffixes ("explained", "review", "guide", "2026")
  // These caused searches to miss the target video entirely.
  // Only optionally append channel name word (natural human behavior, 30% chance).
  const parts = [...kw];
  if (channelName && rng() > 0.70) parts.push(normalizeText(channelName).split(' ')[0]);
  const q = parts.filter(Boolean).join(' ').slice(0, 70);
  if (q.trim().length >= 3) return q;
  const rawTitle = normalizeText(videoTitle || '').trim();
  if (rawTitle.length) return rawTitle.slice(0, 70);

  const ch = normalizeText(channelName || '').trim();
  if (ch.length) return ch.slice(0, 70);
  return 'youtube video';
}

module.exports = {
  buildAgentConfig,
  resolveTrafficMix,
  detectPageBlock,
  readPlaybackContext,
  verifyOpenedVideo,
  planWatchAction,
  extractVideoIdFromUrl,
  createProfilePersonality,
  resolveWatchPercent,
  computeWatchTimeMs,
  validateProfileConfig,
  deriveSearchQuery,
};
