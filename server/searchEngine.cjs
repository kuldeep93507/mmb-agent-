/**
 * SEARCH ENGINE — Smart Video Discovery
 * 
 * Features:
 * 1. Escalation Search (short → long → channel → near-full)
 * 2. Video Verification (title + channel + duration match before click)
 * 3. Multiple Traffic Sources (YouTube, Google, Bing, Channel Page, Direct URL)
 * 4. Per-profile traffic mix (auto-assigned, different for each)
 * 5. Ad tracking (separate from video watch time)
 */

function randomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const {
  STOP_WORDS,
  cleanChannelLabel,
  verifyVideoMatch,
  parseDurationText,
} = require('./utils/videoMatch.cjs');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SEARCH QUERY GENERATOR — Escalation Levels
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function generateEscalationQueries(videoTitle, channelName) {
  const title = videoTitle || '';
  const channel = channelName || '';
  
  // Extract meaningful keywords (remove stop words, punctuation, year in brackets)
  const cleanTitle = title
    .replace(/[()[\]{}|:!?—–\-]/g, ' ')  // Remove punctuation
    .replace(/\b\d{4}\b/g, '')             // Remove years
    .replace(/\s+/g, ' ')
    .trim();
  
  const keywords = cleanTitle.split(' ')
    .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()))
    .map(w => w.toLowerCase());
  
  // Level 1: 2-4 core keywords (most natural)
  const coreKeywords = keywords.slice(0, Math.min(4, keywords.length));
  const level1 = coreKeywords.join(' ');
  
  // Level 2: 4-6 keywords (more specific)
  const level2Keywords = keywords.slice(0, Math.min(6, keywords.length));
  const level2 = level2Keywords.join(' ');
  
  // Level 3: Channel name + 2-3 keywords
  const level3 = channel ? `${channel} ${coreKeywords.slice(0, 3).join(' ')}` : level2;
  
  // Level 4: Near-full title (remove only year and special chars)
  const level4 = cleanTitle.split(' ').filter(w => w.length > 1).slice(0, 10).join(' ');
  
  // Level 5: EXACT original title (last resort — guaranteed to find if video exists)
  const level5 = title.trim();
  
  return [level1, level2, level3, level4, level5].filter(q => q.trim().length > 3);
}

function normalizeQueryText(q) {
  return String(q || '').replace(/\s+/g, ' ').trim();
}

