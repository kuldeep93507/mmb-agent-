/**
 * YouTube page UI: mobile detection/routing, theme, search bar, quality, autoplay, popups, description/related hovers.
 * Multi-source traffic routing (Google/backlink/direct/suggested) lives in `./TrafficRouter.cjs` — helpers wired from agent.cjs.
 * Uses HumanBehavior for typing + smooth scroll where needed.
 */

'use strict';

const { humanType, smoothScroll } = require('./HumanBehavior.cjs');

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MOBILE YOUTUBE DETECTION
// Android profiles open m.youtube.com — completely different DOM
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function isMobileYouTube(page) {
  try {
    const url = page.url();
    if (url.includes('m.youtube.com')) return true;
    const hasMobileEl = await page.evaluate(() => !!document.querySelector('ytm-app, ytm-browse, ytm-watch')).catch(() => false);
    if (hasMobileEl) return true;
    // Fix Bug 19: Android profiles may land on www.youtube.com but still need mobile handling
    const isAndroid = await isAndroidUA(page);
    return isAndroid;
  } catch { return false; }
}

async function isAndroidUA(page) {
  try {
    const ua = await page.evaluate(() => navigator.userAgent);
    return /android|mobile/i.test(ua);
  } catch { return false; }
}

async function mobileYouTubeSearch(page, videoTitle, channelName, log) {
  try {
    log('info', '[Mobile] Using URL-based search for mobile YouTube...');

    const queries = [];
    if (channelName) queries.push(`${channelName} ${videoTitle}`);
    queries.push(videoTitle);
    const shortTitle = videoTitle.split(' ').slice(0, 5).join(' ');
    if (shortTitle !== videoTitle) queries.push(channelName ? `${channelName} ${shortTitle}` : shortTitle);

    const stopWords = new Set(['the','a','an','is','are','in','on','at','to','for','of','with','and','or','this','that']);

    function mobileWordMatch(cardText, targetTitle) {
      const targetWords = targetTitle.toLowerCase().split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
      if (targetWords.length === 0) return 0;
      const matched = targetWords.filter(w => cardText.toLowerCase().includes(w));
      return matched.length / targetWords.length;
    }

    for (const query of queries) {
      const encodedQuery = encodeURIComponent(query);
      await page.goto(`https://m.youtube.com/results?search_query=${encodedQuery}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(randomDelay(2500, 4000));

      const videoHref = await page.evaluate(({ titleTarget, channelTarget, stopWordsArr }) => {
        const stopSet = new Set(stopWordsArr);
        function wordMatch(text, target) {
          const words = target.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopSet.has(w));
          if (words.length === 0) return 0;
          return words.filter(w => text.toLowerCase().includes(w)).length / words.length;
        }

        const cardSelectors = [
          'ytm-compact-video-renderer',
          'ytm-video-with-context-renderer',
        ];

        let bestHref = null;
        let bestScore = 0;

        for (const cardSel of cardSelectors) {
          const cards = document.querySelectorAll(cardSel);
          for (const card of cards) {
            const cardText = (card.textContent || '').toLowerCase();
            const titleScore = wordMatch(cardText, titleTarget);
            let channelScore = 0;
            if (channelTarget) {
              const ct = channelTarget.toLowerCase().trim();
              if (cardText.includes(ct) || ct.split(/\s+/).filter(w => w.length > 2).every(w => cardText.includes(w))) {
                channelScore = 0.35;
              }
            }
            const totalScore = titleScore + channelScore;

            if (totalScore > bestScore) {
              const link = card.querySelector('a[href*="/watch?v="]') || card.querySelector('a[href*="/watch"]');
              if (link) {
                const href = link.getAttribute('href');
                if (href && href.includes('/watch')) {
                  bestScore = totalScore;
                  bestHref = href;
                }
              }
            }
          }
        }

        const minScore = channelTarget ? 0.58 : 0.48;
        return bestScore >= minScore ? bestHref : null;
      }, { titleTarget: videoTitle, channelTarget: channelName || '', stopWordsArr: Array.from(stopWords) });

      if (videoHref) {
        const fullUrl = videoHref.startsWith('http') ? videoHref : `https://m.youtube.com${videoHref}`;
        log('info', `[Mobile] Matched video — navigating to: ${fullUrl}`);
        await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(randomDelay(2000, 4000));
        return true;
      }

      log('info', `[Mobile] No confident match for query "${query}" — trying next...`);
      await sleep(randomDelay(1000, 2000));
    }

    log('warn', '[Mobile] No matching video found after all queries — skipping to avoid wrong video');
    return false;
  } catch (err) {
    log('warn', `[Mobile] Search error: ${err.message}`);
    return false;
  }
}

