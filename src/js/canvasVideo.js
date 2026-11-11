// Spotify-style canvas: the song's music video behind the Now Playing
// panel -- from the server (the Triptych Music Video Data plugin, or its own
// videos, see jellyfin.js), else Apple's preview. Fades in once it has a frame, with a
// shade so the title and controls stay readable; the cover stays on
// battery saver, slow or metered connections, offline mode and Connect.
import { getSettings, onSettingsChange, isPowerSaver, isStaticMotion, getAutoBitrate } from './settings.js';
import { isLocalItemId } from './localLibrary.js';

const FADE_MS = 450;
const found = new Map(); // track Id -> video item | null
let video = null;
let panel = null;
let box = null;
// Phone layout: the canvas fills the whole player. Desktop side panel: it
// fills the top, behind the cover's spot and the title, and fades out above
// the lyrics.
const fullScreen = window.matchMedia('(max-width: 820px)');
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
  box = document.createElement('div');
  box.className = 'now-playing-canvas-box';
  const shade = document.createElement('div');
  shade.className = 'now-playing-canvas-shade';
  box.append(video, shade);
  panel.prepend(box);
  // Desktop: the box ends just under the title/artist, wherever that is.
  const summary = panel.querySelector('.now-playing-summary');
  const fit = () => {
    if (summary) panel.style.setProperty('--canvas-h', `${summary.offsetTop + summary.offsetHeight + 28}px`);
  };
  if (summary && window.ResizeObserver) new ResizeObserver(fit).observe(summary);
  fit();
  place();
  fullScreen.addEventListener('change', place);
  // While focused, any tap brings the player back (and doesn't also press
  // whatever is underneath). Ignores the tap that just switched it on.
  panel.addEventListener('click', (evt) => {
    if (!panel.classList.contains('canvas-focus') || Date.now() - focusSince < 400) return;
    evt.stopPropagation();
    evt.preventDefault();
    toggleCanvasFocus(false);
  }, true);
  video.addEventListener('loadedmetadata', () => {
    // Start where the song is, when the stream allows seeking.
    if (Number.isFinite(video.duration) && video.duration > 0 && video.seekable.length) {
      video.currentTime = (getAudio()?.currentTime || 0) % video.duration;
    }
  });
  video.addEventListener('loadeddata', () => setShown(true));
  video.addEventListener('error', () => { if (video.getAttribute('src')) unload(); });
  document.addEventListener('visibilitychange', syncCanvasPlayback);
  sourcesKey = String(getSettings().appleVideos !== false);
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
  return true;
}

// Videos streamed from the user's own server also need that server to be
// fast (Automatic quality measured it under ~2.5 Mbit/s, see
// probeConnection). Apple's previews come from Apple, whatever the link to
// the server is like -- a slow Tailscale hop shouldn't turn them off.
function serverFastEnough() {
  const kbps = getAutoBitrate();
  return !(getSettings().audioQuality === 'auto' && kbps && kbps < 320);
}

function setShown(on) {
  if (on) matchPanelColor();
  video.classList.toggle('shown', on);
  panel.classList.toggle('has-canvas', on);
  if (!on) toggleCanvasFocus(false);
}

// Phone player: tap the video to see all of it -- the shade, buttons,
// controls and lyrics step aside and the title slides to the bottom -- and
// tap anywhere to bring it all back. Returns whether it switched.
let focusSince = 0;
export function toggleCanvasFocus(force) {
  if (!panel) return false;
  const on = force ?? !panel.classList.contains('canvas-focus');
  if (on === panel.classList.contains('canvas-focus')) return false;
  if (on) {
    if (!fullScreen.matches || !panel.classList.contains('has-canvas')) return false;
    // How far the title row travels: down to just above the bottom edge.
    const row = panel.querySelector('.now-playing-info-row')?.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    if (row) panel.style.setProperty('--focus-shift', `${Math.max(0, box.bottom - row.bottom - 44)}px`);
    focusSince = Date.now();
  }
  panel.classList.toggle('canvas-focus', on);
  return true;
}

