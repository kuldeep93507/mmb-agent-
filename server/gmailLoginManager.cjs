'use strict';
/**
 * Gmail Login Manager
 * Automates Gmail login for multiple Multilogin/MoreLogin profiles in batches.
 * Handles: simple login, phone verification (pause), wrong password, blocked.
 */

const { chromium } = require('playwright-core');
const { providerFactory } = require('./providers/ProviderFactory.cjs');
const fs = require('fs');
const path = require('path');

const GMAIL_STATUS_FILE = path.resolve(__dirname, '..', 'gmail_status_data.json');

function readPersistedStatuses() {
  try {
    const raw = JSON.parse(fs.readFileSync(GMAIL_STATUS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writePersistedStatuses(data) {
  try {
    const tmp = `${GMAIL_STATUS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, GMAIL_STATUS_FILE);
    return true;
  } catch (err) {
    console.warn('[GmailLogin] Failed to persist status:', err.message);
    return false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
async function humanType(page, text) {
  for (const char of text) {
    await page.keyboard.type(char, { delay: randomDelay(60, 130) });
  }
}

/** Status types for each credential entry */
const STATUS = {
  PENDING:           'pending',
  RUNNING:           'running',
  SUCCESS:           'success',
  NEEDS_PHONE:       'needs_phone',      // phone/recovery verification needed
  CAPTCHA:           'captcha',          // CAPTCHA appeared — manual
  WRONG_PASSWORD:    'wrong_password',
  BLOCKED:           'blocked',          // Google blocked this login attempt
  ERROR:             'error',
  SKIPPED:           'skipped',
  WAITING_RESUME:    'waiting_resume',   // user manually handled, waiting to continue
};

class GmailLoginManager {
  constructor() {
    this._queue = [];          // Array of credential entries
    this._running = false;
    this._stopped = false;
    this._batchSize = 3;
    this._activeBatch = [];    // Currently running entries
    this._logs = [];           // Global log
    this._onUpdate = null;     // optional callback
    this._persistedStatuses = readPersistedStatuses(); // profileId -> last known Gmail status
  }

  // ── Public API ────────────────────────────────────────────────────────

  start(credentials, batchSize = 3) {
    if (this._running) return { ok: false, error: 'Already running' };
    this._batchSize = Math.max(1, Math.min(10, batchSize));
    this._stopped = false;
    this._running = true;

    // Merge incoming with existing (preserve already-done entries)
    const existingIds = new Set(this._queue.map(e => e.profileId));
    for (const c of credentials) {
      if (!existingIds.has(c.profileId)) {
        this._queue.push({
          profileId:   c.profileId,
          profileName: c.profileName || c.profileId,
          email:       c.email,
          password:    c.password,
          browserType: c.browserType || 'multilogin',
          status:      STATUS.PENDING,
          message:     '',
          startedAt:   null,
          doneAt:      null,
        });
      }
    }

    this._log('info', `Gmail login started — ${this._queue.length} profiles, batch ${this._batchSize}`);
    void this._runLoop();
    return { ok: true };
  }

  stop() {
    this._stopped = true;
    this._running = false;
    this._log('info', 'Stopped by user');
    return this.getStatus();
  }

  clearAll() {
    if (this._running) return { ok: false, error: 'Stop first before clearing' };
    this._queue = [];
    this._logs = [];
    return { ok: true };
  }

  markResume(profileId) {
    const entry = this._findEntry(profileId);
    if (!entry) return { ok: false, error: 'Profile not found' };
    if (entry.status !== STATUS.NEEDS_PHONE && entry.status !== STATUS.CAPTCHA && entry.status !== STATUS.WAITING_RESUME) {
      return { ok: false, error: `Cannot resume — status is ${entry.status}` };
    }
    entry.status = STATUS.SUCCESS;
    entry.message = 'Manually completed by user';
    entry.doneAt = Date.now();
    this._log('success', `${entry.profileName}: marked as done (manual)`);
    this._persistEntryStatus(entry);
    return { ok: true };
  }

  markSkip(profileId) {
    const entry = this._findEntry(profileId);
    if (!entry) return { ok: false, error: 'Profile not found' };
    entry.status = STATUS.SKIPPED;
    entry.message = 'Skipped by user';
    entry.doneAt = Date.now();
    this._persistEntryStatus(entry);
    return { ok: true };
  }

  retryEntry(profileId) {
    const entry = this._findEntry(profileId);
    if (!entry) return { ok: false, error: 'Profile not found' };
    entry.status = STATUS.PENDING;
    entry.message = '';
    entry.startedAt = null;
    entry.doneAt = null;
    this._persistEntryStatus(entry);
    // If loop stopped, restart it
    if (!this._running && !this._stopped) {
      this._running = true;
      void this._runLoop();
    }
    return { ok: true };
  }

  getStatus() {
    const counts = { total: this._queue.length, pending: 0, running: 0, success: 0, failed: 0, waiting: 0 };
    for (const e of this._queue) {
      if (e.status === STATUS.PENDING) counts.pending++;
      else if (e.status === STATUS.RUNNING) counts.running++;
      else if (e.status === STATUS.SUCCESS) counts.success++;
      else if (e.status === STATUS.NEEDS_PHONE || e.status === STATUS.CAPTCHA) counts.waiting++;
      else if ([STATUS.WRONG_PASSWORD, STATUS.BLOCKED, STATUS.ERROR, STATUS.SKIPPED].includes(e.status)) counts.failed++;
    }
    return {
      running: this._running,
      stopped: this._stopped,
      batchSize: this._batchSize,
      counts,
      entries: this._queue.map(e => ({ ...e })),
      logs: this._logs.slice(-100),
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────

  async _runLoop() {
    while (!this._stopped) {
      // Pick pending entries up to batchSize
      const pending = this._queue.filter(e => e.status === STATUS.PENDING);
      if (pending.length === 0) {
        const successCount = this._queue.filter(e => e.status === STATUS.SUCCESS).length;
        const failCount    = this._queue.filter(e => [STATUS.ERROR, STATUS.WRONG_PASSWORD, STATUS.BLOCKED, STATUS.SKIPPED].includes(e.status)).length;
        const waitCount    = this._queue.filter(e => [STATUS.NEEDS_PHONE, STATUS.CAPTCHA].includes(e.status)).length;
        if (failCount > 0 || waitCount > 0) {
          this._log('warn', `All entries processed — ✅ ${successCount} success | ❌ ${failCount} failed | ⏳ ${waitCount} waiting manual`);
        } else {
          this._log('success', `All profiles done — ✅ ${successCount}/${this._queue.length} logged in successfully!`);
        }
        this._running = false;
        break;
      }

      const batch = pending.slice(0, this._batchSize);
      this._log('info', `Processing batch of ${batch.length} profiles...`);

      // Run batch in parallel
      await Promise.all(batch.map(entry => this._processEntry(entry)));

      // Small pause between batches
      if (!this._stopped) await sleep(2000);
    }
    this._running = false;
  }

  async _processEntry(entry) {
    if (this._stopped) return;
    entry.status = STATUS.RUNNING;
    entry.startedAt = Date.now();
    entry.message = 'Starting browser...';
    this._log('info', `${entry.profileName}: Starting...`);

    let cdpPort = null;
    const browserType = entry.browserType || 'multilogin';

    try {
      // 1. Start browser profile
      const provider = providerFactory.getProvider(browserType);
      const startRes = await provider.startProfile(entry.profileId);
      if (startRes.code !== 0 || !startRes.data?.cdpPort) {
        throw new Error(`Profile start failed: ${startRes.message || 'No CDP port'}`);
      }
      cdpPort = startRes.data.cdpPort;
      const cdpEndpoint = startRes.data.cdpEndpoint || `http://127.0.0.1:${cdpPort}`;

      entry.message = 'Connecting to browser...';
      // Both Multilogin and MoreLogin need time to fully start before CDP is ready
      if (browserType === 'multilogin') await sleep(6000);
      else await sleep(4000); // MoreLogin / others: slightly faster startup

      // 2. Connect Playwright CDP
      const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 30000 });
      const context = browser.contexts()[0] || await browser.newContext();
      const page = context.pages()[0] || await context.newPage();

      entry.message = 'Navigating to Gmail login...';
      await page.goto('https://accounts.google.com/signin/v2/identifier', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      }).catch(() => {});
      await sleep(randomDelay(2000, 3500));

      // Dismiss cookie / consent popups if any (use page.click so DOM re-queried)
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const dismiss = btns.find(b => {
          const t = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase();
          return t.includes('accept') || t.includes('agree') || t.includes('got it');
        });
        if (dismiss) dismiss.click();
      }).catch(() => {});
      await sleep(500);

      // 3. Enter email
      // Use locator() instead of $() — locator re-queries DOM at click time (no stale handle)
      entry.message = 'Entering email...';
      const emailSel = 'input[type="email"], input[name="identifier"], #identifierId';
      try {
        await page.waitForSelector(emailSel, { timeout: 10000 });
      } catch {
        throw new Error('Email input not found on page (timeout)');
      }
      await page.locator(emailSel).first().click();
      await sleep(randomDelay(400, 800));
      await humanType(page, entry.email);
      await sleep(randomDelay(800, 1500));

      // Click Next — use #identifierNext (stable Google container), avoid matching
      // unrelated [jsname="LgbsSe"] buttons (audio CAPTCHA, etc.)
      if (await page.locator('#identifierNext').count() > 0) {
        await page.locator('#identifierNext').click({ timeout: 8000 });
      } else if (await page.locator('#identifierNext button').count() > 0) {
        await page.locator('#identifierNext button').first().click({ timeout: 8000 });
      } else {
        // Last resort — Enter key
        await page.keyboard.press('Enter');
      }
      await sleep(randomDelay(3000, 5000));

      // 4. Check for errors after email
      const afterEmail = await this._checkPageState(page);
      if (afterEmail === 'not_found') {
        entry.status = STATUS.WRONG_PASSWORD;
        entry.message = 'Email not found / account does not exist';
        entry.doneAt = Date.now();
        this._log('warn', `${entry.profileName}: Email not found`);
        await browser.close().catch(() => {});
        await provider.stopProfile(entry.profileId).catch(() => {});
        this._persistEntryStatus(entry);
        return;
      }

      // 5. Enter password
      entry.message = 'Entering password...';
      const passSel = 'input[type="password"]';
      let passVisible = false;
      try {
        await page.waitForSelector(passSel, { timeout: 10000 });
        passVisible = true;
      } catch { passVisible = false; }

      if (!passVisible) {
        // No password field — check if it's a verification screen
        const state = await this._checkPageState(page);
        if (state === 'needs_verification' || state === 'captcha') {
          entry.status = state === 'captcha' ? STATUS.CAPTCHA : STATUS.NEEDS_PHONE;
          entry.message = state === 'captcha'
            ? 'CAPTCHA appeared — complete manually in open browser'
            : 'Phone/2FA verification needed — please complete manually';
          entry.doneAt = Date.now();
          this._log('warn', `${entry.profileName}: Manual verification needed (${state})`);
          this._persistEntryStatus(entry);
          return; // Keep browser open
        }
        throw new Error('Password input not found and no verification detected');
      }

      await page.locator(passSel).first().click();
      await sleep(randomDelay(400, 800));
      await humanType(page, entry.password);
      await sleep(randomDelay(800, 1500));

      // Click Sign In — use #passwordNext (stable Google container)
      if (await page.locator('#passwordNext').count() > 0) {
        await page.locator('#passwordNext').click({ timeout: 8000 });
      } else if (await page.locator('#passwordNext button').count() > 0) {
        await page.locator('#passwordNext button').first().click({ timeout: 8000 });
      } else {
        await page.keyboard.press('Enter');
      }

      // 6. Wait and check result
      entry.message = 'Waiting for login result...';
      await sleep(randomDelay(5000, 8000));

      const finalState = await this._checkPageState(page);

      if (finalState === 'success') {
        entry.status = STATUS.SUCCESS;
        entry.message = 'Gmail logged in successfully ✅';
        entry.doneAt = Date.now();
        this._log('success', `${entry.profileName}: Login SUCCESS`);
        await sleep(2000);
        await browser.close().catch(() => {});
        await provider.stopProfile(entry.profileId).catch(() => {});

      } else if (finalState === 'needs_verification') {
        entry.status = STATUS.NEEDS_PHONE;
        entry.message = 'Phone/2FA verification needed — complete manually in open browser';
        entry.doneAt = Date.now();
        this._log('warn', `${entry.profileName}: Manual verification needed — browser left open`);
        // Do NOT close browser — user needs to verify

      } else if (finalState === 'captcha') {
        entry.status = STATUS.CAPTCHA;
        entry.message = 'CAPTCHA appeared — complete manually in open browser';
        entry.doneAt = Date.now();
        this._log('warn', `${entry.profileName}: CAPTCHA — browser left open`);

      } else if (finalState === 'wrong_password') {
        entry.status = STATUS.WRONG_PASSWORD;
        entry.message = 'Wrong password — check credentials';
        entry.doneAt = Date.now();
        this._log('error', `${entry.profileName}: Wrong password`);
        await browser.close().catch(() => {});
        await provider.stopProfile(entry.profileId).catch(() => {});

      } else if (finalState === 'blocked') {
        entry.status = STATUS.BLOCKED;
        entry.message = 'Google blocked this login attempt';
        entry.doneAt = Date.now();
        this._log('error', `${entry.profileName}: Blocked by Google`);
        await browser.close().catch(() => {});
        await provider.stopProfile(entry.profileId).catch(() => {});

      } else {
        // Unknown state — treat as needs verification
        const url = page.url();
        entry.status = STATUS.NEEDS_PHONE;
        entry.message = `Unknown state (${url}) — check browser manually`;
        entry.doneAt = Date.now();
        this._log('warn', `${entry.profileName}: Unknown post-login state: ${url}`);
      }

    } catch (err) {
      entry.status = STATUS.ERROR;
      entry.message = err.message || String(err);
      entry.doneAt = Date.now();
      this._log('error', `${entry.profileName}: Error — ${entry.message}`);
      // Try to stop browser
      try {
        const provider = providerFactory.getProvider(browserType);
        await provider.stopProfile(entry.profileId).catch(() => {});
      } catch {}
    }
    this._persistEntryStatus(entry);
  }

  /** Detect current page state after Gmail action */
  async _checkPageState(page) {
    try {
      const url = page.url();
      if (url.includes('mail.google.com') || url.includes('myaccount.google.com')) return 'success';

      const result = await page.evaluate(() => {
        const body = (document.body?.textContent || document.body?.innerText || '').toLowerCase();
        const url = window.location.href;

        if (url.includes('mail.google.com') || url.includes('myaccount.google.com')) return 'success';

        // Phone / 2FA / recovery verification
        if (
          document.querySelector('input[type="tel"]') ||
          document.querySelector('[aria-label*="phone" i]') ||
          document.querySelector('[aria-label*="code" i]') ||
          body.includes('verify') && (body.includes('phone') || body.includes('code') || body.includes('text')) ||
          body.includes('enter the code') ||
          body.includes('2-step verification') ||
          body.includes('recovery email') ||
          body.includes('help us protect') ||
          url.includes('challenge') || url.includes('signin/v2/challenge')
        ) return 'needs_verification';

        // CAPTCHA
        if (
          document.querySelector('iframe[src*="recaptcha"]') ||
          document.querySelector('.g-recaptcha') ||
          body.includes('not a robot')
        ) return 'captcha';

        // Wrong password
        if (
          body.includes('wrong password') ||
          body.includes('incorrect') ||
          body.includes('password you entered is incorrect') ||
          document.querySelector('[aria-label*="wrong" i]') ||
          document.querySelector('.o6cuMc') // Google error class
        ) return 'wrong_password';

        // Account not found
        if (
          body.includes('couldn\'t find your google account') ||
          body.includes('no account found') ||
          body.includes('this email address is not registered')
        ) return 'not_found';

        // Blocked
        if (
          body.includes('this browser or app may not be secure') ||
          body.includes('couldn\'t sign you in') ||
          body.includes('sign in was blocked') ||
          url.includes('policy.google.com/terms') ||
          url.includes('deniedsigninrejected')
        ) return 'blocked';

        // Still on sign-in page (password field visible = still entering)
        if (
          document.querySelector('input[type="password"]') ||
          document.querySelector('#identifierId') ||
          url.includes('accounts.google.com/signin')
        ) return 'still_signing';

        return 'unknown';
      });
      return result;
    } catch {
      return 'error';
    }
  }

  _persistEntryStatus(entry) {
    if (!entry?.profileId) return;
    this._persistedStatuses[entry.profileId] = {
      profileId: entry.profileId,
      profileName: entry.profileName || entry.profileId,
      email: entry.email || '',
      status: entry.status,
      message: entry.message || '',
      updatedAt: Date.now(),
      doneAt: entry.doneAt || null,
    };
    writePersistedStatuses(this._persistedStatuses);
  }

  _persistStatus(profileId, status, details = {}) {
    if (!profileId || !status) return;
    this._persistedStatuses[profileId] = {
      ...(this._persistedStatuses[profileId] || {}),
      profileId,
      status,
      profileName: details.profileName || this._persistedStatuses[profileId]?.profileName || profileId,
      message: details.message || this._persistedStatuses[profileId]?.message || '',
      updatedAt: Date.now(),
      doneAt: details.doneAt || this._persistedStatuses[profileId]?.doneAt || null,
    };
    writePersistedStatuses(this._persistedStatuses);
  }

  _findEntry(profileId) {
    return this._queue.find(e => e.profileId === profileId) || null;
  }

  /** Returns the Gmail status string for a profileId, or null if not tracked. Checks memory + persisted state. */
  getProfileGmailStatus(profileId) {
    const entry = this._findEntry(profileId);
    if (entry) return entry.status;
    const persisted = this._persistedStatuses?.[profileId] || readPersistedStatuses()[profileId];
    return persisted?.status || null;
  }

  getPersistedProfileGmailStatus(profileId) {
    return (this._persistedStatuses?.[profileId] || readPersistedStatuses()[profileId]) || null;
  }

  _log(level, message) {
    const entry = { time: new Date().toISOString(), level, message };
    this._logs.push(entry);
    if (this._logs.length > 500) this._logs.splice(0, this._logs.length - 500);
    console.log(`[GmailLogin][${level}] ${message}`);
  }
}

module.exports = new GmailLoginManager();
