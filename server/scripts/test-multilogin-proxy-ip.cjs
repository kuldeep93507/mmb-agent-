'use strict';

/**
 * Live test: Multilogin residential proxy must exit US or GB only.
 * 1) Generate proxy credentials (us / gb / blocked in)
 * 2) Verify exit IP via SOCKS5
 * 3) Create cloud profile via API + verify IP in started browser
 */

require('../providers/loadEnv.cjs')();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { MultiloginProvider } = require('../providers/MultiloginProvider.cjs');
const { normalizeProxyCountry } = require('../services/proxyCountry.cjs');

const API = process.env.TEST_API_BASE || 'http://localhost:3100';
const ALLOWED = new Set(['US', 'GB']);

async function geoViaSocks5(proxy) {
  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: `socks5://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password,
    },
  });
  try {
    const page = await browser.newPage();
    await page.goto('http://ip-api.com/json', { timeout: 45000, waitUntil: 'domcontentloaded' });
    const text = await page.textContent('body');
    return JSON.parse(text);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function geoViaCdp(cdpPort) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 45000 });
  try {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('http://ip-api.com/json', { timeout: 60000, waitUntil: 'domcontentloaded' });
    const text = await page.textContent('body');
    return JSON.parse(text);
  } finally {
    await browser.close().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    apiBase: API,
    steps: [],
    pass: false,
  };

  // --- Unit-style clamp checks ---
  const clampIn = normalizeProxyCountry('in');
  const clampUk = normalizeProxyCountry('uk');
  report.steps.push({
    step: 'clamp in→us',
    pass: clampIn === 'us',
    got: clampIn,
  });
  report.steps.push({
    step: 'clamp uk→gb',
    pass: clampUk === 'gb',
    got: clampUk,
  });

  const provider = new MultiloginProvider();

  // --- Direct proxy generation + SOCKS5 geo ---
  for (const requested of ['us', 'gb', 'in']) {
    const label = `generate+geo country=${requested}`;
    const t0 = Date.now();
    try {
      const resolved = normalizeProxyCountry(requested, !requested || requested === 'in');
      const gen = await provider._generateMultiloginProxy(requested === 'in' ? 'in' : requested);
      if (!gen.success) {
        report.steps.push({ step: label, pass: false, error: gen.error, ms: Date.now() - t0 });
        continue;
      }
      const geo = await geoViaSocks5(gen.proxy);
      const ok = ALLOWED.has(geo.countryCode);
      report.steps.push({
        step: label,
        pass: ok,
        requested,
        resolvedCountry: resolved,
        ip: geo.query,
        country: geo.country,
        countryCode: geo.countryCode,
        city: geo.city,
        proxyHost: gen.proxy.host,
        ms: Date.now() - t0,
      });
    } catch (err) {
      report.steps.push({ step: label, pass: false, error: err.message, ms: Date.now() - t0 });
    }
  }

  // --- Health check ---
  let healthOk = false;
  try {
    const h = await fetch(`${API}/api/health`);
    healthOk = h.ok;
    report.steps.push({ step: 'server health', pass: healthOk, status: h.status });
  } catch (err) {
    report.steps.push({ step: 'server health', pass: false, error: err.message });
  }

  // --- Full profile create via API (same as UI modal) ---
  const profileName = `ML-PROXY-TEST-${Date.now().toString(36).slice(-5)}`;
  let profileId = null;
  if (healthOk) {
    const t0 = Date.now();
    try {
      const { status, json } = await postJson(`${API}/api/profiles/create-full`, {
        name: profileName,
        os: 'Windows',
        browserType: 'multilogin',
        proxyType: 'multilogin',
        proxyCountry: 'us',
        profileMode: 'cloud',
      });
      profileId = json.data?.id || null;
      const proxyCountry = json.data?.proxy?.country;
      report.steps.push({
        step: 'create-full API',
        pass: json.code === 0 && !!profileId,
        httpStatus: status,
        code: json.code,
        message: json.message,
        profileId,
        profileName,
        proxyCountry,
        fingerprintTz: json.data?.fingerprint?.timezone,
        fingerprintLang: json.data?.fingerprint?.language,
        ms: Date.now() - t0,
      });

      if (profileId) {
        await sleep(3000);
        const start = await provider.startProfile(profileId);
        report.steps.push({
          step: 'start profile',
          pass: start.code === 0 && !!start.data?.cdpPort,
          code: start.code,
          message: start.message,
          cdpPort: start.data?.cdpPort,
        });

        if (start.code === 0 && start.data?.cdpPort) {
          await sleep(6000);
          try {
            const geo = await geoViaCdp(start.data.cdpPort);
            const ok = ALLOWED.has(geo.countryCode);
            report.steps.push({
              step: 'browser exit IP (profile)',
              pass: ok,
              ip: geo.query,
              country: geo.country,
              countryCode: geo.countryCode,
              city: geo.city,
              isp: geo.isp,
            });
          } catch (err) {
            report.steps.push({ step: 'browser exit IP (profile)', pass: false, error: err.message });
          }
          await provider.stopProfile(profileId).catch(() => {});
          await sleep(2000);
        }

        const del = await provider.deleteProfile(profileId);
        report.steps.push({
          step: 'cleanup delete profile',
          pass: del.code === 0,
          code: del.code,
          message: del.message,
        });
        profileId = null;
      }
    } catch (err) {
      report.steps.push({ step: 'create-full API', pass: false, error: err.message, ms: Date.now() - t0 });
    }
  }

  report.finishedAt = new Date().toISOString();
  report.pass = report.steps.every((s) => s.pass);

  const outPath = path.join(__dirname, '..', '..', 'multilogin-proxy-ip-test.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== MULTILOGIN PROXY IP TEST ===\n');
  for (const s of report.steps) {
    const mark = s.pass ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${s.step}`);
    if (s.ip) console.log(`       IP: ${s.ip} | ${s.country} (${s.countryCode}) ${s.city || ''}`);
    if (s.error) console.log(`       Error: ${s.error}`);
    if (s.message && !s.pass) console.log(`       Msg: ${s.message}`);
  }
  console.log(`\nOverall: ${report.pass ? 'PASS — US/UK only' : 'FAIL — see report'}`);
  console.log(`Report: ${outPath}\n`);

  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
