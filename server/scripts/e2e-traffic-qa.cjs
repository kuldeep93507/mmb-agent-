/**
 * E2E traffic QA — one profile, one video, each traffic source sequentially.
 *
 * Usage (Multilogin open + backend running + token in Settings):
 *   node server/scripts/e2e-traffic-qa.cjs --profileId=YOUR_UUID --name=P-351 ^
 *     --title="Video Title" --url="https://www.youtube.com/watch?v=XXXX" --channel="Channel Name"
 *
 * Optional: --sources=youtube-search,google,bing  (default: all except backlink)
 *           --include-backlink --backlinkUrl=https://linkedin.com/...
 */

require('../providers/loadEnv.cjs')();

const BASE = process.env.E2E_API_BASE || 'http://127.0.0.1:3100';

function arg(name, def = '') {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

const profileId = arg('profileId');
const profileName = arg('name', 'P-351');
const videoTitle = arg('title');
const videoUrl = arg('url');
const channelName = arg('channel', '');
const sourcesArg = arg('sources', '');

const DEFAULT_SOURCES = [
  'youtube-search',
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'direct',
];

const SOURCES = sourcesArg
  ? sourcesArg.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SOURCES;

if (!profileId || !videoTitle || !videoUrl) {
  console.error(`
Missing required args:
  --profileId=multilogin-uuid
  --title="Exact video title"
  --url="https://www.youtube.com/watch?v=..."

Example:
  node server/scripts/e2e-traffic-qa.cjs --profileId=abc123 --name=P-351 --title="My Video" --url="https://youtube.com/watch?v=xxx"
`);
  process.exit(1);
}

const trafficPrefMap = {
  'youtube-search': 'search',
  google: 'google',
  bing: 'bing',
  duckduckgo: 'duckduckgo',
  yahoo: 'yahoo',
  direct: 'direct',
};

function qaProfileConfig(trafficPreference) {
  return {
    profileId,
    browserType: 'multilogin',
    trafficPreference,
    qaTestMode: true,
    watchTimeMin: 35,
    watchTimeMax: 45,
    qaMinWatchSec: 120,
    qaMaxWatchSec: 180,
    likeEnabled: true,
    dislikeEnabled: true,
    commentEnabled: true,
    commentText: 'Great video, thanks for sharing!',
    subscribeEnabled: false,
    adSkipEnabled: true,
    adSkipAfterSec: 15,
    videoQuality: '144p',
    scrollDuringWatch: true,
    seekForwardSec: 10,
    startDelayMin: 2,
    startDelayMax: 5,
  };
}

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function waitWorkerDone(maxMin = 25) {
  const deadline = Date.now() + maxMin * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/workers/${encodeURIComponent(profileId)}`);
    if (!res.ok) {
      await sleep(5000);
      continue;
    }
    const w = await res.json();
    const st = w.status;
    process.stdout.write(`  … worker status: ${st} ${w.progress || ''}\r`);
    if (st === 'done' || st === 'error' || st === 'crashed' || st === 'stopped') {
      console.log(`\n  → finished: ${st}`, w.results || '');
      return w;
    }
    await sleep(8000);
  }
  console.log('\n  → timeout waiting for worker');
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function logsOpenedVia(profileId, sourceKey, sinceTs) {
  const res = await fetch(`${BASE}/api/logs?limit=300`);
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  const entries = data.entries || [];
  const needle = `[Traffic] Opened via: ${sourceKey}`;
  return entries.some((e) =>
    e.profileId === profileId
    && e.timestamp >= sinceTs
    && typeof e.message === 'string'
    && e.message.includes(needle),
  );
}

async function runOneSource(sourceKey) {
  const pref = trafficPrefMap[sourceKey] || sourceKey;
  const startedAt = Date.now();
  console.log(`\n━━━ Traffic test: ${sourceKey} (${pref}) ━━━`);

  await api('/api/logs', {
    level: 'info',
    message: `[E2E QA] Starting traffic test: ${sourceKey}`,
    profileId,
    profileName,
    source: 'system',
  });

  const scheduleId = `qa_${sourceKey}_${Date.now()}`;
  const video = {
    title: videoTitle,
    value: videoUrl,
    url: videoUrl,
    channelName,
    mode: 'watch',
  };

  const schedule = {
    id: scheduleId,
    name: `E2E QA ${sourceKey} — ${profileName}`,
    selectedProfiles: [profileId],
    assignmentMode: 'per-profile',
    perProfile: [
      {
        profileId,
        channelSelections: [{ channelName, videos: [video] }],
      },
    ],
    profileConfigs: [qaProfileConfig(pref)],
    profileDelayMin: 2,
    profileDelayMax: 5,
    tabDelayMin: 5,
    tabDelayMax: 10,
    commentText: 'Great video, thanks for sharing!',
  };

  const run = await api('/api/schedule/run', { schedule });
  if (!run.ok || !run.data.success) {
    console.error('  ✗ schedule/run failed:', run.data.error || run.data.message || run.status);
    return false;
  }
  console.log('  ✓ started:', run.data.message || 'ok');

  const result = await waitWorkerDone(30);
  const watched = result && result.status === 'done' && (result.results?.watched || 0) > 0;
  const realTraffic = await logsOpenedVia(profileId, sourceKey, startedAt);
  const ok = watched && realTraffic;
  if (watched && !realTraffic) {
    console.log(`  ⚠ watched but wrong traffic — expected "[Traffic] Opened via: ${sourceKey}"`);
  }
  await api('/api/logs', {
    level: ok ? 'success' : 'error',
    message: `[E2E QA] ${sourceKey}: ${ok ? 'PASS' : 'FAIL'} — ${result?.status || 'timeout'}${watched && !realTraffic ? ' (fallback used)' : ''}`,
    profileId,
    profileName,
    source: 'system',
  });
  return ok;
}

async function main() {
  console.log('E2E Traffic QA');
  console.log('  API:', BASE);
  console.log('  Profile:', profileName, profileId);
  console.log('  Video:', videoTitle);
  console.log('  Sources:', SOURCES.join(', '));

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health?.status) {
    console.error('Backend not reachable at', BASE);
    process.exit(1);
  }

  const results = {};
  for (const src of SOURCES) {
    try {
      results[src] = await runOneSource(src);
    } catch (err) {
      console.error('  ✗', err.message);
      results[src] = false;
    }
    await sleep(15000);
  }

  console.log('\n━━━ SUMMARY ━━━');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${v ? '✓' : '✗'} ${k}`);
  }
  const passed = Object.values(results).filter(Boolean).length;
  console.log(`\n${passed}/${Object.keys(results).length} passed`);
  console.log('Check Activity Logs tab for detailed worker steps (ads, 144p, like, comment, seek).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
