'use strict';
/**
 * E2E test — 1 profile, fixed video, full 24/7 cycle:
 * watch → close → cooldown → recreate → (optional 2nd run start)
 *
 * Usage: node server/scripts/test-recycle-e2e.cjs
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = '127.0.0.1';
const PORT = Number(process.env.BACKEND_PORT || 3100);
const TEST_VIDEO_ID = '3gPPHiZYWMk';
const TEST_VIDEO_TITLE = 'Car Accident Claim EASY Process | Insurance Tips You Should Know | Legal Tips';
const TEST_VIDEO_URL = `https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`;

// Default — Profile_128 from recycle history (override via env)
const TEST_PROFILE = {
  id: process.env.TEST_PROFILE_ID || '3c77dcf1-5566-45c1-87c1-48e635bd5060',
  name: process.env.TEST_PROFILE_NAME || 'Profile_128',
  browserType: 'multilogin',
  os: 'Windows',
  proxyType: 'smartproxy',
};

const COOLDOWN_MIN = Number(process.env.TEST_COOLDOWN_MIN || 3);
const MAX_WAIT_MS = Number(process.env.TEST_MAX_WAIT_MS || 90 * 60 * 1000);
const POLL_MS = 8000;

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: BASE,
      port: PORT,
      path: apiPath,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data.slice(0, 500) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout ${method} ${apiPath}`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

function ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function log(tag, msg) { console.log(`[${ts()}] [${tag}] ${msg}`); }

function writeShuffleState() {
  const shufflePath = path.resolve(__dirname, '..', '..', 'shuffle_data.json');
  const state = {
    assignments: [],
    channelConfigs: [
      { channelId: 1, channelName: 'USA INSURANCE', minPerProfile: 1, maxPerProfile: 1 },
    ],
    enabledChannelIds: [1],
    settings: {
      assignmentMode: 'same-all',
      watchTimeMin: 80,
      watchTimeMax: 100,
      videoQuality: 'auto',
      adSkipEnabled: true,
      adSkipAfterSec: 5,
      midRollAdWaitSec: 10,
      sameModeManualPicks: { 1: TEST_VIDEO_ID },
    },
    recycleConfig: {
      enabled: true,
      profileIds: [TEST_PROFILE.id],
      cooldownMinMinutes: COOLDOWN_MIN,
      cooldownMaxMinutes: COOLDOWN_MIN,
    },
  };
  fs.writeFileSync(shufflePath, JSON.stringify(state, null, 2));
  log('SETUP', `shuffle_data.json written → fixed video ${TEST_VIDEO_ID}`);
}

function resetRecycleState() {
  const recyclePath = path.resolve(__dirname, '..', '..', 'recycle_state.json');
  fs.writeFileSync(recyclePath, JSON.stringify({
    enabled: false,
    cooldownMinMs: COOLDOWN_MIN * 60 * 1000,
    cooldownMaxMs: COOLDOWN_MIN * 60 * 1000,
    savedAt: Date.now(),
    slots: [],
  }, null, 2));
  log('SETUP', 'recycle_state.json cleared');
}

async function ensureYouTubeSearchTraffic(profileId) {
  const getRes = await api('GET', `/api/profile-config/${profileId}`);
  const base = getRes.data?.config || {};
  const config = {
    ...base,
    profileId,
    ytTrafficPreference: 'search',
    trafficPreference: 'search',
  };
  await api('PUT', `/api/profile-config/${profileId}`, { config });
  log('SETUP', `Profile traffic locked → youtube-search (${profileId})`);
}

async function getWorkerResults() {
  const workersRes = await api('GET', '/api/workers');
  const w = (workersRes.data?.workers || []).find((x) => x.profileId === TEST_PROFILE.id);
  return w?.results || null;
}

async function findProfile() {
  const res = await api('POST', '/api/profiles/list', { pageNo: 1, pageSize: 100, provider: 'multilogin' });
  const profiles = res.data?.data?.profiles || res.data?.profiles || [];
  let p = profiles.find((x) => x.id === TEST_PROFILE.id || x.name === TEST_PROFILE.name);
  if (!p && profiles.length) {
    p = profiles.find((x) => (x.status || '').toLowerCase() === 'stopped') || profiles[0];
    log('WARN', `Test profile not found — using ${p.name} (${p.id})`);
    TEST_PROFILE.id = p.id;
    TEST_PROFILE.name = p.name || p.id;
  }
  if (!p) throw new Error('No Multilogin profiles found');
  log('PROFILE', `${p.name} | ${p.id} | status=${p.status || 'unknown'}`);
  return p;
}

async function pollOnce(phaseHits) {
  const [workersRes, recycleRes, healthRes] = await Promise.all([
    api('GET', '/api/workers'),
    api('GET', '/api/recycle/status'),
    api('GET', '/api/health'),
  ]);

  const workers = workersRes.data?.workers || [];
  const w = workers.find((x) => x.profileId === TEST_PROFILE.id);
  const slot = (recycleRes.data?.slots || []).find(
    (s) => s.currentProfileId === TEST_PROFILE.id || s.profileName === TEST_PROFILE.name,
  );

  const workerStatus = w?.status || 'none';
  const slotStatus = slot?.status || 'none';
  const progress = w?.progress || '—';
  const currentVideo = w?.currentVideo || '';
  const cooldownUntil = slot?.cooldownUntil;
  const cooldownLeft = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)) : null;

  log('POLL', `worker=${workerStatus} progress=${progress} | slot=${slotStatus}${cooldownLeft != null ? ` cooldown=${cooldownLeft}s` : ''} cycle=${slot?.cycleCount ?? 0}`);
  if (currentVideo) log('VIDEO', currentVideo.slice(0, 90));
  if (w?.logs?.length) {
    const last = w.logs.slice(-3);
    for (const l of last) {
      const msg = String(l.message || '');
      log('LOG', `[${l.level}] ${msg.slice(0, 120)}`);
      if (/ad skipped|Ad skipped|⏭|Ad bypassed/i.test(msg)) phaseHits.adSkip = true;
      if (/closing browser|browser closed|All videos done/i.test(msg)) phaseHits.closed = true;
      if (/Watched:|✓ Watched|Worker done/i.test(msg)) phaseHits.watched = true;
    }
  }

  if (workerStatus === 'watching' || workerStatus === 'running') phaseHits.running = true;
  if (workerStatus === 'done') phaseHits.workerDone = true;
  if (slotStatus === 'cooldown') phaseHits.cooldown = true;
  if (slotStatus === 'recreating') phaseHits.recreating = true;
  if ((slot?.cycleCount || 0) >= 1 && slotStatus !== 'running') phaseHits.cycleComplete = true;
  if ((slot?.cycleCount || 0) >= 1 && (slotStatus === 'running' || slotStatus === 'idle') && phaseHits.recreating) {
    phaseHits.secondRun = true;
  }

  return { workerStatus, slotStatus, slot, health: healthRes.data };
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' 24/7 RECYCLE E2E TEST');
  console.log(` Profile : ${TEST_PROFILE.name}`);
  console.log(` Video   : ${TEST_VIDEO_TITLE}`);
  console.log(` Cooldown: ${COOLDOWN_MIN} min (after full watch + close)`);
  console.log('══════════════════════════════════════════════════════════\n');

  log('INIT', 'Stopping existing workers + recycle...');
  await api('POST', '/api/schedule/stop', {}).catch(() => {});
  await api('POST', '/api/recycle/stop', {}).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  await findProfile();
  await ensureYouTubeSearchTraffic(TEST_PROFILE.id);
  writeShuffleState();
  resetRecycleState();

  log('START', 'Launching 24/7 recycle (1 profile)...');
  const startRes = await api('POST', '/api/recycle/start', {
    profiles: [TEST_PROFILE],
    cooldownMinMinutes: COOLDOWN_MIN,
    cooldownMaxMinutes: COOLDOWN_MIN,
  });
  if (startRes.status !== 200) {
    console.error('Start failed:', startRes.data);
    process.exit(1);
  }
  log('START', 'Recycle loop started — monitoring (full watch may take several minutes)...\n');

  const phaseHits = {
    running: false,
    adSkip: false,
    watched: false,
    closed: false,
    workerDone: false,
    cooldown: false,
    recreating: false,
    cycleComplete: false,
    secondRun: false,
  };

  const t0 = Date.now();
  while (Date.now() - t0 < MAX_WAIT_MS) {
    await pollOnce(phaseHits);

    if (phaseHits.recreating) {
      log('PHASE', '✓ Recreate started');
    }
    if (phaseHits.cooldown && phaseHits.workerDone) {
      log('PHASE', '✓ Task done → cooldown active');
    }

    // Success: first cycle done + recreate finished + second run queued/running
    if (phaseHits.workerDone && phaseHits.cooldown && phaseHits.recreating && phaseHits.secondRun) {
      log('PASS', 'Full cycle verified: watch → close → cooldown → recreate → next run');
      break;
    }

    // Partial pass: at least watch + close + cooldown (recreate may still run)
    if (phaseHits.workerDone && phaseHits.closed && phaseHits.cooldown && phaseHits.recreating) {
      log('PASS', 'Watch + close + cooldown + recreate triggered');
      // wait a bit more for recreate to finish
      await new Promise((r) => setTimeout(r, 60000));
      await pollOnce(phaseHits);
      break;
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const results = await getWorkerResults();
  const watched = results?.watched ?? 0;
  const failed = results?.failed ?? 0;

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' TEST RESULTS');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Actual: Watched=${watched}, Failed=${failed}`);
  const checks = [
    ['Video running/watching', phaseHits.running],
    ['Ad skip detected in logs', phaseHits.adSkip],
    ['Video actually watched', watched >= 1],
    ['Browser close after task', phaseHits.closed],
    ['Worker done', phaseHits.workerDone],
    ['Cooldown started (after done)', phaseHits.cooldown],
    ['Profile recreate', phaseHits.recreating],
    ['Cycle count incremented', phaseHits.cycleComplete],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  }
  const passed = checks.filter(([, ok]) => ok).length;
  console.log(`\n  Score: ${passed}/${checks.length}`);
  if (watched < 1) {
    console.log('\n  FAIL — video was not watched (search/watch flow broken)');
    process.exit(1);
  }
  if (!phaseHits.workerDone || !phaseHits.cooldown) {
    console.log('\n  FAIL — cooldown triggered before task complete (or task never finished)');
    process.exit(1);
  }
  if (passed >= 6) {
    console.log('\n  OVERALL: PASS');
    process.exit(0);
  }
  console.log('\n  OVERALL: PARTIAL — check logs above');
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