async function mobileDirectWatch(page, videoUrl, log) {
  if (!videoUrl || !videoUrl.includes('watch')) return false;
  try {
    const mobileUrl = videoUrl.replace('www.youtube.com', 'm.youtube.com');
    log('info', `[Mobile] Direct URL fallback: ${mobileUrl}`);
    await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(randomDelay(2000, 4000));
    return page.url().includes('/watch');
  } catch (err) {
    log('warn', `[Mobile] Direct URL failed: ${err.message}`);
    return false;
  }
}

async function forceDarkTheme(page) {
  try {
    await page.evaluate(() => {
      document.cookie = 'PREF=f6=400; path=/; domain=.youtube.com; max-age=31536000';
      document.documentElement.setAttribute('dark', 'true');
      document.documentElement.style.colorScheme = 'dark';
      try {
        const pref = JSON.parse(localStorage.getItem('yt-player-quality') || '{}');
        pref.darkTheme = true;
        localStorage.setItem('yt-player-quality', JSON.stringify(pref));
      } catch {}
    });
    await page.emulateMedia({ colorScheme: 'dark' }).catch(() => {});
  } catch {}
}

async function clickSearchAndType(page, query) {
  try {
    await page.keyboard.press('/');
    await sleep(800);
    const focused = await page.evaluate(() => document.activeElement?.id === 'search' || document.activeElement?.tagName === 'INPUT');
    if (focused) {
      await page.keyboard.press('Control+a');
      await sleep(100);
      await page.keyboard.press('Backspace');
      await sleep(300);
      await humanType(page, query);
      return true;
    }
  } catch {}

  try {
    const searchInput = await page.$('input#search');
    if (searchInput) {
      await searchInput.click();
      await sleep(500);
      await page.keyboard.press('Control+a');
      await sleep(100);
      await page.keyboard.press('Backspace');
      await sleep(300);
      await humanType(page, query);
      return true;
    }
  } catch {}

  try {
    const searchBtn = await page.$('#search-icon-legacy, button[aria-label="Search"]');
    if (searchBtn) {
      await searchBtn.click();
      await sleep(800);
      await humanType(page, query);
      return true;
    }
  } catch {}

  try {
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await sleep(200);
      const focuses = await page.evaluate(() => document.activeElement?.id === 'search');
      if (focuses) { await humanType(page, query); return true; }
    }
  } catch {}

  return false;
}

