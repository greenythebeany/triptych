// "Music on this device" mode (desktop): scans the folders the user picked
// for audio files, reads their tags with music-metadata, and serves the files
// and their cover art to the renderer over the tlocal:// scheme. Only files
// found by a scan are served, so the renderer can't use the scheme to read
// anything else on disk.

const { app, protocol, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');

const SCHEME = 'tlocal';
const LIBRARY_PATH = path.join(app.getPath('userData'), 'local-library.json');
const COVERS_DIR = path.join(app.getPath('userData'), 'local-covers');
const LIBRARY_VERSION = 1;
const COVER_MAX_PX = 800;
const FOLDER_ART = ['cover', 'folder', 'front', 'album', 'albumart'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav'
};

let library = { version: LIBRARY_VERSION, folders: [], tracks: [] };
let pathById = new Map();
let scanning = null;

// Must run before the app's ready event.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }]);
}

function loadLibrary() {
  try {
    const data = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
    if (data?.version === LIBRARY_VERSION) library = data;
  } catch (err) {
    // First run, or a corrupt file: start empty, the next scan rebuilds it.
  }
  pathById = new Map(library.tracks.map((tr) => [tr.id, tr.path]));
}

function saveLibrary() {
  try {
    fs.writeFileSync(LIBRARY_PATH, JSON.stringify(library));
  } catch (err) {
    console.log('[local] could not save library:', err.message);
  }
}

const hash = (value, length = 20) => crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
// Stable across rescans, so likes, plays and playlists keep pointing at the same file.
// "lt" prefix: never a valid (all-hex) Jellyfin id, so the renderer can tell sources apart.
const trackId = (file) => `lt${hash(process.platform === 'win32' ? file.toLowerCase() : file)}`;

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && MIME_BY_EXT[path.extname(entry.name).toLowerCase()]) out.push(full);
  }
}

// Saves one downscaled JPEG per distinct image, named by its content hash, so
// an album's tracks all share one file.
function saveCover(buffer) {
  const name = hash(buffer, 24);
  const file = path.join(COVERS_DIR, `${name}.jpg`);
  if (fs.existsSync(file)) return name;
  try {
    let img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    if (Math.max(width, height) > COVER_MAX_PX) {
      img = width >= height ? img.resize({ width: COVER_MAX_PX, quality: 'best' }) : img.resize({ height: COVER_MAX_PX, quality: 'best' });
    }
    fs.mkdirSync(COVERS_DIR, { recursive: true });
    fs.writeFileSync(file, img.toJPEG(90));
    return name;
  } catch (err) {
    return null;
  }
}

const folderArtCache = new Map();
function folderCover(dir) {
  if (folderArtCache.has(dir)) return folderArtCache.get(dir);
  let cover = null;
  try {
    const names = fs.readdirSync(dir);
    const match = names.find((n) => {
      const ext = path.extname(n).toLowerCase();
      return IMAGE_EXTS.includes(ext) && FOLDER_ART.includes(path.basename(n, path.extname(n)).toLowerCase());
    });
    if (match) cover = saveCover(fs.readFileSync(path.join(dir, match)));
  } catch (err) {
    // unreadable folder: no cover
  }
  folderArtCache.set(dir, cover);
  return cover;
}

let mm = null;
async function musicMetadata() {
  if (!mm) mm = await import('music-metadata');
  return mm;
}

async function readTrack(file, stat) {
  const { parseFile } = await musicMetadata();
  let meta;
  try {
    meta = await parseFile(file, { duration: false });
    if (!meta.format.duration) meta = await parseFile(file, { duration: true });
  } catch (err) {
    meta = { common: {}, format: {} };
  }
  const c = meta.common || {};
  const picture = c.picture?.find((p) => /front/i.test(p.type || '')) || c.picture?.[0];
  // A file with an ID3v2 tag but no track number in it falls back to the old
  // ID3v1 block, whose track byte is often junk (yt-dlp files read as 63).
  const native = meta.native || {};
  const v2 = Object.keys(native).filter((k) => k.startsWith('ID3v2'));
  const trackFromV1Only = native.ID3v1 && v2.length && !v2.some((k) => native[k].some((t) => t.id === 'TRCK'));
  const artists = [...new Set((c.artists?.length ? c.artists : c.artist ? [c.artist] : []).flatMap((a) => a.split(/\s*;\s*/)).map((a) => a.trim()).filter(Boolean))];
  return {
    id: trackId(file),
    path: file,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    addedMs: Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs),
    title: c.title?.trim() || path.basename(file, path.extname(file)),
    artists,
    albumArtist: c.albumartist?.trim() || null,
    album: c.album?.trim() || null,
    track: (!trackFromV1Only && c.track?.no) || null,
    disc: c.disk?.no || null,
    year: c.year || null,
    genres: (c.genre || []).flatMap((g) => g.split(/\s*[;/]\s*/)).map((g) => g.trim()).filter(Boolean),
    duration: meta.format.duration || 0,
    gain: c.replaygain_track_gain?.dB ?? null,
    cover: (picture?.data && saveCover(Buffer.from(picture.data))) || folderCover(path.dirname(file))
  };
}

