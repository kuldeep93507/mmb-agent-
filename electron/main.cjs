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

function wireBackendModulePaths() {
  if (!app.isPackaged) return;

  const appPackageJson = path.join(app.getAppPath(), 'package.json');
  const appRequire = require('module').createRequire(appPackageJson);
  const Module = require('module');
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    try {
      return originalLoad.call(this, request, parent, isMain);
    } catch (err) {
      const isMissing = err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND');
      const isBare = request && !request.startsWith('.') && !request.startsWith('/') && !request.startsWith('\\');
      if (isMissing && isBare) {
        try {
          return appRequire(request);
        } catch {
          /* fall through */
        }
      }
      throw err;
    }
  };

  logLine(`Backend module loader patched via ${appPackageJson}`);
}

function loadPackagedEnv() {
  if (!app.isPackaged) return;
  try {
    const loadEnv = require(path.join(process.resourcesPath, 'server', 'providers', 'loadEnv.cjs'));
    const candidates = [
      path.join(process.resourcesPath, 'server', 'runtime.env'),
      path.join(path.dirname(process.execPath), '.env'),
      path.join(process.resourcesPath, 'server', '.env'),
    ];
    for (const envPath of candidates) {
      if (fs.existsSync(envPath)) {
        loadEnv(envPath);
        logLine(`Loaded env: ${envPath}`);
        break;
      }
    }
  } catch (err) {
    logLine(`Could not load packaged env: ${err.message}`);
  }
  if (!process.env.BACKEND_API_KEY && !process.env.MMB_API_TOKEN) {
    process.env.BACKEND_API_KEY = 'mmb-local-dev-2025';
    logLine('Using default BACKEND_API_KEY for packaged app');
  }
}

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
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
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
// START BACKEND
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function startBackend() {
  loadPackagedEnv();
  wireBackendModulePaths();

  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'index.cjs')
    : path.join(__dirname, '..', 'server', 'index.cjs');

  logLine(`Loading backend: ${serverPath}`);

  if (!fs.existsSync(serverPath)) {
    backendLoadError = `Backend not found: ${serverPath}`;
    throw new Error(backendLoadError);
  }

  const _realExit = process.exit.bind(process);
  process.exit = (code) => {
    const msg = backendLoadError
      || `The backend stopped during startup (code ${code ?? 0}).\n\nCommon fixes:\n• Close any other MMB Agent window\n• Restart your PC\n• Reinstall from the latest setup file`;
    logLine(`process.exit(${code ?? 0}) intercepted`);
    if (!isQuitting) {
      showFatalError('MMB Agent — Backend stopped', msg);
    }
    isQuitting = true;
    app.quit();
    setTimeout(() => _realExit(code ?? 0), 5000);
  };

  try {
    require(serverPath);
    logLine('Backend module loaded');
  } catch (err) {
    backendLoadError = err.stack || err.message;
    throw err;
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
  try { process.emit('SIGTERM'); } catch { /* ignore */ }
});