async function setVideoQuality(page, quality, logFn = () => {}) {
  if (!quality || quality === 'auto') {
    logFn('info', '[Quality] auto — no change');
    return true;
  }
  const qualityMap = { '144p': '144', '240p': '240', '360p': '360', '480p': '480', '720p': '720', '1080p': '1080' };
  const targetRes = qualityMap[quality] || String(quality).replace('p', '');
  const mobile = await isMobileYouTube(page);

  try {
    await sleep(mobile ? 1500 : 2000);

    if (mobile) {
      // Tap video to reveal player controls on mobile
      const videoEl = await page.$('video').catch(() => null);
      if (videoEl) { await videoEl.click().catch(() => {}); await sleep(700); }

      const setMobile = await page.evaluate((res) => {
        try {
          const gear = document.querySelector(
            'ytm-icon-button[data-test-id="settings-button"], button[aria-label*="Settings" i], button[aria-label*="Quality" i], .ytm-settings-button, button.ytm-settings-button, .player-settings-icon',
          );
          if (gear) { gear.click(); return 'opened-menu'; }
          return null;
        } catch { return null; }
      }, targetRes).catch(() => null);

      if (setMobile === 'opened-menu') {
        await sleep(800);
        const picked = await page.evaluate((res) => {
          const items = [...document.querySelectorAll('button, [role="menuitem"], .ytm-menu-item-renderer, ytm-menu-item-renderer')];
          for (const el of items) {
            const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
            if (t.includes(res) && (t.includes('p') || t.includes(res))) {
              el.click();
              return true;
            }
          }
          return false;
        }, targetRes).catch(() => false);
        if (picked) {
          logFn('success', `[Quality] Mobile set to ${quality}`);
          return true;
        }
      }
      logFn('warn', `[Quality] Mobile ${quality} — menu not found (may stay auto)`);
      return false;
    }

    // Desktop: hover player first so controls become visible
    const playerEl = await page.$('#movie_player, .html5-video-player').catch(() => null);
    if (playerEl) {
      const box = await playerEl.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30, { steps: 5 }).catch(() => {});
        await sleep(500);
      }
    }

    const settingsBtn = await page.$('.ytp-settings-button');
    if (!settingsBtn) {
      logFn('warn', '[Quality] Settings button not found');
      return false;
    }
    await settingsBtn.click();
    await sleep(800);

    const items = await page.$$('.ytp-menuitem');
    for (const item of items) {
      const text = await item.textContent().catch(() => '');
      if (text.toLowerCase().includes('quality') || text.toLowerCase().includes('qualit')) {
        await item.click();
        await sleep(600);
        break;
      }
    }

    const qualityOptions = await page.$$('.ytp-quality-menu .ytp-menuitem, .ytp-panel-menu .ytp-menuitem');
    for (const option of qualityOptions) {
      const text = await option.textContent().catch(() => '');
      if (text.includes(targetRes)) {
        await option.click();
        await sleep(500);
        logFn('success', `[Quality] Set to ${quality}`);
        return true;
      }
    }
    await page.keyboard.press('Escape');
    logFn('warn', `[Quality] ${quality} option not found`);
    return false;
  } catch (err) {
    logFn('warn', `[Quality] Error: ${err.message}`);
    return false;
  }
}

