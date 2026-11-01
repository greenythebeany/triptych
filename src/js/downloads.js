// Offline downloads — desktop (Electron, via main-process IPC so a multi-MB
// audio file never has to cross the IPC boundary as one message) and Android
// (Capacitor's Filesystem plugin, base64-encoded since the plugin bridge is
// JSON-only). Not available in a plain browser — there's nowhere durable to
// put the file.

import { isDesktop, isMobile } from './platform.js';

const INDEX_KEY = 'triptych:downloads';

function loadIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || '{}');
  } catch (err) {
    return {};
  }
}

function saveIndex() {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch (err) {
    // Storage full/unavailable — downloads already on disk still work this
    // session, they just won't be remembered next launch.
  }
}

let index = loadIndex();
const listeners = [];

function notify() {
  listeners.forEach((cb) => cb());
}

export function onDownloadsChange(cb) {
  listeners.push(cb);
}

export function isSupported() {
  return isDesktop || isMobile;
}

export function isDownloaded(trackId) {
  return !!index[trackId];
}

export function getDownloadedTracks() {
  return Object.entries(index).map(([id, entry]) => ({ id, ...entry }));
}

export function getTotalDownloadedBytes() {
  return Object.values(index).reduce((sum, e) => sum + (e.sizeBytes || 0), 0);
}

function androidFilesystem() {
  return window.Capacitor?.Plugins?.Filesystem || null;
}

function extFromContentType(contentType) {
  const type = (contentType || '').split(';')[0].trim();
  const map = {
    'audio/mpeg': '.mp3',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac'
  };
  return map[type] || '.mp3';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('Could not read downloaded file'));
    reader.readAsDataURL(blob);
  });
}

// Windows paths need each segment percent-encoded to survive as a file://
// URL (a Unicode username is exactly the kind of thing that breaks this if
// done naively) — but the drive letter's colon must be left alone.
function windowsPathToFileUrl(winPath) {
  const parts = winPath.replace(/\\/g, '/').split('/');
  const encoded = parts.map((part, i) => (i === 0 && /^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)));
  return `file:///${encoded.join('/')}`;
}

function entryMeta(track) {
  return {
    name: track.Name,
    album: track.Album || '',
    artist: (track.Artists && track.Artists.length ? track.Artists.join(', ') : track.AlbumArtist) || '',
    imageTag: track.ImageTags?.Primary || null,
    albumId: track.AlbumId || null,
    runTimeTicks: track.RunTimeTicks || 0,
    downloadedAt: Date.now()
  };
}

function extFromImageContentType(contentType) {
  const type = (contentType || '').split(';')[0].trim();
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  return map[type] || '.jpg';
}

// Best-effort — a missing/failed cover shouldn't fail the whole download,
// it just means this offline track falls back to the placeholder art.
async function downloadArtwork(track, jellyfin, headers) {
  const imageUrl = jellyfin.imageUrl(track, 'Primary', 600);
  if (!imageUrl) return null;
  const artKey = `${track.Id}-art`;
  try {
    if (isDesktop) {
      const result = await window.api.downloads.save(artKey, imageUrl, headers);
      return result.ok ? result.path : null;
    }
    const fs = androidFilesystem();
    if (!fs) return null;
    const res = await fetch(imageUrl, { headers });
    if (!res.ok) return null;
    const blob = await res.blob();
    const fileName = `${artKey}${extFromImageContentType(res.headers.get('content-type'))}`;
    const base64 = await blobToBase64(blob);
    await fs.writeFile({ path: fileName, data: base64, directory: 'DATA' });
    return fileName;
  } catch (err) {
    return null;
  }
}