function dedupeQueries(queries) {
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    const n = normalizeQueryText(q);
    if (n.length < 4) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/**
 * Search plan: short AI keywords → channel+title (high hit rate) → exact title.
 * User rule: keyword fail ho to channel name title ke aage laga ke search karo.
 */
function buildYouTubeSearchPlan(videoTitle, channelName, searchQuerySeed, maxAttempts = 6) {
  const title = normalizeQueryText(videoTitle);
  const channel = normalizeQueryText(channelName);
  const seed = normalizeQueryText(searchQuerySeed || title);

  const fromSeed = generateEscalationQueries(seed, channel);
  const fromTitle = generateEscalationQueries(title, channel);

  const channelPlusTitle = [];
  if (channel && title) {
    const cleanTitle = title
      .replace(/[()[\]{}|:!?—–\-]/g, ' ')
      .replace(/\b\d{4}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const keywords = cleanTitle.split(' ')
      .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));
    const core3 = keywords.slice(0, 3).join(' ');
    const core5 = keywords.slice(0, 5).join(' ');
    const nearFull = cleanTitle.split(' ').filter(w => w.length > 1).slice(0, 12).join(' ');

    if (core3) channelPlusTitle.push(`${channel} ${core3}`);
    if (core5 && core5 !== core3) channelPlusTitle.push(`${channel} ${core5}`);
    if (nearFull) channelPlusTitle.push(`${channel} ${nearFull}`);
    channelPlusTitle.push(`${channel} ${title}`.slice(0, 120));
  }

  const titleExact = fromTitle[fromTitle.length - 1] || title;
  const titleNearFull = fromTitle[fromTitle.length - 2] || titleExact;

  return dedupeQueries([
    fromSeed[0],
    fromSeed[1],
    ...channelPlusTitle,
    titleNearFull,
    titleExact,
  ]).slice(0, Math.max(1, maxAttempts));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TRAFFIC SOURCE ASSIGNMENT
// Har profile ko alag traffic source milta hai
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function assignTrafficSource(profileIndex, totalProfiles, hasUrl, trafficMix, trafficPreference) {
  const pref = String(trafficPreference || 'custom').toLowerCase();

  if (pref === 'random') {
    const pool = ['youtube-search', 'google', 'bing', 'channel-page', 'duckduckgo', 'yahoo'];
    if (hasUrl) pool.push('direct');
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (pref === 'search') return 'youtube-search';
  if (pref === 'google') return 'google';
  if (pref === 'bing') return 'bing';
  if (pref === 'duckduckgo') return 'duckduckgo';
  if (pref === 'yahoo') return 'yahoo';
  if (pref === 'direct') return hasUrl ? 'direct' : 'youtube-search';
  if (pref === 'suggested') return 'channel-page';

  // If trafficMix is provided from frontend config, use it
  if (trafficMix && typeof trafficMix === 'object') {
    const sources = [];
    const yt = trafficMix.youtubeSearch || 0;
    const ch = trafficMix.channelPage || 0;
    const go = trafficMix.google || 0;
    const bi = trafficMix.bing || 0;
    const di = trafficMix.direct || 0;
    const ddg = trafficMix.duckduckgo || 0;
    const yh = trafficMix.yahoo || 0;
    
    for (let i = 0; i < yt; i++) sources.push('youtube-search');
    for (let i = 0; i < ch; i++) sources.push('channel-page');
    for (let i = 0; i < go; i++) sources.push('google');
    for (let i = 0; i < bi; i++) sources.push('bing');
    for (let i = 0; i < ddg; i++) sources.push('duckduckgo');
    for (let i = 0; i < yh; i++) sources.push('yahoo');
    if (hasUrl) { for (let i = 0; i < di; i++) sources.push('direct'); }
    else { for (let i = 0; i < di; i++) sources.push('youtube-search'); }
    
    if (sources.length === 0) sources.push('youtube-search');
    
    // Random pick (not deterministic — each video gets random source from mix)
    return sources[Math.floor(Math.random() * sources.length)];
  }
  
  // Default fallback: mostly search
  const sources = [];
  for (let i = 0; i < 50; i++) sources.push('youtube-search');
  for (let i = 0; i < 20; i++) sources.push('channel-page');
  for (let i = 0; i < 15; i++) sources.push('google');
  for (let i = 0; i < 10; i++) sources.push('bing');
  if (hasUrl) for (let i = 0; i < 5; i++) sources.push('direct');
  else for (let i = 0; i < 5; i++) sources.push('youtube-search');
  
  const index = (profileIndex * 7 + 3) % sources.length;
  return sources[index];
}

const YOUTUBE_SEARCH_FAMILY = new Set(['youtube-search', 'channel-page']);

function isYouTubeSearchFamily(source) {
  return YOUTUBE_SEARCH_FAMILY.has(source);
}

async function runPrimaryTrafficSource(page, source, ctx) {
  const {
    videoTitle, channelName, videoUrl, expectedDuration, profileIndex,
    humanTypeFn, log, expectedVideoId, searchQuerySeed,
  } = ctx;
  const ytOpts = {
    maxAttempts: 6,
    searchQuerySeed: searchQuerySeed || undefined,
  };

  switch (source) {
    case 'direct':
      if (videoUrl) {
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(randomDelay(2000, 4000));
        log('success', '[Direct] Video opened via URL (chosen traffic)');
        return { success: true, source: 'direct', intendedSource: source };
      }
      return searchYouTube(page, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId, ytOpts);

    case 'youtube-search':
      return searchYouTube(page, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId, {
        ...ytOpts,
        browseVariant: profileIndex % 5,
        entryMethod: profileIndex % 3,
      });

    case 'google':
      return searchGoogle(page, videoTitle, channelName, expectedDuration, humanTypeFn, log);

    case 'bing':
      return searchBing(page, videoTitle, channelName, expectedDuration, humanTypeFn, log);

    case 'channel-page':
      return searchChannelPage(page, videoTitle, channelName, expectedDuration, humanTypeFn, log);

    case 'duckduckgo':
      return searchDuckDuckGo(page, videoTitle, channelName, expectedDuration, humanTypeFn, log);

    case 'yahoo':
      return searchYahoo(page, videoTitle, channelName, expectedDuration, humanTypeFn, log);

    default:
      return searchYouTube(page, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId, ytOpts);
  }
}


async function isMobileYouTubePage(page) {
  try {
    const url = page.url() || '';
    if (url.includes('m.youtube.com')) return true;
    return await page.evaluate(() => !!document.querySelector('ytm-app, ytm-browse, ytm-watch')
      || /android|mobile/i.test(navigator.userAgent || '')).catch(() => false);
  } catch { return false; }
}

async function typeInMobileSearchBar(page, query, humanTypeFn) {
  try {
    const searchButtons = [
      'button[aria-label*="Search" i]',
      'button[aria-label*="search" i]',
      'ytm-topbar-menu-button-renderer button',
      '.mobile-topbar-header-content button',
    ];
    for (const sel of searchButtons) {
      const btn = await page.$(sel).catch(() => null);
      if (!btn) continue;
      const txt = `${await btn.getAttribute('aria-label').catch(() => '')} ${await btn.textContent().catch(() => '')}`.toLowerCase();
      if (!txt.includes('search') && !sel.includes('topbar')) continue;
      await btn.click().catch(() => {});
      await sleep(700);
      break;
    }

    const inputSelectors = [
      'input[type="search"]',
      'input[name="search_query"]',
      'input[placeholder*="Search" i]',
      'input[aria-label*="Search" i]',
      'ytm-searchbox input',
      '.searchbox-input input',
    ];
    for (const sel of inputSelectors) {
      const input = await page.$(sel).catch(() => null);
      if (!input) continue;
      await input.click().catch(() => {});
      await sleep(300);
      await page.keyboard.press('Control+a').catch(() => {});
      await page.keyboard.press('Meta+a').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await humanTypeFn(page, query);
      return true;
    }
  } catch { /* fallback to desktop methods */ }
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// YOUTUBE SEARCH WITH ESCALATION + VERIFICATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function gotoYouTubeSearchResults(page, query, humanTypeFn) {
  const currentUrl = page.url() || '';
  const onYouTube = currentUrl.includes('youtube.com');

  // ── PATH A: Already on YouTube — use search bar directly ─────────────────
  if (onYouTube) {
    // Scroll to top so search bar is visible/accessible
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(randomDelay(200, 400));
    const typed = await typeInSearchBar(page, query, humanTypeFn);
    if (typed) {
      await sleep(randomDelay(400, 800));
      await page.keyboard.press('Enter');
      await sleep(randomDelay(800, 1500));
      return await isMobileYouTubePage(page) ? 'mobile-search-ui' : 'desktop-search-ui';
    }
  }

  // ── PATH B: Not on YouTube — navigate via address bar typing ─────────────
  // Human behavior: press Ctrl+L, type "youtube.com", Enter, then search
  try {
    await page.keyboard.press('Control+l');
    await sleep(randomDelay(300, 650));
    await page.keyboard.press('Control+a');
    await sleep(randomDelay(50, 130));
    await page.keyboard.press('Backspace');
    await sleep(randomDelay(180, 380));
    await humanTypeFn(page, 'youtube.com');
    await sleep(randomDelay(300, 650));
    await page.keyboard.press('Enter');
    // Wait for YouTube to fully load
    await page.waitForLoadState('domcontentloaded', { timeout: 28000 }).catch(() => {});
    await sleep(randomDelay(1500, 3000));

    // Now type search query in the YouTube search bar
    const typed = await typeInSearchBar(page, query, humanTypeFn);
    if (typed) {
      await sleep(randomDelay(400, 800));
      await page.keyboard.press('Enter');
      await sleep(randomDelay(800, 1500));
      return await isMobileYouTubePage(page) ? 'mobile-search-ui' : 'desktop-search-ui';
    }
  } catch { /* fall through to URL fallback */ }

  // ── FALLBACK: Direct URL only if both typing paths failed ─────────────────
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 28000 });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  }
  await sleep(randomDelay(500, 1100));
  return 'direct-url-last-resort';
}

async function waitForSearchResults(page, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await page.evaluate(() => document.querySelectorAll('ytd-video-renderer').length).catch(() => 0);
    if (count > 0) return true;
    await sleep(450);
  }
  return false;
}

