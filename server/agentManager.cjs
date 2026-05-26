'use strict';

/**
 * AgentManager — MMB YT AGENT 24/7 lifecycle with queue + RAM-aware load balancing
 *
 * Naming: MMB YT AGENT 01, 02...
 * Launch gap: 10-15 seconds
 * Cooldown: 60s (configurable)
 * Queue: up to maxTotalAgents registered; active limited by RAM
 */

const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { ProfileFactory } = require('./profileFactory.cjs');
const { HealthMonitor } = require('./healthMonitor.cjs');
const { assignVideosToAgents } = require('./scheduleEngine.cjs');

const WORKER_PATH = path.join(__dirname, 'agentWorker.cjs');
const STATES_FILE = path.resolve(__dirname, '..', 'agent_states.json');
const LAUNCH_GAP_MIN = 10000;
const LAUNCH_GAP_MAX = 15000;
const COOLDOWN_MS_DEFAULT = 60000;
const MAX_CREATE_RETRIES = 3;
const QUEUE_POLL_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function padNum(n) { return String(n).padStart(2, '0'); }

class AgentManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.agents = new Map();
    this.queue = [];
    this.factory = new ProfileFactory({ proxyType: options.proxyType || 'smartproxy' });
    this.health = new HealthMonitor(options.health || {});
    this.logs = [];
    this.maxLogs = 2000;
    this.autoRebirth = true;
    this._slotCounter = 0;
    this._launchQueue = Promise.resolve();
    this._queueTimer = null;
    this.settings = {
      maxTotalAgents: options.maxTotalAgents ?? 40,
      cooldownMs: options.cooldownMs ?? COOLDOWN_MS_DEFAULT,
      videosMin: options.videosMin ?? 3,
      videosMax: options.videosMax ?? 7,
      launchGapMin: options.launchGapMin ?? LAUNCH_GAP_MIN,
      launchGapMax: options.launchGapMax ?? LAUNCH_GAP_MAX,
      proxyType: options.proxyType || 'smartproxy',
      sessionSettings: options.sessionSettings || {},
    };
    this.factory.setProxyType(this.settings.proxyType);
    this.health.startSnapshots();
    this._loadStates();
    this._startQueueProcessor();
  }

  updateSettings(partial) {
    Object.assign(this.settings, partial);
    if (partial.proxyType) this.factory.setProxyType(partial.proxyType);
    this._saveStates();
  }

  getActiveCount() {
    let n = 0;
    for (const s of this.agents.values()) {
      if (['creating', 'running', 'starting'].includes(s.status)) n++;
    }
    return n;
  }

  /**
   * Start N agents — registers in queue, launches as RAM allows
   */
  async startAgents(count, overrideSettings = {}) {
    const settings = { ...this.settings.sessionSettings, ...overrideSettings };
    const totalRegistered = this.agents.size + this.queue.length;
    const toAdd = Math.min(count, this.settings.maxTotalAgents - totalRegistered);

    if (toAdd <= 0) {
      throw new Error(`Max total agents (${this.settings.maxTotalAgents}) reached`);
    }

    const newNames = [];
    for (let i = 0; i < toAdd; i++) {
      const slotNum = ++this._slotCounter;
      newNames.push(`MMB YT AGENT ${padNum(slotNum)}`);
    }

    const assignments = assignVideosToAgents(newNames, {
      videosMin: this.settings.videosMin,
      videosMax: this.settings.videosMax,
    });

    for (const a of assignments) {
      const agentId = `yt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      this.queue.push({
        agentId,
        agentName: a.agentName,
        videos: a.videos,
        settings,
        queuedAt: Date.now(),
      });
      this._log('info', `Queued ${a.agentName} (${a.videos.length} videos)`);
    }

    this._saveStates();
    this._processQueue();
    return { queued: toAdd, queueLength: this.queue.length };
  }

  _startQueueProcessor() {
    if (this._queueTimer) return;
    this._queueTimer = setInterval(() => this._processQueue(), QUEUE_POLL_MS);
  }

  async _processQueue() {
    if (!this.queue.length) return;

    const check = this.health.canLaunchNewAgent(this.getActiveCount());
    if (!check.allowed) return;

    const item = this.queue.shift();
    if (!item) return;

    this._launchQueue = this._launchQueue.then(async () => {
      const gap = randomDelay(this.settings.launchGapMin, this.settings.launchGapMax);
      if (this.getActiveCount() > 0) {
        this._log('info', `Waiting ${Math.round(gap / 1000)}s before launching ${item.agentName}...`);
        await sleep(gap);
      }
      await this._startAgent(item.agentId, item.agentName, item.videos, item.settings);
      this._saveStates();
      setTimeout(() => this._processQueue(), 500);
    });
  }

  async stopAgent(agentId) {
    const state = this.agents.get(agentId);
    if (!state) return;

    state.autoRebirth = false;
    state.status = 'stopping';

    if (state.process && !state.process.killed) {
      state.process.kill('SIGTERM');
      await sleep(3000);
      if (!state.process.killed) state.process.kill('SIGKILL');
    }

    if (state.profileId) {
      await this.factory.stopAndDelete(state.profileId).catch(() => {});
    }

    state.status = 'stopped';
    this._log('info', `${state.agentName} stopped`);
    this.emit('agentStopped', agentId);
    this._saveStates();
  }

  async stopAll() {
    this.autoRebirth = false;
    this.queue = [];
    const ids = [...this.agents.keys()];
    await Promise.allSettled(ids.map(id => this.stopAgent(id)));
    this._log('info', 'All YT agents stopped');
    this._saveStates();
  }

  getStatus() {
    const health = this.health.getStatus(this.getActiveCount(), this.queue.length);
    const agents = {};
    for (const [id, s] of this.agents) {
      agents[id] = {
        agentId: id,
        agentName: s.agentName,
        status: s.status,
        profileId: s.profileId,
        cdpPort: s.cdpPort,
        videosWatched: s.videosWatched,
        totalVideos: s.totalVideos,
        currentVideo: s.currentVideo,
        watchPercent: s.watchPercent,
        startedAt: s.startedAt,
        cycle: s.cycle,
        cooldownUntil: s.cooldownUntil,
      };
    }
    return { agents, queue: this.queue.map(q => ({ agentId: q.agentId, agentName: q.agentName, videos: q.videos.length })), health };
  }

  getLogs() { return [...this.logs]; }

  async _startAgent(agentId, agentName, videos, settings) {
    const state = {
      agentId,
      agentName,
      status: 'creating',
      profileId: null,
      cdpPort: null,
      videosWatched: 0,
      totalVideos: videos.length,
      currentVideo: '',
      watchPercent: 0,
      startedAt: Date.now(),
      cycle: (this.agents.get(agentId)?.cycle || 0) + 1,
      cooldownUntil: null,
      autoRebirth: this.autoRebirth,
      videos,
      settings,
      process: null,
    };
    this.agents.set(agentId, state);
    this.emit('agentStatus', agentId, state);

    let profileData = null;
    for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
      try {
        this._log('info', `${agentName} — creating profile (${attempt}/${MAX_CREATE_RETRIES})...`);
        profileData = await this.factory.createAndStart(agentName);
        break;
      } catch (err) {
        this._log('error', `${agentName} — create failed: ${err.message}`);
        if (attempt < MAX_CREATE_RETRIES) await sleep(5000);
      }
    }

    if (!profileData) {
      state.status = 'error';
      if (this.health.recordFailure()) this.emit('circuitOpen');
      this.emit('agentError', agentId, 'Profile creation failed');
      if (state.autoRebirth) this._scheduleRebirth(agentId, agentName, videos, settings);
      return;
    }

    state.profileId = profileData.profileId;
    state.cdpPort = profileData.cdpPort;
    state.status = 'running';
    await this._forkWorker(agentId, profileData);
  }

  async _forkWorker(agentId, profileData) {
    const state = this.agents.get(agentId);
    if (!state) return;

    const envVars = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      MULTILOGIN_TOKEN: process.env.MULTILOGIN_TOKEN || '',
      MULTILOGIN_FOLDER_ID: process.env.MULTILOGIN_FOLDER_ID || '',
      PROXY_SERVER: process.env.PROXY_SERVER || '',
      PROXY_PORT: process.env.PROXY_PORT || '',
      PROXY_PREFIX: process.env.PROXY_PREFIX || '',
      PROXY_PASSWORD: process.env.PROXY_PASSWORD || '',
    };

    const child = fork(WORKER_PATH, [], {
      env: { ...process.env, ...envVars },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    state.process = child;

    child.on('message', (msg) => this._handleWorkerMessage(agentId, msg));
    child.stdout?.on('data', (d) => {
      const txt = d.toString().trim();
      if (txt) this._log('info', `[${state.agentName}] ${txt}`);
    });
    child.stderr?.on('data', (d) => {
      const txt = d.toString().trim();
      if (txt) this._log('error', `[${state.agentName}] ${txt}`);
    });

    child.on('exit', () => {
      const s = this.agents.get(agentId);
      if (s && s.status === 'running') {
        s.status = 'error';
        this._handleAgentComplete(agentId);
      }
    });

    child.send({
      type: 'start',
      agentId,
      agentName: state.agentName,
      profileId: profileData.profileId,
      cdpPort: profileData.cdpPort,
      cdpEndpoint: profileData.cdpEndpoint,
      videos: state.videos,
      settings: state.settings,
      envVars,
    });
  }

  _handleWorkerMessage(agentId, msg) {
    const state = this.agents.get(agentId);
    if (!state) return;

    switch (msg.type) {
      case 'progress':
        state.videosWatched = (msg.videoIndex || 0) + 1;
        state.totalVideos = msg.totalVideos || state.totalVideos;
        state.currentVideo = msg.title || '';
        this.emit('agentProgress', agentId, state);
        break;

      case 'video_done':
        this.emit('videoDone', { agentName: state.agentName, videoId: msg.videoId, videoTitle: msg.videoTitle });
        break;

      case 'done':
        state.videosWatched = msg.videosWatched || state.videosWatched;
        state.status = 'completed';
        this.health.recordSuccess();
        this._log('success', `${state.agentName} — session done (${state.videosWatched} videos)`);
        this.emit('agentDone', agentId, msg);
        this._handleAgentComplete(agentId);
        break;

      case 'error':
        state.status = 'error';
        if (this.health.recordFailure()) this.emit('circuitOpen');
        this._log('error', `${state.agentName} — ${msg.error}`);
        this.emit('agentError', agentId, msg.error);
        this._handleAgentComplete(agentId);
        break;

      case 'log':
        this._log(msg.level || 'info', `[${state.agentName}] ${msg.message}`);
        break;
    }
    this.emit('agentStatus', agentId, state);
  }

  async _handleAgentComplete(agentId) {
    const state = this.agents.get(agentId);
    if (!state) return;

    if (state.profileId) {
      await this.factory.stopAndDelete(state.profileId).catch(() => {});
      state.profileId = null;
    }

    if (!state.autoRebirth) {
      state.status = 'stopped';
      this._saveStates();
      return;
    }

    this._scheduleRebirth(agentId, state.agentName, state.videos, state.settings);
  }

  _scheduleRebirth(agentId, agentName, videos, settings) {
    const state = this.agents.get(agentId);
    if (!state) return;

    state.status = 'cooldown';
    state.cooldownUntil = Date.now() + this.settings.cooldownMs;
    this._log('info', `${agentName} — cooldown ${this.settings.cooldownMs / 1000}s`);
    this._saveStates();

    setTimeout(async () => {
      if (!state.autoRebirth) return;
      state.cooldownUntil = null;
      const fresh = assignVideosToAgents([agentName], {
        videosMin: this.settings.videosMin,
        videosMax: this.settings.videosMax,
      });
      state.videos = fresh[0]?.videos || videos;
      state.totalVideos = state.videos.length;
      state.videosWatched = 0;
      this._log('info', `${agentName} — reborn (cycle ${state.cycle + 1})`);
      this.queue.unshift({
        agentId,
        agentName,
        videos: state.videos,
        settings,
        queuedAt: Date.now(),
      });
      this._saveStates();
      this._processQueue();
    }, this.settings.cooldownMs);
  }

  _loadStates() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
      if (raw.settings) Object.assign(this.settings, raw.settings);
      this._slotCounter = raw.slotCounter || 0;
      this.autoRebirth = raw.autoRebirth !== false;
    } catch { /* fresh start */ }
  }

  _saveStates() {
    try {
      fs.writeFileSync(STATES_FILE, JSON.stringify({
        settings: this.settings,
        slotCounter: this._slotCounter,
        autoRebirth: this.autoRebirth,
        queueLength: this.queue.length,
        agentCount: this.agents.size,
        savedAt: Date.now(),
      }, null, 2));
    } catch (err) {
      console.warn('[AgentManager] State save failed:', err.message);
    }
  }

  _log(level, message) {
    const entry = { level, message, ts: Date.now() };
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) this.logs.pop();
    console.log(`[YtAgentMgr:${level.toUpperCase()}] ${message}`);
    this.emit('log', entry);
  }
}

const agentManager = new AgentManager();
module.exports = { AgentManager, agentManager };
