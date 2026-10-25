const { app, BrowserWindow, ipcMain, safeStorage, shell, globalShortcut, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Client: DiscordRpcClient } = require('@xhayper/discord-rpc');
const { checkForUpdates, downloadUpdate, installAndQuit } = require('./update-checker');

// Up to 2.2 the data folder (login, settings, downloads, listening stats) was
// named JellyWave. Move it to the Triptych one on the first start of 2.3;
// this must run before anything reads userData or takes the instance lock.
(function moveLegacyUserData() {
  const legacy = path.join(app.getPath('appData'), 'JellyWave');
  const current = app.getPath('userData');
  if (path.resolve(legacy).toLowerCase() === path.resolve(current).toLowerCase()) return;
  if (fs.existsSync(current) || !fs.existsSync(legacy)) return;
  try {
    fs.renameSync(legacy, current);
  } catch (err) {
    // e.g. another volume or a locked file: copy instead, keep the original
    try { fs.cpSync(legacy, current, { recursive: true }); } catch (e) { console.log('[migrate] data folder:', e.message); }
  }
})();

const CONFIG_PATH = path.join(app.getPath('userData'), 'session.dat');
const DISCORD_CLIENT_ID = '1534197353056174180';
const DOWNLOADS_DIR = path.join(app.getPath('userData'), 'downloads');
// Same asarUnpack reasoning as DOWNLOADER_DIR below -- a native .node addon
// can't be loaded from inside app.asar's virtual filesystem either.
const SMTC_ADDON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'smtc', 'smtc.node')
  : path.join(__dirname, 'native', 'smtc', 'smtc.node');
// Packaged builds pack downloader/ inside app.asar, a virtual archive only
// Node's own fs shim understands -- python.exe (an external process) can't
// open a path inside it at all. asarUnpack (see package.json) copies these
// files out to a real "app.asar.unpacked" directory alongside app.asar
// instead; point there when packaged, and at the plain source tree in dev
// (npm start), where there's no asar to begin with.
const DOWNLOADER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'downloader')
  : path.join(__dirname, 'downloader');
const GRAB_CLI = path.join(DOWNLOADER_DIR, 'cli.py');

// A GUI-launched Electron process doesn't reliably inherit the same PATH a
// terminal session has (this is what caused "spawn python ENOENT" even
// though `python` works fine from any shell) -- resolve a real interpreter
// path up front rather than trusting PATH lookup at spawn time. Falls back
// to bare "python" so this doesn't hard-fail on a machine where it's
// actually on the GUI-process PATH.
function resolvePythonExecutable() {
  const candidates = [
    'C:\\Python314\\python.exe',
    path.join(app.getPath('home'), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(app.getPath('home'), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(app.getPath('home'), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe')
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'python';
}
const PYTHON_EXE = resolvePythonExecutable();

let mainWindow;
let autoUpdateCheckEnabled = true;
let smtc = null;

// Registers Triptych as a real Windows SMTC (System Media Transport
// Controls) provider -- the same OS-level session the taskbar media flyout,
// lock screen, Xbox Game Bar, and third-party readers (e.g. Windhawk's
// Island Media Controls) all read from. Electron never does this on its own
// (see native/smtc/src/lib.rs for why); best-effort, since a missing/failed
// native build must never stop the app from starting.
function setupSmtc() {
  if (process.platform !== 'win32' || !mainWindow) return;
  try {
    const { Smtc } = require(SMTC_ADDON_PATH);
    // napi's plain `i64` binds to a JS number, not BigInt; HWNDs are always
    // small enough that Number() loses nothing.
    const hwnd = Number(mainWindow.getNativeWindowHandle().readBigInt64LE(0));
    smtc = new Smtc(hwnd);
    smtc.attach((err, event) => {
      if (err || !event) return;
      mainWindow?.webContents.send('smtc:event', event);
    });
  } catch (err) {
    console.log('[smtc] native media controls unavailable:', err.message);
    smtc = null;
  }
}

// Window size/position/maximized, remembered between launches. Restored
// only if it still lands on a connected screen (a monitor may have been
// unplugged since), otherwise the default size, centered.
const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, 'utf8'));
    const { screen } = require('electron');
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      state.x < a.x + a.width - 100 && state.x + state.width > a.x + 100 &&
      state.y >= a.y - 10 && state.y < a.y + a.height - 100);
    return visible ? state : { width: state.width, height: state.height, maximized: state.maximized };
  } catch (err) {
    return null;
  }
}
function trackWindowState(win) {
  let timer = null;
  const save = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    try {
      fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
    } catch (err) {
      // Not worth bothering anyone about.
    }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(save, 500); };
  win.on('resize', later);
  win.on('move', later);
  win.on('maximize', later);
  win.on('unmaximize', later);
  win.on('close', () => { clearTimeout(timer); save(); });
}

