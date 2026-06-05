const { app, BrowserWindow, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Icon — safe fallback if file missing
const ICON_PATH = path.join(__dirname, 'icon.png');
const appIcon = fs.existsSync(ICON_PATH) ? ICON_PATH : undefined;

const SPLASH_MIN_MS = 5500;

let mainWindow = null;
let splashWindow = null;
let splashTimer = null;
let splashStartedAt = 0;
let startupComplete = false;
let isQuitting = false;
let backendLoadError = '';

function getLogPath() {
  try {
    return path.join(app.getPath('userData'), 'startup.log');
  } catch {
    return path.join(path.dirname(process.execPath || __dirname), 'mmb-startup.log');
  }
}

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(getLogPath(), line + '\n');
  } catch {
    /* ignore log write errors */
  }
}

function showFatalError(title, message) {
  const body = `${message}\n\nDetails saved to:\n${getLogPath()}`;
  logLine(`FATAL: ${title} — ${message}`);
  try {
    dialog.showErrorBox(title, body);
  } catch {
    /* last resort — at least console */
    console.error(title, message);
  }
}

function getBackendPort() {
  const raw = process.env.BACKEND_PORT || process.env.SERVER_PORT || '3100';
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : 3100;
}

function safeCloseWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.close();
  } catch {
    /* window already gone */
  }
}

// (Node.js backend module patching removed — Python backend use ho raha hai)