// Desktop fade ends in the panel's real background (each interface style
// paints it differently), so there's no seam above the lyrics.
function matchPanelColor() {
  panel.style.removeProperty('--panel-bg');
  const bg = getComputedStyle(panel).backgroundColor;
  if (bg && !/rgba\(.*,\s*0\)$|transparent/.test(bg)) panel.style.setProperty('--panel-bg', bg);
}

function place() {
  panel.classList.toggle('canvas-top', !fullScreen.matches);
  if (!fullScreen.matches) toggleCanvasFocus(false);
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

let sourcesKey = '';
function refresh() {
  if (!video) return;
  requestAnimationFrame(matchPanelColor); // theme may have just changed
  const key = String(getSettings().appleVideos !== false);
  if (key !== sourcesKey) {
    // Apple turned on/off: forget its results and misses, keep the
    // server's own videos.
    sourcesKey = key;
    for (const [id, hit] of found) if (!hit || hit.source === 'apple') found.delete(id);
    const c = cache();
    for (const id of Object.keys(c)) if (!c[id].v) delete c[id]; // misses get a fresh look too
    currentId = null;
  }
  if (!allowed()) { if (currentId || video.getAttribute('src')) { loadToken++; fadeOut().then(unload); } return; }
  setCanvasTrack(lastTrack);
}

// One lookup per track at a time: a prefetch already under way is reused
// when the track starts.
const lookups = new Map();
function lookup(track) {
  if (found.has(track.Id)) return Promise.resolve(found.get(track.Id));
  if (!lookups.has(track.Id)) {
    lookups.set(track.Id, findCanvas(track)
      .then((hit) => { found.set(track.Id, hit); return hit; })
      .finally(() => lookups.delete(track.Id)));
  }
  return lookups.get(track.Id);
}

// The next song in the queue, looked up while this one plays, so its
// video is ready the moment it starts.
export function prefetchCanvas(track) {
  if (!video || !track?.Id || !allowed()) return;
  lookup(track).catch(() => {});
}

async function load(track) {
  const token = ++loadToken;
  await fadeOut();
  if (token !== loadToken) return;
  unload();
  if (!track || !allowed()) return;
  currentId = track.Id;
  let hit;
  try {
    hit = await lookup(track);
  } catch (err) {
    // Unreachable for now -- look again next time this track comes up.
    console.warn('[canvas] lookup failed:', track.Name, err?.message || err);
    if (token === loadToken) currentId = null;
    return;
  }
  if (token !== loadToken || !hit || !allowed()) return;
  video.src = hit.url;
  syncCanvasPlayback();
}

// 1. the server's own video for the song (a Music Videos library entry or
// an album's theme video): your own file beats a preview, 2. what the
// Triptych Music Video Data plugin assigned (the server looked it up ahead
// of time), 3. the song's music video from Apple. 1 and 2 are asked at once.
async function findCanvas(track) {
  const client = getClient();
  const server = client && !client.isLocal && !isLocalItemId(track.Id);
  // A server that can't answer (older Jellyfin, Navidrome, no plugin, an
  // odd item) shouldn't cost the song its video.
  const pluginAnswer = server && typeof client.getAssignedMusicVideo === 'function'
    ? client.getAssignedMusicVideo(track.Id).catch((err) => {
      console.warn('[canvas] plugin lookup failed:', track.Name, err?.message || err);
      return undefined;
    })
    : Promise.resolve(undefined);
  const ownVideo = server && typeof client.findCanvasVideo === 'function' && serverFastEnough()
    ? client.findCanvasVideo(track).catch((err) => {
      console.warn('[canvas] server video lookup failed:', track.Name, err?.message || err);
      return null;
    })
    : Promise.resolve(null);
  const item = await ownVideo;
  if (item) return { source: 'server', url: client.canvasVideoUrl(item) };
  const assigned = await pluginAnswer;
  if (assigned) return { source: 'plugin', url: assigned };
  // The plugin already asked Apple: no point asking again from here.
  const pluginSaidNone = assigned === null;
  if (pluginSaidNone || getSettings().appleVideos === false) return null;
  const id = `a:${track.Id}`;
  let url = cacheGet(id);
  if (url === undefined) {
    url = await searchAppleVideo(track);
    cacheSet(id, url);
  }
  return url ? { source: 'apple', url } : null;
}

// Apple's free iTunes Search API (no key): the song's real music video as
// a 30-second HD preview. Only an exact artist + title match counts -- a
// different song's video is worse than the cover. Artist + title first,
// then the title alone (Apple's search sometimes misses the pair). Apple
// allows ~20 searches a minute; a refusal pauses lookups for 5 minutes.
let appleBlockedUntil = 0;
async function appleSearch(term) {
  if (Date.now() < appleBlockedUntil) throw new Error('Apple rate limited');
  const params = new URLSearchParams({ term, media: 'musicVideo', entity: 'musicVideo', limit: '25' });
  const res = await fetch(`https://itunes.apple.com/search?${params}`);
  if (res.status === 403 || res.status === 429) {
    appleBlockedUntil = Date.now() + 5 * 60 * 1000;
    throw new Error('Apple rate limited');
  }
  if (res.status >= 500) throw new Error(`Apple ${res.status}`);
  if (!res.ok) return [];
  return (await res.json()).results || [];
}

async function searchAppleVideo(track) {
  const names = [...new Set([...(track.Artists || []), track.AlbumArtist].map((n) => words(n)).filter(Boolean))];
  const song = cleanTitle(track.Name);
  const title = words(song);
  if (!names.length || !title) return null;
  const match = (r) => {
    if (!r.previewUrl) return false;
    const artist = words(r.artistName);
    const byArtist = names.some((n) => artist === n || artist.includes(n) || n.includes(artist));
    const name = words(cleanTitle(r.trackName));
    return byArtist && (name === title || name.startsWith(`${title} `) || title.startsWith(`${name} `));
  };
  for (const term of [query(names[0], song), query(song)]) {
    const hit = (await appleSearch(term)).find(match);
    if (hit) return hit.previewUrl;
  }
  return null;
}

// No accents: Apple writes "Zavisly" where libraries have "závislý".
const words = (s) => String(s || '').replace(/\$/g, 's').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Every answer is kept on disk, so a song is looked up once, not on every
// play or app start. Misses are retried after a week.
const CACHE_KEY = 'triptych:canvasCache';
const HIT_TTL = 30 * 864e5;
const MISS_TTL = 7 * 864e5;
let disk = null;
function cache() {
  if (!disk) {
    try { disk = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (err) { disk = {}; }
    // Results from 2.5.x's GIF source: dropped.
    for (const id of Object.keys(disk)) if (!id.startsWith('a:')) delete disk[id];
  }
  return disk;
}
function cacheGet(id) {
  const e = cache()[id];
  if (!e || Date.now() - e.t > (e.v ? HIT_TTL : MISS_TTL)) return undefined;
  return e.v;
}
let saveTimer = null;
function cacheSet(id, v) {
  const c = cache();
  c[id] = { v, t: Date.now() };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keys = Object.keys(c);
    // Keep it small: the newest 1500 entries.
    if (keys.length > 1500) keys.sort((x, y) => c[x].t - c[y].t).slice(0, keys.length - 1500).forEach((k) => delete c[k]);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (err) {}
  }, 1000);
}

// Apple's search does better without "(From the Motion Picture ...)",
// "feat. ..." or "- Remastered", and long terms get cut.
function cleanTitle(name) {
  return String(name || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live).*$/i, '')
    .trim();
}

function query(...parts) {
  let q = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (q.length > 80) q = q.slice(0, 80).replace(/\s+\S*$/, '');
  return q;
}

// Plays along with the song (call on every play/pause).
export function syncCanvasPlayback() {
  if (!video?.getAttribute('src')) return;
  const audio = getAudio();
  if (!audio || audio.paused || document.hidden) video.pause();
  else video.play().catch(() => {});
}
