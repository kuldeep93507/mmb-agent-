/**
 * YouTube traffic routing: openVideoByTraffic / openVideoBySearch / search query variations.
 * Helpers (sleep, scroll, type, theme, search bar) are injected from agent.cjs via setTrafficRouterHelpers.
 */

'use strict';

/** @type {Record<string, unknown>} */
let deps = {};

function dx() {
  return deps;
}

function setTrafficRouterHelpers(d) {
  deps = d;
}

async function openVideoByTraffic(page, videoTitle, channelName, trafficType, videoUrl, backlinkData) {
  const { sleep, randomDelay, humanMouseMove, smoothScroll, humanType } = dx();
  switch (trafficType) {
    case 'backlink':
      // Backlink traffic — open external page first, then find YouTube link
      if (backlinkData?.sourceUrl) {
        await page.goto(backlinkData.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(randomDelay(5000, 15000)); // Read page like human
        await humanMouseMove(page);
        await smoothScroll(page, randomDelay(200, 500), 'down');
        await sleep(randomDelay(2000, 5000));

        // Find YouTube link on page
        const ytLink = await page.$('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
        if (ytLink) {
          await humanMouseMove(page);
          await sleep(randomDelay(500, 1500));
          await ytLink.click();
          await sleep(randomDelay(3000, 5000));
          return true;
        }
        // Fallback: if no YouTube link found, search for video
        return await openVideoBySearch(page, videoTitle, channelName);
      }
      return await openVideoBySearch(page, videoTitle, channelName);

    case 'direct':
      // Direct URL — just navigate
      if (videoUrl) {
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } else {
        // Fallback to search if no URL
        return await openVideoBySearch(page, videoTitle, channelName);
      }
      return true;

    case 'suggested':
      // Go to channel page first, then find video
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(randomDelay(3000, 5000));
      // Click channel link
      const channelLink = await page.$('ytd-channel-renderer a, a[href*="/channel/"], a[href*="/@"]');
      if (channelLink) {
        await channelLink.click();
        await sleep(randomDelay(3000, 5000));
        // Click Videos tab
        const videosTab = await page.$('tp-yt-paper-tab:nth-child(2), [tab-title="Videos"]');
        if (videosTab) { await videosTab.click(); await sleep(randomDelay(2000, 4000)); }
        // Find and click the video
        const videoEl = await page.$(`a[title*="${videoTitle.substring(0, 30)}"], ytd-rich-item-renderer a#video-title-link`);
        if (videoEl) { await videoEl.click(); return true; }
      }
      // Fallback to search
      return await openVideoBySearch(page, videoTitle, channelName);

    case 'random':
      // Randomly pick a method (including backlink if data available)
      const methods = backlinkData?.sourceUrl ? ['search', 'direct', 'suggested', 'backlink'] : ['search', 'direct', 'suggested'];
      const picked = methods[Math.floor(Math.random() * methods.length)];
      return await openVideoByTraffic(page, videoTitle, channelName, picked, videoUrl, backlinkData);

    case 'google':
      // Google Search Referral — search on Google, click YouTube result
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(randomDelay(2000, 4000));

      // Find Google search box and type
      const googleInput = await page.$('input[name="q"], textarea[name="q"]');
      if (googleInput) {
        await googleInput.click();
        await sleep(randomDelay(300, 800));
        const googleQuery = `${channelName} ${videoTitle} youtube`;
        await humanType(page, googleQuery);
        await sleep(randomDelay(500, 1000));
        await page.keyboard.press('Enter');
        await sleep(randomDelay(3000, 6000));

        // Find YouTube result in Google search results
        const ytResult = await page.$('a[href*="youtube.com/watch"], a[href*="youtu.be/"]');
        if (ytResult) {
          await humanMouseMove(page);
          await sleep(randomDelay(1000, 3000));
          await ytResult.click();
          await sleep(randomDelay(3000, 5000));
          return true;
        }
      }
      // Fallback to YouTube search
      return await openVideoBySearch(page, videoTitle, channelName);

    case 'search':
    default:
      return await openVideoBySearch(page, videoTitle, channelName);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SEARCH QUERY VARIATION ENGINE
// Har profile ke liye alag query — YouTube coordinated detection se bachne ke liye
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function generateSearchQuery(videoTitle, channelName) {
  const title = videoTitle || '';
  const channel = channelName || '';

  // Title ke words
  const titleWords = title.split(' ').filter(w => w.length > 2);
  const shortTitle = titleWords.slice(0, Math.floor(titleWords.length * 0.6) + 1).join(' ');
  const longTitle = titleWords.join(' ');

  // Channel short form
  const channelShort = channel.split(' ')[0]; // First word only

  // Query variations pool
  const variations = [
    // Full: channel + title
    channel ? `${channel} ${title}` : title,
    // Short title only
    shortTitle,
    // Channel short + title
    channel ? `${channelShort} ${title}` : title,
    // Title + channel
    channel ? `${title} ${channel}` : title,
    // Title with year
    `${title} ${new Date().getFullYear()}`,
    // Short title + channel
    channel ? `${shortTitle} ${channelShort}` : shortTitle,
    // Title only (no channel)
    longTitle,
    // Channel + short title
    channel ? `${channel} ${shortTitle}` : shortTitle,
  ].filter(q => q.trim().length > 3);

  const idx = variations.length > 0 ? Math.floor(Math.random() * variations.length) : 0;
  const picked = variations[idx];
  if (picked && picked.trim()) return picked;
  const cand = `${title} ${channel}`.trim();
  return cand.length > 2 ? cand : 'youtube video';
}

async function openVideoBySearch(page, videoTitle, channelName) {
  const { sleep, randomDelay, forceDarkTheme, humanMouseMove, clickSearchAndType, smoothScroll, humanType } = dx();

  // Navigate to YouTube via address bar typing (human behavior)
  const currentUrl = page.url() || '';
  if (!currentUrl.includes('youtube.com')) {
    try {
      await page.keyboard.press('Control+l');
      await sleep(randomDelay(300, 600));
      await page.keyboard.press('Control+a');
      await sleep(randomDelay(50, 120));
      await page.keyboard.press('Backspace');
      await sleep(randomDelay(180, 380));
      await humanType(page, 'youtube.com');
      await sleep(randomDelay(300, 600));
      await page.keyboard.press('Enter');
      await page.waitForLoadState('domcontentloaded', { timeout: 25000 }).catch(() => {});
    } catch {
      await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  }
  await sleep(randomDelay(2000, 4000));
  await forceDarkTheme(page);
  await humanMouseMove(page);

  // UNIQUE query per profile — not same for all
  const searchQuery = generateSearchQuery(videoTitle, channelName);
  const typed = await clickSearchAndType(page, searchQuery);
  if (!typed) return false;

  await sleep(randomDelay(500, 1000));
  await page.keyboard.press('Enter');
  await sleep(randomDelay(3000, 5000));

  // Wait for results
  await page.waitForSelector('ytd-video-renderer', { timeout: 10000 }).catch(() => {});
  await sleep(randomDelay(1500, 3000));

  // HUMAN BEHAVIOR: Don't click immediately — browse results first
  // Each profile gets DIFFERENT scroll amounts (wider range = less detectable)
  const scrollDown1 = randomDelay(150, 600);
  const scrollDown2 = randomDelay(80, 400);
  const scrollUp1 = randomDelay(100, 550);

  await smoothScroll(page, scrollDown1, 'down');
  await sleep(randomDelay(1000, 4000));
  await smoothScroll(page, scrollDown2, 'down');
  await sleep(randomDelay(800, 3500));
  await smoothScroll(page, scrollUp1, 'up');
  await sleep(randomDelay(800, 2500));

  // Now find and click the CORRECT video (title match)
  const videoLink = await page.evaluate((searchTitle) => {
    const results = document.querySelectorAll('ytd-video-renderer a#video-title');
    const titleLower = searchTitle.toLowerCase();
    // First pass: find exact/close match
    for (const el of results) {
      const resultTitle = (el.getAttribute('title') || el.textContent || '').toLowerCase();
      if (resultTitle.includes(titleLower) || titleLower.includes(resultTitle.substring(0, 20))) {
        return true; // Found matching video
      }
    }
    return false;
  }, videoTitle);

  if (videoLink) {
    // Click the matched video
    const matchedVideo = await page.evaluateHandle((searchTitle) => {
      const results = document.querySelectorAll('ytd-video-renderer a#video-title');
      const titleLower = searchTitle.toLowerCase();
      for (const el of results) {
        const resultTitle = (el.getAttribute('title') || el.textContent || '').toLowerCase();
        if (resultTitle.includes(titleLower) || titleLower.includes(resultTitle.substring(0, 20))) {
          return el;
        }
      }
      return results[0]; // Fallback to first if no match
    }, videoTitle);

    if (matchedVideo) {
      await humanMouseMove(page);
      await sleep(randomDelay(500, 1500));
      await matchedVideo.click();
      return true;
    }
  }

  // Fallback: click first result if no title match
  const firstVideo = await page.$('ytd-video-renderer a#video-title');
  if (firstVideo) {
    await humanMouseMove(page);
    await sleep(randomDelay(500, 1500));
    await firstVideo.click();
    return true;
  }
  return false;
}

module.exports = {
  setTrafficRouterHelpers,
  openVideoByTraffic,
  openVideoBySearch,
  generateSearchQuery,
};
