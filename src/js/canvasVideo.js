// Spotify-style canvas: a looping video behind the Now Playing panel, from the user's own server (see findCanvasVideo in jellyfin.js),
// else a GIF of the song from GIPHY. Fades in once it has a frame, with a
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
  if (on) matchPanelColor();
  video.classList.toggle('shown', on);
  panel.classList.toggle('has-canvas', on);
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
  requestAnimationFrame(matchPanelColor); // theme may have just changed
  const key = activeGiphyKey();
  if (key !== giphyKey) {
    // Key changed or GIFs turned on/off: forget GIF results and misses,
    // keep the server's own videos.
    giphyKey = key;
    for (const [id, hit] of found) if (!hit || hit.source === 'giphy') found.delete(id);
    const c = cache();
    for (const id of Object.keys(c)) if (!c[id].v) delete c[id]; // misses get a fresh look too
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
      console.warn('[canvas] lookup failed:', track.Name, err?.message || err);
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
    // A server that can't answer (older Jellyfin, Navidrome, an odd item)
    // shouldn't cost the song its GIF.
    try {
      const item = await client.findCanvasVideo(track);
      if (item) return { source: 'server', url: client.canvasVideoUrl(item) };
    } catch (err) {
      console.warn('[canvas] server video lookup failed:', track.Name, err?.message || err);
    }
  }
  if (!activeGiphyKey()) return null;
  const id = `t:${track.Id}`;
  const saved = cacheGet(id);
  if (saved !== undefined) return saved && { source: 'giphy', url: saved };
  const hit = await searchGiphy(track);
  cacheSet(id, hit ? hit.url : null);
  return hit;
}

const MIN_SIDE = 600; // HD renditions are ~1080x680; 480px ones look blocky big
const MIN_FRAMES = 80; // shorter loops stutter like a stuck clip
const STILL_FRAMES = 8; // fewer is a still (a title card, a poster): never
const words = (s) => String(s || '').replace(/\$/g, 's').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const TEXT_GIF = /\b(text|typography|lettering|quote|words?)\b/;
const channels = new Map(); // artist -> GIPHY username | null

