/**
 * Orchestrator — Manages Worker Threads (Agent Pool)
 * 
 * Architecture:
 * Main Process (Express API) → Orchestrator → Worker Pool (1 per profile)
 * 
 * Features:
 * - Spawn isolated worker per profile
 * - Crash isolation: one worker dies, others continue
 * - Auto-restart crashed workers (max 3 retries)
 * - Status tracking per worker
 * - Graceful shutdown
 */

const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_PATH = path.resolve(__dirname, 'worker.cjs');

/** Per-profile worker must match Profile.browserType (Multilogin vs MoreLogin). */
function normalizeScheduleBrowserProvider(raw) {
  const n = raw != null ? String(raw).trim().toLowerCase() : '';
  const mapped = n === 'adspower' ? 'multilogin' : n;
  const envRaw = process.env.BROWSER_PROVIDER ? String(process.env.BROWSER_PROVIDER).trim().toLowerCase() : '';
  const envBt = envRaw === 'adspower' ? 'multilogin' : envRaw;
  let bt = mapped || envBt || 'morelogin';
  if (bt !== 'morelogin' && bt !== 'multilogin') bt = 'morelogin';
  return bt;
}

class Orchestrator {
  constructor() {
    this.workers = new Map(); // profileId → { worker, status, retries, logs }
    this.maxRetries = 3;
    this._arrangeTimer = null;
  }

  /** Resolve worker state after profile_rebinding (map key may have moved). */
  _workerStateByThread(worker) {
    for (const st of this.workers.values()) {
      if (st.worker === worker) return st;
    }
    return null;
  }

  _scheduleArrangeAll() {
    if (this._arrangeTimer) clearTimeout(this._arrangeTimer);
    this._arrangeTimer = setTimeout(async () => {
      try {
        const { arrangeProfilesGrid, resolveRunningFromCache, loadAutoArrangeSetting } = require('./services/windowArranger.cjs');
        if (!loadAutoArrangeSetting()) return;
        const runningIds = [...this.workers.entries()]
          .filter(([, s]) => ['running', 'watching', 'connecting', 'starting', 'waiting'].includes(s.status))
          .map(([id, s]) => s.currentProfileId || id);
        const entries = resolveRunningFromCache(runningIds);
        if (entries.length >= 1) {
          const results = await arrangeProfilesGrid(entries);
          const ok = results.filter((r) => r.status === 'ok').length;
          console.log(`[Orchestrator] Auto-arranged ${ok}/${results.length} browser windows`);
        }
      } catch (err) {
        console.warn('[Orchestrator] Auto-arrange failed:', err.message);
      }
    }, 3000);
  }

