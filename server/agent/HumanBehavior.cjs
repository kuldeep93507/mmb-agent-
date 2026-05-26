/**
 * Human-like Playwright gestures: typing, mouse, wheel scroll, keyboard seek on watch pages.
 * Imported by YoutubeUi / TrafficRouter (helpers injected via agent.cjs).
 */

'use strict';

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isMobileLikePage(page) {
  try {
    const url = page.url() || '';
    if (url.includes('m.youtube.com')) return true;
    return await page.evaluate(() => {
      const ua = navigator.userAgent || '';
      const touch = Number(navigator.maxTouchPoints || 0) > 0;
      const narrow = window.innerWidth > 0 && window.innerWidth <= 820;
      return /android|iphone|ipad|mobile/i.test(ua) || (touch && narrow);
    }).catch(() => false);
  } catch { return false; }
}


/** Seek forward via YouTube-ish keyboard shortcuts (+10s `l`, +5s ArrowRight). */
async function seekForwardKeyboard(page, secondsTotal, personality) {
  let remaining = Math.max(0, Math.floor(Number(secondsTotal) || 0));
  const jitter = () => (personality?.pickInt(90, 340) ?? randomDelay(90, 340));
  while (remaining >= 10) {
    await page.keyboard.press('l');
    remaining -= 10;
    await sleep(jitter());
  }
  while (remaining >= 5) {
    await page.keyboard.press('ArrowRight');
    remaining -= 5;
    await sleep(jitter());
  }
}

async function humanType(page, text, profileSpeed) {
  const baseMin = profileSpeed?.min || randomDelay(40, 120);
  const baseMax = profileSpeed?.max || randomDelay(150, 300);
  const pauseChance = profileSpeed?.pauseChance || (0.05 + Math.random() * 0.1);

  for (const char of text) {
    const charDelay = randomDelay(baseMin, baseMax) + randomDelay(-15, 15);
    await page.keyboard.type(char, { delay: Math.max(30, charDelay) });

    if (Math.random() < pauseChance) await sleep(randomDelay(150, 800));

    if (char === ' ' && Math.random() < 0.15) await sleep(randomDelay(200, 600));
  }
  await sleep(randomDelay(200, 800));
}

async function humanMouseMove(page) {
  const x = randomDelay(200, 900);
  const y = randomDelay(150, 500);
  await page.mouse.move(x, y, { steps: randomDelay(8, 20) });
  await sleep(randomDelay(100, 300));
}

/** Human-like scroll: eased steps on desktop, JS scrollBy on mobile (mouse.wheel breaks touch profiles). */
async function smoothScroll(page, totalPixels, direction = 'down', personality = null) {
  const isMobile = await isMobileLikePage(page);

  if (isMobile) {
    // Mobile: mouse.wheel() doesn't work for touch-UA profiles — use JS scrollBy instead
    const px = direction === 'down' ? Math.abs(totalPixels) : -Math.abs(totalPixels);
    await page.evaluate((scrollPx) => {
      window.scrollBy({ top: scrollPx, behavior: 'smooth' });
    }, px).catch(() => {});
    await sleep(randomDelay(300, 700));
    return;
  }

  // Desktop: eased mouse wheel steps
  const steps = personality
    ? personality.pickInt(personality.scrollStepsMin, personality.scrollStepsMax)
    : randomDelay(8, 16);
  const curve = personality?.scrollCurve ?? 0.28;
  const total = Math.abs(totalPixels);
  for (let i = 0; i < steps; i++) {
    const t = (i + 1) / steps;
    const ease = (1 - Math.cos(t * Math.PI)) / 2;
    const stepPx = (total / steps) * (0.65 + ease * curve * 2);
    const micro = (Math.random() * 10 - 5);
    const delta = direction === 'down' ? stepPx + micro : -(stepPx + micro);
    await page.mouse.wheel(0, delta);
    await sleep(randomDelay(28, 95));
  }
  await sleep(randomDelay(220, 620));
}

/**
 * Type a URL in the browser address bar like a human (Ctrl+L → type → Enter).
 * Returns true if succeeded, false if fell through to goto fallback.
 * Falls back gracefully — caller must do page.goto() if this returns false.
 */
async function typeUrlInAddressBar(page, url, profileSpeed) {
  // Only type the display portion (no https://, no trailing slash)
  const displayText = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  try {
    // Focus address bar — Ctrl+L works on Windows/Linux, F6 is universal fallback
    await page.keyboard.press('Control+l');
    await sleep(randomDelay(300, 600));

    // Select all existing text and clear it
    await page.keyboard.press('Control+a');
    await sleep(randomDelay(50, 120));
    await page.keyboard.press('Backspace');
    await sleep(randomDelay(200, 400));

    // Type the URL character by character (human speed)
    await humanType(page, displayText, profileSpeed);
    await sleep(randomDelay(300, 600));

    await page.keyboard.press('Enter');
    await sleep(randomDelay(1200, 2500));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  seekForwardKeyboard,
  humanType,
  humanMouseMove,
  smoothScroll,
  typeUrlInAddressBar,
  isMobileLikePage,
};
