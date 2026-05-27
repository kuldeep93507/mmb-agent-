/**
 * MMB-AGENT Backend Server
 * - Manages profile agents (one per MoreLogin profile)
 * - Connects to MoreLogin API to start/stop profiles
 * - Uses Playwright CDP for browser automation
 * - Human-like behavior for YouTube watching
 */

// Load .env first (lightweight loader, no dotenv dependency)
const fs = require('fs');
const path = require('path');
const loadEnv = require('./providers/loadEnv.cjs');
loadEnv();
// Packaged Electron build ships runtime.env beside server/
const runtimeEnvPath = path.join(__dirname, 'runtime.env');
if (fs.existsSync(runtimeEnvPath)) loadEnv(runtimeEnvPath);

const express = require('express');
const cors = require('cors');
const http = require('http');
const { ProfileAgent } = require('./agent.cjs');
const { Orchestrator } = require('./orchestrator.cjs');
const { profileRouter } = require('./providers/profileRouter.cjs');
const { providerFactory } = require('./providers/ProviderFactory.cjs');
const { MultiloginCookiesService } = require('./services/MultiloginCookiesService.cjs');

const cookiesService = new MultiloginCookiesService();
const activityLog = require('./activityLog.cjs');
const { getApiToken, requireAuth } = require('./apiAuth.cjs');
const appDataStore = require('./appDataStore.cjs');
const { agentManager } = require('./agentManager.cjs');
const { agentHistoryKey } = require('./scheduleEngine.cjs');
const { notificationService } = require('./notificationService.cjs');
const { ProfileRecycleManager } = require('./profileRecycleManager.cjs');
const { restartTrashJanitor, runEmptyTrash } = require('./services/trashManager.cjs');
const { assignOneProfile } = require('./shuffleEngine.cjs');

const { getServerPort, getMoreloginPort } = require('./utils/config.cjs');

const app = express();
app.use(cors({
  origin(origin, cb) {
    if (!origin || origin === 'null') return cb(null, true);
    if (origin === 'app://.') return cb(null, true);
    try {
      const h = new URL(origin).hostname;
      if (h === 'localhost' || h === '127.0.0.1') return cb(null, true);
    } catch (_) { /* ignore */ }
    return cb(null, false);
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'X-MMB-Token', 'x-api-key'],
}));
app.use(express.json());

const { requireBackendApiKey } = require('./backendApiKeyAuth.cjs');
app.use(requireBackendApiKey);

const PORT = getServerPort();

const activeAgents = new Map();

/** POST /api/jobs entries returned alongside worker rows via GET /api/workers */
const automationJobLedger = [];

// Orchestrator (for scheduled/shuffle runs — worker threads)
const orchestrator = new Orchestrator();

// Clean up completed schedules from runningSchedules to prevent memory leak.
// Fires when a worker reports 'done'. If all workers in a schedule are done,
// remove the schedule entry from the map.
const BACKLINKS_FILE = path.resolve(__dirname, '..', 'backlinks_data.json');

function loadBacklinksFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(BACKLINKS_FILE, 'utf8'));
    return {
      links: Array.isArray(raw.links) ? raw.links : [],
      manualAssign: raw.manualAssign && typeof raw.manualAssign === 'object' ? raw.manualAssign : {},
    };
  } catch {
    return { links: [], manualAssign: {} };
  }
}

function saveBacklinksFile(data) {
  try {
    atomicWriteJson(BACKLINKS_FILE, data);
  } catch (err) {
    console.error('[Backlinks] Failed to save:', err.message);
  }
}

function markBacklinksUsed(ids) {
  if (!ids?.length) return;
  const data = loadBacklinksFile();
  const set = new Set(ids);
  const now = Date.now();
  data.links = data.links.map((b) =>
    set.has(b.id) ? { ...b, usedCount: (b.usedCount || 0) + 1, lastUsed: now } : b,
  );
  saveBacklinksFile(data);
}

orchestrator.onBacklinkUsed = (ids) => markBacklinksUsed(ids);

orchestrator.onActivityLog = (entry) => activityLog.append(entry);

orchestrator.onWorkerDone = (profileId) => {
  for (const [scheduleId, entry] of runningSchedules) {
    const profiles = entry.schedule?.selectedProfiles || [];
    if (!profiles.includes(profileId)) continue;
    // Check if all workers in this schedule are done/stopped
    const allDone = profiles.every(pid => {
      const ws = orchestrator.workers.get(pid);
      return !ws || ws.status === 'done' || ws.status === 'stopped' || ws.status === 'crashed';
    });
    if (allDone) {
      const name = entry.schedule?.name || scheduleId;
      console.log(`[Orchestrator] Schedule "${name}" complete — removing from runningSchedules`);
      notificationService.info('Schedule complete', `"${name}" — all profiles finished`).catch(() => {});
      runningSchedules.delete(scheduleId);
    }
  }
};

function applyYtAgentSettingsFromApp(s) {
  agentManager.updateSettings({
    maxTotalAgents: parseInt(s.ytMaxTotalAgents, 10) || 40,
    videosMin: parseInt(s.ytVideosPerSessionMin, 10) || 3,
    videosMax: parseInt(s.ytVideosPerSessionMax, 10) || 7,
    cooldownMs: parseInt(s.ytAgentCooldownMs, 10) || 60000,
    launchGapMin: parseInt(s.ytAgentLaunchGapMin, 10) || 10000,
    launchGapMax: parseInt(s.ytAgentLaunchGapMax, 10) || 15000,
    proxyType: s.ytProxyType === 'multilogin' ? 'multilogin' : 'smartproxy',
    sessionSettings: {
      trafficPreference: s.ytTrafficPreference || 'custom',
      likeEnabled: s.ytLikeEnabled === true || s.ytLikeEnabled === 'true',
      adSkipEnabled: s.ytAdSkipEnabled !== false && s.ytAdSkipEnabled !== 'false',
      adSkipAfterSec: parseInt(s.ytAdSkipAfterSec, 10) || 5,
      watchTimeMin: parseInt(s.ytWatchTimeMin, 10) || 40,
      watchTimeMax: parseInt(s.ytWatchTimeMax, 10) || 100,
    },
  });
}

function applyNotificationSettingsFromApp(s) {
  notificationService.updateSettings({
    telegramBotToken: s.telegramBotToken,
    telegramChatId: s.telegramChatId,
    smtpHost: s.smtpHost,
    smtpUser: s.smtpUser,
    smtpPass: s.smtpPass,
    notifyEmail: s.notifyEmail,
    mailApiUrl: s.mailApiUrl,
  });
}

agentManager.on('log', (entry) => {
  activityLog.append({
    level: entry.level === 'error' ? 'error' : entry.level === 'success' ? 'success' : 'info',
    source: 'yt-agent',
    message: entry.message,
    timestamp: new Date(entry.ts).toISOString(),
  });
});

agentManager.on('videoDone', ({ agentName, videoId, videoTitle }) => {
  if (!agentName) return;
  const key = agentHistoryKey(agentName);
  if (!watchHistory[key]) watchHistory[key] = [];
  watchHistory[key].push({
    videoId,
    videoTitle,
    watchedAt: Date.now(),
    watchPercent: 100,
  });
  if (watchHistory[key].length > 200) watchHistory[key] = watchHistory[key].slice(-200);
  saveWatchHistory(watchHistory);
});

let ytErrorBurst = [];
agentManager.on('agentError', (agentId, err) => {
  ytErrorBurst.push(Date.now());
  ytErrorBurst = ytErrorBurst.filter(t => Date.now() - t < 5 * 60 * 1000);
  if (ytErrorBurst.length >= 5) {
    notificationService.critical('YT Agents failing', `${ytErrorBurst.length} errors in 5 min. Latest: ${err}`).catch(() => {});
    ytErrorBurst = [];
  } else {
    notificationService.warning('Agent error', `${agentId}: ${err}`).catch(() => {});
  }
});

agentManager.on('circuitOpen', () => {
  notificationService.critical('Circuit breaker OPEN', 'Too many failures — YT agent launches paused 5 min').catch(() => {});
});

let lastRamWarningAt = 0;
const _ramWarnIntervalId = setInterval(() => {
  try {
    const status = agentManager.getStatus();
    const pct = status?.health?.memory?.usedPercent;
    if (typeof pct === 'number' && pct >= 80) {
      const now = Date.now();
      if (now - lastRamWarningAt > 30 * 60 * 1000) {
        lastRamWarningAt = now;
        notificationService.warning('High RAM usage', `Memory at ${pct}% — new YT agent launches may pause`).catch((err) => {
          console.error('[RAM warn] telegram:', err.message);
        });
      }
    }
  } catch (ramErr) {
    console.warn('[RAM monitor] Tick failed:', ramErr.message);
  }
}, 60 * 1000);

// Watch History — persisted to file
const HISTORY_FILE = path.resolve(__dirname, '..', 'watch_history.json');
const { atomicWriteJson } = require('./analyticsStore.cjs');

function loadWatchHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return {}; }
}
function saveWatchHistory(history) {
  try {
    atomicWriteJson(HISTORY_FILE, history);
  } catch (err) {
    // Log the error so disk-full / permission issues are visible
    console.error('[WatchHistory] Failed to save watch_history.json:', err.message);
  }
}
function normalizeHistoryTitle(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
const WATCH_HISTORY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
function cleanupProfileHistory(profileId) {
  const cutoff = Date.now() - WATCH_HISTORY_TTL_MS;
  const rows = Array.isArray(watchHistory[profileId]) ? watchHistory[profileId] : [];
  watchHistory[profileId] = rows
    .filter((h) => (h.watchedAt || 0) > cutoff)
    .slice(-200);
  return watchHistory[profileId];
}
function historyHasDuplicate(profileId, videoId, videoTitle) {
  const vid = videoId ? String(videoId).trim() : '';
  const norm = normalizeHistoryTitle(videoTitle);
  return cleanupProfileHistory(profileId).some((h) => {
    if (vid && h.videoId === vid) return true;
    return !!norm && normalizeHistoryTitle(h.videoTitle) === norm;
  });
}
function addHistoryRow(profileId, row) {
  if (!watchHistory[profileId]) watchHistory[profileId] = [];
  cleanupProfileHistory(profileId);
  watchHistory[profileId].push(row);
  cleanupProfileHistory(profileId);
  saveWatchHistory(watchHistory);
}
// profileId → [{ videoTitle, watchedAt, watchPercent }]
const watchHistory = loadWatchHistory();

// Running schedules
const runningSchedules = new Map();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SETTINGS — UI-configurable, no .env needed
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const SETTINGS_FILE = path.resolve(__dirname, '..', 'user-settings.json');

const DEFAULT_SETTINGS = {
  moreloginBaseUrl: 'http://127.0.0.1:40000',
  moreloginApiKey: '',
  moreloginSecurityEnabled: true,
  moreloginPort: '40000',
  multiloginEmail: '',
  multiloginPassword: '',
  multiloginToken: '',
  multiloginFolderId: '',
  proxyServer: 'us.smartproxy.net',
  proxyPort: '3120',
  proxyPassword: '',
  proxyPrefix: '',
  defaultProxyLife: '4hr',
  maxConcurrent: '5',
  multiloginMaxConcurrent: '3',
  multiloginBatchGapMs: '45000',
  browserProvider: 'multilogin',
  ytMaxTotalAgents: '40',
  ytVideosPerSessionMin: '3',
  ytVideosPerSessionMax: '7',
  ytAgentCooldownMs: '60000',
  ytAgentLaunchGapMin: '10000',
  ytAgentLaunchGapMax: '15000',
  ytProxyType: 'smartproxy',
  ytLikeEnabled: 'false',
  ytLikeAfterPercent: '60',
  ytMaxLikesPerSession: '3',
  ytAdSkipEnabled: 'true',
  ytAdSkipAfterSec: '5',
  ytWatchShorts: 'true',
  ytWatchTimeMin: '40',
  ytWatchTimeMax: '100',
  ytTrafficPreference: 'custom',
  anthropicApiKey: '',
  telegramBotToken: '',
  telegramChatId: '',
  smtpHost: '',
  smtpUser: '',
  smtpPass: '',
  notifyEmail: '',
  mailApiUrl: '',
  multiloginPurgeOnDelete: 'true',
  multiloginAutoEmptyTrash: 'false',
  multiloginAutoEmptyTrashHours: '6',
  multiloginAutoArrangeWindows: 'true',
  // Window / display resolution
  windowWidth: '1920',
  windowHeight: '1080',
  // High RPM/CPM Cookie Warmup
  highRpmCookieWarmupEnabled: 'false',
  warmupVisitCountMin: '3',
  warmupVisitCountMax: '5',
  // Search warmup (pre-video related searches)
  searchWarmupEnabled: 'false',
  searchWarmupAttemptMin: '3',
  searchWarmupAttemptMax: '5',
};

function getMaxConcurrent() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const n = parseInt(s.maxConcurrent, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* use default */ }
  const envN = parseInt(process.env.MAX_CONCURRENT || '', 10);
  if (Number.isFinite(envN) && envN > 0) return envN;
  return parseInt(DEFAULT_SETTINGS.maxConcurrent, 10) || 5;
}

