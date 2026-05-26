'use strict';

/**
 * watchdog.cjs — YouTube backend crash detection + auto-restart (port 3100)
 * Usage: node server/watchdog.cjs
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const BACKEND_PORT = process.env.BACKEND_PORT || 3100;
const CHECK_INTERVAL = 10000;
const RESTART_DELAY = 5000;
const BACKEND_SCRIPT = path.join(__dirname, 'index.cjs');

let backendProcess = null;
let isRestarting = false;
let restartCount = 0;

function log(msg) {
  console.log(`[WATCHDOG ${new Date().toISOString()}] ${msg}`);
}

function startBackend() {
  log(`Starting YouTube backend (attempt #${++restartCount})...`);

  backendProcess = spawn('node', [BACKEND_SCRIPT], {
    stdio: 'inherit',
    detached: false,
    cwd: path.dirname(BACKEND_SCRIPT),
  });

  backendProcess.on('exit', (code, signal) => {
    log(`Backend exited (code=${code}, signal=${signal})`);
    if (!isRestarting) {
      isRestarting = true;
      setTimeout(() => {
        isRestarting = false;
        startBackend();
      }, RESTART_DELAY);
    }
  });

  backendProcess.on('error', (err) => {
    log(`Backend spawn error: ${err.message}`);
  });

  log(`Backend started (PID: ${backendProcess.pid})`);
}

function checkBackendAlive() {
  const req = http.get(
    { hostname: '127.0.0.1', port: BACKEND_PORT, path: '/api/health', timeout: 5000 },
    (res) => {
      if (res.statusCode !== 200) {
        log(`Backend returned status ${res.statusCode}`);
      }
    },
  );

  req.on('error', () => {
    if (!isRestarting && (!backendProcess || backendProcess.killed || backendProcess.exitCode !== null)) {
      log('Health check failed — restarting backend...');
      isRestarting = true;
      setTimeout(() => {
        isRestarting = false;
        startBackend();
      }, RESTART_DELAY);
    }
  });

  req.on('timeout', () => {
    req.destroy();
  });
}

startBackend();
setInterval(checkBackendAlive, CHECK_INTERVAL);

process.on('SIGINT', () => {
  if (backendProcess && !backendProcess.killed) backendProcess.kill('SIGTERM');
  process.exit(0);
});

log(`Watchdog running — monitoring port ${BACKEND_PORT}`);