// Downloads at direct-play quality (no bitrate cap) — the point of an
// offline copy is not re-transcoding it down every time you're not on wifi.
export async function downloadTrack(track, jellyfin) {
  if (index[track.Id] || !isSupported()) return isDownloaded(track.Id);
  const url = jellyfin.streamUrl(track, 0);
  const headers = jellyfin.getAuthHeaders();

  if (isDesktop) {
    const result = await window.api.downloads.save(track.Id, url, headers);
    if (!result.ok) throw new Error(result.error || 'Download failed');
    const imagePath = await downloadArtwork(track, jellyfin, headers);
    index[track.Id] = { path: result.path, imagePath, sizeBytes: result.sizeBytes || 0, ...entryMeta(track) };
    saveIndex();
    notify();
    return true;
  }

  // isMobile
  const fs = androidFilesystem();
  if (!fs) throw new Error('Downloads are not available on this device.');
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  const blob = await res.blob();
  const fileName = `${track.Id}${extFromContentType(res.headers.get('content-type'))}`;
  const base64 = await blobToBase64(blob);
  await fs.writeFile({ path: fileName, data: base64, directory: 'DATA' });
  const imagePath = await downloadArtwork(track, jellyfin, headers);
  index[track.Id] = { path: fileName, imagePath, sizeBytes: blob.size, ...entryMeta(track) };
  saveIndex();
  notify();
  return true;
}

export async function deleteDownload(trackId) {
  const entry = index[trackId];
  if (!entry) return;
  try {
    if (isDesktop) {
      await window.api.downloads.delete(trackId);
      if (entry.imagePath) await window.api.downloads.delete(`${trackId}-art`);
    } else if (isMobile) {
      const fs = androidFilesystem();
      if (fs) {
        await fs.deleteFile({ path: entry.path, directory: 'DATA' }).catch(() => {});
        if (entry.imagePath) await fs.deleteFile({ path: entry.imagePath, directory: 'DATA' }).catch(() => {});
      }
    }
  } finally {
    delete index[trackId];
    saveIndex();
    notify();
  }
}

// The WebView is loaded from an https:// origin, not file:// — a raw
// file:///.../content:// URI from the Filesystem plugin can't be loaded as
// an <audio>/<img> src directly from there, it has to go through
// Capacitor's own bridge scheme first.
function toWebViewSrc(nativeUri) {
  return window.Capacitor?.convertFileSrc ? window.Capacitor.convertFileSrc(nativeUri) : nativeUri;
}

// A URI the <img> element can actually load from, or null if this track has
// no downloaded cover (not downloaded at all, or its download predates this
// feature, or the art fetch failed at download time) — callers should fall
// back to the usual placeholder art in that case.
export async function getLocalImageUri(trackId) {
  const entry = index[trackId];
  if (!entry || !entry.imagePath) return null;
  if (isDesktop) return windowsPathToFileUrl(entry.imagePath);
  if (isMobile) {
    const fs = androidFilesystem();
    if (!fs) return null;
    try {
      const result = await fs.getUri({ directory: 'DATA', path: entry.imagePath });
      return toWebViewSrc(result.uri);
    } catch (err) {
      return null;
    }
  }
  return null;
}

// The saved cover as something the OS media controls can load without the
// server: a file:// URL for Windows SMTC / desktop, a data: URL on phones
// (the native media-session plugin only fetches http(s) or data: URLs, and
// can't reach the WebView's own localhost paths). null if there's none.
export async function getLocalArtwork(trackId) {
  const entry = index[trackId];
  if (!entry || !entry.imagePath) return null;
  if (isDesktop) return windowsPathToFileUrl(entry.imagePath);
  const fs = isMobile ? androidFilesystem() : null;
  if (!fs) return null;
  try {
    const { data } = await fs.readFile({ path: entry.imagePath, directory: 'DATA' });
    if (!data || typeof data !== 'string') return null;
    const ext = (entry.imagePath.split('.').pop() || '').toLowerCase();
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return `data:${type};base64,${data}`;
  } catch (err) {
    return null;
  }
}

// A URI the <audio> element can actually play from, or null if this track
// isn't downloaded (or downloads aren't supported here).
export async function getLocalUri(trackId) {
  const entry = index[trackId];
  if (!entry) return null;
  if (isDesktop) return windowsPathToFileUrl(entry.path);
  if (isMobile) {
    const fs = androidFilesystem();
    if (!fs) return null;
    try {
      const result = await fs.getUri({ directory: 'DATA', path: entry.path });
      return toWebViewSrc(result.uri);
    } catch (err) {
      return null;
    }
  }
  return null;
}
