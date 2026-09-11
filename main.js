'use strict';

const { app, BrowserWindow, dialog, screen } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { parseServerUrl, startupFailureMessage, systemProxyEnv } = require('./scripts/shell-utils.cjs');

// Optional startup helper (packaged through build.files "scripts/**/*"). A
// packaging miss must degrade to "no sync", never to a broken startup.
let syncModelCatalog = async () => {};
try {
  syncModelCatalog = require('./scripts/model-sync.cjs').syncModelCatalog;
} catch (error) {
  console.error('[model-sync] helper unavailable:', error.message);
}

// First-run locale default (also packaged through build.files "scripts/**/*").
let ensureDefaultLocale = () => ({ status: 'unavailable' });
try {
  ({ ensureDefaultLocale } = require('./scripts/default-settings.cjs'));
} catch (error) {
  console.error('[default-settings] helper unavailable:', error.message);
}

const HOST = '127.0.0.1';

// A packaged GUI has no visible stdout, so every server line is also written to
// a log the error dialogs can point at. os.tmpdir() is used because the drive
// root is not reliably writable.
const LOG_FILE = path.join(os.tmpdir(), 'deepseek-harness.log');
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;
const STDERR_KEEP_CHARS = 8 * 1024;

let serverProc = null;
let mainWindow = null;
let startupFailed = false;
let shuttingDown = false;
let stdoutBuf = '';
let stderrBuf = '';

function logLine(tag, text) {
  const line = `[${new Date().toISOString()}] [${tag}] ${text}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_LIMIT_BYTES) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, `${line}${os.EOL}`);
  } catch {
    /* logging must never be the reason startup fails */
  }
}

function dshBinPath() {
  // @deepseek-ai/dsh ships the CLI entry at lib/bin.js
  return path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: timeoutMs }, (res) => {
      // Any HTTP answer (including the auth fence's 401) means the server is up.
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(port, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Report one startup problem (with the log path) and exit instead of dying silently. */
function failStartup(what, detail) {
  if (startupFailed) return;
  startupFailed = true;
  logLine('shell', `startup failed: ${what}`);
  stopServer();
  dialog.showErrorBox('DeepSeek Harness', startupFailureMessage(what, detail ?? stderrBuf, LOG_FILE));
  app.quit();
}

function startServer() {
  const bin = dshBinPath();
  // --expose-internals became unnecessary once 0.1.5 dropped the HMR loader
  // requirement; it is still a valid Node flag, so it stays for compatibility
  // with older builds this shell may be pointed at.
  //
  // --no-open matters on 0.1.5+: dsh web now hands off to the default browser
  // by default, which would open a second window next to this shell.
  const args = ['--expose-internals', bin, 'web', '--host', HOST, '--port', '0', '--no-open'];

  // A desktop launch inherits a launch directory that varies (shortcut,
  // Explorer, portable extraction). dsh uses process.cwd() as the fallback
  // workspace root for sessions without their own cwd, so pin something
  // predictable instead of letting the sandbox root drift per launch.
  const proxyEnv = systemProxyEnv();
  if (Object.keys(proxyEnv).length > 0) logLine('shell', `proxy env: ${JSON.stringify(proxyEnv)}`);

  serverProc = spawn(process.execPath, args, {
    cwd: os.homedir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...proxyEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  logLine('shell', `server pid ${String(serverProc.pid)}; log ${LOG_FILE}`);

  serverProc.stdout.on('data', (d) => {
    const text = d.toString();
    stdoutBuf += text;
    if (stdoutBuf.length > 64 * 1024) stdoutBuf = stdoutBuf.slice(-64 * 1024);
    for (const line of text.split(/\r?\n/)) if (line.trim().length > 0) logLine('dsh', line);
    if (mainWindow !== null) return;
    // 0.1.5 prints the readiness line with the auth token:
    //   dsh web: http://127.0.0.1:PORT/?token=…  (LAN: …)
    // The window must load that URL verbatim: a bare / answers 401.
    const parsed = parseServerUrl(stdoutBuf);
    if (parsed === undefined) return;
    waitForServer(parsed.port).then((ok) => {
      if (startupFailed || mainWindow !== null) return;
      if (ok) createWindow(parsed.url);
      else failStartup('服务已启动但一直没有响应（可能是插件加载失败）');
    });
  });

  serverProc.stderr.on('data', (d) => {
    const text = d.toString();
    stderrBuf = `${stderrBuf}${text}`.slice(-STDERR_KEEP_CHARS);
    for (const line of text.split(/\r?\n/)) if (line.trim().length > 0) logLine('dsh!', line);
  });

  serverProc.on('error', (err) => {
    failStartup(`无法启动服务进程：${err.message}`);
  });

  serverProc.on('exit', (code) => {
    logLine('shell', `server exited with code ${String(code)}`);
    if (startupFailed || shuttingDown) return;
    if (mainWindow === null) failStartup(`服务进程提前退出（code ${String(code)}）`);
    else failStartup(`服务进程意外退出（code ${String(code)}），窗口已无法继续工作`);
  });
}

/**
 * Stop the harness server and everything it spawned.
 *
 * The folder-dialog worker is a grandchild (main -> server -> worker). A plain
 * `kill()` only reaps the server, leaving the worker — and its modal dialog —
 * alive as an orphan; that stray dialog then sits on screen and the next run
 * reads as "选择目录没反应". On Windows `taskkill /T` takes the whole tree.
 */
function stopServer() {
  if (serverProc === null || serverProc.killed || serverProc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch (error) {
      console.error('[dsh] taskkill failed, falling back to kill():', error.message);
    }
  }
  serverProc.kill();
}

function createWindow(serverUrl) {
  // Fit small laptop work areas (a fixed 1400x900 window can exceed them).
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1400, width),
    height: Math.min(900, height),
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 0.1.5's auth fence answers a bare `/` with 401 as a *successful* HTTP
  // response, so did-fail-load never fires and the user would just see an error
  // page. The token exchange sets `dsh-auth-*`; without that cookie the window
  // is not authenticated, whatever the page looks like.
  const serverOrigin = new URL(serverUrl).origin;
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.session.cookies
      .get({ url: serverOrigin })
      .then((cookies) => {
        const authenticated = cookies.some((cookie) => cookie.name.startsWith('dsh-auth-'));
        logLine('shell', `window loaded (auth cookie: ${authenticated ? 'present' : 'missing'})`);
        if (!authenticated) {
          failStartup('界面已加载但没有取得认证 cookie（token 可能失效或协议变化）', stderrBuf);
        }
      })
      .catch((error) => logLine('shell', `could not read cookies: ${error.message}`));
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    if (errorCode === -3) return; // aborted navigation, not a failure
    logLine('shell', `window failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`);
    failStartup(`界面加载失败：${errorDescription}`, stderrBuf);
  });

  mainWindow.loadURL(serverUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance: focus the existing window instead of booting a second server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Log the OS language: it decides the UI language (the locale plugin
    // delegates to the browser unless a preference is stored) and it is the
    // first thing to check when a report says "界面是英文的".
    logLine('shell', `system locale: ${app.getLocale()}`);
    logLine('shell', `locale default: ${ensureDefaultLocale({ locale: app.getLocale() }).status}`);
    startServer();
    // Background model-catalog sync: mirrors api.deepseek.com/models into the
    // hot-reloaded `llm-deepseek.models` settings section so freshly released
    // models show up and retired ones disappear. Deliberately not awaited — the
    // window must never wait on the network, and the call never rejects.
    syncModelCatalog().catch(() => {});
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    shuttingDown = true; // an intentional shutdown is not a crash
    stopServer();
  });
}