  /**
   * Start a worker for a profile
   */
  startWorker(profileId, profileName, videos, config = {}, startDelay = 0, existingRetries = 0) {
    // Kill existing worker for this profile if any
    if (this.workers.has(profileId)) {
      this.stopWorker(profileId);
    }

    const browserType = normalizeScheduleBrowserProvider(config.browserType);

    const workerState = {
      worker: null,
      status: 'starting',
      profileName,
      /** Updated if worker reports profile_rebinding after recovery recreate */
      currentProfileId: profileId,
      currentVideo: null,
      progress: '0/0',
      retries: Math.max(0, Number(existingRetries) || 0),
      logs: [],
      startedAt: Date.now(),
      results: null,
      remainingVideos: [...videos], // Track remaining videos for crash recovery
      browserType,
      cdpPort: null,
      cdpEndpoint: null,
    };

    // Create worker thread
    const worker = new Worker(WORKER_PATH);

    worker.on('message', (msg) => {
      const msgProfileKey = typeof msg.profileId === 'string' && msg.profileId
        ? msg.profileId
        : profileId;
      const stateLookupKey = msg.type === 'profile_rebinding'
        ? (msg.oldProfileId || profileId)
        : msgProfileKey;
      let state = this.workers.get(stateLookupKey);
      if (!state && msgProfileKey !== stateLookupKey) {
        state = this.workers.get(msgProfileKey);
      }
      if (!state && stateLookupKey !== profileId) {
        state = this.workers.get(profileId);
      }
      if (!state) return;

      const emitProfileId = (typeof msg.profileId === 'string' && msg.profileId)
        ? msg.profileId
        : (state.currentProfileId || profileId);
      switch (msg.type) {
        case 'profile_rebinding': {
          const oldPid = msg.oldProfileId || profileId;
          const newPid = msg.profileId;
          if (!newPid || oldPid === newPid) break;
          this.workers.delete(oldPid);
          state.currentProfileId = newPid;
          this.workers.set(newPid, state);
          console.log(`[Orchestrator] Profile rebind ${oldPid.slice(-4)} → ${newPid.slice(-4)}`);
          break;
        }
        case 'status':
          state.status = msg.status;
          if (msg.currentVideo) state.currentVideo = msg.currentVideo;
          if (msg.progress) {
            state.progress = msg.progress;
            // IMPORTANT: progress is emitted when a video STARTS, not when it completes.
            // Do not slice remainingVideos here or a crash during the current video will
            // skip it on retry. remainingVideos is advanced only on `video_done`.
          }
          break;
        case 'cdp_ready':
          if (msg.cdpPort) state.cdpPort = msg.cdpPort;
          if (msg.cdpEndpoint) state.cdpEndpoint = msg.cdpEndpoint;
          break;
        case 'log':
          state.logs.push({ time: msg.time, level: msg.level, message: msg.message });
          if (state.logs.length > 50) state.logs = state.logs.slice(-50);
          if (this.onActivityLog) {
            this.onActivityLog({
              level: msg.level,
              message: msg.message,
              profileId: emitProfileId,
              profileName: state.profileName,
              source: 'worker',
              timestamp: msg.time ? parseLogTime(msg.time) : Date.now(),
            });
          }
          break;
        case 'signin_required':
          // 24/7 worker detected sign-in wall — notify recycle manager to recreate immediately.
          // Mark as done so the subsequent 'done' message doesn't re-trigger onWorkerFinished.
          if (!state.finishNotified) {
            state.finishNotified = true;
            state.status = 'done';
            if (this.onWorkerSignInRequired) this.onWorkerSignInRequired(emitProfileId);
          }
          break;
        case 'backlink_used':
          if (msg.backlinkId && this.onBacklinkUsed) {
            this.onBacklinkUsed([msg.backlinkId]);
          }
          break;
        case 'window_connected':
          this._scheduleArrangeAll();
          break;
        case 'done':
          state.status = 'done';
          state.results = msg.results;
          if (!state.finishNotified) {
            state.finishNotified = true;
            if (this.onWorkerDone) this.onWorkerDone(emitProfileId);
            const watched = msg.results?.watched ?? 0;
            const failed = msg.results?.failed ?? 0;
            if (this.onWorkerFinished) {
              this.onWorkerFinished(emitProfileId, {
                success: watched > 0,
                status: watched > 0 ? 'done' : 'no_watch',
                watched,
                failed,
              });
            }
          }
          break;
        case 'video_done':
          if (typeof msg.videoIndex === 'number' && state.remainingVideos) {
            state.remainingVideos = state.remainingVideos.slice(
              Math.min(msg.videoIndex + 1, state.remainingVideos.length),
            );
          }
          break;
        case 'error':
          state.status = 'error';
          state.logs.push({ time: new Date().toISOString(), level: 'error', message: msg.error });
          if (this.onActivityLog) {
            this.onActivityLog({
              level: 'error',
              message: String(msg.error || 'Worker error'),
              profileId: emitProfileId,
              profileName: state.profileName,
              source: 'worker',
            });
          }
          // Auto-restart on error — resume from REMAINING videos (not original array)
          if (state.retries < this.maxRetries) {
            state.retries++;
            // remainingVideos is already correctly maintained by the progress handler (H-2 fix).
            // On crash, state.results is null (only set on 'done'), so we NEVER use results.watched.
            // Instead we rely on remainingVideos which was updated live as videos were watched.
            const remainingVideos = (state.remainingVideos && state.remainingVideos.length > 0)
              ? state.remainingVideos
              : videos; // Fallback to full list only if remainingVideos is empty/undefined
            state.remainingVideos = remainingVideos; // Keep in sync for next potential crash
            const curId = state.currentProfileId || profileId;
            console.log(`[Orchestrator] Worker ${curId.slice(-4)} crashed — restarting with ${remainingVideos.length} remaining videos (${state.retries}/${this.maxRetries})`);
            setTimeout(() => {
              this.startWorker(curId, profileName, remainingVideos, config, 3000, state.retries);
            }, 5000);
          } else {
            console.log(`[Orchestrator] Worker ${(state.currentProfileId || profileId).slice(-4)} — max retries reached, giving up`);
            state.status = 'crashed';
            if (this.onWorkerFinished) this.onWorkerFinished(emitProfileId, { success: false, status: 'crashed' });
          }
          break;
      }
    });

    worker.on('error', (err) => {
      const state = this._workerStateByThread(worker);
      if (!state) return;
      const curId = state.currentProfileId || profileId;
      console.error(`[Orchestrator] Worker ${curId.slice(-4)} error:`, err.message);
      state.status = 'error';
      state.logs.push({ time: new Date().toISOString(), level: 'error', message: `Worker crashed: ${err.message}` });
      if (this.onActivityLog) {
        this.onActivityLog({
          level: 'error',
          message: `Worker crashed: ${err.message}`,
          profileId: curId,
          profileName: state.profileName,
          source: 'worker',
        });
      }
      if (state.retries < this.maxRetries) {
        state.retries++;
        const remainingVideos = (state.remainingVideos && state.remainingVideos.length > 0)
          ? state.remainingVideos
          : videos;
        state.remainingVideos = remainingVideos;
        console.log(`[Orchestrator] Worker ${curId.slice(-4)} thread error — restarting with ${remainingVideos.length} remaining videos (${state.retries}/${this.maxRetries})`);
        setTimeout(() => {
          this.startWorker(curId, profileName, remainingVideos, config, 3000, state.retries);
        }, 5000);
      } else {
        state.status = 'crashed';
        console.log(`[Orchestrator] Worker ${curId.slice(-4)} — max retries reached after thread crash`);
        if (this.onWorkerFinished) this.onWorkerFinished(curId, { success: false, status: 'crashed' });
      }
    });

    worker.on('exit', (code) => {
      const state = this._workerStateByThread(worker);
      const curId = state?.currentProfileId || profileId;
      if (state && state.status !== 'done') {
        state.status = code === 0 ? 'done' : 'crashed';
      }
      console.log(`[Orchestrator] Worker ${curId.slice(-4)} exited with code ${code}`);
    });

    workerState.worker = worker;
    this.workers.set(profileId, workerState);

    // Send start message to worker
    worker.postMessage({
      type: 'start',
      profileId,
      profileName,
      videos,
      config: { ...config, browserType },
      startDelay,
    });

    console.log(`[Orchestrator] Worker spawned for "${profileName}" (${profileId.slice(-4)})`);
    return true;
  }

