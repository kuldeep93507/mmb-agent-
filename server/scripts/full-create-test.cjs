'use strict';

require('../providers/loadEnv.cjs')();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const ProfileCreator = require('../services/ProfileCreator.cjs');
const { MultiloginProvider } = require('../providers/MultiloginProvider.cjs');
const { HIGH_CPC_VISIT_URLS, MLX_COOKIE_TARGETS } = require('../services/HighCPCCookieWarmer.cjs');

const CANVAS_JS = `(() => {
  const c = document.createElement('canvas');
  c.width = 280; c.height = 60;
  const x = c.getContext('2d');
  x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20);
  x.fillStyle = '#069'; x.font = '11pt Arial';
  x.fillText('test', 2, 15);
  const d = c.toDataURL();
  let h = 0;
  for (let i = 0; i < d.length; i++) h = ((h << 5) - h + d.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
})()`;

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    mlxTargets: MLX_COOKIE_TARGETS,
    visitUrlCount: HIGH_CPC_VISIT_URLS.length,
    visitUrls: HIGH_CPC_VISIT_URLS,
  };
  const t0 = Date.now();
  const pc = new ProfileCreator();
  const name = `FULL-TEST-${Date.now().toString(36).slice(-5)}`;

  console.log(`\n=== FULL CREATE TEST: ${name} ===\n`);

  const create = await pc.createProfile({
    name,
    os: 'Windows',
    browserType: 'multilogin',
    proxyType: 'smartproxy',
    profileMode: 'cloud',
  });

  report.elapsedCreateSec = Math.round((Date.now() - t0) / 1000);
  report.create = {
    code: create.code,
    message: create.message,
    profileId: create.data?.id,
    profileName: name,
    cookieWarmDetails: create.data?.cookieWarmDetails,
  };
  report.fingerprint = create.data?.fingerprint ? {
    ua: create.data.fingerprint.userAgent,
    timezone: create.data.fingerprint.timezone,
    resolution: create.data.fingerprint.resolution,
    canvasSeed: create.data.fingerprint.canvasNoise?.seed,
    webglSeed: create.data.fingerprint.webGLNoise?.seed,
    audioSeed: create.data.fingerprint.audioContextNoise?.seed,
    gpu: create.data.fingerprint.webGLMeta?.renderer,
    cpu: create.data.fingerprint.cpu,
    ram: create.data.fingerprint.ram,
  } : null;

  if (create.code !== 0 || !create.data?.id) {
    report.pass = false;
    report.failReason = 'Profile create failed';
    writeReport(report);
    process.exit(1);
  }

  const profileId = create.data.id;
  const provider = new MultiloginProvider();
  const start = await provider.startProfile(profileId);
  report.liveProbe = { startCode: start.code, startMessage: start.message, cdpPort: start.data?.cdpPort };

  if (start.code === 0 && start.data?.cdpPort) {
    await new Promise((r) => setTimeout(r, 5000));
    let browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${start.data.cdpPort}`, { timeout: 45000 });
      const ctx = browser.contexts()[0];
      const page = ctx.pages()[0] || await ctx.newPage();
      report.liveProbe.canvasHash = await page.evaluate(CANVAS_JS);
      report.liveProbe.navigator = await page.evaluate(() => ({
        ua: navigator.userAgent,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
        lang: navigator.language,
        cores: navigator.hardwareConcurrency,
      }));
      const cookies = await ctx.cookies();
      report.liveProbe.totalCookies = cookies.length;
      report.liveProbe.cookieDomains = [...new Set(cookies.map((c) => c.domain))].sort();
      report.liveProbe.hasYoutubePref = cookies.some((c) => c.name === 'PREF' && c.domain.includes('youtube'));
      report.liveProbe.hasGoogleConsent = cookies.some((c) => c.name === 'CONSENT' && (c.domain.includes('google') || c.domain.includes('youtube')));
      report.liveProbe.financeRelatedDomains = report.liveProbe.cookieDomains.filter((d) =>
        /google|youtube|amazon|facebook|credit|bank|nerd|ebay|bing|etsy/.test(d)
      );
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
    await provider.stopProfile(profileId);
  }

  report.elapsedTotalSec = Math.round((Date.now() - t0) / 1000);
  const cw = report.create.cookieWarmDetails || {};
  report.pass = create.code === 0 && cw.metadataSet && (cw.liveBake || cw.cookieCount > 0);
  report.summary = buildSummary(report);
  writeReport(report);
  console.log('\n' + report.summary);
  console.log(`\nReport: ${path.join(__dirname, '..', '..', 'full-test-report.json')}`);
  process.exit(report.pass ? 0 : 1);
}

function buildSummary(r) {
  const cw = r.create.cookieWarmDetails || {};
  const lp = r.liveProbe || {};
  return [
    '=== FULL TEST REPORT ===',
    `Profile: ${r.create.profileName} (${r.create.profileId})`,
    `Create: ${r.create.code === 0 ? 'PASS' : 'FAIL'} (${r.elapsedCreateSec}s)`,
    '',
    '--- Antidetect ---',
    `Canvas seed: ${r.fingerprint?.canvasSeed || '—'}`,
    `WebGL seed:  ${r.fingerprint?.webglSeed || '—'}`,
    `Audio seed:  ${r.fingerprint?.audioSeed || '—'}`,
    `GPU: ${(r.fingerprint?.gpu || '—').slice(0, 55)}...`,
    `TZ: ${r.fingerprint?.timezone} | Screen: ${r.fingerprint?.resolution}`,
    `Live canvas hash: ${lp.canvasHash || '—'}`,
    '',
    '--- Cookies (at create time) ---',
    `MLX metadata: ${cw.metadataSet ? 'YES' : 'NO'} (${cw.metadataMessage || '—'})`,
    `Live bake: ${cw.liveBake ? 'YES' : 'NO'}`,
    `Sites visited: ${(cw.sitesVisited || []).length}/${r.visitUrlCount}`,
    `Cookies after bake: ${cw.cookieCount ?? '—'}`,
    `Live probe cookies: ${lp.totalCookies ?? '—'}`,
    `PREF (YouTube US): ${lp.hasYoutubePref ? 'YES' : 'NO'}`,
    `CONSENT: ${lp.hasGoogleConsent ? 'YES' : 'NO'}`,
    `High-value domains: ${(lp.financeRelatedDomains || []).join(', ') || '—'}`,
    '',
    `OVERALL: ${r.pass ? 'PASS' : 'PARTIAL/FAIL'}`,
    `Total time: ${r.elapsedTotalSec}s`,
  ].join('\n');
}

function writeReport(report) {
  fs.writeFileSync(path.join(__dirname, '..', '..', 'full-test-report.json'), JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
