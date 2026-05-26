'use strict';

/**
 * healthMonitor — RAM/CPU monitoring, circuit breaker, auto active-agent limits
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const HEALTH_FILE = path.resolve(__dirname, '..', 'health_stats.json');
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

function getMemoryStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalMb: Math.round(total / 1024 / 1024),
    freeMb: Math.round(free / 1024 / 1024),
    usedMb: Math.round(used / 1024 / 1024),
    usedPercent: Math.round((used / total) * 100),
  };
}

function estimateMaxActiveAgents(ramGbOverride) {
  const totalGb = ramGbOverride || (os.totalmem() / 1024 / 1024 / 1024);
  if (totalGb >= 38) return 14;
  if (totalGb >= 28) return 10;
  if (totalGb >= 20) return 8;
  if (totalGb >= 14) return 6;
  return 4;
}

class HealthMonitor {
  constructor(options = {}) {
    this.ramWarningPercent = options.ramWarningPercent ?? 80;
    this.ramCriticalPercent = options.ramCriticalPercent ?? 85;
    this.ramEmergencyPercent = options.ramEmergencyPercent ?? 90;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 5;
    this.recentFailures = [];
    this.circuitOpenUntil = 0;
    this.snapshots = [];
    this._interval = null;
  }

  getStatus(activeCount = 0, queuedCount = 0) {
    const mem = getMemoryStats();
    const maxActive = estimateMaxActiveAgents();
    const circuitOpen = Date.now() < this.circuitOpenUntil;
    let launchAllowed = !circuitOpen && mem.usedPercent < this.ramCriticalPercent;

    return {
      memory: mem,
      cpuLoad: os.loadavg(),
      maxActiveAgents: maxActive,
      activeAgents: activeCount,
      queuedAgents: queuedCount,
      circuitBreakerOpen: circuitOpen,
      circuitOpenUntil: this.circuitOpenUntil || null,
      launchAllowed,
      ramWarning: mem.usedPercent >= this.ramWarningPercent,
      ramCritical: mem.usedPercent >= this.ramCriticalPercent,
    };
  }

  canLaunchNewAgent(activeCount) {
    const status = this.getStatus(activeCount);
    if (status.circuitBreakerOpen) {
      return { allowed: false, reason: 'Circuit breaker open — too many recent failures' };
    }
    if (status.ramCritical) {
      return { allowed: false, reason: `RAM critical (${status.memory.usedPercent}%) — waiting for memory` };
    }
    if (activeCount >= status.maxActiveAgents) {
      return { allowed: false, reason: `Active limit reached (${activeCount}/${status.maxActiveAgents})` };
    }
    return { allowed: true };
  }

  recordFailure() {
    const now = Date.now();
    this.recentFailures.push(now);
    this.recentFailures = this.recentFailures.filter(t => now - t < 5 * 60 * 1000);
    if (this.recentFailures.length >= this.circuitBreakerThreshold) {
      this.circuitOpenUntil = now + 5 * 60 * 1000;
      console.warn(`[HealthMonitor] Circuit breaker OPEN for 5 minutes (${this.recentFailures.length} failures)`);
      return true;
    }
    return false;
  }

  recordSuccess() {
    if (this.recentFailures.length > 0) this.recentFailures.pop();
  }

  startSnapshots() {
    if (this._interval) return;
    this._loadSnapshots();
    this._interval = setInterval(() => this._saveSnapshot(), SNAPSHOT_INTERVAL_MS);
  }

  stopSnapshots() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  _loadSnapshots() {
    try {
      const raw = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
      this.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots.slice(-500) : [];
    } catch {
      this.snapshots = [];
    }
  }

  _saveSnapshot(extra = {}) {
    const entry = { ts: Date.now(), ...getMemoryStats(), ...extra };
    this.snapshots.push(entry);
    if (this.snapshots.length > 500) this.snapshots = this.snapshots.slice(-500);
    try {
      fs.writeFileSync(HEALTH_FILE, JSON.stringify({ snapshots: this.snapshots }, null, 2));
    } catch (err) {
      console.warn('[HealthMonitor] Snapshot save failed:', err.message);
    }
  }
}

module.exports = { HealthMonitor, getMemoryStats, estimateMaxActiveAgents };
