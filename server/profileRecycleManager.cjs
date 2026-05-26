'use strict';

/**
 * ProfileRecycleManager — 24/7 per-profile loop:
 * run → complete → cooldown → recreate → shuffle → run
 */

const fs = require('fs');
const path = require('path');
const RecreateHandler = require('./services/RecreateHandler.cjs');
const { assignOneProfile, buildRecycleSchedule } = require('./shuffleEngine.cjs');
const appDataStore = require('./appDataStore.cjs');
const gmailLoginManager = require('./gmailLoginManager.cjs');
const { atomicWriteJson } = require('./analyticsStore.cjs');

const RECYCLE_FILE = path.resolve(__dirname, '..', 'recycle_state.json');
const QUEUE_POLL_MS = 5000;
const ERROR_RETRY_MS = 5 * 60 * 1000;
const LOCKED_GMAIL_STATUSES = new Set(['blocked', 'needs_phone', 'captcha', 'wrong_password']);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class ProfileRecycleManager {
  /**
   * @param {object} deps
   * @param {import('./orchestrator.cjs').Orchestrator} deps.orchestrator
   * @param {() => number} deps.getMaxConcurrent
   * @param {() => number} deps.getRunningCount
   * @param {Map} deps.runningSchedules
   * @param {() => object} deps.getWatchHistory
   * @param {() => object} deps.loadShuffleFile
   * @param {object} deps.activityLog
   * @param {object} deps.notificationService
   * @param {() => object} deps.loadAppSettings
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, object>} */
    this.slots = new Map();
    /** @type {Map<string, string>} profileId → slotId */
    this.profileToSlot = new Map();
    this.enabled = false;
    this.cooldownMinMs = 10 * 60 * 1000;
    this.cooldownMaxMs = 30 * 60 * 1000;
    this.maxErrorRetries = 3;
    /** @type {Map<string, NodeJS.Timeout>} */
    this._timers = new Map();
    this._queueTimer = null;
    /** Reserved video IDs for active/queued 24/7 assignments in this process. */
    this._reservedVideoIds = new Set();
    this._loadState();
    this._startQueueProcessor();
  }

  _loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(RECYCLE_FILE, 'utf8'));
      this.enabled = !!raw.enabled;
      this.cooldownMinMs = raw.cooldownMinMs || this.cooldownMinMs;
      this.cooldownMaxMs = raw.cooldownMaxMs || this.cooldownMaxMs;
      if (Array.isArray(raw.slots)) {
        for (const s of raw.slots) {
          if (!s.slotId && !s.currentProfileId) continue;
          // Migration: older recycle_state used profileName as slotId, which collides
          // when two profiles have the same name. New slotId is always currentProfileId.
          const slotId = String(s.currentProfileId || s.slotId);
          const migratedStatus = s.isPaused || s.status === 'paused'
            ? 'paused'
            : (s.enabled === false ? 'stopped' : (s.status || 'idle'));
          const slot = {
            ...s,
            slotId,
            status: migratedStatus,
            cooldownUntil: migratedStatus === 'paused' ? null : (s.cooldownUntil || null),
            isPaused: migratedStatus === 'paused' || !!s.isPaused,
          };
          this.slots.set(slotId, slot);
          if (slot.currentProfileId) this.profileToSlot.set(slot.currentProfileId, slotId);
        }
      }
      if (this.enabled) {
        for (const slot of this.slots.values()) {
          if (slot.status === 'paused') {
            slot.isPaused = true;
            slot.cooldownUntil = null;
            continue;
          }
          if (slot.status === 'error' && slot.enabled !== false) {
            this._log('info', `${slot.profileName} — recovering from error on startup`);
            slot.errorRetries = 0;
            slot.lastError = null;
            slot.status = 'recreating';
            setTimeout(() => {
              this._afterCooldown(slot.slotId).catch((err) => {
                this._log('error', `Startup recovery failed: ${err.message}`);
              });
            }, 3000);
          } else if (slot.status === 'cooldown' && slot.cooldownUntil > Date.now()) {
            this._scheduleCooldown(slot.slotId, slot.cooldownUntil - Date.now());
          } else if (slot.status === 'cooldown') {
            if (this._isWorkerActive(slot.currentProfileId)) {
              slot.status = 'running';
              this._saveState();
              this._log('warn', `${slot.profileName} — worker still active, keeping slot running`);
            } else {
              slot.status = 'idle';
              this._afterCooldown(slot.slotId).catch(() => {});
            }
          } else if (slot.status === 'running') {
            if (!this._isWorkerActive(slot.currentProfileId)) {
              slot.status = 'idle';
              this._saveState();
              this._tryRunSlot(slot).catch(() => {});
            }
          } else if (['idle', 'queued'].includes(slot.status)) {
            if (this._isWorkerActive(slot.currentProfileId)) {
              slot.status = 'running';
              this._saveState();
            } else {
              this._tryRunSlot(slot).catch(() => {});
            }
          }
        }
      }
    } catch {
      /* fresh start */
    }
  }

  _saveState() {
    try {
      const payload = {
        enabled: this.enabled,
        cooldownMinMs: this.cooldownMinMs,
        cooldownMaxMs: this.cooldownMaxMs,
        savedAt: Date.now(),
        slots: [...this.slots.values()].map((s) => ({
          slotId: s.slotId,
          profileName: s.profileName,
          currentProfileId: s.currentProfileId,
          browserType: s.browserType,
          os: s.os,
          proxyType: s.proxyType,
          status: s.status,
          cycleCount: s.cycleCount || 0,
          cooldownUntil: s.cooldownUntil || null,
          lastError: s.lastError || null,
          errorRetries: s.errorRetries || 0,
          enabled: s.enabled !== false,
          isPaused: s.isPaused || false,
        })),
      };
      atomicWriteJson(RECYCLE_FILE, payload);
    } catch (err) {
      console.error('[Recycle] Failed to save state:', err.message);
    }
  }

  _log(level, message) {
    console.log(`[Recycle] ${message}`);
    this.deps.activityLog.append({
      level: level === 'error' ? 'error' : level === 'success' ? 'success' : 'info',
      source: 'shuffle',
      message: `[24/7] ${message}`,
    });
  }

  _startQueueProcessor() {
    if (this._queueTimer) return;
    this._queueTimer = setInterval(() => {
      if (!this.enabled) return;
      for (const slot of this.slots.values()) {
        if (slot.enabled === false || slot.status === 'paused' || slot.isPaused) continue;
        if (slot.status === 'error') {
          this._recoverErrorSlot(slot).catch(() => {});
        } else if (slot.status === 'queued' || slot.status === 'idle') {
          this._tryRunSlot(slot).catch(() => {});
        } else if (slot.status === 'running') {
          // BUG FIX: worker may have died without triggering onWorkerFinished
          // (crash, CDP drop, process kill). Detect stale 'running' slots and recover.
          if (!this._isWorkerActive(slot.currentProfileId)) {
            this._log('warn', `${slot.profileName} — stale 'running' slot detected (worker gone), forcing cooldown`);
            slot.errorRetries = (slot.errorRetries || 0) + 1;
            slot.lastError = 'Worker died silently';
            slot.status = 'cooldown';
            // Use user's configured cooldown (not hardcoded 5 min) so 1-min setting is respected
            const silentDeathCooldown = this.cooldownMinMs || ERROR_RETRY_MS;
            slot.cooldownUntil = Date.now() + silentDeathCooldown;
            this._saveState();
            this._scheduleCooldown(slot.slotId, silentDeathCooldown);
          }
        }
      }
    }, QUEUE_POLL_MS);
  }

  async _recoverErrorSlot(slot) {
    if (!this.enabled || slot.enabled === false || slot.status !== 'error') return;
    if (this._timers.has(`recover_${slot.slotId}`)) return;
    this._log('warn', `${slot.profileName} — auto-recovering via profile recreate`);
    slot.errorRetries = 0;
    slot.lastError = null;
    slot.status = 'recreating';
    slot.cooldownUntil = null;
    this._saveState();
    const timer = setTimeout(() => {
      this._timers.delete(`recover_${slot.slotId}`);
      this._afterCooldown(slot.slotId).catch((err) => {
        slot.status = 'error';
        slot.lastError = err.message;
        this._saveState();
        this._log('error', `${slot.profileName} auto-recover failed: ${err.message}`);
      });
    }, 2000);
    this._timers.set(`recover_${slot.slotId}`, timer);
  }

  _allProfileIds() {
    return [...this.slots.values()]
      .filter((s) => s.enabled !== false)
      .map((s) => s.currentProfileId)
      .filter(Boolean);
  }

  _assignmentVideoIds(slot) {
    return (slot?.assignment?.videos || []).map((v) => v.videoId).filter(Boolean);
  }

  _releaseAssignment(slot) {
    for (const vid of this._assignmentVideoIds(slot)) {
      this._reservedVideoIds.delete(vid);
    }
  }

  _reserveAssignment(slot) {
    for (const vid of this._assignmentVideoIds(slot)) {
      this._reservedVideoIds.add(vid);
    }
  }

  _rebuildReservations() {
    this._reservedVideoIds.clear();
    for (const s of this.slots.values()) {
      if (s.enabled !== false && ['queued', 'idle', 'running', 'recreating'].includes(s.status)) {
        this._reserveAssignment(s);
      }
    }
  }

  _shuffleForSlot(slot) {
    this._releaseAssignment(slot);
    this._rebuildReservations();
    const shuffleFile = this.deps.loadShuffleFile();
    const watchHistory = this.deps.getWatchHistory();
    const usedInThisRun = new Set(this._reservedVideoIds);
    const result = assignOneProfile({
      profileId: slot.currentProfileId,
      profileName: slot.profileName,
      shuffleFile,
      watchHistory,
      allProfileIds: this._allProfileIds(),
      usedInThisRun,
    });
    slot.assignment = result;
    this._reserveAssignment(slot);
    if (result.videos?.length) {
      this._log('info', `${slot.profileName}: reserved ${result.videos.length} unique video(s) for this 24/7 batch`);
    }
    if (result.notices?.length) {
      this._log('info', `${slot.profileName}: ${result.notices.join('; ')}`);
    }
    return result;
  }

  _migrateProfileConfig(oldId, newId) {
    const cfg = appDataStore.getProfileConfig(oldId);
    if (cfg) {
      appDataStore.setProfileConfig(newId, { ...cfg, profileId: newId });
    }
  }

  _getProfileConfig(profileId) {
    return appDataStore.getProfileConfig(profileId) || {};
  }

  _getRecreateProtection(slot, reason = 'recreate') {
    const profileId = slot?.currentProfileId;
    if (!profileId) return null;
    const cfg = this._getProfileConfig(profileId);
    const protectedByConfig = cfg.sessionProtected === true
      || cfg.gmailProtected === true
      || cfg.doNotRecreate === true
      || cfg.recycleProtected === true;
    if (protectedByConfig) {
      return {
        kind: 'session_protected',
        message: `Profile protected by config (${reason}) — automatic recreate skipped`,
      };
    }
    const gmailStatus = gmailLoginManager.getProfileGmailStatus(profileId);
    if (gmailStatus && LOCKED_GMAIL_STATUSES.has(gmailStatus)) {
      return {
        kind: `gmail_${gmailStatus}`,
        message: `Gmail locked (${gmailStatus}) — fix Gmail first, then restart slot`,
      };
    }
    return null;
  }

  _markNeedsAttention(slot, message) {
    slot.status = 'needs_attention';
    slot.isPaused = true;
    slot.cooldownUntil = null;
    slot.lastError = message;
    this._stopOrchestratorWorker(slot.currentProfileId);
    this._saveState();
    this._log('error', `${slot.profileName} — ${message}`);
  }

  async start({ profiles, cooldownMinMinutes, cooldownMaxMinutes }) {
    if (!profiles?.length) throw new Error('No profiles selected');

    this.enabled = true;
    this.cooldownMinMs = Math.max(1, cooldownMinMinutes || 10) * 60 * 1000;
    this.cooldownMaxMs = Math.max(this.cooldownMinMs, (cooldownMaxMinutes || 30) * 60 * 1000);

    const selectedIds = new Set(profiles.map((p) => String(p.id)).filter(Boolean));

    // Disable/remove old slots that are not part of the new 24/7 selection.
    // This prevents previous-run profiles from continuing silently after user
    // restarts 24/7 with a smaller profile list.
    for (const [slotId, slot] of [...this.slots.entries()]) {
      if (!slot?.currentProfileId || selectedIds.has(String(slot.currentProfileId))) continue;
      this._log('info', `${slot.profileName} — removed from new 24/7 selection; stopping slot`);
      this._releaseAssignment(slot);
      this._stopSlot(slot, false);
      if (slotId !== slot.slotId) this.slots.delete(slotId);
    }

    for (const p of profiles) {
      const slotId = String(p.id); // profileId-based slot id avoids duplicate-name collisions
      const oldSlotId = this.profileToSlot.get(p.id);
      let existing = this.slots.get(slotId) || (oldSlotId ? this.slots.get(oldSlotId) : null);

      // Migration for an in-memory old slot keyed by profileName.
      if (existing && existing.slotId !== slotId) {
        this.slots.delete(existing.slotId);
        existing.slotId = slotId;
      }

      const wasRunning = existing?.status === 'running' || this._isWorkerActive(existing?.currentProfileId || p.id);
      const wasPaused = existing?.status === 'paused' || existing?.isPaused === true;
      const slot = {
        slotId,
        profileName: p.name || existing?.profileName || slotId,
        currentProfileId: p.id,
        browserType: p.browserType || existing?.browserType || 'multilogin',
        os: p.os || existing?.os || 'Windows',
        proxyType: p.proxyType || existing?.proxyType || 'smartproxy',
        status: wasRunning ? 'running' : (wasPaused ? 'paused' : 'idle'),
        cycleCount: existing?.cycleCount || 0,
        cooldownUntil: wasPaused ? null : (existing?.cooldownUntil || null),
        lastError: wasPaused ? (existing?.lastError || 'Paused by user') : null,
        errorRetries: 0,
        enabled: true,
        isPaused: wasPaused,
        assignment: wasRunning || wasPaused ? existing?.assignment : null,
        profileIdChangedAt: existing?.profileIdChangedAt || null,
      };
      this.slots.set(slotId, slot);
      this.profileToSlot.set(p.id, slotId);
    }

    this._saveState();
    this._log('success', `24/7 loop started for ${profiles.length} profile(s)`);

    for (const slot of this.slots.values()) {
      if (slot.enabled !== false && slot.status !== 'running' && slot.status !== 'paused' && !this._isWorkerActive(slot.currentProfileId)) {
        await this._tryRunSlot(slot);
      }
    }

    return this.getStatus();
  }

  stop({ slotId, profileId } = {}) {
    if (slotId) {
      const slot = this.slots.get(slotId);
      if (slot) this._stopSlot(slot);
    } else if (profileId) {
      const sid = this.profileToSlot.get(profileId);
      if (sid) this._stopSlot(this.slots.get(sid));
    } else {
      this.enabled = false;
      for (const slot of this.slots.values()) {
        this._stopSlot(slot, true);
      }
      this._log('info', '24/7 loop stopped for all profiles');
    }
    this._saveState();
    return this.getStatus();
  }

  _stopSlot(slot, keepInMap = false) {
    if (!slot) return;
    this._releaseAssignment(slot);
    slot.enabled = false;
    slot.status = 'stopped';
    const t = this._timers.get(slot.slotId);
    if (t) {
      clearTimeout(t);
      this._timers.delete(slot.slotId);
    }
    if (slot.currentProfileId) {
      this.deps.orchestrator.stopWorker(slot.currentProfileId);
    }
    if (!keepInMap) {
      this.profileToSlot.delete(slot.currentProfileId);
      this.slots.delete(slot.slotId);
    }
  }

  _scheduleCooldown(slotId, delayMs) {
    const existing = this._timers.get(slotId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this._timers.delete(slotId);
      const slot = this.slots.get(slotId);
      if (!slot || slot.status === 'paused' || slot.isPaused || slot.status !== 'cooldown') {
        this._log('warn', `Cooldown fired for ${slotId} but slot is ${slot?.status || 'missing'} — skipped`);
        return;
      }
      if (slot.cooldownUntil && slot.cooldownUntil > Date.now()) {
        const remain = slot.cooldownUntil - Date.now();
        this._log('info', `${slot.profileName} — cooldown not finished yet, rescheduling ${Math.round(remain / 1000)}s`);
        this._scheduleCooldown(slotId, remain);
        return;
      }
      this._afterCooldown(slotId).catch((err) => {
        this._log('error', `Cooldown handler failed: ${err.message}`);
      });
    }, Math.max(1000, delayMs));
    this._timers.set(slotId, timer);
  }

  _isWorkerActive(profileId) {
    if (!profileId) return false;
    const ws = this.deps.orchestrator.getWorkerStatus(profileId);
    if (!ws) return false;
    return ['running', 'watching', 'searching', 'starting', 'connecting', 'waiting'].includes(ws.status);
  }

  _stopOrchestratorWorker(profileId) {
    if (!profileId) return;
    try {
      this.deps.orchestrator.stopWorker(profileId);
    } catch { /* ignore */ }
  }

  onWorkerFinished(profileId, { success = true, status = 'done', watched = null } = {}) {
    if (!this.enabled) return;
    const slotId = this.profileToSlot.get(profileId);
    if (!slotId) return;
    const slot = this.slots.get(slotId);
    if (!slot) return;

    // Ignore stale finish from old profile ID after recreate
    if (slot.currentProfileId !== profileId) {
      this._log('warn', `${slot.profileName} — ignoring stale worker finish (${profileId.slice(-6)}), slot on ${slot.currentProfileId.slice(-6)}`);
      return;
    }
    if (slot.status !== 'running') {
      this._log('warn', `${slot.profileName} — worker finished but slot is ${slot.status}, ignoring`);
      return;
    }

    // Double-check orchestrator — don't cooldown while worker still active.
    // If worker status hasn't cleared yet (race condition: onWorkerFinished fires
    // before orchestrator.getWorkerStatus() reflects the done state), retry once
    // after 2 seconds rather than silently bailing out (which would leave the slot
    // stuck in 'running' forever).
    const ws = this.deps.orchestrator.getWorkerStatus(profileId);
    if (ws && ['running', 'watching', 'searching', 'starting', 'connecting', 'waiting'].includes(ws.status)) {
      this._log('warn', `${slot.profileName} — worker still ${ws.status}, retrying in 2s`);
      setTimeout(() => {
        // Re-enter onWorkerFinished only if slot is still 'running' for this profileId
        const s = this.slots.get(slotId);
        if (s && s.currentProfileId === profileId && s.status === 'running') {
          this.onWorkerFinished(profileId, { success, status, watched });
        }
      }, 2000);
      return;
    }

    const didWatch = watched != null ? watched > 0 : success;

    if (success && didWatch) {
      slot.cycleCount = (slot.cycleCount || 0) + 1;
      slot.errorRetries = 0;
      slot.lastError = null;
      const delay = randomBetween(this.cooldownMinMs, this.cooldownMaxMs);
      this._releaseAssignment(slot);
      slot.status = 'cooldown';
      slot.cooldownUntil = Date.now() + delay;
      slot.assignment = null;
      this._saveState();
      this._log('success', `${slot.profileName} cycle ${slot.cycleCount} done — cooldown ${Math.round(delay / 60000)}m`);
      this._scheduleCooldown(slotId, delay);
      this.deps.notificationService.info(
        '24/7 cycle complete',
        `"${slot.profileName}" finished — next run in ~${Math.round(delay / 60000)} min`,
      ).catch(() => {});
    } else if (success && !didWatch) {
      slot.errorRetries = (slot.errorRetries || 0) + 1;
      slot.lastError = 'No videos watched';
      const noWatchCooldown = this.cooldownMinMs;
      this._log('warn', `${slot.profileName} finished with 0 watched — quick retry (${slot.errorRetries}/${this.maxErrorRetries}), cooldown ${Math.round(noWatchCooldown / 60000)}m (user config)`);
      this._releaseAssignment(slot);
      slot.status = 'cooldown';
      slot.cooldownUntil = Date.now() + noWatchCooldown;
      this._saveState();
      this._scheduleCooldown(slotId, noWatchCooldown);
    } else {
      slot.errorRetries = (slot.errorRetries || 0) + 1;
      slot.lastError = `Worker ${status}`;
      this._log('error', `${slot.profileName} failed (${status}) — retry ${slot.errorRetries}/${this.maxErrorRetries}`);
      if (slot.errorRetries >= this.maxErrorRetries) {
        this._log('warn', `${slot.profileName} max failures — scheduling profile recreate`);
        slot.errorRetries = 0;
        this._releaseAssignment(slot);
        slot.status = 'cooldown';
        slot.cooldownUntil = Date.now() + 5000;
        this._saveState();
        this._scheduleCooldown(slotId, 5000);
        return;
      }
      const errorCooldown = this.cooldownMinMs;
      this._log('warn', `${slot.profileName} — error cooldown ${Math.round(errorCooldown / 60000)}m (user config)`);
      this._releaseAssignment(slot);
      slot.status = 'cooldown';
      slot.cooldownUntil = Date.now() + errorCooldown;
      this._saveState();
      this._scheduleCooldown(slotId, errorCooldown);
    }

    this._processQueue();
  }

  _processQueue() {
    for (const slot of this.slots.values()) {
      if (slot.enabled !== false && !slot.isPaused && (slot.status === 'queued' || slot.status === 'idle')) {
        this._tryRunSlot(slot).catch(() => {});
      }
    }
  }

  async _forceStopBeforeRecreate(profileId, browserType) {
    try {
      const { providerFactory } = require('./providers/ProviderFactory.cjs');
      const provider = providerFactory.getProvider(browserType || 'multilogin');
      this._log('info', `Force stopping profile ${profileId.slice(-6)} before recreate...`);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await provider.stopProfile(profileId);
        } catch (err) {
          this._log('warn', `Stop attempt ${attempt}/3: ${err.message}`);
        }
        await sleep(2500);
      }
      this._log('success', `Profile stopped — waiting before delete`);
      await sleep(2000);
    } catch (err) {
      this._log('warn', `Force stop warning: ${err.message}`);
    }
  }

  async _afterCooldown(slotId) {
    const slot = this.slots.get(slotId);
    if (!slot || !this.enabled || slot.enabled === false) return;
    if (slot.status === 'running' && this._isWorkerActive(slot.currentProfileId)) {
      this._log('warn', `${slot.profileName} — recreate skipped, worker still running`);
      this._saveState();
      return;
    }

    const protection = this._getRecreateProtection(slot, 'cooldown/recreate');
    if (protection) {
      this._markNeedsAttention(slot, protection.message);
      return;
    }

    slot.status = 'recreating';
    slot.cooldownUntil = null;
    this._saveState();

    const oldId = slot.currentProfileId;
    this._stopOrchestratorWorker(oldId);
    await sleep(3000);
    await this._forceStopBeforeRecreate(oldId, slot.browserType);
    this._log('info', `${slot.profileName} — recreating profile...`);
    try {
      const handler = new RecreateHandler();
      const result = await handler.recreate({
        profileId: oldId,
        browserType: slot.browserType,
        preserveName: true,
        proxyType: slot.proxyType,
        // Force-stop already attempted above; marking stopped avoids a second nested stop race
        // (Multilogin stopProfile tries several launcher URLs — can exceed legacy 30s cap).
        originalProfile: {
          name: slot.profileName,
          os: slot.os,
          browserType: slot.browserType,
          status: 'stopped',
        },
        fingerprintConfig: {
          canvas: 'real',
          webrtc: 'real',
          timezone: 'real',
          screen: 'real',
          navigator: 'real',
        },
      });

      if (result.code !== 0 || !result.data?.newProfileId) {
        throw new Error(result.message || 'Recreate failed');
      }

      const newId = result.data.newProfileId;
      this._migrateProfileConfig(oldId, newId);
      this.profileToSlot.delete(oldId);
      slot.currentProfileId = newId;
      this.profileToSlot.set(newId, slotId);
      slot.profileIdChangedAt = Date.now();
      if (this.deps.onProfileRecreated) {
        this.deps.onProfileRecreated({ oldId, newId, profileName: slot.profileName, slotId });
      }
      this._log('success', `${slot.profileName} recreated ${oldId.slice(-6)} → ${newId.slice(-6)}`);
    } catch (err) {
      slot.status = 'error';
      slot.lastError = err.message;
      this._saveState();
      this._log('error', `${slot.profileName} recreate failed: ${err.message}`);
      this.deps.notificationService.warning('24/7 recreate failed', `"${slot.profileName}": ${err.message}`).catch(() => {});
      return;
    }

    try {
      this._shuffleForSlot(slot);
      if (!slot.assignment?.videos?.length) {
        throw new Error('Shuffle returned no videos — check channels');
      }
    } catch (err) {
      slot.status = 'error';
      slot.lastError = err.message;
      this._saveState();
      this._log('error', `${slot.profileName} shuffle failed: ${err.message}`);
      return;
    }

    slot.status = 'idle';
    this._saveState();
    await this._tryRunSlot(slot);
  }

  async _tryRunSlot(slot) {
    if (!this.enabled || slot.enabled === false) return;
    if (['running', 'recreating', 'cooldown', 'paused', 'needs_attention'].includes(slot.status) || slot.isPaused) return;

    if (this._isWorkerActive(slot.currentProfileId)) {
      slot.status = 'running';
      this._saveState();
      this._log('info', `${slot.profileName} — worker already active, skipping duplicate start`);
      return;
    }

    const running = this.deps.getRunningCount();
    const limit = this.deps.getMaxConcurrent();
    if (running >= limit) {
      if (slot.status !== 'running') {
        slot.status = 'queued';
        this._saveState();
      }
      return;
    }

    try {
      if (!slot.assignment?.videos?.length) {
        this._shuffleForSlot(slot);
      }
      if (!slot.assignment?.videos?.length) {
        slot.status = 'error';
        slot.lastError = 'No videos to run';
        this._saveState();
        return;
      }

      const shuffleFile = this.deps.loadShuffleFile();
      const schedule = buildRecycleSchedule(slot, shuffleFile);
      slot.status = 'running';
      slot.lastRunAt = Date.now();
      this._saveState();

      this.deps.runningSchedules.set(schedule.id, {
        schedule,
        status: 'running',
        startedAt: Date.now(),
        recycleSlotId: slot.slotId,
      });

      this.deps.orchestrator.runSchedule(schedule);
      this._log('info', `${slot.profileName} — run started (${slot.assignment.videos.length} videos)`);
    } catch (err) {
      slot.status = 'error';
      slot.lastError = err.message;
      this._saveState();
      this._log('error', `${slot.profileName} run failed: ${err.message}`);
    }
  }

  /**
   * Pause all active 24/7 slots without converting them into cooldown.
   * Old behavior used a fake far-future cooldown; resume then fired _afterCooldown()
   * and could recreate profiles unexpectedly. Paused is now a real non-destructive state.
   */
  pause() {
    if (!this.enabled) return this.getStatus();
    this._log('info', '24/7 loop PAUSED — stopping workers without recreating profiles');
    for (const slot of this.slots.values()) {
      if (slot.enabled === false) continue;
      const t = this._timers.get(slot.slotId);
      if (t) { clearTimeout(t); this._timers.delete(slot.slotId); }
      this._stopOrchestratorWorker(slot.currentProfileId);
      slot.isPaused = true;
      slot.status = 'paused';
      slot.cooldownUntil = null;
      slot.lastError = slot.lastError || 'Paused by user';
    }
    this._saveState();
    return this.getStatus();
  }

  /**
   * Resume paused slots by queuing/running them directly. Never routes through
   * _afterCooldown(), so resume cannot trigger profile recreate by accident.
   */
  resume() {
    if (!this.enabled) return this.getStatus();
    this._log('info', '24/7 loop RESUMED — queued paused slots without recreate');
    for (const slot of this.slots.values()) {
      if (slot.enabled === false || (!slot.isPaused && slot.status !== 'paused')) continue;
      slot.isPaused = false;
      slot.cooldownUntil = null;
      slot.lastError = null;
      slot.status = 'idle';
    }
    this._saveState();
    this._processQueue();
    return this.getStatus();
  }

  /**
   * Called when the worker detects a sign-in wall in 24/7 mode.
   * Skips cooldown and triggers an immediate profile recreate.
   */
  immediateRecreate(profileId) {
    const slotId = this.profileToSlot.get(profileId);
    if (!slotId) return;
    const slot = this.slots.get(slotId);
    if (!slot || !this.enabled || slot.enabled === false) return;
    if (slot.status === 'recreating') return; // already in progress

    const protection = this._getRecreateProtection(slot, 'sign-in wall');
    if (protection) {
      this._markNeedsAttention(slot, `Sign-in wall detected but recreate skipped. ${protection.message}`);
      return;
    }

    this._log('warn', `${slot.profileName} — sign-in wall detected, scheduling immediate recreate`);

    const t = this._timers.get(slotId);
    if (t) { clearTimeout(t); this._timers.delete(slotId); }

    slot.status = 'recreating';
    slot.isPaused = false;
    slot.cooldownUntil = null;
    slot.errorRetries = 0;
    slot.lastError = 'Sign-in wall — profile recreating';
    this._saveState();

    // Give the worker 5s to exit cleanly before _afterCooldown stops the browser
    const timer = setTimeout(() => {
      this._timers.delete(`signin_${slotId}`);
      this._afterCooldown(slotId).catch((err) => {
        slot.status = 'error';
        slot.lastError = err.message;
        this._saveState();
        this._log('error', `${slot.profileName} sign-in recreate failed: ${err.message}`);
      });
    }, 5000);
    this._timers.set(`signin_${slotId}`, timer);
  }

  isRecycleProfile(profileId) {
    return this.profileToSlot.has(profileId);
  }

  getStatus() {
    const slots = [...this.slots.values()].map((s) => ({
      slotId: s.slotId,
      profileName: s.profileName,
      currentProfileId: s.currentProfileId,
      status: s.status,
      cycleCount: s.cycleCount || 0,
      cooldownUntil: s.cooldownUntil,
      lastError: s.lastError,
      videoCount: s.assignment?.videos?.length || 0,
      enabled: s.enabled !== false,
      isPaused: s.isPaused || false,
      profileIdChangedAt: s.profileIdChangedAt || null,
    }));
    return {
      enabled: this.enabled,
      cooldownMinMs: this.cooldownMinMs,
      cooldownMaxMs: this.cooldownMaxMs,
      activeSlots: slots.filter((s) => s.enabled).length,
      slots,
    };
  }

  updateConfig({ cooldownMinMinutes, cooldownMaxMinutes, profileIds }) {
    if (cooldownMinMinutes != null && cooldownMaxMinutes != null) {
      this.cooldownMinMs = Math.max(1, cooldownMinMinutes) * 60 * 1000;
      this.cooldownMaxMs = Math.max(this.cooldownMinMs, cooldownMaxMinutes) * 60 * 1000;
    }
    if (Array.isArray(profileIds)) {
      const selected = new Set(profileIds.map(String));
      for (const slot of this.slots.values()) {
        const keep = selected.has(String(slot.currentProfileId));
        slot.enabled = keep;
        if (!keep) {
          this._stopOrchestratorWorker(slot.currentProfileId);
          slot.status = 'stopped';
          slot.isPaused = false;
          slot.cooldownUntil = null;
        }
      }
    }
    this._saveState();
    return this.getStatus();
  }

  /**
   * Resume 24/7 loop from shuffle_data.json when recycle_state was lost but config remains.
   */
  async resumeFromShuffleConfig() {
    if (this.enabled) return this.getStatus();
    const shuffle = this.deps.loadShuffleFile();
    const rc = shuffle.recycleConfig || {};
    if (rc.enabled !== true || !Array.isArray(rc.profileIds) || !rc.profileIds.length) {
      return this.getStatus();
    }
    const storedSlots = [...this.slots.values()];
    const profiles = rc.profileIds.map((id) => {
      const slot = storedSlots.find((s) => s.currentProfileId === id || s.slotId === id);
      return {
        id,
        name: slot?.profileName || id,
        browserType: slot?.browserType || 'multilogin',
        os: slot?.os || 'Windows',
        proxyType: slot?.proxyType || 'smartproxy',
      };
    });
    this._log('info', `Resuming 24/7 loop from shuffle config (${profiles.length} profile(s))`);
    return this.start({
      profiles,
      cooldownMinMinutes: rc.cooldownMinMinutes ?? 10,
      cooldownMaxMinutes: rc.cooldownMaxMinutes ?? 30,
    });
  }
}

module.exports = { ProfileRecycleManager };