async function scan(onProgress) {
  if (scanning) return scanning;
  scanning = (async () => {
    folderArtCache.clear();
    const files = [];
    for (const folder of library.folders) await walk(folder, files);
    const previous = new Map(library.tracks.map((tr) => [tr.path, tr]));
    const tracks = [];
    let done = 0;
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++];
        try {
          const stat = await fs.promises.stat(file);
          const old = previous.get(file);
          tracks.push(old && old.size === stat.size && old.mtimeMs === stat.mtimeMs ? old : await readTrack(file, stat));
        } catch (err) {
          // vanished mid-scan or unreadable: skip
        }
        done++;
        if (done % 20 === 0 || done === files.length) onProgress?.({ done, total: files.length });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    library.tracks = tracks;
    pathById = new Map(tracks.map((tr) => [tr.id, tr.path]));
    saveLibrary();
    pruneCovers(new Set(tracks.map((tr) => tr.cover).filter(Boolean)));
    return { count: tracks.length };
  })();
  try {
    return await scanning;
  } finally {
    scanning = null;
  }
}

// Covers of files that are gone (folder removed, file deleted).
function pruneCovers(keep) {
  let names = [];
  try { names = fs.readdirSync(COVERS_DIR); } catch (err) { return; }
  for (const name of names) {
    if (!keep.has(path.basename(name, '.jpg'))) {
      try { fs.unlinkSync(path.join(COVERS_DIR, name)); } catch (err) { /* in use or gone */ }
    }
  }
}

function notFound() {
  return new Response('Not found', { status: 404 });
}

function fileResponse(file, rangeHeader, extraHeaders) {
  const { size } = fs.statSync(file);
  const headers = { 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', ...extraHeaders };
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (match && (match[1] || match[2])) {
    let start = match[1] ? Number(match[1]) : size - Number(match[2]);
    let end = match[1] && match[2] ? Number(match[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function coverPath(name) {
  return /^[a-f0-9]{24}$/.test(name || '') ? path.join(COVERS_DIR, `${name}.jpg`) : null;
}

// tlocal://cover/<hash> -> the cached cover file, for the Windows media
// controls (they can't read a custom scheme). souvlaki strips "file://" and
// opens the rest as a plain path, so this is "file://C:\...", not a real
// file URL. Anything else is passed through.
function toOsCoverUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(`${SCHEME}://cover/`)) return url;
  const file = coverPath(url.slice(`${SCHEME}://cover/`.length).split(/[/?#]/)[0]);
  return file && fs.existsSync(file) ? `file://${file}` : undefined;
}

function serve(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return notFound();
  }
  const id = url.pathname.replace(/^\/+/, '');
  try {
    if (url.hostname === 'track') {
      const file = pathById.get(id);
      if (!file || !fs.existsSync(file)) return notFound();
      const type = MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
      return fileResponse(file, request.headers.get('range'), { 'Content-Type': type });
    }
    if (url.hostname === 'cover') {
      const file = coverPath(id);
      if (!file || !fs.existsSync(file)) return notFound();
      return fileResponse(file, null, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000, immutable' });
    }
  } catch (err) {
    return notFound();
  }
  return notFound();
}

// "<name>.lrc" next to the file wins over lyrics embedded in its tags.
async function getLyrics(id) {
  const file = pathById.get(id);
  if (!file) return null;
  const base = file.slice(0, -path.extname(file).length);
  for (const ext of ['.lrc', '.LRC', '.txt']) {
    try {
      return { text: await fs.promises.readFile(base + ext, 'utf8') };
    } catch (err) {
      // no sidecar with this extension
    }
  }
  try {
    const { parseFile } = await musicMetadata();
    const { common } = await parseFile(file, { skipCovers: true, duration: false });
    const tag = common.lyrics?.[0];
    if (!tag) return null;
    if (typeof tag === 'string') return { text: tag };
    if (tag.syncText?.length) return { synced: tag.syncText.map((l) => ({ text: l.text || '', ms: l.timestamp ?? 0 })) };
    return tag.text ? { text: tag.text } : null;
  } catch (err) {
    return null;
  }
}

function publicTrack(tr) {
  const { path: _path, size, mtimeMs, ...rest } = tr;
  return rest;
}

function setup(ipcMain, getWindow) {
  loadLibrary();
  protocol.handle(SCHEME, serve);

  ipcMain.handle('local:pickFolders', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle('local:getFolders', () => library.folders);
  ipcMain.handle('local:setFolders', (_event, folders) => {
    library.folders = [...new Set((Array.isArray(folders) ? folders : []).filter((f) => typeof f === 'string' && path.isAbsolute(f)))];
    saveLibrary();
    return library.folders;
  });
  ipcMain.handle('local:scan', (event) => scan((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('local:scanProgress', progress);
  }));
  ipcMain.handle('local:getTracks', () => library.tracks.map(publicTrack));
  ipcMain.handle('local:getLyrics', (_event, id) => getLyrics(id));
}

module.exports = { registerScheme, setup, toOsCoverUrl };
