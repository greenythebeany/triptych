// Spotify-style canvas: a looping video behind the whole Now Playing
// panel, from the user's own server (see findCanvasVideo in jellyfin.js),
// else a GIF of the song from GIPHY. Fades in once it has a frame, with a
// shade so the title and controls stay readable; the cover stays on
// battery saver, slow or metered connections, offline mode and Connect.
import { getSettings, onSettingsChange, isPowerSaver, isStaticMotion, getAutoBitrate } from './settings.js';
import { isLocalItemId } from './localLibrary.js';

const FADE_MS = 450;
const found = new Map(); // track Id -> video item | null
let video = null;
let panel = null;
let shade = null;
let getAudio = () => null;
let getClient = () => null;
let lastTrack = null;
let currentId = null; // track whose video is loaded (or being looked up)
let loadToken = 0;

// Safe to call again on re-login: only the getters are swapped.
export function initCanvasVideo({ panel: panelEl, audio, client }) {
  getAudio = audio;
  getClient = client;
  if (video) return;
  video = document.createElement('video');
  video.className = 'now-playing-canvas';
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.disablePictureInPicture = true;
  video.setAttribute('aria-hidden', 'true');
  panel = panelEl;
  shade = document.createElement('div');
  shade.className = 'now-playing-canvas-shade';
  panel.prepend(video, shade);
  video.addEventListener('loadedmetadata', () => {
    // Start where the song is, when the stream allows seeking.
    if (Number.isFinite(video.duration) && video.duration > 0 && video.seekable.length) {
      video.currentTime = (getAudio()?.currentTime || 0) % video.duration;
    }
  });
  video.addEventListener('loadeddata', () => setShown(true));
  video.addEventListener('error', () => { if (video.getAttribute('src')) unload(); });
  document.addEventListener('visibilitychange', syncCanvasPlayback);
  giphyKey = activeGiphyKey();
  onSettingsChange(refresh);
  navigator.connection?.addEventListener?.('change', refresh);
  window.addEventListener('offline', refresh);
  window.addEventListener('online', refresh);
}

function allowed() {
  const s = getSettings();
  if (s.canvasVideos === false || s.offlineMode || isPowerSaver() || navigator.onLine === false) return false;
  const conn = navigator.connection;
  // effectiveType's '3g' is a rough guess Chromium also gives fast desktop
  // links -- the measured probe below is the real check.
  if (conn?.saveData || /2g/.test(conn?.effectiveType || '')) return false;
  if (s.audioQuality === 'low') return false;
  // Automatic quality measured under ~2.5 Mbit/s (see probeConnection).
  const kbps = getAutoBitrate();
  if (s.audioQuality === 'auto' && kbps && kbps < 320) return false;
  return true;
}

function setShown(on) {
  video.classList.toggle('shown', on);
  panel.classList.toggle('has-canvas', on);
}

function unload() {
  currentId = null;
  setShown(false);
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function fadeOut() {
  if (!video.classList.contains('shown')) return Promise.resolve();
  setShown(false);
  return new Promise((resolve) => setTimeout(resolve, isStaticMotion() ? 0 : FADE_MS));
}

// Called on every track change (and with null while Connect drives
// another device). Same track again just keeps what's there.
export function setCanvasTrack(track) {
  lastTrack = track || null;
  if (track && track.Id === currentId && allowed()) { syncCanvasPlayback(); return; }
  load(lastTrack);
}

// The key GIF searches use right now ('' = GIFs off).
function activeGiphyKey() {
  const s = getSettings();
  return s.giphyEnabled === false ? '' : (s.giphyApiKey || '').trim();
}

let giphyKey = '';
function refresh() {
  if (!video) return;
  const key = activeGiphyKey();
  if (key !== giphyKey) {
    // Key changed or GIFs turned on/off: forget GIF results and misses,
    // keep the server's own videos.
    giphyKey = key;
    for (const [id, hit] of found) if (!hit || hit.source === 'giphy') found.delete(id);
    currentId = null;
  }
  if (!allowed()) { if (currentId || video.getAttribute('src')) { loadToken++; fadeOut().then(unload); } return; }
  setCanvasTrack(lastTrack);
}

async function load(track) {
  const token = ++loadToken;
  await fadeOut();
  if (token !== loadToken) return;
  unload();
  if (!track || !allowed()) return;
  currentId = track.Id;
  let hit = found.get(track.Id);
  if (hit === undefined) {
    try {
      hit = await findCanvas(track);
      found.set(track.Id, hit);
    } catch (err) {
      // Unreachable for now -- look again next time this track comes up.
      if (token === loadToken) currentId = null;
      return;
    }
  }
  if (token !== loadToken || !hit || !allowed()) return;
  video.src = hit.url;
  syncCanvasPlayback();
}

// The server's own video first, then GIPHY.
async function findCanvas(track) {
  const client = getClient();
  if (client && !client.isLocal && typeof client.findCanvasVideo === 'function' && !isLocalItemId(track.Id)) {
    const item = await client.findCanvasVideo(track);
    if (item) return { source: 'server', url: client.canvasVideoUrl(item) };
  }
  return searchGiphy(track);
}

const MIN_SIDE = 480;
const MIN_FRAMES = 80; // shorter loops stutter like a stuck clip
const words = (s) => String(s || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Settings -> Canvas videos -> GIPHY key (free at developers.giphy.com).
// Song first, then just the artist. Long loops win (most frames), then a
// name match, then sharpness -- original_mp4 is the upload's full
// resolution, not GIPHY's 200px previews.
async function searchGiphy(track) {
  const key = activeGiphyKey();
  const artist = (track.Artists?.[0] || track.AlbumArtist || '').trim();
  const title = words(track.Name);
  if (!key || !artist) return null;
  const a = words(artist);
  for (const q of [title && `${artist} ${title}`, artist].filter(Boolean)) {
    const params = new URLSearchParams({ api_key: key, q, limit: '50', rating: 'pg-13', lang: 'en' });
    const res = await fetch(`https://api.giphy.com/v1/gifs/search?${params}`);
    if (res.status === 401 || res.status === 403) return null; // bad key
    if (!res.ok) throw new Error(`GIPHY ${res.status}`);
    const { data } = await res.json();
    const ranked = (data || [])
      .map((g) => {
        const o = g.images?.original_mp4 || {};
        const side = Math.min(+o.width || 0, +o.height || 0);
        const frames = +g.images?.original?.frames || 0;
        const name = words(`${g.title} ${g.slug} ${g.username}`);
        const score = (name.includes(a) ? 2 : 0) + (title && name.includes(title) ? 1 : 0);
        return { url: o.mp4, side, score, frames };
      })
      .filter((g) => g.url)
      .sort((x, y) => (y.frames >= MIN_FRAMES) - (x.frames >= MIN_FRAMES) || y.score - x.score
        || (y.side >= MIN_SIDE) - (x.side >= MIN_SIDE) || y.frames - x.frames);
    if (ranked.length) return { source: 'giphy', url: ranked[0].url };
  }
  return null;
}

// Plays along with the song (call on every play/pause).
export function syncCanvasPlayback() {
  if (!video?.getAttribute('src')) return;
  const audio = getAudio();
  if (!audio || audio.paused || document.hidden) video.pause();
  else video.play().catch(() => {});
}
