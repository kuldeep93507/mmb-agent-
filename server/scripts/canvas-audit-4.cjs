'use strict';

/**
 * Start 4 MLX cloud profiles, read live canvas/WebGL/UA via CDP, compare uniqueness.
 * Usage: node server/scripts/canvas-audit-4.cjs
 */

require('../providers/loadEnv.cjs')();

const { chromium } = require('playwright-core');
const { MultiloginProvider } = require('../providers/MultiloginProvider.cjs');

const PROFILES = [
  { name: 'ANTIDETECT-LIVE-P1', id: '99d47772-cd9b-4f1d-bb51-6ed50e68dcb0' },
  { name: 'ANTIDETECT-LIVE-P2', id: 'dfc6e219-30f4-4f34-b99b-76a5056e3abb' },
  { name: 'ANTIDETECT-LIVE-P3', id: '7a171aa7-8010-462b-a55e-d2f3733c5712' },
  { name: 'ANTIDETECT-LIVE-P4', id: 'd0a917a2-cd25-45c3-bdf1-499981ce9faf' },
];

const CANVAS_JS = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 280;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f60';
  ctx.fillRect(100, 1, 62, 20);
  ctx.fillStyle = '#069';
  ctx.font = '11pt Arial';
  ctx.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 15);
  ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
  ctx.font = '18pt Times New Roman';
  ctx.fillText('Cwm fjordbank glyphs vext quiz, 😃', 4, 45);
  const data = canvas.toDataURL();
  let h = 0;
  for (let i = 0; i < data.length; i++) h = ((h << 5) - h + data.charCodeAt(i)) | 0;
  return {
    canvasHash: (h >>> 0).toString(16),
    canvasLen: data.length,
    ua: navigator.userAgent,
    platform: navigator.platform,
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: navigator.language,
    screen: screen.width + 'x' + screen.height + '@' + devicePixelRatio,
  };
})()`;

const WEBGL_JS = `(() => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { renderer: 'none', vendor: 'none' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  } catch (e) { return { renderer: 'err', vendor: String(e.message) }; }
})()`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function probeProfile(provider, profile) {
  console.log(`\n--- ${profile.name} (${profile.id.slice(0, 8)}...) ---`);
  const start = await provider.startProfile(profile.id);
  if (start.code !== 0 || !start.data?.cdpPort) {
    return { ...profile, ok: false, error: start.message || 'No CDP port' };
  }

  const port = start.data.cdpPort;
  console.log(`  CDP port: ${port}`);
  await sleep(4000);

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 });
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages()[0] || await ctx.newPage();

    await page.goto('about:blank', { timeout: 15000 }).catch(() => {});
    const canvas = await page.evaluate(CANVAS_JS);
    const webgl = await page.evaluate(WEBGL_JS);

    let browserleaks = null;
    try {
      await page.goto('https://browserleaks.com/canvas', { timeout: 90000, waitUntil: 'domcontentloaded' });
      await sleep(5000);
      browserleaks = await page.evaluate(() => {
        const sig = document.querySelector('#canvas-hash, .hash, td[data-hash]');
        const text = document.body.innerText || '';
        const m = text.match(/Signature[:\s]+([a-f0-9]{32})/i) || text.match(/([a-f0-9]{32})/);
        return { signature: m ? m[1] : null, title: document.title };
      });
    } catch (err) {
      browserleaks = { error: err.message };
    }

    await provider.stopProfile(profile.id);
    await sleep(3000);

    return {
      ...profile,
      ok: true,
      cdpPort: port,
      canvasHash: canvas.canvasHash,
      canvasLen: canvas.canvasLen,
      ua: canvas.ua,
      screen: canvas.screen,
      tz: canvas.tz,
      cores: canvas.cores,
      webglVendor: webgl.vendor,
      webglRenderer: (webgl.renderer || '').slice(0, 80),
      browserleaks,
    };
  } catch (err) {
    await provider.stopProfile(profile.id).catch(() => {});
    return { ...profile, ok: false, error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  const provider = new MultiloginProvider();
  const results = [];

  for (const p of PROFILES) {
    results.push(await probeProfile(provider, p));
    console.log('  canvasHash:', results[results.length - 1].canvasHash || '—');
    if (results[results.length - 1].browserleaks?.signature) {
      console.log('  browserleaks:', results[results.length - 1].browserleaks.signature);
    }
  }

  const ok = results.filter((r) => r.ok);
  const hashes = new Set(ok.map((r) => r.canvasHash));
  const uas = new Set(ok.map((r) => r.ua));
  const renderers = ok.map((r) => r.webglRenderer);

  console.log('\n=== CANVAS AUDIT SUMMARY ===');
  console.log(`Profiles probed: ${ok.length}/${PROFILES.length}`);
  console.log(`Unique canvas hashes: ${hashes.size}/${ok.length}`);
  console.log(`Unique UAs: ${uas.size}/${ok.length}`);

  for (const r of ok) {
    console.log(`  ${r.name}: hash=${r.canvasHash} tz=${r.tz} screen=${r.screen}`);
    console.log(`    GPU: ${r.webglRenderer}`);
  }

  const pass = ok.length === PROFILES.length && hashes.size === ok.length;
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'canvas-audit-4.json'), JSON.stringify({ at: new Date().toISOString(), results, pass }, null, 2));
  console.log(`\n${pass ? 'PASS' : 'FAIL'}: canvas hashes ${pass ? 'all different' : 'DUPLICATE or probe failed'}`);
  console.log('Report: canvas-audit-4.json');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
