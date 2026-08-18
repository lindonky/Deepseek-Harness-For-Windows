'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const HOST = '127.0.0.1';
const URL_LINE = /http:\/\/[\w.:-]+/;
const PORT_RE = /:(\d+)\/?$/;

let serverProc = null;
let mainWindow = null;

function dshBinPath() {
  // @deepseek-ai/dsh ships the CLI entry at lib/bin.js
  return path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

function probe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: timeoutMs }, (res) => {
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

function startServer() {
  const bin = dshBinPath();
  // --expose-internals is required by the web profile's HMR plugin.
  const args = ['--expose-internals', bin, 'web', '--host', HOST, '--port', '0'];
  serverProc = spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buf = '';
  serverProc.stdout.on('data', (d) => {
    const text = d.toString();
    console.log('[dsh]', text.trim());
    buf += text;
    // The server prints its URL ("dsh web: http://127.0.0.1:PORT"); parse it once.
    if (!mainWindow) {
      const m = buf.match(URL_LINE);
      if (m) {
        const pm = m[0].match(PORT_RE);
        if (pm) {
          const port = Number(pm[1]);
          if (Number.isInteger(port)) {
            waitForServer(port).then((ok) => {
              if (ok) {
                createWindow(port);
              } else {
                dialog.showErrorBox(
                  'DeepSeek Harness',
                  'The harness server started but is not responding. See the console output for details.'
                );
                app.quit();
              }
            });
          }
        }
      }
    }
  });

  serverProc.stderr.on('data', (d) => {
    console.error('[dsh]', d.toString().trim());
  });

  serverProc.on('error', (err) => {
    dialog.showErrorBox('DeepSeek Harness', `Failed to start the harness server:\n${err.message}`);
    app.quit();
  });

  serverProc.on('exit', (code) => {
    console.log('[dsh] server exited with code', code);
    if (!mainWindow) app.quit();
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://${HOST}:${port}/`);
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
    startServer();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('will-quit', () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill();
    }
  });
}
