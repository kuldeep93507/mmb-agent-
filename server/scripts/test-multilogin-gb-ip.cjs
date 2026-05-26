'use strict';

/** Quick GB profile IP check via API + CDP (no SOCKS5 launch). */
require('../providers/loadEnv.cjs')();
process.env.COOKIE_WARM_ON_CREATE = 'false';

const { chromium } = require('playwright-core');
const { MultiloginProvider } = require('../providers/MultiloginProvider.cjs');

const API = 'http://localhost:3100';
const ALLOWED = new Set(['US', 'GB']);

async function main() {
  const name = `ML-GB-TEST-${Date.now().toString(36).slice(-5)}`;
  const provider = new MultiloginProvider();

  const res = await fetch(`${API}/api/profiles/create-full`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      os: 'Windows',
      browserType: 'multilogin',
      proxyType: 'multilogin',
      proxyCountry: 'gb',
      profileMode: 'cloud',
    }),
  });
  const json = await res.json();
  const profileId = json.data?.id;
  console.log('Create:', json.code, json.message, 'proxyCountry=', json.data?.proxy?.country, 'tz=', json.data?.fingerprint?.timezone);

  if (json.code !== 0 || !profileId) process.exit(1);

  await new Promise((r) => setTimeout(r, 3000));
  const start = await provider.startProfile(profileId);
  if (start.code !== 0) {
    console.error('Start failed:', start.message);
    await provider.deleteProfile(profileId).catch(() => {});
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 6000));
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${start.data.cdpPort}`, { timeout: 45000 });
  let geo;
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('http://ip-api.com/json', { timeout: 60000, waitUntil: 'domcontentloaded' });
    geo = JSON.parse(await page.textContent('body'));
  } finally {
    await browser.close().catch(() => {});
  }

  await provider.stopProfile(profileId).catch(() => {});
  await provider.deleteProfile(profileId).catch(() => {});

  const ok = ALLOWED.has(geo.countryCode);
  console.log('Exit IP:', geo.query, geo.country, geo.countryCode, geo.city);
  console.log(ok ? 'PASS GB/US' : 'FAIL — not US/UK');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