async function disableAutoplay(page, logFn = () => {}) {
  let ok = false;
  try {
    // FIX: Hover the player first so controls become visible (autoplay toggle is hidden otherwise)
    await page.evaluate(() => {
      const player = document.querySelector('#movie_player, .html5-video-player');
      if (player) {
        const rect = player.getBoundingClientRect();
        if (rect.width > 0) {
          player.dispatchEvent(new MouseEvent('mousemove', {
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height * 0.8, // near bottom controls bar
            bubbles: true,
          }));
        }
      }
    }).catch(() => {});
    await sleep(900); // wait for controls to appear

    const mobile = await isMobileYouTube(page);

    // FIX: clickIfOn now also handles case where aria attributes might not be set but button IS visible
    // Also tries clicking even when status is ambiguous (not pressed/checked), since default state might vary
    const clickIfOn = async (selector) => {
      const el = await page.$(selector);
      if (!el) return false;
      const state = await el.evaluate((node) => {
        const pressed = node.getAttribute('aria-pressed');
        const checked = node.getAttribute('aria-checked');
        const hasActiveClass = node.classList.contains('ytp-autonav-toggle-button--active')
          || node.classList.contains('on')
          || (node.getAttribute('data-tooltip-text') || '').toLowerCase().includes('on');
        // visible means it exists in DOM and not hidden
        const visible = node.offsetParent !== null
          || window.getComputedStyle(node).display !== 'none';
        return { pressed, checked, hasActiveClass, visible };
      }).catch(() => null);
      if (!state || !state.visible) return false;
      const isOn = state.pressed === 'true' || state.checked === 'true' || state.hasActiveClass;
      // Only click when we're sure autoplay is ON — ambiguous state skips click
      // to avoid accidentally turning autoplay ON when it was already OFF (Bug 6 fix)
      if (isOn) {
        await el.dispatchEvent('click').catch(() => {});
        await el.click({ force: true }).catch(() => {});
        await sleep(400);
        return true;
      }
      return false;
    };

    if (await clickIfOn('button[data-tooltip-target-id="autoplay-toggle-button"]')) ok = true;
    else if (await clickIfOn('.ytp-autonav-toggle-button')) ok = true;
    else if (await clickIfOn('button[aria-label*="Autoplay" i]')) ok = true;
    else if (await clickIfOn('button[aria-label*="autoplay" i]')) ok = true;

    if (mobile) {
      const mob = await page.evaluate(() => {
        const selectors = [
          'button[aria-label*="Autoplay" i]',
          'button[aria-label*="autoplay" i]',
          'ytm-toggle-button-renderer button',
          '[class*="autonav"]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (!btn || btn.offsetParent === null) continue;
          const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.textContent || ''}`.toLowerCase();
          const cls = String(btn.className || '').toLowerCase();
          const confidentlyOn = btn.getAttribute('aria-pressed') === 'true'
            || btn.getAttribute('aria-checked') === 'true'
            || cls.includes('active')
            || cls.includes('on')
            || label.includes('autoplay is on')
            || label.includes('autoplay on');
          const confidentlyOff = btn.getAttribute('aria-pressed') === 'false'
            || btn.getAttribute('aria-checked') === 'false'
            || label.includes('autoplay is off')
            || label.includes('autoplay off');
          if (confidentlyOn) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { clicked: true, state: 'on' };
          }
          if (confidentlyOff) return { clicked: false, state: 'off' };
          return { clicked: false, state: 'unknown' };
        }
        return { clicked: false, state: 'not_found' };
      }).catch(() => ({ clicked: false, state: 'error' }));
      if (mob.clicked) ok = true;
      if (mob.state === 'unknown') logFn('warn', '[Autoplay] Mobile toggle state unknown — preference set only, no blind click');
    }

    // Always write localStorage to be sure — this persists across navigations
    await page.evaluate(() => {
      try {
        // Primary YouTube player pref key
        localStorage.setItem('yt-player-autoplay', JSON.stringify({ autoplay: false }));
        // Also update existing prefs objects if present
        const keys = ['yt-player-autoplay', 'yt-player-bandwidth'];
        for (const k of keys) {
          try {
            const raw = localStorage.getItem(k);
            if (!raw) continue;
            const prefs = JSON.parse(raw);
            if (prefs && typeof prefs === 'object') {
              prefs.autoplay = false;
              localStorage.setItem(k, JSON.stringify(prefs));
            }
          } catch { /* ignore */ }
        }
        // Some YouTube versions store it differently
        try {
          const cfg = JSON.parse(localStorage.getItem('yt-player-preferences') || '{}');
          cfg.autoplay = false;
          localStorage.setItem('yt-player-preferences', JSON.stringify(cfg));
        } catch { /* ignore */ }
      } catch { /* ignore */ }
    }).catch(() => {});
    logFn(ok ? 'success' : 'info', `[Autoplay] ${ok ? 'Toggle clicked OFF + preference set' : 'Preference set to OFF; toggle not clicked/verified'}`);
    return ok;
  } catch (err) {
    logFn('warn', `[Autoplay] Error: ${err.message}`);
    return false;
  }
}

/** FIX: Returns null when button not found (unknown state), true when confirmed off, false when confirmed on */
async function verifyAutoplayOff(page) {
  const result = await page.evaluate(() => {
    const btn = document.querySelector(
      'button[data-tooltip-target-id="autoplay-toggle-button"], .ytp-autonav-toggle-button, button[aria-label*="Autoplay" i], button[aria-label*="autoplay" i]',
    );
    // FIX: Don't claim "off" just because button wasn't found — return null (unknown)
    if (!btn || btn.offsetParent === null) return null;
    const on = btn.getAttribute('aria-pressed') === 'true'
      || btn.getAttribute('aria-checked') === 'true'
      || btn.classList.contains('ytp-autonav-toggle-button--active');
    return !on; // true = off, false = still on
  }).catch(() => null);
  return result;
}

async function ensureAutoplayOff(page, logFn = () => {}) {
  for (let pass = 1; pass <= 3; pass++) {
    await disableAutoplay(page, logFn);
    const state = await verifyAutoplayOff(page);

    if (state === true) {
      logFn('success', `[Autoplay] Verified OFF (pass ${pass}/3): OK`);
      return true;
    }
    if (state === null) {
      logFn('warn', '[Autoplay] State unknown — preference set to OFF, but toggle not verified');
      return null;
    }
    // state === false: button found and still ON
    if (pass < 3) {
      logFn('warn', `[Autoplay] Still ON after pass ${pass} — retrying in ${pass * 600}ms...`);
      await sleep(pass * 600);
    }
  }
  logFn('warn', '[Autoplay] Could not confirm OFF after 3 passes — continuing anyway');
  return false;
}

async function dismissYouTubePopups(page, logFn = () => {}) {
  // Retry up to 3 times — popup can appear 1-3s after page load
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Handle Google consent page redirect (consent.youtube.com or accounts.google.com/consent)
      const url = page.url();
      if (url.includes('consent.youtube.com') || url.includes('consent.google.com')) {
        const consentClicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, .VfPpkd-LgbsSe')];
          // Priority: "Accept all" first — don't click "Reject all" by mistake
          const priority = ['accept all', 'accept', 'agree', 'reject all', 'reject'];
          for (const keyword of priority) {
            const btn = btns.find((b) => (b.textContent || '').toLowerCase().trim().includes(keyword));
            if (btn) { btn.click(); return keyword; }
          }
          const formBtn = document.querySelector('form[action*="consent"] button, form button[type="submit"]');
          if (formBtn) { formBtn.click(); return 'consent-form-submit'; }
          return null;
        });
        if (consentClicked) {
          logFn('info', `[YouTube popup] Consent page dismissed: "${consentClicked}"`);
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await sleep(randomDelay(1000, 2000));
          return;
        }
      }

      // Inline popup / modal on YouTube page
      const clicked = await page.evaluate(() => {
        // Priority order for button text — "Accept all" before "Reject all"
        const preferredLabels = ['accept all', 'allow all', 'accept', 'i agree', 'agree', 'got it'];
        const dismissLabels = ['reject all', 'reject', 'no thanks', 'not now', 'dismiss', 'close', 'continue'];
        const allLabels = [...preferredLabels, ...dismissLabels];

        function findByText(container, labels) {
          const buttons = [...container.querySelectorAll('button, tp-yt-paper-button, ytd-button-renderer button')];
          for (const keyword of labels) {
            const btn = buttons.find((b) => {
              const t = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase().trim();
              return t === keyword || t.includes(keyword);
            });
            if (btn) {
              const r = btn.getBoundingClientRect();
              if (r.width > 20 && r.height > 12) { btn.click(); return keyword; }
            }
          }
          return null;
        }

        // YouTube-specific consent containers — search for "Accept all" by text first
        const ytContainers = [
          document.querySelector('ytd-consent-bump-v2-lightbox'),
          document.querySelector('yt-consent-ui-lightbox'),
          document.querySelector('tp-yt-paper-dialog'),
          document.querySelector('.ytd-consent-bump-v2-lightbox'),
        ].filter(Boolean);

        for (const container of ytContainers) {
          const result = findByText(container, allLabels);
          if (result) return `[dialog] ${result}`;
        }

        // aria-label based buttons (fallback)
        for (const sel of ['button[aria-label*="Accept" i]', 'button[aria-label*="Agree" i]']) {
          const btn = document.querySelector(sel);
          if (btn) {
            const r = btn.getBoundingClientRect();
            if (r.width > 20 && r.height > 12 && r.top >= 0 && r.top < window.innerHeight) {
              btn.click(); return sel.slice(0, 40);
            }
          }
        }

        // Generic scan — entire page, text-priority order
        for (const sel of ['tp-yt-paper-button', 'ytd-button-renderer button', 'button']) {
          for (const el of document.querySelectorAll(sel)) {
            const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase().trim();
            if (!t || t.length > 40) continue;
            if (allLabels.some((w) => t === w || t.includes(w))) {
              const r = el.getBoundingClientRect();
              if (r.width > 20 && r.height > 12 && r.top >= 0 && r.top < window.innerHeight) {
                el.click();
                return t.slice(0, 30);
              }
            }
          }
        }
        return null;
      });

      if (clicked) {
        logFn('info', `[YouTube popup] Dismissed (attempt ${attempt}): "${clicked}"`);
        await sleep(randomDelay(800, 1500));
        return; // popup dismissed — stop retrying
      }
    } catch (err) {
      logFn('warn', `[YouTube popup] Attempt ${attempt} error: ${err.message}`);
    }

    // No popup found/clicked this attempt — wait and try again (popup may not have appeared yet)
    if (attempt < 3) await sleep(randomDelay(1500, 2500));
  }
}

async function expandDescriptionAndRead(page, logFn = () => {}) {
  try {
    await smoothScroll(page, randomDelay(120, 280), 'down');
    await sleep(randomDelay(800, 1600));
    const expanded = await page.evaluate(() => {
      // Mobile selectors (ytm-) first, then desktop
      const mobileSelectors = [
        'ytm-text-inline-expander .expand-button',
        'ytm-expander .expand-collapse-button',
        'ytm-section-list-renderer [aria-label*="more" i]',
        '[id*="expand-content"] button',
        'ytm-watch-description-hero-renderer button',
        'button[aria-label*="Show more" i]',
        'button[aria-label*="more" i]',
      ];
      for (const sel of mobileSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { el.click(); return true; }
      }
      // Desktop selectors
      const btn = document.querySelector(
        '#expand, tp-yt-paper-button#expand, ytd-text-inline-expander #expand',
      );
      if (btn) { btn.click(); return true; }
      const more = [...document.querySelectorAll('button, yt-formatted-string, span')].find(el => {
        const t = (el.textContent || '').toLowerCase().trim();
        return t === '...more' || t === 'show more' || t === 'more';
      });
      if (more) { more.click(); return true; }
      return false;
    });
    if (expanded) {
      logFn('info', '[Human] Description expanded — reading...');
      await sleep(randomDelay(2000, 4500));
      await smoothScroll(page, randomDelay(180, 420), 'down');
      await sleep(randomDelay(1500, 3000));
      await smoothScroll(page, randomDelay(200, 500), 'up');
      await sleep(randomDelay(800, 1800));
      const player = await page.$('#movie_player, .html5-video-player, video').catch(() => null);
      if (player) {
        const box = await player.boundingBox().catch(() => null);
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3, { steps: randomDelay(6, 14) }).catch(() => {});
      }
      logFn('info', '[Human] Back to video area');
    }
  } catch (err) {
    logFn('warn', `[Human] Description read: ${err.message}`);
  }
}

/**
 * Click the bell notification icon after subscribing.
 * Works on both desktop (www.youtube.com) and Android mobile (m.youtube.com).
 */
async function clickBellIcon(page, logFn = () => {}) {
  try {
    await sleep(randomDelay(800, 1800));
    const clicked = await page.evaluate(() => {
      // Mobile selectors (ytm-)
      const mobileSelectors = [
        'ytm-subscription-notification-toggle-button-renderer button',
        'button[aria-label*="notification" i]',
        'button[aria-label*="All notifications" i]',
        '.notification-preference-button button',
        '[data-style="NOTIFICATION_PREFERENCE_STYLE_UNKNOWN"] button',
      ];
      for (const sel of mobileSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { el.click(); return 'mobile'; }
      }
      // Desktop selectors
      const desktopSelectors = [
        '#notification-preference-button button',
        'ytd-subscription-notification-toggle-button-renderer button',
        'button[aria-label*="notification" i]',
        'button[aria-label*="Notification" i]',
      ];
      for (const sel of desktopSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { el.click(); return 'desktop'; }
      }
      return null;
    });
    if (clicked) {
      logFn('info', `🔔 Bell icon clicked (${clicked})`);
      await sleep(randomDelay(500, 1200));
      // If a popup appeared (notification options), pick "All" or dismiss
      await page.evaluate(() => {
        const allBtn = [...document.querySelectorAll('button, [role="menuitem"], tp-yt-paper-item')]
          .find(el => {
            const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
            return t.includes('all') && (t.includes('notif') || el.closest('[id*="notification"]'));
          });
        if (allBtn) allBtn.click();
      }).catch(() => {});
      return true;
    }
    return false;
  } catch (err) {
    logFn('warn', `[Bell] Click failed: ${err.message}`);
    return false;
  }
}

async function hoverRelatedVideos(page, logFn = () => {}) {
  try {
    // Mobile selectors (ytm-) + desktop selectors
    const items = await page.$$(
      'ytm-compact-video-renderer, ytm-video-with-context-renderer, ytd-compact-video-renderer, ytd-video-renderer, ytd-rich-item-renderer',
    );
    const pick = items.slice(0, Math.min(items.length, 12));
    if (!pick.length) return;
    const count = randomDelay(1, 3);
    const used = new Set();
    for (let i = 0; i < count; i++) {
      let idx = Math.floor(Math.random() * pick.length);
      if (used.size < pick.length) {
        while (used.has(idx)) idx = Math.floor(Math.random() * pick.length);
        used.add(idx);
      }
      const el = pick[idx];
      const box = await el.boundingBox().catch(() => null);
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: randomDelay(10, 22) }).catch(() => {});
        await sleep(randomDelay(1200, 2800));
        logFn('info', `[Human] Hover related video ${i + 1}/${count}`);
      }
    }
  } catch (err) {
    logFn('warn', `[Human] Related hover: ${err.message}`);
  }
}

async function verifyVideoQuality(page, quality) {
  if (!quality || quality === 'auto') return true;
  const targetRes = String(quality).replace(/p$/i, '');
  const minPx = parseInt(targetRes, 10);
  const threshold = Number.isFinite(minPx) ? minPx : 360;

  const readState = () =>
    page
      .evaluate((floor) => {
        const els = [...document.querySelectorAll('video')];
        let bestH = 0;
        for (const v of els) {
          try {
            const h = typeof v.videoHeight === 'number' ? v.videoHeight : 0;
            if (h > bestH) bestH = h;
          } catch {
            /* ignore */
          }
          try {
            const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
            if (q && typeof q.size === 'object' && typeof q.size.height === 'number') {
              const qh = q.size.height;
              if (qh > bestH) bestH = qh;
            }
          } catch {
            /* ignore */
          }
        }
        if (bestH >= Math.floor(floor * 0.85)) return true;
        const gear = document.querySelector('.ytp-settings-button');
        const qualityBtn = document.querySelector('.ytp-quality-button .ytp-menuitem-label');
        const label = (qualityBtn?.textContent || gear?.getAttribute('aria-label') || '').toLowerCase();
        const f = String(floor);
        return label.includes(f) || label.includes(`${floor}p`);
      }, threshold)
      .catch(() => false);

  for (let i = 1; i <= 3; i++) {
    const ok = await readState();
    if (ok) return true;
    if (i < 3) await sleep(randomDelay(800, 2600));
  }
  return false;
}

async function ensureVideoQuality(page, quality, logFn = () => {}) {
  if (!quality || quality === 'auto') {
    logFn('info', '[Quality] auto — no change');
    return true;
  }
  let ok = await setVideoQuality(page, quality, logFn);
  let verified = await verifyVideoQuality(page, quality);
  if (!verified) {
    logFn('warn', `[Quality] Verify failed after pass 1 — retrying ${quality}...`);
    await sleep(1000);
    ok = await setVideoQuality(page, quality, logFn) || ok;
    verified = await verifyVideoQuality(page, quality);
  }
  logFn(verified ? 'success' : 'warn', `[Quality] Verified (2-pass): ${verified ? quality : 'unconfirmed'}`);
  return verified || ok;
}

module.exports = {
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
};