function waitForBackend(maxMs = 45000) {
  const port = getBackendPort();
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (isQuitting) {
        resolve(false);
        return;
      }
      if (Date.now() - started > maxMs) {
        resolve(false);
        return;
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health`, {
        headers: { 'x-api-key': process.env.BACKEND_API_KEY || 'mmb-local-dev-2025' },
      }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        setTimeout(tick, 600);
      });
      req.setTimeout(2500, () => {
        req.destroy();
        setTimeout(tick, 600);
      });
    };
    tick();
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SPLASH SCREEN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function createSplashWindow() {
  if (isQuitting) return;
  splashStartedAt = Date.now();
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  splashWindow = new BrowserWindow({
    width: 500,
    height: 400,
    x: Math.round((width - 500) / 2),
    y: Math.round((height - 400) / 2),
    frame: false,
    // transparent splash fails silently on many Windows Server / RDP setups
    transparent: false,
    backgroundColor: '#0a0a0a',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  if (appIcon) splashWindow.setIcon(appIcon);
  splashWindow.setMenuBarVisibility(false);
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function dismissSplashAndShowMain() {
  if (isQuitting) return;
  safeCloseWindow(splashWindow);
  splashWindow = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    startupComplete = true;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN WINDOW
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function createMainWindow() {
  if (isQuitting) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1400, width - 100),
    height: Math.min(900, height - 100),
    minWidth: 1000,
    minHeight: 700,
    show: false,
    frame: true,
    title: 'MMB Agent 24/7',
    icon: appIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html');

  if (isDev) {
    mainWindow.loadURL('http://localhost:5178');
  } else if (!fs.existsSync(indexPath)) {
    backendLoadError = `UI file missing: ${indexPath}`;
    showFatalError(
      'MMB Agent — UI missing',
      'The app UI could not be found inside the installation.\nPlease reinstall from the official setup file.',
    );
    isQuitting = true;
    app.quit();
    return;
  } else {
    mainWindow.loadFile(indexPath);
  }

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    backendLoadError = `UI load failed (${code}): ${desc} — ${url}`;
    showFatalError(
      'MMB Agent — UI failed to load',
      `${desc}\n\nTry reinstalling the app.`,
    );
  });

  mainWindow.once('ready-to-show', () => {
    if (isQuitting) return;
    const elapsed = Date.now() - splashStartedAt;
    const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
    splashTimer = setTimeout(() => {
      splashTimer = null;
      dismissSplashAndShowMain();
    }, remaining);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// START BACKEND — Python Flask server
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let _pythonProcess = null;

function loadPackagedEnvForPython() {
  // .env file load karo — Python server ko env vars chahiye
  const candidates = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'server_python', 'runtime.env'),
        path.join(path.dirname(process.execPath), '.env'),
        path.join(process.resourcesPath, '.env'),
      ]
    : [
        path.join(__dirname, '..', '.env'),
      ];

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      logLine(`Loading env for Python: ${envPath}`);
      // Simple .env parser — dotenv Python side pe bhi load karta hai
      try {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx < 0) continue;
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
          if (key && !process.env[key]) process.env[key] = val;
        }
      } catch (e) {
        logLine(`Env parse warning: ${e.message}`);
      }
      break;
    }
  }

  // Default API key agar set nahi hai
  if (!process.env.BACKEND_API_KEY) {
    process.env.BACKEND_API_KEY = 'mmb-local-dev-2025';
  }
}

function findPythonExecutable() {
  // Packaged app mein bundled python, dev mein system python
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'python', 'python.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  // System python — 'python' ya 'python3'
  return process.platform === 'win32' ? 'python' : 'python3';
}

function startBackend() {
  loadPackagedEnvForPython();

  const pythonExe = findPythonExecutable();

  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'server_python', 'main.py')
    : path.join(__dirname, '..', 'server_python', 'main.py');

  logLine(`Starting Python backend: ${pythonExe} ${scriptPath}`);

  if (!fs.existsSync(scriptPath)) {
    backendLoadError = `Python backend not found: ${scriptPath}`;
    throw new Error(backendLoadError);
  }

  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',   // stdout/stderr immediately flush ho
    PYTHONIOENCODING: 'utf-8',
  };

  const { spawn } = require('child_process');
  _pythonProcess = spawn(pythonExe, [scriptPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, '..'),
  });

  _pythonProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => { if (line.trim()) logLine(`[Python] ${line.trim()}`); });
  });

  _pythonProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => { if (line.trim()) logLine(`[Python ERR] ${line.trim()}`); });
  });

  _pythonProcess.on('error', (err) => {
    backendLoadError = `Python spawn error: ${err.message}`;
    logLine(backendLoadError);
    if (!isQuitting) {
      showFatalError(
        'MMB Agent — Python not found',
        `Could not start Python backend.\n\nError: ${err.message}\n\nFix: Python 3.10+ install karo aur PATH mein add karo.`,
      );
      isQuitting = true;
      app.quit();
    }
  });

  _pythonProcess.on('exit', (code, signal) => {
    logLine(`Python backend exited | code=${code} signal=${signal}`);
    if (!isQuitting && code !== 0 && signal !== 'SIGTERM') {
      showFatalError(
        'MMB Agent — Backend stopped',
        `Python server unexpectedly stopped (code ${code}).\n\nApp restart karo.`,
      );
      isQuitting = true;
      app.quit();
    }
  });

  logLine('Python backend process spawned');
}

function stopPythonBackend() {
  if (_pythonProcess && !_pythonProcess.killed) {
    logLine('Stopping Python backend...');
    _pythonProcess.kill('SIGTERM');
    // Force kill after 5s agar graceful shutdown nahi hua
    setTimeout(() => {
      if (_pythonProcess && !_pythonProcess.killed) {
        _pythonProcess.kill('SIGKILL');
      }
    }, 5000);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GLOBAL ERROR HANDLERS — never crash silently
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
process.on('uncaughtException', (err) => {
  if (isQuitting) return;
  backendLoadError = err.stack || err.message;
  showFatalError('MMB Agent — Unexpected error', err.message || String(err));
  isQuitting = true;
  try { app.quit(); } catch { /* ignore */ }
});

process.on('unhandledRejection', (reason) => {
  logLine(`Unhandled rejection: ${reason}`);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// APP LIFECYCLE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.whenReady().then(async () => {
  try {
    if (app.isPackaged) {
      process.env.MMB_PACKAGED = '1';
    }
    logLine(`App starting (packaged=${app.isPackaged})`);
    createSplashWindow();
    startBackend();

    logLine('Waiting for backend health...');
    const ready = await waitForBackend();
    if (!ready) {
      const port = getBackendPort();
      const msg = backendLoadError || (
        `Backend did not start on port ${port} within 45 seconds.\n\n` +
        'Try these fixes:\n' +
        '1. Close all other MMB Agent windows\n' +
        '2. Check if another app uses port 3100\n' +
        '3. Run as Administrator once\n' +
        '4. Reinstall from the latest setup ZIP'
      );
      showFatalError('MMB Agent — Could not start', msg);
      isQuitting = true;
      app.quit();
      return;
    }

    logLine('Backend healthy — opening main window');
    createMainWindow();
  } catch (err) {
    backendLoadError = err.stack || err.message;
    showFatalError(
      'MMB Agent — Startup failed',
      err.message || String(err),
    );
    isQuitting = true;
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // During startup the splash may close before main opens — do not quit silently
  if (!startupComplete && !isQuitting) return;
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (splashTimer) {
    clearTimeout(splashTimer);
    splashTimer = null;
  }
  safeCloseWindow(splashWindow);
  splashWindow = null;
  stopPythonBackend();
});