async function openVideoFromSearchResult(page, expectedVideoId, log) {
  const inResults = await page.evaluate((vid) => {
    for (const a of document.querySelectorAll('ytd-video-renderer a#video-title')) {
      if ((a.getAttribute('href') || '').includes(vid)) return true;
    }
    return false;
  }, expectedVideoId).catch(() => false);

  if (!inResults) return false;

  try {
    await page.goto(`https://www.youtube.com/watch?v=${expectedVideoId}`, { waitUntil: 'commit', timeout: 28000 });
  } catch {
    return false;
  }
  const ok = await waitForWatchPage(page, expectedVideoId, 18000);
  if (ok && typeof log === 'function') log('success', `[YT] Opened from search via video ID: ${expectedVideoId}`);
  return ok;
}

async function waitForWatchPage(page, expectedVideoId, timeoutMs = 18000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const url = page.url();
      if (expectedVideoId && url.includes(`v=${expectedVideoId}`)) return true;
      if (expectedVideoId && url.includes(expectedVideoId)) return true;
      const onWatch = await page.evaluate((vid) => {
        const u = location.href || '';
        if (vid && (u.includes(`v=${vid}`) || u.includes(vid))) return true;
        return /\/watch|\/shorts\//.test(u);
      }, expectedVideoId || '').catch(() => false);
      if (onWatch && expectedVideoId) {
        const idOnPage = await page.evaluate(() => {
          const u = location.href;
          const m = u.match(/[?&]v=([A-Za-z0-9_-]{11})/);
          return m ? m[1] : '';
        }).catch(() => '');
        if (idOnPage === expectedVideoId) return true;
      } else if (onWatch && !expectedVideoId) {
        return true;
      }
    } catch { /* page navigating */ }
    await sleep(500);
  }
  return false;
}

async function runSearchAttempt(page, query, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId, scanOpts) {
  const searchPath = await gotoYouTubeSearchResults(page, query, humanTypeFn);
  if (searchPath) log('info', `[Search Path] ${searchPath}`);
  const loaded = await waitForSearchResults(page, 10000);
  if (!loaded) {
    log('info', `[Search] Results not loaded for "${query.slice(0, 50)}" — next keyword`);
    return false;
  }
  return findAndVerifyVideo(page, videoTitle, channelName, expectedDuration, log, expectedVideoId, scanOpts);
}

async function searchYouTube(page, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId, options = {}) {
  const maxAttempts = Math.max(1, Math.min(6, options.maxAttempts ?? 6));
  const queries = buildYouTubeSearchPlan(
    videoTitle,
    channelName,
    options.searchQuerySeed || videoTitle,
    maxAttempts,
  );
  const scanOpts = { quick: true, maxScrolls: 2 };

  for (let attempt = 0; attempt < queries.length; attempt++) {
    const query = queries[attempt];
    log('info', `[Search Attempt ${attempt + 1}/${queries.length}] "${query}"${expectedVideoId ? ` [ID: ${expectedVideoId}]` : ''}`);

    try {
      const found = await runSearchAttempt(
        page, query, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId, scanOpts,
      );
      if (found) {
        log('success', `[Search] Found video on attempt ${attempt + 1}: "${query}"`);
        return { success: true, source: 'youtube-search', query };
      }
    } catch (err) {
      log('warn', `[Search] Attempt ${attempt + 1} error: ${err.message} — next keyword`);
    }

    log('info', `[Search] Not in results — next keyword...`);
    if (attempt < queries.length - 1) await sleep(randomDelay(200, 500));
  }

  log('warn', '[Search] All escalation queries failed — exact title not found in results');
  return { success: false, source: 'youtube-search' };
}

/** Last resort: channel + full title first, then full title alone */
async function searchYouTubeFullTitle(page, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId) {
  const fullQuery = String(videoTitle || '').trim().slice(0, 120);
  if (fullQuery.length < 5) return { success: false, source: 'youtube-search-fulltitle' };

  const channel = cleanChannelLabel(channelName);
  const queries = dedupeQueries([
    channel ? `${channel} ${fullQuery}`.slice(0, 120) : '',
    fullQuery,
  ]);

  const scanOpts = { quick: true, maxScrolls: 3 };

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    log('info', `[Search FULL TITLE] "${query.slice(0, 70)}${query.length > 70 ? '…' : ''}"`);

    try {
      const found = await runSearchAttempt(
        page, query, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId, scanOpts,
      );
      if (found) {
        log('success', '[Search FULL TITLE] Video found and clicked from results list');
        return { success: true, source: 'youtube-search-fulltitle', query };
      }
    } catch (err) {
      log('warn', `[Search FULL TITLE] Error: ${err.message}`);
    }
  }

  log('warn', '[Search FULL TITLE] Video not found even with full title');
  return { success: false, source: 'youtube-search-fulltitle' };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXTERNAL SEARCH HELPERS (Google/Bing/Yahoo — mobile overlays)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function dismissSiteOverlays(page, log, label = '') {
  const tag = label ? `[${label}]` : '';
  try {
    const clicked = await page.evaluate(() => {
      const gBtn = document.querySelector('#L2AGLb, button#L2AGLb');
      if (gBtn) { gBtn.click(); return 'google-consent'; }
      const want = ['accept all', 'accept', 'i agree', 'reject all', 'agree', 'got it', 'allow all'];
      for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"]')) {
        const t = (el.textContent || el.value || '').toLowerCase().trim();
        if (!t || t.length > 48) continue;
        if (want.some((w) => t === w || t.includes(w))) {
          const r = el.getBoundingClientRect();
          if (r.width > 8 && r.height > 8) {
            el.click();
            return t.slice(0, 24);
          }
        }
      }
      return null;
    });
    if (clicked) {
      log('info', `${tag} Dismissed overlay (${clicked})`);
      await sleep(randomDelay(800, 1500));
    }
    return !!clicked;
  } catch {
    return false;
  }
}

async function dismissYahooPromo(page, log) {
  try {
    const closed = await page.evaluate(() => {
      const close = document.querySelector(
        '.scoutPromoPopup button, [class*="scoutPromo"] button, button[aria-label="Close"], button[aria-label="close"]',
      );
      if (close) { close.click(); return true; }
      document.querySelectorAll('.scoutPromoPopup, section.scoutPromoPopup').forEach((el) => el.remove());
      return false;
    });
    if (closed) {
      log('info', '[Yahoo] Closed promo popup');
      await sleep(500);
    }
  } catch { /* ignore */ }
}