function createWindow() {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.width || 1360,
    height: saved?.height || 870,
    ...(saved && saved.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    // macOS keeps its own traffic-light buttons, set into the app's title bar
    // (36px tall, see --titlebar-h); elsewhere the app draws its own controls.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 11 } }
      : { frame: false, titleBarStyle: 'hidden' }),
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (saved?.maximized) mainWindow.maximize();
  trackWindowState(mainWindow);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  // Links with target="_blank" (e.g. the attribution credit) open in the
  // user's real browser instead of a bare Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', 'normal'));

  setupSmtc();
}

ipcMain.on('smtc:setMetadata', (_event, meta) => {
  try {
    smtc?.setMetadata({
      title: meta?.title || '',
      artist: meta?.artist || '',
      album: meta?.album || '',
      coverUrl: meta?.coverUrl || undefined,
      durationMs: meta?.durationMs ?? undefined
    });
  } catch (err) {
    // Non-fatal -- e.g. called right as the window is closing.
  }
});

ipcMain.on('smtc:setPlayback', (_event, state, positionMs) => {
  try {
    smtc?.setPlayback(state, positionMs ?? undefined);
  } catch (err) {
    // Non-fatal, same as above.
  }
});

// One Triptych at a time. A second copy (opened twice, or started by the
// installer while the old one is still closing) can't open the locked
// local storage, so it ran on empty, throwaway storage: a new device id,
// 0 minutes listened, no downloads list. Instead it just brings the running
// window to the front and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Silent background check — only speaks up if something's actually newer.
  // Settings → Privacy → "Automatic update check" can turn this off entirely
  // (autoUpdateCheckEnabled, pushed over IPC as soon as the renderer loads
  // its settings) -- checked here, not just at display time, so the
  // opt-out actually stops the GitHub request rather than just hiding it.
  setTimeout(() => {
    if (!autoUpdateCheckEnabled) return;
    checkForUpdates()
      .then((result) => {
        if (result.status === 'available' && mainWindow) {
          mainWindow.webContents.send('update:available', result);
        }
      })
      .catch(() => {});
  }, 4000);

  // Hardware media keys (play/pause/next/prev on a keyboard) — these are
  // global accelerators Electron recognizes specially, so they work even
  // when the app isn't focused, same as they would for any other player.
  const mediaKeyMap = {
    MediaPlayPause: 'playpause',
    MediaNextTrack: 'next',
    MediaPreviousTrack: 'previous',
    MediaStop: 'stop'
  };
  Object.entries(mediaKeyMap).forEach(([accelerator, key]) => {
    try {
      globalShortcut.register(accelerator, () => {
        mainWindow?.webContents.send('media-key', key);
      });
    } catch (err) {
      // Some OS/keyboard combos don't expose these — non-fatal either way.
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Kills a running Import (Python/yt-dlp) along with any ffmpeg it spawned.
// Child processes outlive the app on Windows, and a leftover python.exe
// keeps files under app.asar.unpacked\downloader open -- the installer's
// "close Triptych" step only targets Triptych.exe, so it would then fail
// to replace those files.
function killGrabProcess() {
  if (!grabProcess) return;
  const pid = grabProcess.pid;
  grabProcess = null;
  if (process.platform === 'win32' && pid) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch (err) {
      // fall through to a plain kill
    }
  }
  try { process.kill(pid); } catch (err) { /* already gone */ }
}

// Fully closes Triptych for the updater: children killed, Discord/SMTC
// released (via will-quit), then a hard exit if a graceful quit is still
// hanging on something (an open stream to the server, a native handle...)
// a couple of seconds later.
function shutdownForUpdate() {
  killGrabProcess();
  mainWindow?.webContents.send('app:shuttingDown');
  // Give the renderer a moment to save, then make sure local storage is on
  // disk before the (possibly hard) exit below.
  setTimeout(() => {
    session.defaultSession.flushStorageData();
    app.quit();
  }, 600);
  setTimeout(() => app.exit(0), 3000);
}

app.on('will-quit', () => {
  session.defaultSession.flushStorageData();
  killGrabProcess();
  globalShortcut.unregisterAll();
  try {
    smtc?.detach();
  } catch (err) {
    // Non-fatal -- we're quitting anyway.
  }
  // Release the Discord RPC IPC connection explicitly rather than leaving it
  // to process teardown — matters for the updater, which detects a running
  // instance by image name and can end up fighting a lingering handle.
  try {
    discordClient?.destroy();
  } catch (err) {
    // Already disconnected/never connected — nothing to clean up.
  }
});

ipcMain.handle('update:check', async () => {
  try {
    return await checkForUpdates();
  } catch (err) {
    return { status: 'error', error: err.message };
  }
});

ipcMain.handle('update:download', async (event) => {
  try {
    const result = await downloadUpdate((progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('update:progress', progress);
    });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:install', (_event, file) => {
  try {
    installAndQuit(file, shutdownForUpdate);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('update:setAutoCheckEnabled', (_event, enabled) => {
  autoUpdateCheckEnabled = enabled !== false;
});

// Lets jellyfin.js report the real installed version to the server instead
// of a hardcoded constant that has to be remembered on every release (see
// CLIENT_VERSION in jellyfin.js) — app.getVersion() reads package.json,
// which is already the single source of truth kept up to date at release
// time.
ipcMain.handle('app:getVersion', () => app.getVersion());

// --- Window controls for the custom title bar ---
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

// --- Encrypted session storage (server URL, username, access token) ---
ipcMain.handle('session:save', (_event, data) => {
  try {
    const json = JSON.stringify(data);
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json);
      fs.writeFileSync(CONFIG_PATH, encrypted);
    } else {
      fs.writeFileSync(CONFIG_PATH, Buffer.from(json, 'utf-8'));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('session:load', () => {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const buffer = fs.readFileSync(CONFIG_PATH);
    let json;
    if (safeStorage.isEncryptionAvailable()) {
      json = safeStorage.decryptString(buffer);
    } else {
      json = buffer.toString('utf-8');
    }
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
});

ipcMain.handle('session:clear', () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// --- Discord Rich Presence ---
// Only reachable if the Discord desktop client is running locally (it exposes
// an IPC socket, not something available over the network) — if it's not,
// login() rejects and we just silently skip until the next track/play event
// tries again, rate-limited so a closed Discord doesn't spam retries.
let discordClient = null;
let discordReady = false;
let lastDiscordAttempt = 0;
const DISCORD_RETRY_MS = 10000;

async function ensureDiscordConnected() {
  if (discordReady) return true;
  const now = Date.now();
  if (now - lastDiscordAttempt < DISCORD_RETRY_MS) return false;
  lastDiscordAttempt = now;

  if (!discordClient) {
    discordClient = new DiscordRpcClient({ clientId: DISCORD_CLIENT_ID });
    discordClient.on('ready', () => { discordReady = true; });
    discordClient.on('disconnected', () => { discordReady = false; });
  }
  try {
    await discordClient.login();
    return discordReady;
  } catch (err) {
    return false;
  }
}

ipcMain.handle('discord:setActivity', async (_event, activity) => {
  const connected = await ensureDiscordConnected();
  if (!connected) return { ok: false };
  try {
    await discordClient.user?.setActivity(activity);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('discord:clearActivity', async () => {
  if (!discordReady || !discordClient) return { ok: true };
  try {
    await discordClient.user?.clearActivity();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Deezer's search API doesn't send CORS headers, so the renderer can't call
// it directly — proxied through here instead. Album metadata rarely matches
// Deezer's listing exactly (deluxe/remaster suffixes, "Vol." vs "Volume",
// OST naming, etc.), so try progressively looser queries before giving up.
async function deezerSearch(query, type) {
  try {
    const q = encodeURIComponent(query.trim());
    if (!q) return null;
    const endpoint = type === 'album' ? 'search/album' : 'search';
    const res = await fetch(`https://api.deezer.com/${endpoint}?q=${q}&limit=1`);
    const data = await res.json();
    const entry = data.data?.[0];
    const cover = type === 'album' ? entry?.cover_xl || entry?.cover_big : entry?.album?.cover_xl || entry?.album?.cover_big;
    return cover || null;
  } catch (err) {
    return null;
  }
}

ipcMain.handle('deezer:searchAlbumArt', async (_event, artist, album, trackName) => {
  return (
    (await deezerSearch(`${artist} ${album}`, 'album')) ||
    (await deezerSearch(`${artist} ${trackName}`, 'track')) ||
    (await deezerSearch(`${artist} ${album}`, 'track')) ||
    (await deezerSearch(album, 'album'))
  );
});

// --- Offline downloads ---
// Fetched here (not the renderer) so a multi-MB audio file never has to
// cross the IPC boundary as one big message — only the resulting file path
// does.
const EXT_BY_CONTENT_TYPE = {
  'audio/mpeg': '.mp3',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac'
};

function downloadedFilePath(itemId) {
  if (!fs.existsSync(DOWNLOADS_DIR)) return null;
  const match = fs.readdirSync(DOWNLOADS_DIR).find((name) => name.startsWith(`${itemId}.`));
  return match ? path.join(DOWNLOADS_DIR, match) : null;
}

ipcMain.handle('downloads:save', async (_event, itemId, url, headers) => {
  try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, error: `Server responded ${res.status}` };
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    const ext = EXT_BY_CONTENT_TYPE[contentType] || '.mp3';
    const filePath = path.join(DOWNLOADS_DIR, `${itemId}${ext}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    return { ok: true, path: filePath, sizeBytes: buffer.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('downloads:delete', (_event, itemId) => {
  try {
    const existing = downloadedFilePath(itemId);
    if (existing) fs.unlinkSync(existing);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('downloads:getPath', (_event, itemId) => {
  try {
    return downloadedFilePath(itemId);
  } catch (err) {
    return null;
  }
});

// --- Import from YouTube/YouTube Music/SoundCloud (grab) ---
// Runs the Python/yt-dlp engine in downloader/ as a child process rather
// than reimplementing its logic in JS -- it already handles cookie auth,
// YouTube's JS challenge solving, release-date correction, and pillarboxed
// cover-art cropping, all of which are nontrivial to port. Each stdout line
// is one JSON event (see downloader/cli.py) forwarded to the renderer as-is.
let grabProcess = null;

ipcMain.handle('grab:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.on('grab:start', (event, { url, outputDir }) => {
  if (grabProcess) {
    event.sender.send('grab:event', { type: 'error', message: 'A download is already in progress.' });
    return;
  }

  grabProcess = spawn(PYTHON_EXE, [GRAB_CLI, url, outputDir], { cwd: path.dirname(GRAB_CLI) });
  let buffer = '';

  grabProcess.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // last entry may be a partial line -- keep it for next chunk
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        event.sender.send('grab:event', JSON.parse(line));
      } catch (err) {
        // Non-JSON stray output (e.g. a library warning) -- surface as a log line rather than drop it silently.
        event.sender.send('grab:event', { type: 'log', message: line });
      }
    }
  });

  grabProcess.stderr.on('data', (chunk) => {
    event.sender.send('grab:event', { type: 'log', message: chunk.toString().trim() });
  });

  grabProcess.on('close', (code) => {
    grabProcess = null;
    if (code !== 0) event.sender.send('grab:event', { type: 'error', message: `Process exited with code ${code}` });
  });

  grabProcess.on('error', (err) => {
    grabProcess = null;
    event.sender.send('grab:event', { type: 'error', message: `Could not start Python: ${err.message}` });
  });
});

ipcMain.on('grab:cancel', () => {
  grabProcess?.kill();
  grabProcess = null;
});
