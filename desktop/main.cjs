// Velocity Blocks for Windows: the web game (the same `npm run build` the Android app uses) in its own window.
// scripts/build-desktop.mjs copies dist/ to www/ next to this file and packs both with electron-builder:
// an installer (NSIS) and a portable .exe.
//
// - The game is served from app://game/ (not file://, where module scripts and fetch() of the models fail);
//   its records live in that origin's localStorage, so they survive updates and are shared by both builds.
// - F11 toggles full screen. Links to other sites open in the default browser; the window never leaves the game.
// - Once a day it asks GitHub for the latest release. The installed app downloads the new installer (progress
//   on the taskbar button) and runs it; the portable .exe opens the download in the browser.

const { app, BrowserWindow, Menu, dialog, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const REPO = 'Mitovoid-AI/VelocityBlocks';
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const ORIGIN = 'app://game';
const WWW = path.join(__dirname, 'www');
const DAY_MS = 24 * 60 * 60 * 1000;
/** Set by electron-builder's portable launcher: this is the single .exe, not an installed copy. */
const PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function serveGame() {
  protocol.handle('app', (req) => {
    const url = new URL(req.url);
    if (url.host !== 'game') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(WWW, rel));
    if (file !== WWW && !file.startsWith(WWW + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function openOutside(url) {
  if (/^https:\/\//i.test(url)) void shell.openExternal(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 450,
    show: false,
    backgroundColor: '#0b1020',
    title: 'Velocity Blocks',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(ORIGIN + '/')) return;
    e.preventDefault();
    openOutside(url);
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
    setTimeout(() => void checkForUpdate(), 4000);
  });
  win.on('closed', () => (win = null));
  void win.loadURL(`${ORIGIN}/index.html`);
}

// ------------------------------------------------------------------ Updates

function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(s ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const stateFile = () => path.join(app.getPath('userData'), 'update-check.json');
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveState(s) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch {
    /* the worst case is one more check */
  }
}

async function checkForUpdate() {
  const state = loadState();
  const now = Date.now();
  if (state.lastCheck && now - state.lastCheck < DAY_MS && now >= state.lastCheck) return;
  saveState({ ...state, lastCheck: now });
  let release;
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `VelocityBlocks/${app.getVersion()}` },
    });
    if (!res.ok) return;
    release = await res.json();
  } catch {
    return; // offline or rate-limited: try again tomorrow
  }
  const latest = parseVersion(release?.tag_name);
  const current = parseVersion(app.getVersion());
  if (!latest || !current || release.draft || release.prerelease || newer(latest, current) <= 0) return;
  if (state.skipped === release.tag_name) return;
  const want = PORTABLE ? 'VelocityBlocks-Portable.exe' : 'VelocityBlocks-Setup.exe';
  const asset = (release.assets ?? []).find((a) => a?.name === want);
  if (!asset || typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith(DOWNLOAD_PREFIX)) return;
  if (!win) return;
  const version = latest.join('.');
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Update available',
    message: `Velocity Blocks ${version} is available`,
    detail: `You have ${app.getVersion()}. ${PORTABLE ? 'Download the new .exe in your browser and run it instead of this one.' : 'It downloads here and then installs.'} Your records and tracks are kept.`,
    buttons: [PORTABLE ? 'Download' : 'Update now', 'Later', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 2) return saveState({ ...loadState(), skipped: release.tag_name });
  if (response !== 0) return;
  if (PORTABLE) return void shell.openExternal(asset.browser_download_url);
  await downloadAndInstall(asset, version);
}

/** Download the installer to the temp folder (progress on the taskbar button), run it and quit. */
async function downloadAndInstall(asset, version) {
  const file = path.join(app.getPath('temp'), `VelocityBlocks-Setup-${version}.exe`);
  const part = `${file}.part`;
  try {
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const out = fs.createWriteStream(part);
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      if (win && total > 0) win.setProgressBar(Math.min(1, received / total));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (asset.size && received !== asset.size) throw new Error('the download was cut short');
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
  } catch (e) {
    fs.rmSync(part, { force: true });
    win?.setProgressBar(-1);
    if (win) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Update',
        message: "The update didn't download",
        detail: `${e?.message ?? e}. You can download it in your browser instead.`,
        buttons: ['Open in browser', 'Close'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) void shell.openExternal(asset.browser_download_url);
    }
    return;
  }
  win?.setProgressBar(-1);
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

// ------------------------------------------------------------------ App

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  serveGame();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