  /**
   * Stop a specific worker
   */
  stopWorker(profileId) {
    let state = this.workers.get(profileId);
    let mapKey = profileId;
    if (!state) {
      for (const [id, st] of this.workers.entries()) {
        if (st.currentProfileId === profileId) {
          state = st;
          mapKey = id;
          break;
        }
      }
    }
    if (!state || !state.worker) return false;

    const livePid = state.currentProfileId || profileId;

    try {
      state.worker.postMessage({ type: 'stop', profileId: livePid, browserType: state.browserType, cdpPort: state.cdpPort });
      setTimeout(() => {
        try { state.worker.terminate(); } catch {}
      }, 3000);
    } catch {}

    state.status = 'stopped';
    console.log(`[Orchestrator] Worker ${livePid.slice(-4)} stopped`);
    return true;
  }

  /**
   * Stop all workers
   */
  stopAll() {
    if (this._arrangeTimer) {
      clearTimeout(this._arrangeTimer);
      this._arrangeTimer = null;
    }
    for (const [profileId] of this.workers) {
      this.stopWorker(profileId);
    }
    console.log('[Orchestrator] All workers stopped');
  }

  /**
   * Get status of all workers
   */
  getAllStatuses() {
    const statuses = [];
    for (const [profileId, state] of this.workers) {
      statuses.push({
        profileId,
        status: state.status,
        currentVideo: state.currentVideo,
        progress: state.progress,
        retries: state.retries,
        logs: state.logs.slice(-10),
        results: state.results,
        uptime: Date.now() - state.startedAt,
        cdpPort: state.cdpPort || null,
      });
    }
    return statuses;
  }

  /**
   * Get status of single worker
   */
  getWorkerStatus(profileId) {
    const state = this.workers.get(profileId);
    if (!state) return null;
    return {
      profileId,
      status: state.status,
      currentVideo: state.currentVideo,
      progress: state.progress,
      retries: state.retries,
      logs: state.logs.slice(-20),
      results: state.results,
      uptime: Date.now() - state.startedAt,
      cdpPort: state.cdpPort || null,
    };
  }

  /**
   * Get summary stats
   */
  getStats() {
    let running = 0, done = 0, error = 0, waiting = 0;
    for (const [, state] of this.workers) {
      if (state.status === 'running' || state.status === 'watching') running++;
      else if (state.status === 'done') done++;
      else if (state.status === 'error' || state.status === 'crashed') error++;
      else waiting++;
    }
    return { total: this.workers.size, running, done, error, waiting };
  }