function proxyLifeToMinutes(life) {
  const map = { '1hr': 60, '2hr': 120, '4hr': 240, '8hr': 480, '24hr': 1440 };
  if (life && map[life]) return map[life];
  const n = parseInt(String(life || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

function hydrateSettingsFromEnv(s) {
  const out = { ...s };
  const fill = (key, envKey) => {
    if (!out[key] && process.env[envKey]) out[key] = process.env[envKey];
  };
  fill('proxyPassword', 'PROXY_PASSWORD');
  fill('proxyPrefix', 'PROXY_PREFIX');
  fill('multiloginToken', 'MULTILOGIN_TOKEN');
  fill('multiloginFolderId', 'MULTILOGIN_FOLDER_ID');
  fill('multiloginEmail', 'MULTILOGIN_EMAIL');
  fill('multiloginPassword', 'MULTILOGIN_PASSWORD');
  fill('anthropicApiKey', 'ANTHROPIC_API_KEY');
  fill('telegramBotToken', 'TELEGRAM_BOT_TOKEN');
  fill('telegramChatId', 'TELEGRAM_CHAT_ID');
  return out;
}

/** Fill empty user-settings.json fields from .env so UI + server stay in sync. */
function persistSettingsHydratedFromEnv(merged) {
  const hydrated = hydrateSettingsFromEnv(merged);
  const secretKeys = [
    'proxyPassword', 'proxyPrefix',
    'multiloginEmail', 'multiloginPassword', 'multiloginToken', 'multiloginFolderId',
    'anthropicApiKey',
  ];
  let changed = false;
  const out = { ...merged };
  for (const key of secretKeys) {
    const wasEmpty = !out[key] || String(out[key]).trim() === '';
    const nowVal = hydrated[key];
    if (wasEmpty && nowVal && String(nowVal).trim() !== '') {
      out[key] = nowVal;
      changed = true;
    }
  }
  if (changed) {
    out.savedAt = Date.now();
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2));
      console.log('[Settings] Auto-synced missing credentials from .env → user-settings.json');
    } catch (err) {
      console.warn('[Settings] Could not persist .env sync:', err.message);
    }
  }
  return hydrateSettingsFromEnv(out);
}

function loadAppSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
      return persistSettingsHydratedFromEnv(merged);
    }
  } catch {}
  return persistSettingsHydratedFromEnv({ ...DEFAULT_SETTINGS });
}

function parseMoreloginPort(s) {
  if (s.moreloginPort) return String(s.moreloginPort);
  if (s.moreloginBaseUrl) {
    try {
      const u = new URL(s.moreloginBaseUrl);
      if (u.port) return u.port;
    } catch { /* ignore */ }
  }
  return '40000';
}

function applySettingsToEnv(s) {
  const pick = (val, envKey) => {
    const v = val != null ? String(val).trim() : '';
    if (v) return v;
    const e = process.env[envKey];
    return e != null ? String(e).trim() : '';
  };
  const setIfNonEmpty = (envKey, val) => {
    const v = pick(val, envKey);
    if (v) process.env[envKey] = v;
  };
  setIfNonEmpty('MORELOGIN_API_KEY', s.moreloginApiKey);
  process.env.MORELOGIN_PORT = parseMoreloginPort(s);
  setIfNonEmpty('MULTILOGIN_EMAIL', s.multiloginEmail);
  setIfNonEmpty('MULTILOGIN_PASSWORD', s.multiloginPassword);
  setIfNonEmpty('MULTILOGIN_TOKEN', s.multiloginToken);
  setIfNonEmpty('MULTILOGIN_FOLDER_ID', s.multiloginFolderId);
  // Support multiple folder IDs (array stored in settings)
  if (Array.isArray(s.multiloginFolderIds) && s.multiloginFolderIds.length) {
    const allIds = [...new Set([
      ...(s.multiloginFolderId ? [s.multiloginFolderId] : []),
      ...s.multiloginFolderIds,
    ])].filter(Boolean);
    process.env.MULTILOGIN_FOLDER_IDS = allIds.join(',');
    if (!process.env.MULTILOGIN_FOLDER_ID && allIds[0]) {
      process.env.MULTILOGIN_FOLDER_ID = allIds[0];
    }
  }
  if (s.proxyServer) process.env.PROXY_SERVER = String(s.proxyServer);
  if (s.proxyPort) process.env.PROXY_PORT = String(s.proxyPort);
  setIfNonEmpty('PROXY_PASSWORD', s.proxyPassword);
  setIfNonEmpty('PROXY_PREFIX', s.proxyPrefix);
  if (s.defaultProxyLife) {
    process.env.DEFAULT_PROXY_LIFE = String(s.defaultProxyLife);
    process.env.PROXY_LIFE_MINUTES = String(proxyLifeToMinutes(s.defaultProxyLife));
  }
  if (s.multiloginMaxConcurrent) process.env.MULTILOGIN_MAX_CONCURRENT = String(s.multiloginMaxConcurrent);
  if (s.multiloginBatchGapMs) process.env.MULTILOGIN_BATCH_GAP_MS = String(s.multiloginBatchGapMs);
  setIfNonEmpty('ANTHROPIC_API_KEY', s.anthropicApiKey);
  setIfNonEmpty('TELEGRAM_BOT_TOKEN', s.telegramBotToken);
  setIfNonEmpty('TELEGRAM_CHAT_ID', s.telegramChatId);
}

let appSettings = loadAppSettings();
applySettingsToEnv(appSettings);
applyYtAgentSettingsFromApp(appSettings);
applyNotificationSettingsFromApp(appSettings);
restartTrashJanitor();

const { assertRequiredSecretsOrExit } = require('./bootSecrets.cjs');
assertRequiredSecretsOrExit(appSettings);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MORELOGIN API HELPER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function moreloginRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const apiKey = String(process.env.MORELOGIN_API_KEY || '').trim();
    if (!apiKey) {
      resolve({ code: -2, msg: 'MORELOGIN_API_KEY is not configured (set in .env or app settings)' });
      return;
    }
    const payload = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port: getMoreloginPort(),
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ code: -1, msg: 'Invalid JSON response' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Health check
app.get('/api/health', (req, res) => {
  const ytStatus = agentManager.getStatus();
  res.json({
    status: 'ok',
    agents: activeAgents.size,
    schedules: runningSchedules.size,
    workers: orchestrator.getStats(),
    ytAgents: {
      active: agentManager.getActiveCount(),
      queued: ytStatus.queue.length,
      total: Object.keys(ytStatus.agents).length,
      health: ytStatus.health,
    },
  });
});

// Get all agent statuses (includes worker statuses)
app.get('/api/agents', (req, res) => {
  const manualAgents = [];
  for (const [id, agent] of activeAgents) {
    manualAgents.push(agent.getStatus());
  }
  const workerStatuses = orchestrator.getAllStatuses();
  res.json({ agents: manualAgents, workers: workerStatuses });
});

// Get specific agent status
app.get('/api/agents/:profileId', (req, res) => {
  const agent = activeAgents.get(req.params.profileId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent.getStatus());
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RUN SCHEDULE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/schedule/run', async (req, res) => {
  const { schedule } = req.body;
  if (!schedule) return res.status(400).json({ error: 'Schedule required' });

  const maxConcurrent = getMaxConcurrent();
  const currentRunning = orchestrator.getStats().running + activeAgents.size;
  const requestedProfiles = schedule.selectedProfiles.length;
  const availableSlots = Math.max(0, maxConcurrent - currentRunning);

  if (availableSlots === 0) {
    activityLog.append({
      level: 'warn',
      source: activityLog.inferScheduleSource(schedule),
      message: `Schedule "${schedule.name}" blocked — max concurrent (${maxConcurrent}) reached`,
    });
    return res.status(429).json({ 
      error: `Max concurrent limit reached (${maxConcurrent}). Currently ${currentRunning} running. Stop some first.`,
      running: currentRunning,
      limit: maxConcurrent
    });
  }

  let trimmed = false;
  if (requestedProfiles > availableSlots) {
    schedule.selectedProfiles = schedule.selectedProfiles.slice(0, availableSlots);
    trimmed = true;
    console.log(`[Orchestrator] Trimmed to ${availableSlots} profiles (limit: ${maxConcurrent}, running: ${currentRunning})`);
  }

  const scheduleId = schedule.id || Date.now().toString();
  console.log(`\n━━━ Starting Schedule: ${schedule.name} ━━━`);
  console.log(`Profiles: ${schedule.selectedProfiles.length} | Using Worker Threads`);

  // Store running schedule
  runningSchedules.set(scheduleId, { schedule, status: 'running', startedAt: Date.now() });

  // Use Orchestrator with Worker Threads
  const result = orchestrator.runSchedule(schedule);
  const logSource = activityLog.inferScheduleSource(schedule);
  activityLog.append({
    level: 'success',
    source: logSource,
    message: `Started "${schedule.name}" — ${result.workersSpawned} worker(s)${trimmed ? ` (trimmed from ${requestedProfiles})` : ''}${result.skippedNoVideos ? `, ${result.skippedNoVideos} skipped (no videos)` : ''}`,
  });

  const mlxHint = (schedule.selectedProfiles?.length || 0) > 3
    ? ' Multilogin: profiles start in batches of 3 (plan limit) — check Logs / Workers for CDP errors.'
    : '';

  res.json({
    success: true,
    scheduleId,
    message: `Schedule "${schedule.name}" started with ${result.workersSpawned} worker(s).${mlxHint}`,
    workersSpawned: result.workersSpawned,
    skippedNoVideos: result.skippedNoVideos || 0,
    multiloginBatchSize: result.multiloginBatchSize || null,
    trimmed,
    limit: maxConcurrent,
    running: currentRunning,
  });
});

// Schedule list persistence (server-side backup; UI also syncs on save)
const SCHEDULES_FILE = path.resolve(__dirname, '..', 'schedules_data.json');

function loadSchedulesFile() {
  try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); } catch { return []; }
}
function saveSchedulesFile(list) {
  try { fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2)); } catch (err) {
    console.error('[Schedules] Failed to save:', err.message);
  }
}

app.get('/api/schedules', (req, res) => {
  res.json({ schedules: loadSchedulesFile() });
});

app.put('/api/schedules', (req, res) => {
  const { schedules } = req.body;
  if (!Array.isArray(schedules)) return res.status(400).json({ error: 'schedules array required' });
  saveSchedulesFile(schedules);
  syncScheduledJobsFromList(schedules);
  res.json({ success: true, count: schedules.length });
});

