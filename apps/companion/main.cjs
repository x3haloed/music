const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const { homedir } = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const runRoot = path.resolve(process.env.MUSIC_RUN_DIR || path.join(homedir(), '.local/share/music/residents/resident'));
let companion;
let window;
let tray;
let pollTimer;
let lastRevision = '';
const ownsInstance = app.requestSingleInstanceLock();

if (!ownsInstance) app.quit();
else app.on('second-instance', showWindow);

async function loadCompanion() {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../src/companion.js')).href;
  companion = await import(moduleUrl);
}

function createWindow() {
  window = new BrowserWindow({
    width: 430,
    height: 650,
    minWidth: 390,
    minHeight: 520,
    show: true,
    resizable: true,
    fullscreenable: false,
    title: 'Music Companion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, 'index.html'));
  window.on('closed', () => { window = undefined; });
}

function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;utf8,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <circle cx="9" cy="9" r="8" fill="black"/>
      <path d="M5 12V6.7L8 9l2.5-3v6L13 9.8" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`)}`);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Music Companion');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Music Companion', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => window?.isVisible() ? window.hide() : showWindow());
}

function showWindow() {
  if (!window) createWindow();
  window.show();
  window.focus();
}

function snapshot() {
  return companion.companionSnapshot(runRoot);
}

function safe(operation) {
  try { return { ok: true, ...operation() }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error), run: runRoot }; }
}

function beginPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const result = safe(snapshot);
    const revision = result.ok ? `${result.head}:${result.presence.phase}:${result.conversation.length}` : `error:${result.error}`;
    if (revision === lastRevision) return;
    lastRevision = revision;
    window?.webContents.send('music:snapshot', result);
  }, 750);
}

ipcMain.handle('music:getSnapshot', () => safe(snapshot));
ipcMain.handle('music:send', async (_event, payload) => {
  try {
    const result = await companion.sendCompanionMessage(runRoot, payload?.message, { from: 'Chad' });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

if (ownsInstance) {
  app.whenReady().then(async () => {
    await loadCompanion();
    createWindow();
    createTray();
    beginPolling();
  });
  app.on('activate', showWindow);
}

app.on('window-all-closed', event => event.preventDefault());
app.on('before-quit', () => clearInterval(pollTimer));