  /** Stats for a subset of profile IDs (schedule-scoped progress). */
  getStatsForProfiles(profileIds) {
    const idSet = new Set((profileIds || []).map(String));
    let running = 0, done = 0, error = 0, waiting = 0, total = 0;
    for (const [profileId, state] of this.workers) {
      if (!idSet.has(profileId)) continue;
      total++;
      if (state.status === 'running' || state.status === 'watching') running++;
      else if (state.status === 'done') done++;
      else if (state.status === 'error' || state.status === 'crashed') error++;
      else waiting++;
    }
    return { total, running, done, error, waiting };
  }

  /**
   * Run a schedule — spawn workers for all profiles
   */
  runSchedule(schedule) {
    const { selectedProfiles, perProfile, sameForAll, assignmentMode, profileDelayMin, profileDelayMax, tabDelayMin, tabDelayMax } = schedule;

    console.log(`\n━━━ [Orchestrator] Running Schedule: ${schedule.name} ━━━`);
    console.log(`   Profiles: ${selectedProfiles.length} | Mode: ${assignmentMode}`);

    const mlxMaxConcurrent = Math.max(1, parseInt(process.env.MULTILOGIN_MAX_CONCURRENT || '3', 10) || 3);
    const mlxBatchGapMs = Math.max(15000, parseInt(process.env.MULTILOGIN_BATCH_GAP_MS || '45000', 10) || 45000);
    let spawned = 0;
    let skippedNoVideos = 0;

    for (let i = 0; i < selectedProfiles.length; i++) {
      const profileId = selectedProfiles[i];
      const profileName = `Profile-${profileId.slice(-4)}`;

      // Get videos for this profile
      let videos = [];
      if (assignmentMode === 'same-all') {
        for (const cs of (sameForAll || [])) {
          for (const v of (cs.videos || [])) {
            videos.push({ ...v, channelName: cs.channelName || '' });
          }
        }
      } else {
        const pa = (perProfile || []).find(p => p.profileId === profileId);
        if (pa) {
          for (const cs of (pa.channelSelections || [])) {
            for (const v of (cs.videos || [])) {
              videos.push({ ...v, channelName: cs.channelName || '' });
            }
          }
        }
      }

      // Config from profile settings (passed from frontend) — single source via agentBrain
      const profileConfig = (schedule.profileConfigs || []).find(pc => pc.profileId === profileId);
      const browserType = normalizeScheduleBrowserProvider(profileConfig?.browserType);
      const { buildAgentConfig, validateProfileConfig } = require('./agentBrain.cjs');
      const config = buildAgentConfig(profileConfig || {}, {
        profileDelayMin,
        profileDelayMax,
        tabDelayMin,
        tabDelayMax,
        commentText: schedule.commentText || '',
      });
      config.browserType = browserType;
      config._isRecycleRun = !!schedule._recycleSlotId;

      const validation = validateProfileConfig(config);
      if (!validation.ok) {
        console.warn(`[Orchestrator] ${profileName} config warnings: ${validation.errors.join('; ')}`);
      }

      if (schedule.trafficType === 'backlink') {
        config.trafficPreference = 'backlink';
      }

      if (!videos.length) {
        skippedNoVideos++;
        console.log(`[Orchestrator] Skip ${profileName} — no videos in schedule payload`);
        continue;
      }

      // Staggered start: profile Settings startDelay overrides schedule delay when set
      const delayMinSec = config.startDelayMin ?? profileDelayMin ?? 5;
      const delayMaxSec = config.startDelayMax ?? profileDelayMax ?? 20;
      let delay = randomDelay(delayMinSec * 1000, delayMaxSec * 1000) + (i * 3000);

      // Multilogin: most plans allow ~3 concurrent browsers — batch starts to avoid silent launcher failures
      if (browserType === 'multilogin') {
        const batch = Math.floor(spawned / mlxMaxConcurrent);
        delay += batch * mlxBatchGapMs;
        if (spawned > 0 && spawned % mlxMaxConcurrent === 0) {
          console.log(`[Orchestrator] Multilogin batch ${batch + 1} — ${mlxMaxConcurrent} profiles per wave (${mlxBatchGapMs / 1000}s gap)`);
        }
      }

      this.startWorker(profileId, profileName, videos, config, delay);
      spawned++;
    }

    return {
      success: true,
      workersSpawned: spawned,
      skippedNoVideos,
      multiloginBatchSize: mlxMaxConcurrent,
    };
  }
}

function randomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function parseLogTime(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

module.exports = { Orchestrator };