app.get('/api/schedule/progress', (req, res) => {
  const raw = req.query.profileIds;
  const profileIds = typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!profileIds.length) return res.status(400).json({ error: 'profileIds query required' });
  res.json({ stats: orchestrator.getStatsForProfiles(profileIds) });
});

app.get('/api/concurrency', (req, res) => {
  const limit = getMaxConcurrent();
  const workerStats = orchestrator.getStats();
  const running = workerStats.running + activeAgents.size;
  res.json({ limit, running, available: Math.max(0, limit - running), workers: workerStats });
});

// Stop a running schedule
app.post('/api/schedule/stop', async (req, res) => {
  const { scheduleId } = req.body;

  if (scheduleId) {
    // Stop only the specific schedule's workers
    const schedule = runningSchedules.get(scheduleId);
    if (schedule) {
      const profileIds = schedule.schedule?.selectedProfiles || [];
      for (const profileId of profileIds) {
        orchestrator.stopWorker(profileId);
      }
      runningSchedules.delete(scheduleId);
      const src = activityLog.inferScheduleSource(schedule.schedule);
      activityLog.append({
        level: 'warn',
        source: src,
        message: `Stopped schedule "${schedule.schedule?.name || scheduleId}" (${profileIds.length} workers)`,
      });
      res.json({ success: true, message: `Schedule ${scheduleId} stopped (${profileIds.length} workers)` });
    } else {
      res.json({ success: false, message: 'Schedule not found' });
    }
  } else {
    // No scheduleId — stop everything
    orchestrator.stopAll();
    for (const [profileId, agent] of activeAgents) {
      await agent.disconnect();
      activeAgents.delete(profileId);
    }
    runningSchedules.clear();
    activityLog.append({ level: 'warn', source: 'system', message: 'Stop all — all workers and manual agents stopped' });
    res.json({ success: true, message: 'All workers and agents stopped' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ACTIVITY LOGS — unified server-backed timeline
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/logs', (req, res) => {
  const result = activityLog.getLogs({
    limit: req.query.limit,
    since: req.query.since,
    level: req.query.level,
    source: req.query.source,
    profileId: req.query.profileId,
    search: req.query.search,
  });
  res.json(result);
});

app.post('/api/logs', (req, res) => {
  const { level, message, profileId, profileName, source, id, timestamp } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  const entry = activityLog.append({ level, message, profileId, profileName, source, id, timestamp });
  res.json({ success: true, entry });
});

app.delete('/api/logs', requireAuth, (req, res) => {
  activityLog.clear();
  res.json({ success: true });
});

app.post('/api/notifications/test', async (req, res) => {
  const { type, settings: bodySettings } = req.body || {};
  const s = bodySettings ? { ...loadAppSettings(), ...bodySettings } : loadAppSettings();
  applyNotificationSettingsFromApp(s);

  if (type === 'telegram') {
    const ok = await notificationService.sendTelegram(
      '✅ <b>MMB AGENT 247</b>\nTest notification — Telegram connected!',
    );
    return res.json({
      success: ok,
      message: ok ? 'Telegram message sent!' : 'Failed — check Bot Token + Chat ID, then Save settings.',
    });
  }

  if (type === 'email') {
    const ok = await notificationService.sendEmail(
      'MMB AGENT 247 — Test Email',
      'Test notification from MMB AGENT 247. If you received this, email alerts are working.',
    );
    return res.json({
      success: ok,
      message: ok
        ? 'Email sent via Mail API!'
        : 'No Mail API — check SMTP + Notify Email, or set Mail API URL. (See server console if log-only.)',
    });
  }

  return res.status(400).json({ error: 'type must be "telegram" or "email"' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// REAL-TIME ANALYTICS TRACKING — Persisted with serialized writes + atomic file swap
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ANALYTICS_FILE = path.resolve(__dirname, '..', 'analytics_data.json');
const { createAnalyticsStore } = require('./analyticsStore.cjs');
const analyticsStore = createAnalyticsStore(ANALYTICS_FILE);
// Expose globally so engagementQueue.cjs can track analytics without circular deps
global.mmbAnalyticsStore = analyticsStore;

const _analyticsDailyInterval = setInterval(() => {
  try {
    const status = agentManager.getStatus();
    const active = Object.values(status?.agents || {}).filter(a => a.status === 'running' || a.status === 'watching').length;
    const snap = analyticsStore.snapshotSync();
    notificationService.dailyReport({
      totalViews: snap.totalViews || 0,
      totalWatchTime: snap.totalWatchTime || 0,
      totalLikes: snap.totalLikes || 0,
      activeAgents: active,
    }).catch((err) => console.error('[notify] Daily report:', err.message));
  } catch (err) {
    console.error('[analytics] daily interval:', err.message);
  }
}, 60 * 60 * 1000);

// Track an action
app.post('/api/analytics/track', async (req, res) => {
  const { profileId, action, value } = req.body;
  if (!profileId || !action) return res.status(400).json({ error: 'profileId and action required' });

  try {
    await analyticsStore.enqueue((analyticsData) => {
      if (!analyticsData.perProfile[profileId]) {
        analyticsData.perProfile[profileId] = { views: 0, watchTime: 0, likes: 0, subscribes: 0, comments: 0 };
      }
      const p = analyticsData.perProfile[profileId];

      switch (action) {
        case 'view': analyticsData.totalViews++; p.views++; break;
        case 'watchTime': analyticsData.totalWatchTime += (value || 0); p.watchTime += (value || 0); break;
        case 'like': analyticsData.totalLikes++; p.likes++; break;
        case 'subscribe': analyticsData.totalSubscribes++; p.subscribes++; break;
        case 'comment': analyticsData.totalComments++; p.comments++; break;
        case 'session': analyticsData.totalSessions++; break;
        case 'ads_total': analyticsData.totalAds = (analyticsData.totalAds || 0) + (value || 1); break;
        case 'ads_skipped': analyticsData.adsSkipped = (analyticsData.adsSkipped || 0) + (value || 1); break;
        case 'ads_watched_full': analyticsData.adsWatchedFull = (analyticsData.adsWatchedFull || 0) + (value || 1); break;
        case 'ad_watch_time': analyticsData.adWatchTime = (analyticsData.adWatchTime || 0) + (value || 0); break;
        case 'traffic_youtube-search': analyticsData.trafficYouTube = (analyticsData.trafficYouTube || 0) + 1; break;
        case 'traffic_google': analyticsData.trafficGoogle = (analyticsData.trafficGoogle || 0) + 1; break;
        case 'traffic_bing': analyticsData.trafficBing = (analyticsData.trafficBing || 0) + 1; break;
        case 'traffic_direct': analyticsData.trafficDirect = (analyticsData.trafficDirect || 0) + 1; break;
        case 'traffic_direct-fallback':
        case 'traffic_direct-rare':
        case 'traffic_mobile-direct-fallback':
          analyticsData.trafficDirectFallback = (analyticsData.trafficDirectFallback || 0) + 1;
          break;
        case 'traffic_channel-page': analyticsData.trafficChannel = (analyticsData.trafficChannel || 0) + 1; break;
        case 'traffic_backlink':
          analyticsData.trafficBacklink = (analyticsData.trafficBacklink || 0) + 1;
          break;
        case 'traffic_backlink-direct-fallback':
          analyticsData.trafficBacklinkFallback = (analyticsData.trafficBacklinkFallback || 0) + 1;
          break;
        default: break;
      }

      if (!analyticsData.recentActivity) analyticsData.recentActivity = [];
      analyticsData.recentActivity.push({ profileId, action, value, time: Date.now() });
      if (analyticsData.recentActivity.length > 500) {
        analyticsData.recentActivity = analyticsData.recentActivity.slice(-500);
      }

      if (!analyticsData.dailyLog) analyticsData.dailyLog = [];
      analyticsData.dailyLog.push({ profileId, action, value: value || 1, time: Date.now() });
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      if (analyticsData.dailyLog.length > 50000) {
        analyticsData.dailyLog = analyticsData.dailyLog.filter(e => e.time > thirtyDaysAgo);
      }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[analytics] track enqueue failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

function buildDailyTrendFromLogs(logs) {
  const buckets = {};
  for (const entry of logs) {
    if (!entry || !entry.time) continue;
    const dayKey = new Date(entry.time).toISOString().slice(0, 10);
    if (!buckets[dayKey]) buckets[dayKey] = { date: dayKey, views: 0, watchTime: 0 };
    if (entry.action === 'view') buckets[dayKey].views++;
    if (entry.action === 'watchTime') buckets[dayKey].watchTime += entry.value || 0;
  }
  return Object.values(buckets).sort((a, b) => a.date.localeCompare(b.date));
}

function aggregateAnalyticsFromLogs(logs, recentActivity, filterMeta) {
  const filtered = {
    totalViews: 0, totalWatchTime: 0, totalSessions: 0,
    totalLikes: 0, totalSubscribes: 0, totalComments: 0,
    totalAds: 0, adsSkipped: 0, adsWatchedFull: 0, adWatchTime: 0,
    trafficYouTube: 0, trafficGoogle: 0, trafficBing: 0, trafficDirect: 0, trafficChannel: 0,
    trafficBacklink: 0, trafficDirectFallback: 0, trafficBacklinkFallback: 0,
    perProfile: {},
    recentActivity: recentActivity || [],
    dailyTrend: buildDailyTrendFromLogs(logs),
    ...filterMeta,
  };

  for (const entry of logs) {
    const { profileId, action, value } = entry;
    if (!filtered.perProfile[profileId]) {
      filtered.perProfile[profileId] = { views: 0, watchTime: 0, likes: 0, subscribes: 0, comments: 0 };
    }
    const p = filtered.perProfile[profileId];

    switch (action) {
      case 'view': filtered.totalViews++; p.views++; break;
      case 'watchTime': filtered.totalWatchTime += (value || 0); p.watchTime += (value || 0); break;
      case 'like': filtered.totalLikes++; p.likes++; break;
      case 'subscribe': filtered.totalSubscribes++; p.subscribes++; break;
      case 'comment': filtered.totalComments++; p.comments++; break;
      case 'session': filtered.totalSessions++; break;
      case 'ads_total': filtered.totalAds += (value || 1); break;
      case 'ads_skipped': filtered.adsSkipped += (value || 1); break;
      case 'ads_watched_full': filtered.adsWatchedFull += (value || 1); break;
      case 'ad_watch_time': filtered.adWatchTime += (value || 0); break;
      case 'traffic_youtube-search': filtered.trafficYouTube++; break;
      case 'traffic_google': filtered.trafficGoogle++; break;
      case 'traffic_bing': filtered.trafficBing++; break;
      case 'traffic_direct': filtered.trafficDirect++; break;
      case 'traffic_direct-fallback':
      case 'traffic_direct-rare':
      case 'traffic_mobile-direct-fallback':
        filtered.trafficDirectFallback++;
        break;
      case 'traffic_channel-page': filtered.trafficChannel++; break;
      case 'traffic_backlink': filtered.trafficBacklink++; break;
      case 'traffic_backlink-direct-fallback':
        filtered.trafficBacklinkFallback++;
        break;
      default: break;
    }
  }
  return filtered;
}

app.post('/api/analytics/reset-today-engagement', async (req, res) => {
  try {
    await analyticsStore.enqueue((analyticsData) => {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const t0 = todayStart.getTime();
      const engagement = new Set(['like', 'subscribe', 'comment']);
      analyticsData.dailyLog = (analyticsData.dailyLog || []).filter(
        (e) => !(e.time >= t0 && engagement.has(e.action)),
      );
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[analytics] reset enqueue failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get analytics (with optional date filter)
app.get('/api/analytics', async (req, res) => {
  try {
    await analyticsStore.flushPending();
  } catch (err) {
    console.warn('[analytics] flush before read:', err.message);
  }
  const analyticsData = analyticsStore.snapshotSync();
  const { filter } = req.query;

  if (!filter || filter === 'all') {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const logs = (analyticsData.dailyLog || []).filter((e) => e.time >= thirtyDaysAgo);
    const recent = (analyticsData.recentActivity || []).filter((e) => e.time >= thirtyDaysAgo);
    return res.json({
      ...analyticsData,
      dailyTrend: buildDailyTrendFromLogs(logs),
      recentActivity: recent.slice(-100),
      filter: 'all',
    });
  }

  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  let fromTime = 0;
  let toTime = now;

  switch (filter) {
    case 'today':
      fromTime = todayStart.getTime();
      break;
    case 'yesterday':
      fromTime = todayStart.getTime() - 24 * 60 * 60 * 1000;
      toTime = todayStart.getTime();
      break;
    case '7d':
      fromTime = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case '30d':
      fromTime = now - 30 * 24 * 60 * 60 * 1000;
      break;
    default:
      return res.json(analyticsData);
  }

  const logs = (analyticsData.dailyLog || []).filter(e => e.time >= fromTime && e.time <= toTime);
  const recent = (analyticsData.recentActivity || []).filter(e => e.time >= fromTime && e.time <= toTime);
  res.json(aggregateAnalyticsFromLogs(logs, recent.slice(-100), { filter, fromTime, toTime }));
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WATCH HISTORY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/history', (req, res) => {
  res.json(watchHistory);
});

app.get('/api/history/:profileId', (req, res) => {
  res.json(watchHistory[req.params.profileId] || []);
});

app.post('/api/history/add', (req, res) => {
  const { profileId, videoTitle, watchPercent, videoId } = req.body;
  if (!profileId || !videoTitle) return res.status(400).json({ error: 'profileId and videoTitle required' });
  const vid = videoId ? String(videoId).trim() : '';
  if (!watchHistory[profileId]) watchHistory[profileId] = [];
  if (historyHasDuplicate(profileId, vid, videoTitle)) {
    saveWatchHistory(watchHistory); // persist TTL cleanup if it happened
    return res.json({ success: true, duplicate: true });
  }
  addHistoryRow(profileId, {
    videoTitle,
    videoId: vid || undefined,
    watchedAt: Date.now(),
    watchPercent: watchPercent || 100,
  });
  res.json({ success: true });
});

// Check if video already watched by profile (24h window)
app.post('/api/history/check', (req, res) => {
  const { profileId, videoTitle } = req.body;
  const history = watchHistory[profileId] || [];
  const cutoff = Date.now() - 86400000; // 24 hours
  const norm = normalizeHistoryTitle(videoTitle);
  const alreadyWatched = history.some(h => normalizeHistoryTitle(h.videoTitle) === norm && h.watchedAt > cutoff);
  res.json({ alreadyWatched });
});

/** Normalized shuffle/automation sync — reads same store as /api/history (last 14 days). */
app.get('/api/watch-history/:profileId', (req, res) => {
  const { profileId } = req.params;
  try {
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const list = watchHistory[profileId] || [];
    const filtered = list.filter((h) => (h.watchedAt || 0) > cutoff);
    res.json({ code: 0, data: filtered });
  } catch {
    res.json({ code: 0, data: [] });
  }
});

/** Push video-id row used by Video Shuffle — merges with orchestrator rows in watch_history.json */
app.post('/api/watch-history/add', (req, res) => {
  const { profileId, videoId, videoTitle } = req.body || {};
  if (!profileId || !videoId) {
    return res.status(400).json({ code: -1, message: 'Missing profileId or videoId' });
  }
  try {
    if (!watchHistory[profileId]) watchHistory[profileId] = [];
    const exists = historyHasDuplicate(profileId, videoId, videoTitle || '');
    if (!exists) {
      addHistoryRow(profileId, {
        videoId,
        videoTitle: videoTitle || '',
        watchedAt: Date.now(),
      });
    } else {
      saveWatchHistory(watchHistory); // persist TTL cleanup if it happened
    }
    return res.json({ code: 0, message: 'History saved', duplicate: exists });
  } catch (err) {
    return res.status(500).json({ code: -1, message: err.message || String(err) });
  }
});

app.delete('/api/watch-history/:profileId', (req, res) => {
  const { profileId } = req.params;
  try {
    delete watchHistory[profileId];
    saveWatchHistory(watchHistory);
    res.json({ code: 0, message: 'History cleared' });
  } catch (err) {
    res.status(500).json({ code: -1, message: err.message || String(err) });
  }
});

// Video Shuffle state (assignments + channel min/max + enabled channels)
const SHUFFLE_FILE = path.resolve(__dirname, '..', 'shuffle_data.json');

function loadShuffleFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SHUFFLE_FILE, 'utf8'));
    return {
      assignments: Array.isArray(raw.assignments) ? raw.assignments : [],
      channelConfigs: Array.isArray(raw.channelConfigs) ? raw.channelConfigs : [],
      enabledChannelIds: Array.isArray(raw.enabledChannelIds) ? raw.enabledChannelIds : [],
      settings: raw.settings && typeof raw.settings === 'object' ? { ...raw.settings, warmupEnabled: false } : { warmupEnabled: false },
      recycleConfig: raw.recycleConfig && typeof raw.recycleConfig === 'object' ? raw.recycleConfig : {},
    };
  } catch {
    return { assignments: [], channelConfigs: [], enabledChannelIds: [], settings: { warmupEnabled: false }, recycleConfig: {} };
  }
}

function saveShuffleFile(data) {
  try {
    const safe = { ...data, settings: { ...(data.settings || {}), warmupEnabled: false } };
    atomicWriteJson(SHUFFLE_FILE, safe);
  } catch (err) {
    console.error('[Shuffle] Failed to save:', err.message);
  }
}

app.get('/api/shuffle/state', (req, res) => {
  res.json(loadShuffleFile());
});

app.get('/api/backlinks', (req, res) => {
  res.json(loadBacklinksFile());
});

app.put('/api/backlinks', (req, res) => {
  const { links, manualAssign } = req.body || {};
  const prev = loadBacklinksFile();
  const next = {
    links: Array.isArray(links) ? links : prev.links,
    manualAssign: manualAssign && typeof manualAssign === 'object' ? manualAssign : prev.manualAssign,
  };
  saveBacklinksFile(next);
  res.json({ success: true, ...next });
});

app.post('/api/backlinks/mark-used', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  markBacklinksUsed(ids);
  res.json({ success: true, count: ids.length });
});

app.put('/api/shuffle/state', (req, res) => {
  const { assignments, channelConfigs, enabledChannelIds, settings, recycleConfig } = req.body || {};
  const prev = loadShuffleFile();
  const next = {
    assignments: Array.isArray(assignments) ? assignments : prev.assignments,
    channelConfigs: Array.isArray(channelConfigs) ? channelConfigs : prev.channelConfigs,
    enabledChannelIds: Array.isArray(enabledChannelIds) ? enabledChannelIds : prev.enabledChannelIds,
    settings: settings && typeof settings === 'object' ? settings : prev.settings,
    recycleConfig: recycleConfig && typeof recycleConfig === 'object' ? recycleConfig : prev.recycleConfig,
  };
  saveShuffleFile(next);
  res.json({ success: true });
});

app.post('/api/shuffle/assign-one', (req, res) => {
  const { profileId, profileName, allProfileIds, usedVideoIds } = req.body || {};
  if (!profileId) return res.status(400).json({ error: 'profileId required' });
  try {
    const shuffleFile = loadShuffleFile();
    const result = assignOneProfile({
      profileId,
      profileName: profileName || profileId,
      shuffleFile,
      watchHistory,
      allProfileIds: Array.isArray(allProfileIds) ? allProfileIds : [],
      usedInThisRun: new Set(Array.isArray(usedVideoIds) ? usedVideoIds : []),
    });
    res.json({ success: true, assignment: result });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

let profileRecycleManager = null;

function initProfileRecycleManager() {
  profileRecycleManager = new ProfileRecycleManager({
    orchestrator,
    getMaxConcurrent,
    getRunningCount() {
      return orchestrator.getStats().running + activeAgents.size;
    },
    runningSchedules,
    getWatchHistory: () => watchHistory,
    loadShuffleFile,
    activityLog,
    notificationService,
    loadAppSettings,
    onProfileRecreated({ oldId, newId, profileName }) {
      activityLog.append({
        level: 'info',
        source: 'shuffle',
        message: `[24/7] Profile ID updated: "${profileName}" ${oldId.slice(-6)} → ${newId.slice(-6)}`,
      });
    },
  });

  orchestrator.onWorkerFinished = (profileId, outcome) => {
    if (profileRecycleManager?.isRecycleProfile(profileId)) {
      profileRecycleManager.onWorkerFinished(profileId, outcome);
    }
  };

  orchestrator.onWorkerSignInRequired = (profileId) => {
    if (profileRecycleManager?.isRecycleProfile(profileId)) {
      profileRecycleManager.immediateRecreate(profileId);
    }
  };

  if (!profileRecycleManager.enabled) {
    profileRecycleManager.resumeFromShuffleConfig().catch((err) => {
      console.warn('[Recycle] Shuffle config resume failed:', err.message);
    });
  }
}

initProfileRecycleManager();

app.get('/api/recycle/status', (req, res) => {
  res.json(profileRecycleManager.getStatus());
});

app.post('/api/recycle/start', async (req, res) => {
  const { profiles, cooldownMinMinutes, cooldownMaxMinutes } = req.body || {};
  if (!Array.isArray(profiles) || !profiles.length) {
    return res.status(400).json({ error: 'profiles array required' });
  }
  try {
    const status = await profileRecycleManager.start({
      profiles,
      cooldownMinMinutes: cooldownMinMinutes ?? 10,
      cooldownMaxMinutes: cooldownMaxMinutes ?? 30,
    });
    const recycleConfig = {
      enabled: true,
      profileIds: profiles.map((p) => p.id),
      cooldownMinMinutes: cooldownMinMinutes ?? 10,
      cooldownMaxMinutes: cooldownMaxMinutes ?? 30,
    };
    const shuffle = loadShuffleFile();
    saveShuffleFile({ ...shuffle, recycleConfig });
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.post('/api/recycle/stop', (req, res) => {
  const { slotId, profileId } = req.body || {};
  const status = profileRecycleManager.stop({ slotId, profileId });
  if (!slotId && !profileId) {
    const shuffle = loadShuffleFile();
    saveShuffleFile({ ...shuffle, recycleConfig: { ...shuffle.recycleConfig, enabled: false } });
  }
  res.json({ success: true, status });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GMAIL LOGIN MANAGER API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const gmailLoginManager = require('./gmailLoginManager.cjs');

app.post('/api/gmail-login/start', (req, res) => {
  const { credentials, batchSize } = req.body || {};
  if (!Array.isArray(credentials) || !credentials.length) {
    return res.status(400).json({ ok: false, error: 'credentials array required' });
  }
  const result = gmailLoginManager.start(credentials, batchSize || 3);
  res.json(result);
});

app.post('/api/gmail-login/stop', (req, res) => {
  res.json(gmailLoginManager.stop());
});

app.get('/api/gmail-login/status', (req, res) => {
  res.json(gmailLoginManager.getStatus());
});

app.post('/api/gmail-login/mark-done/:profileId', (req, res) => {
  res.json(gmailLoginManager.markResume(req.params.profileId));
});

app.post('/api/gmail-login/skip/:profileId', (req, res) => {
  res.json(gmailLoginManager.markSkip(req.params.profileId));
});

app.post('/api/gmail-login/retry/:profileId', (req, res) => {
  res.json(gmailLoginManager.retryEntry(req.params.profileId));
});

app.post('/api/gmail-login/clear', (req, res) => {
  res.json(gmailLoginManager.clearAll());
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ENGAGEMENT QUEUE API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const { engagementQueue } = require('./engagementQueue.cjs');

// Start engagement jobs for a batch of profiles
app.post('/api/engagement/start', async (req, res) => {
  try {
    const {
      profiles,        // [{ profileId, profileName, browserType, source, delayMs, actions, videos[] }]
      watchPct,        // 0-100
      adSkipEnabled,   // boolean (default true)
      videoQuality,    // 'auto'|'144p'|...|'1080p'
      maxConcurrent,
    } = req.body;

    if (!profiles || !profiles.length) {
      return res.status(400).json({ code: -1, message: 'profiles required' });
    }

    const jobIds = engagementQueue.enqueue({
      profiles,
      watchPct:       watchPct       ?? 40,
      adSkipEnabled:  adSkipEnabled  !== false,
      videoQuality:   videoQuality   || 'auto',
      maxConcurrent:  Math.max(1, Math.min(50, Number(maxConcurrent) || profiles.length || 1)),
    });

    res.json({ code: 0, message: `Queued ${jobIds.length} engagement jobs`, jobIds });
  } catch (err) {
    res.status(500).json({ code: -1, message: err.message });
  }
});

// Get queue status
app.get('/api/engagement/status', (req, res) => {
  res.json({ code: 0, data: engagementQueue.getStatus() });
});

// Cancel all pending jobs
app.post('/api/engagement/cancel', (req, res) => {
  engagementQueue.cancelAll();
  res.json({ code: 0, message: 'Cancelled all pending jobs' });
});

// Clear finished/failed/cancelled jobs
app.post('/api/engagement/clear', (req, res) => {
  engagementQueue.clearFinished();
  res.json({ code: 0, message: 'Cleared finished jobs' });
});

app.post('/api/recycle/pause', (req, res) => {
  const status = profileRecycleManager.pause();
  res.json({ success: true, status });
});

app.post('/api/recycle/resume', (req, res) => {
  const status = profileRecycleManager.resume();
  res.json({ success: true, status });
});

app.put('/api/recycle/config', (req, res) => {
  const body = req.body || {};
  const hasCooldownMin = Object.prototype.hasOwnProperty.call(body, 'cooldownMinMinutes');
  const hasCooldownMax = Object.prototype.hasOwnProperty.call(body, 'cooldownMaxMinutes');
  const hasProfileIds = Object.prototype.hasOwnProperty.call(body, 'profileIds');
  const cooldownMinMinutes = hasCooldownMin ? body.cooldownMinMinutes : undefined;
  const cooldownMaxMinutes = hasCooldownMax ? body.cooldownMaxMinutes : undefined;
  const profileIds = hasProfileIds && Array.isArray(body.profileIds) ? body.profileIds : undefined;

  const status = profileRecycleManager.updateConfig({ cooldownMinMinutes, cooldownMaxMinutes, profileIds });
  const shuffle = loadShuffleFile();
  const recycleConfig = { ...shuffle.recycleConfig };
  if (hasCooldownMin && cooldownMinMinutes != null) recycleConfig.cooldownMinMinutes = cooldownMinMinutes;
  if (hasCooldownMax && cooldownMaxMinutes != null) recycleConfig.cooldownMaxMinutes = cooldownMaxMinutes;
  if (hasProfileIds && Array.isArray(body.profileIds)) recycleConfig.profileIds = body.profileIds;
  saveShuffleFile({ ...shuffle, recycleConfig });
  res.json({ success: true, status });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROXY ROTATION — Real server-side session rotate
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** POST /api/proxy/rotate
 *  Generates a fresh SmartProxy session (new session ID, same state/city/life).
 *  Returns the new proxy config so the frontend can update its state.
 *  Does NOT update the Multilogin profile — that requires a profile recreate.
 */
const proxyRotator = require('./services/ProxyRotator.cjs');

const { updateProviderProxy } = require('./services/ProxyProfileUpdater.cjs');

app.post('/api/proxy/rotate', async (req, res) => {
  const { profileId, currentProxy, browserType } = req.body || {};
  if (!profileId) return res.status(400).json({ success: false, error: 'profileId required' });

  const host = String(currentProxy?.server || currentProxy?.host || '').toLowerCase();
  if (host.includes('multilogin.com') || host.includes('gate.multilogin')) {
    return res.status(400).json({
      success: false,
      error: 'Multilogin built-in proxy cannot be rotated here — recreate profile or change proxy in MLX app.',
    });
  }

  try {
    // Generate a fresh proxy keeping same geo (state/city) but new session ID
    const { server, port, password, prefix } = proxyRotator._getProxyEnv();

    if (!password || !prefix) {
      return res.status(500).json({ success: false, error: 'Proxy credentials not configured in .env' });
    }

    // Use state/city from current proxy if available, else pick random
    const state = currentProxy?.state || null;
    const city = currentProxy?.city || null;
    const life = currentProxy?.life || '120';

    // Generate a new session ID that's not in the current assignments
    const sessionId = proxyRotator._generateUniqueSessionId();

    const username = state && city
      ? `${prefix}_area-US_state-${state}_city-${city}_life-${life}_session-${sessionId}`
      : `${prefix}_area-US_session-${sessionId}_life-${life}`;

    const now = Date.now();
    const LIFE_MS_MAP = { '60': 3600000, '120': 7200000, '240': 14400000, '480': 28800000, '1440': 86400000 };

    const newProxy = {
      server,
      port,
      username,
      password,
      state: state || 'NEWYORK',
      city: city || 'NEWYORK',
      life,
      sessionId,
      assignedAt: now,
      expiresAt: now + (LIFE_MS_MAP[life] || 7200000),
    };

    // Update the registration
    proxyRotator.registerAssignment(profileId, newProxy);

    let providerUpdated = false;
    let providerMessage = '';
    // Default to BROWSER_PROVIDER env var when browserType not sent in request
    const bt = (browserType || process.env.BROWSER_PROVIDER || '').toLowerCase();
    if (bt === 'morelogin' || bt === 'multilogin') {
      const push = await updateProviderProxy(profileId, bt, newProxy);
      providerUpdated = push.success;
      providerMessage = push.success ? push.message : (push.error || 'Provider update failed');
      if (!push.success) {
        console.warn(`[ProxyRotate] Provider push failed for ${profileId}: ${providerMessage}`);
      }
    }

    console.log(`[ProxyRotate] Profile ${profileId.slice(-4)} → new session ${sessionId} (provider: ${providerUpdated})`);
    res.json({
      success: true,
      proxy: newProxy,
      providerUpdated,
      providerMessage: providerMessage || undefined,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/proxy/check — real proxy speed + geo via ip-api.com
app.post('/api/proxy/check', async (req, res) => {
  const { server, port, username, password } = req.body || {};
  if (!server || !port) return res.status(400).json({ success: false, error: 'server and port required' });

  const start = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: server,
        port: parseInt(port, 10) || 3120,
        path: 'http://ip-api.com/json',
        method: 'GET',
        headers: {
          Host: 'ip-api.com',
          'User-Agent': 'Mozilla/5.0',
          'Proxy-Authorization': 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64'),
        },
      };
      const req2 = http.request(options, (proxyRes) => {
        let data = '';
        proxyRes.on('data', (c) => { data += c; });
        proxyRes.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.status === 'success') {
              resolve({ ip: json.query, city: json.city, region: json.regionName, country: json.country, countryCode: json.countryCode, isp: json.isp });
            } else {
              resolve({ ip: 'Unknown', city: '', region: '', country: '', isp: json.message || '' });
            }
          } catch {
            resolve({ ip: 'Unknown', city: '', region: '', country: '', isp: '' });
          }
        });
      });
      req2.setTimeout(9000, () => { req2.destroy(); reject(new Error('timeout')); });
      req2.on('error', reject);
      req2.end();
    });
    res.json({ success: true, ...result, speed: Date.now() - start });
  } catch (err) {
    res.json({ success: false, error: err.message || 'failed', speed: Date.now() - start });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// APP DATA — profile configs, comments, channels (server source of truth)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/profile-configs', (req, res) => {
  res.json({ success: true, configs: appDataStore.getAllProfileConfigs() });
});

app.get('/api/profile-config/:profileId', (req, res) => {
  const config = appDataStore.getProfileConfig(req.params.profileId);
  if (!config) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, config });
});

app.put('/api/profile-config/:profileId', (req, res) => {
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') return res.status(400).json({ success: false, error: 'config object required' });
  appDataStore.setProfileConfig(req.params.profileId, config);
  res.json({ success: true });
});

app.put('/api/profile-configs', (req, res) => {
  const { configs } = req.body || {};
  if (!configs || typeof configs !== 'object') return res.status(400).json({ success: false, error: 'configs object required' });
  appDataStore.setAllProfileConfigs(configs);
  res.json({ success: true, count: Object.keys(configs).length });
});

app.get('/api/comments', (req, res) => {
  res.json({ success: true, comments: appDataStore.getComments() });
});

app.put('/api/comments', (req, res) => {
  const { comments } = req.body || {};
  if (!Array.isArray(comments)) return res.status(400).json({ success: false, error: 'comments array required' });
  appDataStore.setComments(comments);
  res.json({ success: true, count: comments.length });
});

app.get('/api/channels-data', (req, res) => {
  res.json({ success: true, ...appDataStore.getChannelsBundle() });
});

app.put('/api/channels-data', (req, res) => {
  const { channels, videos, playlists } = req.body || {};
  appDataStore.setChannelsBundle({ channels, videos, playlists });
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCHEDULED TIMER — Check every 15s for due schedules
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const scheduledJobs = new Map(); // scheduleId → { schedule, nextRun, repeat }

function scheduleNextRunMs(schedule) {
  const t = schedule?.scheduledTime;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const parsed = new Date(t).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function syncScheduledJobsFromList(list) {
  if (!Array.isArray(list)) return;
  scheduledJobs.clear();
  for (const schedule of list) {
    if (!schedule?.id) continue;
    const nextRun = scheduleNextRunMs(schedule);
    const waiting =
      schedule.status === 'scheduled'
      || (schedule.runMode === 'scheduled' && nextRun > Date.now());
    if (!waiting || nextRun <= Date.now()) continue;
    scheduledJobs.set(schedule.id, {
      schedule,
      nextRun,
      repeat: schedule.repeatEnabled ? schedule.repeatInterval : null,
    });
  }
  if (scheduledJobs.size > 0) {
    console.log(`[Timer] ${scheduledJobs.size} schedule(s) armed for auto-run`);
  }
}

app.post('/api/schedule/timer/set', (req, res) => {
  const { schedule } = req.body;
  if (!schedule || !schedule.scheduledTime) return res.status(400).json({ error: 'schedule with scheduledTime required' });

  const scheduleId = schedule.id || Date.now().toString();
  const nextRun = scheduleNextRunMs(schedule);
  if (!nextRun || nextRun <= Date.now()) {
    return res.status(400).json({ error: 'scheduledTime must be in the future' });
  }
  scheduledJobs.set(scheduleId, {
    schedule,
    nextRun,
    repeat: schedule.repeatEnabled ? schedule.repeatInterval : null,
  });
  console.log(`[Timer] Schedule "${schedule.name}" set for ${new Date(nextRun).toLocaleString()} (repeat: ${schedule.repeatInterval || 'none'})`);
  res.json({ success: true, scheduleId, nextRun });
});

app.get('/api/schedule/timer/list', (req, res) => {
  const list = [];
  for (const [id, job] of scheduledJobs) {
    list.push({ id, name: job.schedule.name, nextRun: job.nextRun, repeat: job.repeat });
  }
  res.json(list);
});

app.post('/api/schedule/timer/cancel', (req, res) => {
  const { scheduleId } = req.body;
  scheduledJobs.delete(scheduleId);
  res.json({ success: true });
});

// Check every 15s for due schedules (respects max concurrent like /api/schedule/run)
const _scheduledJobsTickerId = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of scheduledJobs) {
    if (!job.nextRun || now < job.nextRun) continue;

    const maxConcurrent = getMaxConcurrent();
    const currentRunning = orchestrator.getStats().running + activeAgents.size;
    if (currentRunning >= maxConcurrent) {
      console.log(`[Timer] ⏰ "${job.schedule.name}" due but skipped — max concurrent (${maxConcurrent}) reached`);
      continue;
    }

    console.log(`[Timer] ⏰ Schedule "${job.schedule.name}" is DUE — running now!`);
    const scheduleToRun = { ...job.schedule };
    const availableSlots = Math.max(1, maxConcurrent - currentRunning);
    if (scheduleToRun.selectedProfiles?.length > availableSlots) {
      scheduleToRun.selectedProfiles = scheduleToRun.selectedProfiles.slice(0, availableSlots);
      console.log(`[Timer] Trimmed to ${availableSlots} profiles (limit: ${maxConcurrent})`);
    }

    orchestrator.runSchedule(scheduleToRun);

    const scheduleId = scheduleToRun.id || id;
    runningSchedules.set(scheduleId, { schedule: scheduleToRun, status: 'running', startedAt: Date.now() });

    if (job.repeat) {
      const intervals = { '1hr': 3600000, '3hr': 10800000, '6hr': 21600000, '12hr': 43200000, '24hr': 86400000, 'daily': 86400000 };
      job.nextRun = now + (intervals[job.repeat] || 21600000);
      console.log(`[Timer] Next run: ${new Date(job.nextRun).toLocaleString()}`);
    } else {
      scheduledJobs.delete(id);
    }
  }
}, 15000);

try {
  syncScheduledJobsFromList(loadSchedulesFile());
} catch (err) {
  console.warn('[Timer] Failed to hydrate schedules:', err.message);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WORKER THREAD STATUS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/jobs', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { randomUUID } = require('crypto');
  const taskType = String(body.taskType || 'watch_video').trim();
  const profileId = body.profileId != null ? String(body.profileId).trim() : '';
  const profileName = body.profileName != null ? String(body.profileName).trim() : `Profile-${profileId.slice(-4)}`;
  if (!profileId) return res.status(400).json({ error: 'profileId required' });

  const job = {
    id: `${profileId}-${randomUUID()}`,
    profileId,
    profileName,
    taskType,
    status: 'pending',
    retryCount: 0,
    createdAt: Date.now(),
    details: typeof body.details === 'string' ? body.details.slice(0, 500) : undefined,
    queuedBy: typeof body.source === 'string' ? body.source.slice(0, 80) : 'ui',
  };
  automationJobLedger.unshift(job);
  if (automationJobLedger.length > 500) automationJobLedger.length = 500;
  res.json({ success: true, job });
});

app.get('/api/workers', (req, res) => {
  res.json({
    workers: orchestrator.getAllStatuses(),
    stats: orchestrator.getStats(),
    queuedJobs: automationJobLedger.slice(0, 200),
  });
});

app.get('/api/workers/:profileId', (req, res) => {
  const status = orchestrator.getWorkerStatus(req.params.profileId);
  if (!status) return res.status(404).json({ error: 'Worker not found' });
  res.json(status);
});

app.post('/api/workers/stop/:profileId', (req, res) => {
  orchestrator.stopWorker(req.params.profileId);
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROVIDER PING — Sidebar connection status
// Checks LOCAL app port only — no cloud auth needed
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/providers/ping', (req, res) => {
  const https = require('https');
  const http = require('http');
  const provider = (req.query.provider || process.env.BROWSER_PROVIDER || 'morelogin').toLowerCase();

  if (provider === 'multilogin') {
    // Ping LOCAL Multilogin launcher (port 45001) — any HTTP response = app is running
    const options = { hostname: 'launcher.mlx.yt', port: 45001, path: '/api/v1/profile/active', method: 'GET', timeout: 5000, rejectUnauthorized: false };
    let sent = false;
    const reply = (data) => { if (!sent) { sent = true; res.json(data); } };
    const r = https.request(options, () => reply({ code: 0, message: 'Multilogin launcher running' }));
    r.on('error', () => reply({ code: -1, message: 'Multilogin app not running — please open it' }));
    r.on('timeout', () => { r.destroy(); reply({ code: -1, message: 'Multilogin launcher timeout' }); });
    r.end();
  } else {
    // Ping MoreLogin local API (port 40000)
    const mlPort = parseInt(process.env.MORELOGIN_PORT || '40000', 10);
    let sent = false;
    const reply = (data) => { if (!sent) { sent = true; res.json(data); } };
    const r = http.request({ hostname: '127.0.0.1', port: mlPort, path: '/', method: 'GET', timeout: 3000 }, () => reply({ code: 0, message: 'MoreLogin running' }));
    r.on('error', () => reply({ code: -1, message: 'MoreLogin app not running — please open it' }));
    r.on('timeout', () => { r.destroy(); reply({ code: 0, message: 'MoreLogin running' }); });
    r.end();
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MANUAL CONTROL — Batch commands for selected profiles
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Start profiles for manual control (connect CDP but don't automate)
app.post('/api/manual/start', async (req, res) => {
  const { profileIds, profileMeta } = req.body || {};
  if (!profileIds || !Array.isArray(profileIds)) return res.status(400).json({ error: 'profileIds required' });

  const meta = profileMeta && typeof profileMeta === 'object' ? profileMeta : {};

  const results = [];
  for (const profileId of profileIds) {
    try {
      // Start profile via provider (MultiLogin/MoreLogin)
      let debugPort = null;
      const provider = providerFactory.getProvider();
      const startRes = await provider.startProfile(profileId);
      if (startRes.code === 0 && startRes.data?.cdpPort) {
        debugPort = startRes.data.cdpPort;
      } else {
        // Start may take time — wait and retry once
        await sleep(8000);
        const retry = await provider.startProfile(profileId);
        if (retry.code === 0 && retry.data?.cdpPort) debugPort = retry.data.cdpPort;
      }

      if (debugPort) {
        const pidKey = typeof profileId === 'string' ? profileId : String(profileId);
        const hint = meta[pidKey] && typeof meta[pidKey] === 'object' ? meta[pidKey] : {};
        const profileOs = typeof hint.os === 'string' ? hint.os : '';
        const agent = new ProfileAgent(profileId, `Manual-${profileId.slice(-4)}`, debugPort, { profileOs });
        await agent.connect();
        activeAgents.set(profileId, agent);

        // Ensure at least one page exists (open YouTube if no tabs)
        try {
          const pages = agent.context.pages();
          if (pages.length === 0) {
            const newPage = await agent.context.newPage();
            await newPage.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          }
        } catch {}

        // Auto-cleanup after 30 minutes of inactivity
        agent._cleanupTimer = setTimeout(async () => {
          if (activeAgents.has(profileId)) {
            console.log(`[Manual] Auto-cleanup: agent ${profileId.slice(-4)} idle 30min`);
            await agent.disconnect().catch(() => {});
            activeAgents.delete(profileId);
          }
        }, 30 * 60 * 1000);

        results.push({ profileId, status: 'connected', debugPort });
      } else {
        results.push({ profileId, status: 'failed', error: 'No debug port' });
      }
    } catch (err) {
      results.push({ profileId, status: 'failed', error: err.message });
    }
  }
  // Return real success/failure based on actual connection results
  const connectedCount = results.filter(r => r.status === 'connected').length;
  const failedCount = results.filter(r => r.status === 'failed').length;
  const allFailed = connectedCount === 0;

  activityLog.append({
    level: allFailed ? 'error' : connectedCount > 0 ? 'success' : 'warn',
    source: 'manual',
    message: allFailed
      ? `Manual start failed for ${failedCount} profile(s)`
      : `Manual CDP: ${connectedCount} connected, ${failedCount} failed`,
  });

  res.status(allFailed ? 500 : 200).json({
    success: !allFailed,
    connected: connectedCount,
    failed: failedCount,
    results,
    message: allFailed
      ? `All ${failedCount} profiles failed to connect`
      : `${connectedCount} connected, ${failedCount} failed`,
  });
});

// Batch command for manual control — PARALLEL execution with unique behavior per profile
app.post('/api/manual/batch', async (req, res) => {
  const { profileIds, command, params } = req.body;
  if (!profileIds || !command) return res.status(400).json({ error: 'profileIds and command required' });

  if (command === 'arrangeWindows') {
    const { arrangeProfilesGrid, resolveRunningFromCache } = require('./services/windowArranger.cjs');
    const runningIds = profileIds.length
      ? profileIds
      : orchestrator.getAllStatuses()
        .filter((w) => ['running', 'watching', 'starting', 'connecting', 'waiting'].includes(w.status))
        .map((w) => w.profileId);
    const entries = resolveRunningFromCache(runningIds);
    if (entries.length > 0) {
      const results = await arrangeProfilesGrid(entries);
      const ok = results.filter((r) => r.status === 'ok').length;
      return res.json({
        success: ok > 0,
        results,
        message: ok > 0 ? `Arranged ${ok}/${results.length} windows on screen` : 'Could not arrange windows — check CDP ports',
      });
    }
  }

  // Reset cleanup timer for all active profiles (user is actively using them)
  for (const profileId of profileIds) {
    const agent = activeAgents.get(profileId);
    if (agent && agent._cleanupTimer) {
      clearTimeout(agent._cleanupTimer);
      agent._cleanupTimer = setTimeout(async () => {
        if (activeAgents.has(profileId)) {
          console.log(`[Manual] Auto-cleanup: agent ${profileId.slice(-4)} idle 30min`);
          await agent.disconnect().catch(() => {});
          activeAgents.delete(profileId);
        }
      }, 30 * 60 * 1000);
    }
  }

  // Run ALL profiles in PARALLEL (not sequential)
  const promises = profileIds.map(async (profileId, index) => {
    const agent = activeAgents.get(profileId);
    if (!agent || !agent.context) {
      return { profileId, status: 'not_connected' };
    }

    try {
      let pages = agent.context.pages();
      let page = pages[pages.length - 1];
      if (!page) {
        page = await agent.context.newPage();
        await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      }

      // Tiny stagger (20-100ms) — just enough to not be identical timestamps
      await sleep(Math.floor(Math.random() * 80) + 20);

      switch (command) {
        case 'scrollDown': {
          // UNIQUE curve per profile — different amount, speed, pattern
          const totalAmount = randomDelay(150, 600); // Wide range = unique per profile
          const steps = randomDelay(3, 8);
          const acceleration = 0.5 + Math.random() * 1.5; // Some fast start, some slow start
          for (let s = 0; s < steps; s++) {
            // Curve: accelerate then decelerate (not straight line)
            const progress = s / steps;
            const curveMultiplier = Math.sin(progress * Math.PI * acceleration); // Sine curve
            const stepAmount = (totalAmount / steps) * (0.5 + curveMultiplier);
            const jitter = stepAmount + (Math.random() * 20 - 10);
            await page.mouse.wheel(0, jitter);
            await sleep(randomDelay(15, 40));
          }
          return { profileId, status: 'ok', action: `scrolled down ${totalAmount}px (curve)` };
        }
        case 'scrollUp': {
          const totalAmount = randomDelay(150, 600);
          const steps = randomDelay(3, 8);
          const acceleration = 0.5 + Math.random() * 1.5;
          for (let s = 0; s < steps; s++) {
            const progress = s / steps;
            const curveMultiplier = Math.sin(progress * Math.PI * acceleration);
            const stepAmount = (totalAmount / steps) * (0.5 + curveMultiplier);
            await page.mouse.wheel(0, -(stepAmount + (Math.random() * 20 - 10)));
            await sleep(randomDelay(15, 40));
          }
          return { profileId, status: 'ok', action: `scrolled up ${totalAmount}px (curve)` };
        }
        case 'search': {
          const query = params?.query || '';
          if (!query) return { profileId, status: 'no_query' };
          
          // TRAFFIC MIX — each profile gets different search method
          const methods = ['youtube', 'youtube', 'youtube', 'google', 'bing']; // 60% YT, 20% Google, 20% Bing
          const method = methods[(index * 3 + profileId.charCodeAt(profileId.length - 1)) % methods.length];
          
          if (method === 'google') {
            await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(randomDelay(1000, 2000));
            const gInput = await page.$('input[name="q"], textarea[name="q"]');
            if (gInput) { await gInput.click(); await sleep(300); }
            for (const char of (query + ' youtube')) {
              await page.keyboard.type(char, { delay: randomDelay(50, 150) });
            }
            await sleep(500);
            await page.keyboard.press('Enter');
            return { profileId, status: 'ok', action: `searched via Google: ${query}` };
          } else if (method === 'bing') {
            await page.goto('https://www.bing.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(randomDelay(1000, 2000));
            const bInput = await page.$('input[name="q"], #sb_form_q');
            if (bInput) { await bInput.click(); await sleep(300); }
            for (const char of (query + ' youtube')) {
              await page.keyboard.type(char, { delay: randomDelay(50, 150) });
            }
            await sleep(500);
            await page.keyboard.press('Enter');
            return { profileId, status: 'ok', action: `searched via Bing: ${query}` };
          } else {
            // YouTube search
            const currentUrl = page.url();
            if (!currentUrl.includes('youtube.com')) {
              await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
              await sleep(randomDelay(1000, 2000));
            }
            await page.keyboard.press('/');
            await sleep(randomDelay(500, 800));
            await page.keyboard.press('Control+a');
            await sleep(100);
            await page.keyboard.press('Backspace');
            await sleep(200);
            for (const char of query) {
              await page.keyboard.type(char, { delay: randomDelay(50, 150) });
            }
            await sleep(500);
            await page.keyboard.press('Enter');
            return { profileId, status: 'ok', action: `searched via YouTube: ${query}` };
          }
        }
        case 'play': {
          await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.play(); });
          return { profileId, status: 'ok', action: 'play' };
        }
        case 'pause': {
          await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.pause(); });
          return { profileId, status: 'ok', action: 'pause' };
        }
        case 'next': {
          const nextBtn = await page.$('.ytp-next-button, [aria-label="Next"]');
          if (nextBtn) await nextBtn.click();
          return { profileId, status: 'ok', action: 'next' };
        }
        case 'stop': {
          await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.pause(); v.currentTime = 0; } });
          return { profileId, status: 'ok', action: 'stop' };
        }
        case 'skipForward': {
          await page.keyboard.press('l');
          return { profileId, status: 'ok', action: 'skipped +10s' };
        }
        case 'skipBackward': {
          await page.keyboard.press('j');
          return { profileId, status: 'ok', action: 'skipped -10s' };
        }
        case 'closeTab': {
          const osHint = agent.profileOs || '';
          const s = osHint.toLowerCase();
          const macLike = s.includes('mac') || s.includes('ios');
          try {
            if (macLike) {
              await page.keyboard.press('Meta+KeyW');
            } else {
              await page.keyboard.press('Control+KeyW');
            }
            return { profileId, status: 'ok', action: macLike ? 'closeTab (⌘W)' : 'closeTab (Ctrl+W)' };
          } catch (ctErr) {
            console.error('[Manual] closeTab failed:', ctErr.message);
            return { profileId, status: 'error', action: ctErr.message || String(ctErr) };
          }
        }
        case 'newTab': {
          const newPage = await agent.context.newPage();
          await newPage.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          return { profileId, status: 'ok', action: 'new tab opened' };
        }
        case 'openYoutube': {
          await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.evaluate(() => { document.cookie = 'PREF=f6=400; path=/; domain=.youtube.com'; }).catch(() => {});
          return { profileId, status: 'ok', action: 'YouTube opened' };
        }
        case 'clickVideo': {
          const vid = await page.$('ytd-video-renderer a#video-title, ytd-rich-item-renderer a#video-title-link');
          if (vid) { await vid.click(); return { profileId, status: 'ok', action: 'clicked video' }; }
          return { profileId, status: 'not_found', action: 'no video to click' };
        }
        case 'clickLike': {
          const likeBtn = await page.$('like-button-view-model button, #top-level-buttons-computed ytd-toggle-button-renderer:first-child button');
          if (likeBtn) { await likeBtn.click(); return { profileId, status: 'ok', action: 'liked' }; }
          return { profileId, status: 'not_found' };
        }
        case 'clickSubscribe': {
          const subBtn = await page.$('#subscribe-button button, ytd-subscribe-button-renderer button');
          if (subBtn) { await subBtn.click(); return { profileId, status: 'ok', action: 'subscribed' }; }
          return { profileId, status: 'not_found' };
        }
        case 'arrangeWindows': {
          const allAgents = [...activeAgents.values()];
          const totalWindows = allAgents.length;
          if (totalWindows === 0) return { profileId, status: 'no_agents' };
          const cols = Math.ceil(Math.sqrt(totalWindows));
          const winW = Math.floor(1920 / cols);
          const winH = Math.floor(1080 / Math.ceil(totalWindows / cols));
          let idx = allAgents.findIndex(a => a.profileId === profileId);
          if (idx === -1) idx = 0;
          const x = (idx % cols) * winW;
          const y = Math.floor(idx / cols) * winH;
          try {
            const cdpSession = await page.context().newCDPSession(page);
            const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
            await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { left: x, top: y, width: winW, height: winH, windowState: 'normal' } });
            return { profileId, status: 'ok', action: `arranged at ${x},${y}` };
          } catch (err) { return { profileId, status: 'error', action: err.message }; }
        }
        case 'shortsWarmup': {
          const shortsCount = params?.count || 10;
          await page.goto('https://www.youtube.com/shorts', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(randomDelay(2000, 4000));
          for (let s = 0; s < shortsCount; s++) {
            await sleep(randomDelay(5000, 30000));
            if (Math.random() < 0.15) {
              const likeBtn = await page.$('button[aria-label*="like"], #like-button button');
              if (likeBtn) await likeBtn.click().catch(() => {});
            }
            await page.keyboard.press('ArrowDown');
            await sleep(randomDelay(500, 1500));
          }
          return { profileId, status: 'ok', action: `Shorts warmup: ${shortsCount} shorts` };
        }
        default:
          return { profileId, status: 'unknown_command' };
      }
    } catch (err) {
      return { profileId, status: 'error', error: err.message };
    }
  });

  const results = await Promise.all(promises);
  res.json({ success: true, results });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SETTINGS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Legacy save (kept for backward compat — new /api/settings POST handles everything)
app.post('/api/settings/save', (req, res) => {
  const { moreloginApiKey } = req.body;
  if (moreloginApiKey) {
    appSettings.moreloginApiKey = moreloginApiKey;
    applySettingsToEnv(appSettings);
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2)); } catch {}
  }
  res.json({ success: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AUTO UPDATE — git pull + npm install
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.post('/api/update/run', requireAuth, async (req, res) => {
  if (process.env.MMB_PACKAGED === '1') {
    return res.status(400).json({
      success: false,
      mode: 'download',
      message: 'Team app updates via installer download. Use the Update button in the app header.',
    });
  }

  const { execFileSync } = require('child_process');
  const projectDir = path.resolve(__dirname, '..');

  console.log('━━━ Running Update ━━━');
  try {
    // Step 1: git pull — array argv only (no shell interpolation)
    console.log('[Update] Running git pull...');
    const pullResult = execFileSync('git', ['pull'], { cwd: projectDir, encoding: 'utf8', timeout: 30000 });
    console.log('[Update] git pull:', pullResult.trim());

    // Step 2: npm install (Windows: npm.cmd)
    console.log('[Update] Running npm install...');
    const npmExe = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npmExe, ['install'], { cwd: projectDir, encoding: 'utf8', timeout: 120000 });
    console.log('[Update] npm install done');

    // Step 3: Read new version
    let newVersion = '1.0.0';
    try {
      const versionFile = fs.readFileSync(path.join(projectDir, 'version.json'), 'utf8');
      newVersion = JSON.parse(versionFile).version;
    } catch (verErr) {
      console.warn('[Update] Could not read version.json:', verErr.message);
    }

    console.log(`[Update] ✅ Updated to v${newVersion}`);
    res.json({ success: true, message: 'Update complete! Restart to apply.', newVersion, pullResult: pullResult.trim() });
  } catch (err) {
    console.error('[Update] ❌ Failed:', err.message);
    res.json({ success: false, message: 'Update failed: ' + err.message });
  }
});

app.get('/api/update/version', (req, res) => {
  const path = require('path');
  try {
    const versionFile = require('fs').readFileSync(path.resolve(__dirname, '..', 'version.json'), 'utf8');
    res.json(JSON.parse(versionFile));
  } catch {
    res.json({ version: '1.0.0', lastUpdate: '', changelog: [] });
  }
});

// Push update to GitHub (owner dev machine only — blocked in packaged Electron app)
app.post('/api/update/push', requireAuth, async (req, res) => {
  if (process.env.MMB_PACKAGED === '1') {
    return res.status(403).json({
      success: false,
      message: 'Git push is disabled in the team app. Push updates from localhost dev only.',
    });
  }

  const { execFileSync } = require('child_process');
  const projectDir = path.resolve(__dirname, '..');
  const { version, changelog } = req.body || {};
  const {
    validateVersion,
    normalizeChangelogArray,
    buildCommitMessage,
  } = require('./updatePushValidators.cjs');

  const vCheck = validateVersion(version);
  if (!vCheck.ok) {
    return res.status(400).json({ success: false, message: vCheck.error });
  }

  const cCheck = normalizeChangelogArray(changelog);
  if (!cCheck.ok) {
    return res.status(400).json({ success: false, message: cCheck.error });
  }

  const safeVersion = vCheck.version;
  const sanitizedChangelog = cCheck.changelog;

  console.log(`━━━ Pushing Update v${safeVersion} ━━━`);
  try {
    // Step 1: Update version.json (sanitized changelog only)
    const versionData = {
      version: safeVersion,
      lastUpdate: new Date().toISOString().split('T')[0],
      changelog: sanitizedChangelog,
    };
    fs.writeFileSync(path.join(projectDir, 'version.json'), JSON.stringify(versionData, null, 2));
    console.log('[Push] version.json updated');

    // Step 2: git add all (safe — no user input)
    execFileSync('git', ['add', '-A'], { cwd: projectDir, encoding: 'utf8' });
    console.log('[Push] git add done');

    const commitMsg = buildCommitMessage(safeVersion, sanitizedChangelog);
    execFileSync('git', ['commit', '-m', commitMsg], { cwd: projectDir, encoding: 'utf8' });
    console.log('[Push] git commit done');

    // Step 3: git push (safe — no user input)
    const pushResult = execFileSync('git', ['push'], { cwd: projectDir, encoding: 'utf8', timeout: 30000 });
    console.log('[Push] git push done:', pushResult.trim());

    console.log(`[Push] ✅ v${safeVersion} pushed to GitHub!`);
    res.json({ success: true, message: `v${safeVersion} pushed to GitHub!` });
  } catch (err) {
    console.error('[Push] ❌ Failed:', err.message);
    res.json({ success: false, message: err.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MULTI-BROWSER PROVIDER ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

app.use(profileRouter);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MULTILOGIN COOKIE WARMING ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/cookies/websites — list available target websites
app.get('/api/cookies/websites', async (req, res) => {
  const result = await cookiesService.getTargetWebsites();
  res.status(result.code === 0 ? 200 : 502).json(result);
});

// POST /api/cookies/metadata — create cookie warming metadata for a profile
// Body: { profileId, targetWebsite }
app.post('/api/cookies/metadata', async (req, res) => {
  const { profileId, targetWebsite = 'mix' } = req.body || {};
  if (!profileId) {
    return res.status(400).json({ code: -5, message: 'profileId is required', data: null });
  }
  const result = await cookiesService.createCookieMetadata(profileId, targetWebsite);
  res.status(result.code === 0 ? 200 : 502).json(result);
});

// PUT /api/cookies/metadata — update cookie warming target website
// Body: { profileId, targetWebsite, additionalWebsite? }
app.put('/api/cookies/metadata', async (req, res) => {
  const { profileId, targetWebsite, additionalWebsite } = req.body || {};
  if (!profileId || !targetWebsite) {
    return res.status(400).json({ code: -5, message: 'profileId and targetWebsite are required', data: null });
  }
  const result = await cookiesService.updateCookieMetadata(profileId, targetWebsite, additionalWebsite);
  res.status(result.code === 0 ? 200 : 502).json(result);
});

// POST /api/cookies/warm-high-cpc — full high CPC/RPM bake for existing profile
app.post('/api/cookies/warm-high-cpc', async (req, res) => {
  const { profileId } = req.body || {};
  if (!profileId) {
    return res.status(400).json({ code: -5, message: 'profileId is required', data: null });
  }
  try {
    const { MultiloginProvider } = require('./providers/MultiloginProvider.cjs');
    const { HighCPCCookieWarmer } = require('./services/HighCPCCookieWarmer.cjs');
    const provider = new MultiloginProvider();
    const warmer = new HighCPCCookieWarmer(provider);
    const result = await warmer.warmOnCreate(profileId, { profileMode: 'cloud' });
    res.json({ code: 0, message: 'High CPC/RPM cookie warm complete', data: result });
  } catch (err) {
    res.status(500).json({ code: -1, message: err.message, data: null });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SETTINGS API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// GET /api/settings — return current settings + local API token for authenticated mutations
app.get('/api/settings', (req, res) => {
  res.json({ success: true, settings: appSettings, apiToken: getApiToken() });
});

// POST /api/settings — save + hot-apply to process.env + clear provider cache
app.post('/api/settings', (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') return res.status(400).json({ success: false, error: 'Invalid body' });

  // Drop removed legacy keys if present
  const {
    startDelay, actionDelay, maxRetries, cronEnabled, cronSchedule, cronAction,
    mcpEnabled, mcpPort, dbPath, walMode, pm2Name, pm2Instances,
    ...clean
  } = updates;

  appSettings = { ...appSettings, ...clean };
  if (clean.moreloginBaseUrl && !clean.moreloginPort) {
    appSettings.moreloginPort = parseMoreloginPort(appSettings);
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to write settings: ' + err.message });
  }

  applySettingsToEnv(appSettings);

  try { providerFactory.clearCache(); } catch {}
  applyYtAgentSettingsFromApp(appSettings);
  applyNotificationSettingsFromApp(appSettings);
  restartTrashJanitor();

  console.log('[Settings] Saved and applied:', Object.keys(clean).join(', '));
  activityLog.append({
    level: 'success',
    source: 'settings',
    message: `Settings saved (${Object.keys(clean).length} field(s))`,
  });
  res.json({ success: true, message: 'Settings saved and applied!', settings: appSettings });
});

app.post('/api/settings/test/morelogin', async (req, res) => {
  const base = req.body?.moreloginBaseUrl || `http://127.0.0.1:${parseMoreloginPort(req.body || {})}`;
  const apiKey = req.body?.moreloginApiKey || process.env.MORELOGIN_API_KEY || '';
  const headers = { 'Content-Type': 'application/json' };
  if (req.body?.moreloginSecurityEnabled !== false && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${base.replace(/\/$/, '')}/api/env/page`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pageNo: 1, pageSize: 1 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.ok) return res.json({ ok: true, message: `MoreLogin API reachable (${r.status})` });
    return res.json({ ok: false, message: `MoreLogin returned HTTP ${r.status}` });
  } catch (err) {
    res.json({ ok: false, message: err.message || 'Cannot reach MoreLogin — is the desktop app running?' });
  }
});

/** Team self-setup: fetch 30-day automation token from member's own Multilogin email/password */
app.post('/api/settings/multilogin/fetch-token', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = String(body.multiloginEmail || appSettings.multiloginEmail || '').trim();
    const password = String(body.multiloginPassword || appSettings.multiloginPassword || '').trim();
    const folderId = String(body.multiloginFolderId || appSettings.multiloginFolderId || '').trim();

    if (!email || !password) {
      return res.json({
        ok: false,
        message: 'Apna Multilogin email + password daalo pehle (har team member ka alag account).',
      });
    }

    const merged = {
      ...appSettings,
      multiloginEmail: email,
      multiloginPassword: password,
      multiloginToken: '',
      ...(folderId ? { multiloginFolderId: folderId } : {}),
    };
    applySettingsToEnv(merged);
    delete process.env.MULTILOGIN_TOKEN;

    try { providerFactory.clearCache(); } catch {}
    const { MultiloginProvider } = require('./providers/MultiloginProvider.cjs');
    const provider = new MultiloginProvider();
    const auth = await provider.authenticate({ skipStaticToken: true });

    if (auth.code !== 0) {
      return res.json({ ok: false, message: auth.message || 'Multilogin sign-in failed' });
    }

    const token = String(process.env.MULTILOGIN_TOKEN || provider.token || '').trim();
    if (!token) {
      return res.json({
        ok: false,
        message: 'Sign-in OK but automation token nahi mila. Plan mein Automation API check karo.',
      });
    }

    appSettings = {
      ...appSettings,
      multiloginEmail: email,
      multiloginPassword: password,
      multiloginToken: token,
      ...(folderId ? { multiloginFolderId: folderId } : {}),
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
    applySettingsToEnv(appSettings);
    try { providerFactory.clearCache(); } catch {}

    return res.json({
      ok: true,
      message: 'Automation token auto-save ho gaya (30 din). Ab "Test Multilogin" dabao.',
      tokenPreview: `${token.slice(0, 12)}…`,
    });
  } catch (err) {
    return res.json({ ok: false, message: err.message || 'Token fetch failed' });
  }
});

app.post('/api/settings/test/multilogin', async (req, res) => {
  try {
    if (req.body && typeof req.body === 'object') {
      applySettingsToEnv({ ...appSettings, ...req.body });
      try { providerFactory.clearCache(); } catch {}
    }
    const provider = providerFactory.getProvider('multilogin');
    const token = process.env.MULTILOGIN_TOKEN;
    const email = process.env.MULTILOGIN_EMAIL;
    if (!token && !email) {
      return res.json({ ok: false, message: 'Save Multilogin token or email/password first' });
    }
    const list = await provider.listProfiles();
    if (list.code === 0) {
      return res.json({ ok: true, message: `Multilogin OK — ${(list.data || []).length} profiles in folder` });
    }
    return res.json({ ok: false, message: list.message || 'Multilogin auth failed' });
  } catch (err) {
    res.json({ ok: false, message: err.message || 'Multilogin test failed' });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// START SERVER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — shutting down gracefully...`);

  try {
    notificationService.stopCommandPoller();
  } catch { /* ignore */ }

  try {
    clearInterval(_ramWarnIntervalId);
    clearInterval(_analyticsDailyInterval);
    clearInterval(_scheduledJobsTickerId);
  } catch (timerErr) {
    console.error('[shutdown] clear timers:', timerErr.message);
  }

  try {
    orchestrator.stopAll();
  } catch (ochErr) {
    console.error('[shutdown] orchestrator.stopAll:', ochErr.message);
  }

  try {
    await agentManager.stopAll();
  } catch (amErr) {
    console.error('[shutdown] agentManager.stopAll:', amErr.message);
  }

  const disconnectAgents = [...activeAgents.entries()];
  activeAgents.clear();
  for (const [, ag] of disconnectAgents) {
    try {
      if (ag && ag._cleanupTimer) clearTimeout(ag._cleanupTimer);
      await ag.disconnect();
    } catch (disconnectErr) {
      console.error('[shutdown] ProfileAgent.disconnect:', disconnectErr.message);
    }
  }

  try {
    await analyticsStore.flushPending();
  } catch (flushErr) {
    console.error('[shutdown] analytics flush:', flushErr.message);
  }

  saveWatchHistory(watchHistory);

  server.close((closeErr) => {
    if (closeErr) {
      console.error('[shutdown] server.close:', closeErr.message);
    } else {
      console.log('[shutdown] HTTP server closed');
    }
    process.exit(closeErr ? 1 : 0);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TELEGRAM BOT — data provider for command poller
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getTodayWatchStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const cutoff = todayStart.getTime();

  let videosWatched = 0;
  let totalWatchSec = 0;
  let likes = 0;
  const profilesUsed = new Set();

  for (const [profileId, rows] of Object.entries(watchHistory)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row.watchedAt || row.watchedAt < cutoff) continue;
      videosWatched++;
      profilesUsed.add(profileId);
      // estimate watch time from watchPercent (assume avg 8min video)
      if (row.watchPercent) totalWatchSec += Math.round((row.watchPercent / 100) * 480);
      if (row.liked) likes++;
    }
  }

  return { videosWatched, totalWatchSec, likes, profilesUsed: profilesUsed.size };
}

function buildTelegramDataProvider() {
  return {
    getAgentManagerStatus: () => agentManager.getStatus(),
    getActiveYTCount: () => agentManager.getActiveCount(),
    getOrchestratorStats: () => orchestrator.getStats(),
    getManualAgentCount: () => activeAgents.size,
    getRunningScheduleCount: () => runningSchedules.size,
    getRunningSchedules: () => [...runningSchedules.values()],
    getRecentErrorsAndWarnings: (n = 5) => {
      const errResult  = activityLog.getLogs({ level: 'error', limit: n });
      const warnResult = activityLog.getLogs({ level: 'warn',  limit: n });
      return {
        errors:   (errResult.entries  || []).slice(-n).reverse(),
        warnings: (warnResult.entries || []).slice(-n).reverse(),
      };
    },
    getTodayStats: () => getTodayWatchStats(),
    stopAllAgents: async () => {
      orchestrator.stopAll();
      await agentManager.stopAll();
      for (const [, ag] of activeAgents) {
        try { await ag.disconnect(); } catch { /* ignore */ }
      }
      activeAgents.clear();
    },
  };
}

const server = app.listen(PORT, () => {
  const providerName = (process.env.BROWSER_PROVIDER || 'morelogin').toUpperCase();
  console.log(`\n🤖 MMB-AGENT Backend Server running on http://localhost:${PORT}`);
  console.log(`   Browser Provider: ${providerName}`);
  console.log(`   Playwright CDP: Ready`);
  console.log(`   Worker Threads: Enabled (crash isolation)`);
  console.log(`   Endpoints:`);
  console.log(`     GET  /api/health`);
  console.log(`     GET  /api/agents`);
  console.log(`     GET  /api/workers`);
  console.log(`     GET  /api/logs`);
  console.log(`     POST /api/logs`);
  console.log(`     DELETE /api/logs`);
  console.log(`     POST /api/schedule/run    (Worker Threads)`);
  console.log(`     POST /api/schedule/stop`);
  console.log(`     POST /api/manual/start    (Direct CDP)`);
  console.log(`     POST /api/manual/batch`);
  console.log(`     POST /api/update/run`);
  console.log(`     POST /api/update/push`);
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Start Telegram bot command poller
  notificationService.startCommandPoller(buildTelegramDataProvider());
});

server.on('error', (err) => {
  console.error('[FATAL] Server listen error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — close other MMB Agent instances and retry.`);
  }
  process.exit(1);
});

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