async function typeInExternalSearch(page, selectors, query, humanTypeFn, log, label) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissSiteOverlays(page, log, label);
    for (const sel of sels) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        await loc.waitFor({ state: 'visible', timeout: 8000 });
        await loc.focus().catch(() => {});
        await loc.click({ timeout: 8000, force: true }).catch(async () => {
          await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (el) { el.focus(); el.click(); }
          }, sel);
        });
        await sleep(randomDelay(300, 700));
        await page.keyboard.press('Control+a').catch(() => {});
        await page.keyboard.press('Meta+a').catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await humanTypeFn(page, query);
        return true;
      } catch { /* try next selector */ }
    }
    await sleep(1000);
  }
  return false;
}

function resolveSearchResultUrl(href, baseHost = 'https://www.google.com') {
  if (!href) return null;
  let url = href.trim();
  if (url.startsWith('/url?')) {
    try {
      const u = new URL(baseHost + url);
      url = u.searchParams.get('q') || u.searchParams.get('url') || url;
    } catch { /* keep */ }
  }
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('/')) url = `${baseHost.replace(/\/$/, '')}${url}`;
  if (!url.startsWith('http')) return null;
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) return null;
  return url;
}

async function openYouTubeResultLink(page, link, log, label) {
  const href = await link.getAttribute('href').catch(() => null);
  const url = resolveSearchResultUrl(href);
  if (!url) return false;
  log('info', `[${label}] Opening result: ${url.slice(0, 80)}…`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(randomDelay(3000, 5000));
  return true;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BING SEARCH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function searchBing(page, videoTitle, channelName, expectedDuration, humanTypeFn, log) {
  log('info', '[Bing] Searching via Bing...');
  
  try {
    await page.goto('https://www.bing.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(randomDelay(2000, 4000));

    const sanitize = (s) => s.replace(/[\[\](){}:!?—–"']/g, ' ').replace(/\s+/g, ' ').trim();
    const bingQuery = channelName
      ? `${sanitize(channelName)} ${sanitize(videoTitle)} youtube`
      : `${sanitize(videoTitle)} youtube`;

    const typed = await typeInExternalSearch(
      page,
      ['textarea[name="q"]', 'input[name="q"]', '#sb_form_q'],
      bingQuery,
      humanTypeFn,
      log,
      'Bing',
    );
    if (!typed) {
      log('warn', '[Bing] Search box not found');
      return { success: false, source: 'bing' };
    }
    await sleep(randomDelay(500, 1000));
    await page.keyboard.press('Enter');
    await sleep(randomDelay(3000, 6000));
    
    // Find YouTube links and VERIFY exact title + channel
    const ytLinks = await page.$$('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
    
    for (const link of ytLinks.slice(0, 5)) {
      const text = await link.textContent().catch(() => '');
      const textClean = text.toLowerCase().trim();
      // Word-level matching — same logic as YouTube search (no more string.includes)
      const verification = verifyVideoMatch(textClean, '', 0, videoTitle, channelName || '', 0);
      if (verification.isMatch) {
        await sleep(randomDelay(1000, 3000));
        if (await openYouTubeResultLink(page, link, log, 'Bing')) {
          log('success', `[Bing] Found video and opened (score=${verification.score})`);
          return { success: true, source: 'bing', query: bingQuery };
        }
      }
    }

    log('info', '[Bing] Video not found in Bing results');
    return { success: false, source: 'bing' };
  } catch (err) {
    log('warn', `[Bing] Error: ${err.message}`);
    return { success: false, source: 'bing' };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GOOGLE SEARCH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function searchGoogle(page, videoTitle, channelName, expectedDuration, humanTypeFn, log) {
  log('info', '[Google] Searching via Google...');
  
  try {
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(randomDelay(2000, 4000));

    const sanitize = (s) => s.replace(/[\[\](){}:!?—–"']/g, ' ').replace(/\s+/g, ' ').trim();
    const googleQuery = channelName
      ? `${sanitize(channelName)} ${sanitize(videoTitle)} youtube`
      : `${sanitize(videoTitle)} youtube`;

    const typed = await typeInExternalSearch(
      page,
      ['textarea[name="q"]', 'input[name="q"]', 'textarea[title="Search"]', 'input[title="Search"]'],
      googleQuery,
      humanTypeFn,
      log,
      'Google',
    );
    if (!typed) {
      log('warn', '[Google] Search box not found');
      return { success: false, source: 'google' };
    }
    await sleep(randomDelay(500, 1000));
    await page.keyboard.press('Enter');
    await sleep(randomDelay(3000, 6000));
    
    // Find YouTube links in Google results and VERIFY title + channel
    const ytLinks = await page.$$('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
    
    for (const link of ytLinks.slice(0, 5)) {
      const text = await link.textContent().catch(() => '');
      const textClean = text.toLowerCase().trim();
      // Word-level matching — same logic as YouTube search (no more string.includes)
      const verification = verifyVideoMatch(textClean, '', 0, videoTitle, channelName || '', 0);
      if (verification.isMatch) {
        await sleep(randomDelay(1000, 3000));
        if (await openYouTubeResultLink(page, link, log, 'Google')) {
          log('success', `[Google] Found video and opened (score=${verification.score})`);
          return { success: true, source: 'google', query: googleQuery };
        }
      }
    }

    log('info', '[Google] Video not found in Google results');
    return { success: false, source: 'google' };
  } catch (err) {
    log('warn', `[Google] Error: ${err.message}`);
    return { success: false, source: 'google' };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CHANNEL PAGE — Go to channel, find video
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function searchChannelPage(page, videoTitle, channelName, expectedDuration, humanTypeFn, log) {
  if (!channelName) return { success: false, source: 'channel-page' };
  log('info', `[Channel] Going to "${channelName}" channel page...`);
  
  try {
    // Search for channel — navigate to YouTube via address bar first, then type channel name
    const chCurrentUrl = page.url() || '';
    const chOnYouTube = chCurrentUrl.includes('youtube.com');
    let chNavOk = false;
    if (!chOnYouTube) {
      try {
        await page.keyboard.press('Control+l');
        await sleep(randomDelay(300, 600));
        await page.keyboard.press('Control+a');
        await sleep(randomDelay(50, 120));
        await page.keyboard.press('Backspace');
        await sleep(randomDelay(180, 350));
        await humanTypeFn(page, 'youtube.com');
        await sleep(randomDelay(300, 600));
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
        await sleep(randomDelay(1200, 2500));
        chNavOk = true;
      } catch { /* fall through */ }
    } else {
      chNavOk = true;
    }
    if (!chNavOk) {
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else {
      // Type channel name in search bar
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await sleep(randomDelay(200, 400));
      const chTyped = await typeInSearchBar(page, channelName, humanTypeFn);
      if (chTyped) {
        await sleep(randomDelay(400, 700));
        await page.keyboard.press('Enter');
      } else {
        await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      }
    }
    await sleep(randomDelay(3000, 5000));
    
    // Click the channel that matches the expected name (not the first result)
    const channelRenderers = await page.$$('ytd-channel-renderer');
    let channelOpened = false;
    const expCh = channelName.toLowerCase().trim();

    for (const chEl of channelRenderers.slice(0, 10)) {
      const chTitle = await chEl.evaluate(el => {
        const t = el.querySelector('#channel-title, #text-container #text, yt-formatted-string#text, #main-link #text');
        return (t?.textContent || '').trim();
      }).catch(() => '');

      const got = chTitle.toLowerCase().trim();
      const nameOk = got && (got.includes(expCh) || expCh.includes(got) ||
        expCh.split(/\s+/).filter(w => w.length > 2).every(w => got.includes(w)));

      if (!nameOk) continue;

      const link = await chEl.$('a#main-link, a#avatar-link, a');
      if (link) {
        await link.click();
        channelOpened = true;
        break;
      }
    }

    if (!channelOpened) {
      log('warn', `[Channel] Channel "${channelName}" not found in YouTube search results`);
      return { success: false, source: 'channel-page' };
    }
    await sleep(randomDelay(3000, 5000));
    
    // Click Videos tab
    const videosTab = await page.$('[tab-title="Videos"], tp-yt-paper-tab:nth-child(2)');
    if (videosTab) {
      await videosTab.click();
      await sleep(randomDelay(2000, 4000));
    }
    
    // Scroll and find video by title
    for (let scroll = 0; scroll < 3; scroll++) {
      const videos = await page.$$('ytd-rich-item-renderer a#video-title-link, ytd-grid-video-renderer a#video-title');
      
      for (const vid of videos) {
        const title = await vid.getAttribute('title').catch(() => '') || await vid.textContent().catch(() => '');
        const verification = verifyVideoMatch(title, channelName, 0, videoTitle, channelName, expectedDuration);
        
        if (verification.isMatch) {
          await sleep(randomDelay(500, 1500));
          await vid.click();
          await sleep(randomDelay(2000, 4000));
          log('success', '[Channel] Found video on channel page');
          return { success: true, source: 'channel-page' };
        }
      }
      
      // Scroll down to load more
      await page.mouse.wheel(0, 500);
      await sleep(randomDelay(1500, 3000));
    }
    
    log('info', '[Channel] Video not found on channel page');
    return { success: false, source: 'channel-page' };
  } catch (err) {
    log('warn', `[Channel] Error: ${err.message}`);
    return { success: false, source: 'channel-page' };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Type in YouTube search bar (multiple fallback methods, up to 3 attempts)
async function typeInSearchBar(page, query, humanTypeFn) {
  if (await isMobileYouTubePage(page)) {
    const mobileTyped = await typeInMobileSearchBar(page, query, humanTypeFn);
    if (mobileTyped) return true;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Wait for search bar to be present before trying (catches slow page loads)
    await page.waitForSelector('input#search, #search-icon-legacy, button[aria-label="Search"]', { timeout: 3000 }).catch(() => {});

    // Method 1: '/' shortcut
    try {
      await page.keyboard.press('/');
      await sleep(600);
      const focused = await page.evaluate(() => document.activeElement?.id === 'search' || document.activeElement?.tagName === 'INPUT');
      if (focused) {
        await page.keyboard.press('Control+a');
        await sleep(100);
        await page.keyboard.press('Backspace');
        await sleep(200);
        await humanTypeFn(page, query);
        return true;
      }
    } catch {}

    // Method 2: Click input
    try {
      const input = await page.$('input#search');
      if (input) {
        await input.click();
        await sleep(400);
        await page.keyboard.press('Control+a');
        await sleep(100);
        await page.keyboard.press('Backspace');
        await sleep(200);
        await humanTypeFn(page, query);
        return true;
      }
    } catch {}

    // Method 3: Click search icon
    try {
      const btn = await page.$('#search-icon-legacy, button[aria-label="Search"]');
      if (btn) {
        await btn.click();
        await sleep(600);
        await humanTypeFn(page, query);
        return true;
      }
    } catch {}

    if (attempt < 3) {
      await sleep(1500); // brief wait before retry — page may still be loading
    }
  }

  return false;
}

// Browse search results like human — varied pattern per call (anti-pattern for 24/7)
async function browseResults(page, variant = 0) {
  const v = variant % 5;
  const patterns = [
    async () => {
      await page.mouse.wheel(0, randomDelay(180, 420));
      await sleep(randomDelay(1200, 2800));
      await page.mouse.wheel(0, randomDelay(90, 220));
      await sleep(randomDelay(900, 2000));
      await page.mouse.wheel(0, -randomDelay(120, 350));
      await sleep(randomDelay(700, 1800));
    },
    async () => {
      await page.mouse.wheel(0, randomDelay(250, 550));
      await sleep(randomDelay(1500, 3200));
      await page.mouse.wheel(0, randomDelay(100, 280));
      await sleep(randomDelay(1000, 2200));
      await page.mouse.wheel(0, -randomDelay(80, 200));
      await sleep(randomDelay(600, 1500));
      await page.mouse.wheel(0, -randomDelay(100, 250));
    },
    async () => {
      await page.mouse.move(randomDelay(200, 600), randomDelay(180, 400), { steps: randomDelay(8, 18) }).catch(() => {});
      await sleep(randomDelay(400, 900));
      await page.mouse.wheel(0, randomDelay(150, 380));
      await sleep(randomDelay(1100, 2400));
      await page.mouse.wheel(0, -randomDelay(150, 400));
    },
    async () => {
      for (let i = 0; i < 2; i++) {
        await page.mouse.wheel(0, randomDelay(120, 300));
        await sleep(randomDelay(800, 1600));
      }
      await page.mouse.wheel(0, -randomDelay(200, 450));
      await sleep(randomDelay(900, 2000));
    },
    async () => {
      await page.mouse.wheel(0, randomDelay(300, 650));
      await sleep(randomDelay(2000, 4000));
      if (Math.random() < 0.5) await page.mouse.wheel(0, randomDelay(60, 180));
      await sleep(randomDelay(500, 1200));
      await page.mouse.wheel(0, -randomDelay(180, 480));
    },
  ];
  await patterns[v]();
  await sleep(randomDelay(600, 1400));
}

// Extract video ID from YouTube URL
function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Find and verify video in YouTube search results
// RULE: Only click if EXACT title matches — never click wrong video
// ENHANCEMENT: If expectedVideoId provided (from URL), use it for 100% accurate match
async function findAndVerifyVideo(page, videoTitle, channelName, expectedDuration, log, expectedVideoId, options = {}) {
  const quick = !!options.quick;
  const maxScrolls = options.maxScrolls ?? (quick ? 2 : 3);
  const initialWait = quick ? 350 : 1500;
  const scrollWaitMin = quick ? 500 : 1500;
  const scrollWaitMax = quick ? 900 : 2500;
  const clickWaitMin = quick ? 1200 : 2000;
  const clickWaitMax = quick ? 2200 : 4000;

  try {
    await sleep(initialWait);
    
    const hasResults = await page.evaluate(() => {
      return document.querySelectorAll('ytd-video-renderer').length;
    });
    
    if (hasResults === 0) return false;
    
    for (let scrollAttempt = 0; scrollAttempt < maxScrolls; scrollAttempt++) {
      // Fast path: video ID match in one pass (most reliable)
      if (expectedVideoId) {
        const navigated = await openVideoFromSearchResult(page, expectedVideoId, log);
        if (navigated) {
          await sleep(randomDelay(clickWaitMin, clickWaitMax));
          return true;
        }
        if (typeof log === 'function') log('warn', `[YT] ID ${expectedVideoId} in results but watch page failed — continuing scan`);
      }

      // Get all video results
      const results = await page.evaluate(() => {
        const videos = document.querySelectorAll('ytd-video-renderer');
        const matches = [];
        
        for (let i = 0; i < Math.min(videos.length, 20); i++) {
          const el = videos[i];
          const titleEl = el.querySelector('a#video-title');
          const channelEl = el.querySelector('ytd-channel-name a, .ytd-channel-name, ytd-channel-name yt-formatted-string');
          
          const title = titleEl?.getAttribute('title') || titleEl?.textContent?.trim() || '';
          const channel = (channelEl?.textContent || '').replace(/\s+/g, ' ').trim();
          
          matches.push({ index: i, title, channel });
        }
        
        return matches;
      });
      
      if (!results || results.length === 0) {
        if (scrollAttempt < maxScrolls - 1) {
          await page.mouse.wheel(0, randomDelay(350, 650));
          await sleep(randomDelay(scrollWaitMin, scrollWaitMax));
        }
        continue;
      }

      for (const result of results) {
        const verification = verifyVideoMatch(
          result.title,
          cleanChannelLabel(result.channel),
          0,
          videoTitle,
          cleanChannelLabel(channelName),
          0
        );

        if (verification.isMatch) {
          if (typeof log === 'function') {
            log('info', `[YT] Match: "${result.title}" / "${result.channel}" (score:${verification.score}) — index ${result.index}`);
          }

          if (expectedVideoId) {
            const navigated = await openVideoFromSearchResult(page, expectedVideoId, log);
            if (navigated) {
              await sleep(randomDelay(clickWaitMin, clickWaitMax));
              return true;
            }
          }

          // FIX Bug 7: Human-like thumbnail hover BEFORE clicking
          // First move mouse to thumbnail, glance at it, THEN move to title and click
          const videoEls = await page.$$('ytd-video-renderer');
          const videoEl = videoEls[result.index];
          if (videoEl) {
            try {
              // Step 1: Hover thumbnail (left side of card)
              const thumbEl = await videoEl.$('ytd-thumbnail, a#thumbnail, img.yt-core-image').catch(() => null);
              if (thumbEl) {
                const thumbBox = await thumbEl.boundingBox().catch(() => null);
                if (thumbBox && thumbBox.width > 0) {
                  await page.mouse.move(
                    thumbBox.x + randomDelay(20, thumbBox.width - 20),
                    thumbBox.y + randomDelay(10, thumbBox.height - 10),
                    { steps: randomDelay(6, 14) },
                  );
                  await sleep(randomDelay(300, 700)); // glance at thumbnail
                }
              }
              // Step 2: Move to channel name to verify (human checks channel)
              const channelEl = await videoEl.$('ytd-channel-name a, .ytd-channel-name').catch(() => null);
              if (channelEl) {
                const chBox = await channelEl.boundingBox().catch(() => null);
                if (chBox && chBox.width > 0) {
                  await page.mouse.move(
                    chBox.x + chBox.width / 2,
                    chBox.y + chBox.height / 2,
                    { steps: randomDelay(4, 9) },
                  );
                  await sleep(randomDelay(150, 400));
                }
              }
              // Step 3: Move to title and click
              const titleEl = await videoEl.$('a#video-title').catch(() => null);
              if (titleEl) {
                const titleBox = await titleEl.boundingBox().catch(() => null);
                if (titleBox && titleBox.width > 0) {
                  await page.mouse.move(
                    titleBox.x + randomDelay(10, titleBox.width - 10),
                    titleBox.y + titleBox.height / 2,
                    { steps: randomDelay(5, 10) },
                  );
                  await sleep(randomDelay(200, 500));
                  await page.mouse.click(
                    titleBox.x + randomDelay(10, titleBox.width - 10),
                    titleBox.y + titleBox.height / 2,
                  );
                  const navigated = expectedVideoId
                    ? await waitForWatchPage(page, expectedVideoId, 18000)
                    : true;
                  if (!navigated) {
                    if (typeof log === 'function') log('warn', `[YT] Click did not load watch page — next result`);
                    continue;
                  }
                  if (typeof log === 'function') log('success', `[YT] Human-clicked result at index ${result.index}`);
                  await sleep(randomDelay(clickWaitMin, clickWaitMax));
                  return true;
                }
                // Fallback: Playwright click
                await titleEl.click();
                await sleep(2000);
                return true;
              }
            } catch { /* fall through to JS click */ }
          }

          // Last resort: JS click
          const clicked = await page.evaluate((idx) => {
            const videos = document.querySelectorAll('ytd-video-renderer');
            const el = videos[idx];
            if (!el) return false;
            const titleEl = el.querySelector('a#video-title');
            if (!titleEl) return false;
            titleEl.click();
            return true;
          }, result.index).catch(() => false);

          if (clicked) {
            await sleep(randomDelay(clickWaitMin, clickWaitMax));
            return true;
          }
        }
      }
      
      // Not found in current viewport — scroll once more, then next keyword
      if (scrollAttempt < maxScrolls - 1) {
        await page.mouse.wheel(0, randomDelay(350, 650));
        await sleep(randomDelay(scrollWaitMin, scrollWaitMax));
      }
    }
    
    // Video not found in results — return false (will try next keyword)
    return false;
  } catch {
    return false;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DUCKDUCKGO SEARCH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function searchDuckDuckGo(page, videoTitle, channelName, expectedDuration, humanTypeFn, log) {
  log('info', '[DuckDuckGo] Searching via DuckDuckGo...');
  
  try {
    await page.goto('https://duckduckgo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(randomDelay(2000, 4000));

    const ddgQuery = channelName ? `${channelName} ${videoTitle} youtube` : `${videoTitle} youtube`;

    const typed = await typeInExternalSearch(
      page,
      ['input[name="q"]', '#searchbox_input', 'textarea[name="q"]'],
      ddgQuery,
      humanTypeFn,
      log,
      'DuckDuckGo',
    );
    if (!typed) {
      log('warn', '[DuckDuckGo] Search box not found');
      return { success: false, source: 'duckduckgo' };
    }
    await sleep(randomDelay(500, 1000));
    await page.keyboard.press('Enter');
    await sleep(randomDelay(3000, 6000));
    
    // Find YouTube links and verify exact title + channel
    const ytLinks = await page.$$('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
    
    for (const link of ytLinks.slice(0, 5)) {
      const text = await link.textContent().catch(() => '');
      const textClean = text.toLowerCase().trim();
      // Word-level matching — same logic as YouTube search (no more string.includes)
      const verification = verifyVideoMatch(textClean, '', 0, videoTitle, channelName || '', 0);
      if (verification.isMatch) {
        await sleep(randomDelay(1000, 3000));
        if (await openYouTubeResultLink(page, link, log, 'DuckDuckGo')) {
          log('success', `[DuckDuckGo] Found video and opened (score=${verification.score})`);
          return { success: true, source: 'duckduckgo', query: ddgQuery };
        }
      }
    }

    log('info', '[DuckDuckGo] Video not found');
    return { success: false, source: 'duckduckgo' };
  } catch (err) {
    log('warn', `[DuckDuckGo] Error: ${err.message}`);
    return { success: false, source: 'duckduckgo' };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// YAHOO SEARCH
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function searchYahoo(page, videoTitle, channelName, expectedDuration, humanTypeFn, log) {
  log('info', '[Yahoo] Searching via Yahoo...');
  
  try {
    await page.goto('https://search.yahoo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(randomDelay(2000, 4000));
    await dismissYahooPromo(page, log);

    const yahooQuery = channelName ? `${channelName} ${videoTitle} youtube` : `${videoTitle} youtube`;

    const typed = await typeInExternalSearch(
      page,
      ['input[name="p"]', '#yschsp', 'textarea[name="p"]'],
      yahooQuery,
      humanTypeFn,
      log,
      'Yahoo',
    );
    if (!typed) {
      log('warn', '[Yahoo] Search box not found');
      return { success: false, source: 'yahoo' };
    }
    await sleep(randomDelay(500, 1000));
    await page.keyboard.press('Enter');
    await sleep(randomDelay(3000, 6000));
    await dismissYahooPromo(page, log);

    // Find YouTube links and verify exact title + channel
    const ytLinks = await page.$$('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');

    for (const link of ytLinks.slice(0, 5)) {
      const text = await link.textContent().catch(() => '');
      const textClean = text.toLowerCase().trim();
      const verification = verifyVideoMatch(textClean, '', 0, videoTitle, channelName || '', 0);
      if (verification.isMatch) {
        await sleep(randomDelay(1000, 3000));
        await dismissYahooPromo(page, log);
        if (await openYouTubeResultLink(page, link, log, 'Yahoo')) {
          log('success', `[Yahoo] Found video and opened (score=${verification.score})`);
          return { success: true, source: 'yahoo', query: yahooQuery };
        }
      }
    }

    log('info', '[Yahoo] Video not found');
    return { success: false, source: 'yahoo' };
  } catch (err) {
    log('warn', `[Yahoo] Error: ${err.message}`);
    return { success: false, source: 'yahoo' };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN EXPORT — Open Video with Smart Strategy
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function openVideoSmart(page, videoTitle, channelName, videoUrl, expectedDuration, profileIndex, humanTypeFn, log, trafficMix, trafficPreference, options = {}) {
  const strictSource = !!options.strictTraffic;
  const sessionState = options.sessionState || null;
  const source = options.assignedSource
    || assignTrafficSource(profileIndex, 30, !!videoUrl, trafficMix, trafficPreference);
  const intendedSource = source;

  log('info', `[Traffic] Locked source: ${source} (preference: ${trafficPreference || 'custom'})`);

  const expectedVideoId = extractVideoId(videoUrl);
  if (expectedVideoId) log('info', `[VideoID] Will verify with ID: ${expectedVideoId}`);

  const ctx = {
    videoTitle, channelName, videoUrl, expectedDuration, profileIndex, humanTypeFn, log, expectedVideoId,
    searchQuerySeed: options.searchQuerySeed || null,
  };

  let result = await runPrimaryTrafficSource(page, source, ctx);

  // Step 2: Exact title + channel name search on YouTube (guaranteed hit rate).
  // Runs when primary source failed — regardless of whether primary was YouTube or external.
  // External sources (Google/Bing/DDG/Yahoo) get ONE YouTube fallback, not a cascade of all engines.
  if (!strictSource && (!result || !result.success) && source !== 'direct') {
    log('info', `[Fallback] "${source}" failed — trying EXACT TITLE + CHANNEL on YouTube...`);
    try {
      result = await searchYouTubeFullTitle(page, videoTitle, channelName, expectedDuration, humanTypeFn, log, expectedVideoId);
    } catch (err) {
      log('warn', `[Fallback] Exact title search error: ${err.message}`);
    }
  }

  // Last resort: known watch URL only when strictTraffic is false (matches legacy behaviour)
  if (!strictSource && (!result || !result.success)) {
    if (videoUrl) {
      log('warn', '[Fallback] All search sources failed — direct URL as LAST RESORT');
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(randomDelay(2000, 4000));
      result = { success: true, source: 'direct-fallback', intendedSource, usedFallback: true };
      if (sessionState && typeof sessionState === 'object') {
        sessionState.directUrlUses = (sessionState.directUrlUses ?? 0) + 1;
      }
    } else {
      log('error', '[Fallback] All sources failed and no URL available');
    }
  }

  if (!result || !result.success) {
    log('warn', `[Traffic] "${source}" failed after fallbacks — skipping video`);
    result = {
      ...((result && typeof result === 'object') ? result : {}),
      success: false,
      source: result?.source || source || 'none',
      intendedSource,
      skipped: true,
    };
  }

  // Post-open verification — wrong video par watch mat karo
  if (result && result.success) {
    result = {
      ...result,
      intendedSource: result.intendedSource || intendedSource,
      usedFallback: result.usedFallback || (result.source !== intendedSource && result.source !== 'direct'),
    };
    try {
      if (expectedVideoId) {
        await waitForWatchPage(page, expectedVideoId, 12000);
      } else {
        await sleep(randomDelay(1500, 3000));
      }
      const { verifyOpenedVideo, detectPageBlock } = require('./agentBrain.cjs');
      const block = await detectPageBlock(page);
      if (block.blocked) {
        log('warn', `[Verify] Page blocked (${block.kind}): ${block.message}`);
        return { success: false, source: result.source, blocked: true, blockKind: block.kind, intendedSource };
      }
      const check = await verifyOpenedVideo(page, {
        title: videoTitle,
        channelName,
        videoUrl,
        videoId: expectedVideoId,
      });
      let finalCheck = check;
      if (!finalCheck.ok) {
        log('warn', `[Verify] Opened wrong video (${finalCheck.reason}): playing "${finalCheck.actual?.title}" by "${finalCheck.actual?.channel}"`);
        if (expectedVideoId && videoUrl) {
          log('warn', '[Verify] Recovering via watch URL from search result...');
          try {
            await page.goto(videoUrl, { waitUntil: 'commit', timeout: 30000 });
            await waitForWatchPage(page, expectedVideoId, 15000);
            finalCheck = await verifyOpenedVideo(page, {
              title: videoTitle,
              channelName,
              videoUrl,
              videoId: expectedVideoId,
            });
          } catch (err) {
            log('warn', `[Verify] URL recovery failed: ${err.message}`);
          }
        }
      }
      if (!finalCheck.ok) {
        return { success: false, source: result.source, verifyFailed: true, verifyReason: finalCheck.reason, intendedSource };
      }
      log('success', `[Verify] Confirmed: "${finalCheck.actual.title}"`);
    } catch (err) {
      log('warn', `[Verify] Check skipped: ${err.message}`);
    }
  }

  return result || { success: false, source: 'none', intendedSource };
}

function extractVideoIdFromUrl(url) {
  if (!url) return '';
  const m = String(url).match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : '';
}

/**
 * External referral page → find YouTube link → click (YouTube Analytics "External").
 */
async function openVideoViaBacklink(page, videoTitle, channelName, videoUrl, backlinkData, log) {
  const sourceUrl = backlinkData?.sourceUrl;
  if (!sourceUrl) {
    log('warn', '[Backlink] No source URL on video');
    return { success: false, source: 'backlink' };
  }
  const expectedVid = extractVideoIdFromUrl(videoUrl);
  try {
    log('info', `[Backlink] Referral: ${String(sourceUrl).slice(0, 72)}…`);
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(randomDelay(5000, 12000));
    await page.evaluate(() => {
      window.scrollBy(0, 200 + Math.random() * 500);
    });
    await sleep(randomDelay(2000, 5000));
    await page.evaluate(() => {
      window.scrollBy(0, 150 + Math.random() * 300);
    });
    await sleep(randomDelay(1500, 3500));

    const clickResult = await page.evaluate((vid) => {
      const anchors = [...document.querySelectorAll('a[href]')];
      const yt = anchors.filter((a) => {
        const h = a.href || '';
        return /youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\//i.test(h);
      });
      const pick = vid ? yt.find((a) => (a.href || '').includes(vid)) : null;
      const target = pick || yt[Math.floor(Math.random() * Math.min(yt.length, 5))];
      if (!target) return null;
      const href = target.href || target.getAttribute('href') || '';
      // Force same-tab navigation; otherwise target=_blank can open a new tab while
      // the agent keeps watching the old referral page.
      target.removeAttribute('target');
      target.setAttribute('target', '_self');
      target.click();
      return { mode: pick ? 'matched' : 'first', href };
    }, expectedVid || '');

    if (clickResult?.href) {
      log('info', `[Backlink] Clicked YouTube link (${clickResult.mode}) same-tab`);
      await sleep(randomDelay(4000, 8000));
      if (!/youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\//i.test(page.url())) {
        log('warn', '[Backlink] Click did not navigate same-tab — using href fallback');
        await page.goto(clickResult.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(randomDelay(2500, 5000));
      }
      return { success: true, source: 'backlink' };
    }

    if (videoUrl) {
      log('warn', '[Backlink] No YT link on page — opening target video URL');
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(randomDelay(2500, 5000));
      return { success: true, source: 'backlink-direct-fallback', intendedSource: 'backlink', usedFallback: true };
    }

    log('warn', '[Backlink] No YouTube link on referral page');
    return { success: false, source: 'backlink' };
  } catch (err) {
    log('warn', `[Backlink] ${err.message}`);
    return { success: false, source: 'backlink' };
  }
}

module.exports = {
  openVideoSmart,
  openVideoViaBacklink,
  extractVideoIdFromUrl,
  generateEscalationQueries,
  buildYouTubeSearchPlan,
  verifyVideoMatch,
  assignTrafficSource,
  parseDurationText,
  searchYouTube,
  searchGoogle,
  searchBing,
  searchDuckDuckGo,
  searchYahoo,
  searchChannelPage,
};
