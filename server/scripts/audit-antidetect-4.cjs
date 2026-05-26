'use strict';

/**
 * Generate 4 full anti-detect fingerprints, verify uniqueness,
 * optionally create profiles via POST /api/profiles/create-full.
 *
 * Usage:
 *   node server/scripts/audit-antidetect-4.cjs           # dry-run (fingerprints only)
 *   node server/scripts/audit-antidetect-4.cjs --create  # live create 4 cloud profiles
 */

require('../providers/loadEnv.cjs')();

const http = require('http');
const FingerprintGenerator = require('../services/FingerprintGenerator.cjs');
const { MultiloginProvider } = require('../providers/MultiloginProvider.cjs');
const { fingerprintSignature } = require('../services/UniquenessValidator.cjs');
const { FULL_STATE_TIMEZONE_MAP } = require('../services/fingerprintData.cjs');

const COUNT = 4;
const CREATE_LIVE = process.argv.includes('--create');
const API_HOST = process.env.API_HOST || '127.0.0.1';
const API_PORT = parseInt(process.env.PORT || '3100', 10);

function randomUsGeo() {
  const states = Object.keys(FULL_STATE_TIMEZONE_MAP);
  const state = states[Math.floor(Math.random() * states.length)];
  return {
    country: 'US',
    language: 'en-US',
    timezone: FULL_STATE_TIMEZONE_MAP[state] || 'America/New_York',
    city: state,
    region: state,
    latitude: 25 + Math.random() * 20,
    longitude: -120 + Math.random() * 40,
  };
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 120000,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function main() {
  const gen = new FingerprintGenerator();
  const mlx = new MultiloginProvider();
  const profiles = [];
  const signatures = new Set();
  const fields = {
    userAgent: new Set(),
    canvasSeed: new Set(),
    webglSeed: new Set(),
    audioSeed: new Set(),
    webglRenderer: new Set(),
    resolution: new Set(),
    timezone: new Set(),
    cpu: new Set(),
  };

  console.log(`\n=== Anti-Detect Audit (${COUNT} profiles) ===\n`);

  for (let i = 0; i < COUNT; i++) {
    const geo = randomUsGeo();
    const fingerprint = gen.generate('Windows', geo);
    const sig = fingerprintSignature(fingerprint);

    if (signatures.has(sig)) {
      console.error(`FAIL: duplicate signature at profile ${i + 1}`);
      process.exit(1);
    }
    signatures.add(sig);

    fields.userAgent.add(fingerprint.userAgent);
    fields.canvasSeed.add(fingerprint.canvasNoise.seed);
    fields.webglSeed.add(fingerprint.webGLNoise.seed);
    fields.audioSeed.add(fingerprint.audioContextNoise.seed);
    fields.webglRenderer.add(fingerprint.webGLMeta.renderer);
    fields.resolution.add(fingerprint.resolution);
    fields.timezone.add(fingerprint.timezone);
    fields.cpu.add(fingerprint.cpu);

    const { flags, fingerprint: mlxFp } = mlx._buildAntidetectParameters({
      os: 'Windows',
      fingerprint,
      fingerprintConfig: {
        canvas: 'real',
        webrtc: 'real',
        timezone: 'real',
        screen: 'real',
        navigator: 'real',
      },
    }, true);

    profiles.push({
      index: i + 1,
      name: `ANTIDETECT-P${i + 1}-${Date.now().toString(36).slice(-4)}`,
      signature: sig.slice(0, 60) + '...',
      fingerprint,
      sentToMlx: { flags, fingerprint: mlxFp },
    });

    console.log(`Profile ${i + 1}: ${profiles[i].name}`);
    console.log(`  UA: ${fingerprint.userAgent.slice(0, 55)}...`);
    console.log(`  Screen: ${fingerprint.resolution} @ ${fingerprint.pixelRatio}x`);
    console.log(`  TZ: ${fingerprint.timezone} | CPU: ${fingerprint.cpu} | RAM: ${fingerprint.ram}GB`);
    console.log(`  Canvas: ${fingerprint.canvasNoise.seed} | WebGL: ${fingerprint.webGLNoise.seed} | Audio: ${fingerprint.audioContextNoise.seed}`);
    console.log(`  GPU: ${fingerprint.webGLMeta.renderer.slice(0, 50)}...`);
    console.log(`  MLX flags: canvas=${flags.canvas_noise} webrtc=${flags.webrtc_masking} graphics=${flags.graphics_masking}`);
    console.log(`  MLX payload keys: ${Object.keys(mlxFp).join(', ')}\n`);
  }

  console.log('--- Uniqueness summary (critical anti-detect fields) ---');
  const critical = ['userAgent', 'canvasSeed', 'webglSeed', 'audioSeed'];
  for (const key of critical) {
    const set = fields[key];
    const ok = set.size === COUNT;
    console.log(`  ${ok ? 'OK' : 'FAIL'} ${key}: ${set.size}/${COUNT} unique`);
  }
  for (const key of ['webglRenderer', 'resolution', 'timezone', 'cpu']) {
    console.log(`  info ${key}: ${fields[key].size}/${COUNT} unique (overlap OK — real users share these)`);
  }

  const seedsUnique = critical.every((k) => fields[k].size === COUNT);
  if (!seedsUnique || signatures.size !== COUNT) {
    console.error('\nFAIL: duplicate canvas/webgl/audio seed or signature');
    process.exit(1);
  }
  console.log('\nPASS: all anti-detect seeds + signatures unique across 4 profiles\n');

  if (CREATE_LIVE) {
    console.log('--- Live create via API (cloud + smartproxy) ---\n');
    const created = [];
    for (const p of profiles) {
      try {
        const res = await postJson('/api/profiles/create-full', {
          name: p.name,
          os: 'Windows',
          browserType: 'multilogin',
          proxyType: 'smartproxy',
          profileMode: 'cloud',
        });
        if (res.body && res.body.code === 0) {
          created.push({ name: p.name, id: res.body.data?.id, ok: true });
          console.log(`  OK ${p.name} → ${res.body.data?.id || 'id?'}`);
        } else {
          created.push({ name: p.name, ok: false, error: res.body?.message || res.status });
          console.log(`  FAIL ${p.name}: ${res.body?.message || res.status}`);
        }
      } catch (err) {
        created.push({ name: p.name, ok: false, error: err.message });
        console.log(`  FAIL ${p.name}: ${err.message}`);
      }
    }
    profiles.forEach((p, i) => { p.createResult = created[i]; });
  }

  const outPath = require('path').join(__dirname, '..', '..', 'audit-antidetect-4.json');
  require('fs').writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), profiles }, null, 2));
  console.log(`Report saved: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
