'use strict';

/**
 * HighCPCCookieWarmer — Makes new profiles look "aged" to YouTube/ad networks.
 *
 * 1. MLX cookie metadata (mix = Google + Amazon + Facebook high-CPC pool)
 * 2. Optional live bake: start profile → visit high-RPM sites → seed PREF/CONSENT → stop
 *
 * @module HighCPCCookieWarmer
 */

const { chromium } = require('playwright-core');
const { MultiloginCookiesService } = require('./MultiloginCookiesService.cjs');

/** MLX cookies API official targets (live from cookies.multilogin.com) */
const MLX_COOKIE_TARGETS = ['mix', 'google', 'amazon', 'facebook', 'ebay', 'etsy', 'bing'];

/**
 * High CPC / RPM / CPM — ad-buyer + finance/loan/insurance interest signals.
 * Finance verticals are NOT separate MLX metadata keys; they come from:
 *   - mix pool ("Mixed cookies — other websites")
 *   - live browse below (YouTube finance searches + finance sites)
 */
const HIGH_CPC_VISIT_URLS = [
  // Core ad networks (MLX metadata targets)
  'https://www.google.com/search?q=best+tech+deals+2026&hl=en&gl=us',
  'https://www.youtube.com/?hl=en&gl=US',
  'https://www.amazon.com/',
  'https://www.facebook.com/',
  'https://www.ebay.com/',
  'https://www.bing.com/',
  // YouTube high-CPM niches — finance / loan / insurance (interest cookies)
  'https://www.youtube.com/results?search_query=personal+loan+interest+rates+2026',
  'https://www.youtube.com/results?search_query=car+insurance+quotes+comparison',
  'https://www.youtube.com/results?search_query=home+loan+mortgage+rates+usa',
  'https://www.youtube.com/results?search_query=credit+score+improve+tips',
  // Finance / insurance publisher sites (high CPC buyers)
  'https://www.google.com/search?q=compare+life+insurance+rates&hl=en&gl=us',
  'https://www.creditkarma.com/',
  'https://www.bankrate.com/',
  'https://www.nerdwallet.com/',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function isEnabled() {
  const v = process.env.COOKIE_WARM_ON_CREATE;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

class HighCPCCookieWarmer {
  constructor(provider) {
    this.provider = provider;
    this.cookiesSvc = new MultiloginCookiesService();
  }

  /**
   * Register ALL MLX cookie metadata targets at profile create time.
   * mix = finance/shopping/misc high-CPC pool (not just Google/Amazon/FB).
   */
  async applyMetadata(profileId) {
    let ok = false;
    let message = '';

    const mix = await this.cookiesSvc.createCookieMetadata(profileId, 'mix');
    if (mix.code === 0) {
      ok = true;
      // Primary: google + amazon (YouTube RPM + shopping ads)
      await this.cookiesSvc.updateCookieMetadata(profileId, 'google', 'amazon').catch(() => {});
      // Secondary: facebook via another update (MLX allows one additional_website per call)
      await this.cookiesSvc.updateCookieMetadata(profileId, 'google', 'facebook').catch(() => {});
      message = 'mix + google/amazon/facebook + finance pool (mix)';
    } else {
      const google = await this.cookiesSvc.createCookieMetadata(profileId, 'google');
      ok = google.code === 0;
      if (ok) {
        await this.cookiesSvc.updateCookieMetadata(profileId, 'google', 'amazon').catch(() => {});
        message = 'google + amazon fallback';
      } else {
        message = mix.message || google.message || 'metadata failed';
      }
    }

    return { ok, targets: MLX_COOKIE_TARGETS, message };
  }

  /**
   * Seed US high-RPM preference cookies + browse ad-buyer sites once.
   * Cloud profiles only — cookies persist after stop.
   *
   * @param {string} profileId
   * @param {object} [opts]
   * @param {boolean} [opts.cloudOnly=true]
   * @returns {Promise<{baked: boolean, sitesVisited: string[], cookieCount: number, error?: string}>}
   */
  async bakeLiveSession(profileId, opts = {}) {
    if (!isEnabled()) {
      return { baked: false, sitesVisited: [], cookieCount: 0, error: 'COOKIE_WARM_ON_CREATE disabled' };
    }

    const cloudOnly = opts.cloudOnly !== false;
    if (cloudOnly && opts.profileMode === 'quick') {
      return { baked: false, sitesVisited: [], cookieCount: 0, error: 'quick profile — skip live bake' };
    }

    let browser;
    const sitesVisited = [];

    try {
      const start = await this.provider.startProfile(profileId);
      if (start.code !== 0 || !start.data?.cdpPort) {
        return {
          baked: false,
          sitesVisited,
          cookieCount: 0,
          error: start.message || 'Could not start profile for cookie bake',
        };
      }

      const port = start.data.cdpPort;
      await sleep(5000);

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 45000 });
      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();

      await this._seedHighRPMCookies(context);

      for (const url of HIGH_CPC_VISIT_URLS) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
          await sleep(randomDelay(6000, 14000));
          if (url.includes('youtube.com')) {
            await page.evaluate(() => {
              window.scrollBy(0, 300 + Math.random() * 400);
              document.cookie = 'PREF=f6=400&f7=100&hl=en&gl=US; path=/; domain=.youtube.com; max-age=31536000; Secure';
            }).catch(() => {});
            await sleep(randomDelay(2000, 5000));
          } else if (/creditkarma|bankrate|nerdwallet|finance|loan|insurance/i.test(url)) {
            await page.evaluate(() => { window.scrollBy(0, 200 + Math.random() * 300); }).catch(() => {});
            await sleep(randomDelay(4000, 8000));
          }
          sitesVisited.push(url);
        } catch (err) {
          console.warn(`[HighCPCCookieWarmer] Skip ${url}: ${err.message}`);
        }
      }

      const cookies = await context.cookies();
      const cookieCount = cookies.length;

      await this.provider.stopProfile(profileId);
      await sleep(3000);

      console.log(
        `[HighCPCCookieWarmer] Baked ${profileId.slice(0, 8)}… — ${sitesVisited.length} sites, ${cookieCount} cookies stored`
      );

      return { baked: true, sitesVisited, cookieCount };
    } catch (err) {
      await this.provider.stopProfile(profileId).catch(() => {});
      return { baked: false, sitesVisited, cookieCount: 0, error: err.message };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Full pipeline: metadata + live bake.
   * @param {string} profileId
   * @param {object} [opts]
   */
  async warmOnCreate(profileId, opts = {}) {
    const meta = await this.applyMetadata(profileId);
    let bake = { baked: false, sitesVisited: [], cookieCount: 0 };

    if (meta.ok && opts.profileMode !== 'quick') {
      bake = await this.bakeLiveSession(profileId, opts);
    }

    return {
      metadataSet: meta.ok,
      metadataTargets: meta.targets,
      metadataMessage: meta.message,
      liveBake: bake.baked,
      sitesVisited: bake.sitesVisited,
      cookieCount: bake.cookieCount,
      bakeError: bake.error,
    };
  }

  /** US English ad-preference + consent seeds (safe, no fake auth tokens). */
  async _seedHighRPMCookies(context) {
    const now = Math.floor(Date.now() / 1000);
    const expires = now + 365 * 24 * 3600;
    const consentVal = `YES+cb.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-00-p0.en+FX+${randomDelay(100, 999)}`;

    const seeds = [
      { name: 'PREF', value: 'f6=400&f7=100&hl=en&gl=US', domain: '.youtube.com', path: '/', expires, secure: true, sameSite: 'Lax' },
      { name: 'PREF', value: 'f6=400&hl=en&gl=US', domain: '.google.com', path: '/', expires, secure: true, sameSite: 'Lax' },
      { name: 'CONSENT', value: consentVal, domain: '.google.com', path: '/', expires, secure: true, sameSite: 'Lax' },
      { name: 'CONSENT', value: consentVal, domain: '.youtube.com', path: '/', expires, secure: true, sameSite: 'Lax' },
      { name: 'SOCS', value: 'CAISNQgAEhJndGlyX2Jrc19kZXNrcF9yb29tEiwKCC9KAw', domain: '.google.com', path: '/', expires, secure: true, sameSite: 'Lax' },
    ];

    try {
      await context.addCookies(seeds);
    } catch (err) {
      console.warn(`[HighCPCCookieWarmer] Seed cookies partial: ${err.message}`);
    }
  }
}

module.exports = { HighCPCCookieWarmer, HIGH_CPC_VISIT_URLS, MLX_COOKIE_TARGETS, isEnabled };