// A free GIPHY key allows ~100 searches an hour, so every answer is kept on
// disk: a song, an artist's channel or an artist's clip list is looked up
// once, not on every play or app start. Misses are retried after a week.
const CACHE_KEY = 'triptych:canvasCache';
const HIT_TTL = 30 * 864e5;
const MISS_TTL = 7 * 864e5;
let disk = null;
function cache() {
  if (!disk) {
    try { disk = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (err) { disk = {}; }
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

// Over the hourly limit (429): stop asking for a while instead of burning
// more requests; songs looked up meanwhile get another try afterwards.
let giphyBlockedUntil = 0;
const searches = new Map(); // query -> results, this session

async function giphyGet(path, key, params) {
  const memo = `${path}?${new URLSearchParams(params)}`;
  if (searches.has(memo)) return searches.get(memo);
  if (Date.now() < giphyBlockedUntil) throw new Error('GIPHY rate limited');
  const res = await fetch(`https://api.giphy.com/v1/${path}?${new URLSearchParams({ api_key: key, ...params })}`);
  if (res.status === 401 || res.status === 403) return null; // bad key
  if (res.status === 429) {
    giphyBlockedUntil = Date.now() + 15 * 60 * 1000;
    throw new Error('GIPHY rate limited');
  }
  // Down: look again later. Any other refusal = nothing found.
  if (res.status >= 500) throw new Error(`GIPHY ${res.status}`);
  const data = res.ok ? ((await res.json()).data || []) : [];
  // Trimmed to what bestGif reads, so the session memo stays small.
  const slim = data.map((g) => ({
    title: g.title, slug: g.slug, username: g.username, is_sticker: g.is_sticker,
    display_name: g.display_name, user: g.user && { username: g.user.username, display_name: g.user.display_name, is_verified: g.user.is_verified },
    images: g.images && { hd: g.images.hd, original_mp4: g.images.original_mp4, original: g.images.original && { frames: g.images.original.frames } }
  }));
  searches.set(memo, slim);
  return slim;
}

// GIPHY refuses queries over 50 characters, and "(From the Motion
// Picture ...)", "feat. ..." or "- Remastered" only make matches worse.
function cleanTitle(name) {
  return String(name || '')
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live).*$/i, '')
    .trim();
}

function query(...parts) {
  let q = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (q.length > 50) q = q.slice(0, 50).replace(/\s+\S*$/, '');
  return q;
}

// The artist's own verified GIPHY channel (most labels post music-video
// footage there): same name, or initials ("mgk" -> Machine Gun Kelly).
async function artistChannel(artist, key) {
  const a = words(artist);
  if (channels.has(a)) return channels.get(a);
  const saved = cacheGet(`ch:${a}`);
  if (saved !== undefined) { channels.set(a, saved); return saved; }
  const list = (await giphyGet('channels/search', key, { q: query(artist.replace(/\$/g, 's')), limit: '10' })) || [];
  const flat = a.replace(/ /g, '');
  const match = list.find((c) => {
    if (!c.user?.is_verified) return false;
    const name = words(c.display_name || c.user?.display_name);
    const initials = name.split(' ').map((w) => w[0]).join('');
    return name === a || name.replace(/ /g, '') === flat || (flat.length >= 2 && initials === flat);
  });
  const user = match?.user?.username || null;
  channels.set(a, user);
  cacheSet(`ch:${a}`, user);
  return user;
}

// The song's name wins, then sharpness (HD), then long loops (most frames).
function bestGif(data, title, mustMatch, seed) {
  const ranked = data
    .map((g) => {
      // GIPHY's HD rendition (often 1080p) where there is one; the
      // regular original_mp4 tops out around 480px and looks blocky big.
      const o = g.images?.hd?.mp4 ? g.images.hd : (g.images?.original_mp4 || {});
      const name = words(`${g.title} ${g.slug}`);
      return {
        url: o.mp4,
        text: TEXT_GIF.test(name) || g.is_sticker,
        side: Math.min(+o.width || 0, +o.height || 0),
        frames: +g.images?.original?.frames || 0,
        still: (+g.images?.original?.frames || 0) < STILL_FRAMES,
        song: !!title && name.includes(title),
        named: mustMatch(name, g)
      };
    })
    .filter((g) => g.url && !g.text && !g.still && g.named)
    .sort((x, y) => y.song - x.song || (y.side >= MIN_SIDE) - (x.side >= MIN_SIDE)
      || (y.frames >= MIN_FRAMES) - (x.frames >= MIN_FRAMES) || y.frames - x.frames);
  if (!ranked.length) return null;
  // No clip of this song: a different one of the artist's best per song,
  // instead of the same clip on all of them.
  let pick = ranked[0];
  if (seed && !pick.song) {
    const pool = ranked.slice(0, 8);
    let h = 0;
    for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    pick = pool[h % pool.length];
  }
  return { source: 'giphy', url: pick.url };
}

// Settings -> Canvas videos -> GIPHY key (free at developers.giphy.com).
// 1. the song in the artist's own channel, 2. anything from that channel,
// 3. a general search, only GIFs that name the artist or the song. No good
// match = the cover stays (better than a stranger's GIF).
async function searchGiphy(track) {
  const key = activeGiphyKey();
  const artist = (track.Artists?.[0] || track.AlbumArtist || '').trim();
  const song = cleanTitle(track.Name);
  const title = words(song);
  if (!key || !artist) return null;
  const params = { limit: '50', rating: 'pg-13', lang: 'en' };
  const search = async (q) => (await giphyGet('gifs/search', key, { ...params, q })) || [];
  // Featured or co-artists too: the first one with a channel.
  let user = null;
  const names = [...new Set([...(track.Artists || []), track.AlbumArtist].map((n) => (n || '').trim()).filter(Boolean))].slice(0, 3);
  for (const name of names) if ((user = await artistChannel(name, key))) break;
  if (user) {
    const own = () => true;
    // The song, then its album (labels often name clips after the
    // record), then any of the artist's own clips.
    if (title) {
      const hit = bestGif(await search(query(`@${user}`, song)), title, own);
      if (hit) return hit;
    }
    const album = cleanTitle(track.Album);
    if (album && words(album) !== title) {
      const hit = bestGif(await search(query(`@${user}`, album)), title, own, track.Id);
      if (hit) return hit;
    }
    const hit = bestGif(await search(`@${user}`), title, own, track.Id);
    if (hit) return hit;
  }
  // No channel: only GIFs naming this song (by title) or posted by an
  // account with the artist's name -- a stranger's GIF that merely shares
  // a word with the artist ("Little Big ... by Oliver Tree") doesn't count.
  if (!title) return null;
  const flat = words(artist).replace(/ /g, '');
  return bestGif(await search(query(artist.replace(/\$/g, 's'), song)), title,
    (name, g) => name.includes(title) || words(g.username).replace(/ /g, '') === flat);
}

// Plays along with the song (call on every play/pause).
export function syncCanvasPlayback() {
  if (!video?.getAttribute('src')) return;
  const audio = getAudio();
  if (!audio || audio.paused || document.hidden) video.pause();
  else video.play().catch(() => {});
}
