const STORAGE_KEY = 'triptych:settings';

export const PALETTES = {
  // Each interface style's own accent (Spotify green / Apple red / Nothing
  // red) -- the swatch shows the current style's, see --style-accent.
  default: { label: 'Default', accent: 'var(--style-accent)' },
  blue: { label: 'Blue', accent: '#3b82f6', accentHover: '#60a5fa' },
  green: { label: 'Green', accent: '#1ed760', accentHover: '#3be275' },
  red: { label: 'Red', accent: '#ef4444', accentHover: '#f87171' },
  magenta: { label: 'Magenta', accent: '#d946ef', accentHover: '#e879f9' },
  purple: { label: 'Purple', accent: '#a855f7', accentHover: '#c084fc' },
  pink: { label: 'Pink', accent: '#f472b6', accentHover: '#f9a8d4' },
  orange: { label: 'Orange', accent: '#f97316', accentHover: '#fb923c' },
  yellow: { label: 'Yellow', accent: '#facc15', accentHover: '#fde047' },
  teal: { label: 'Teal', accent: '#14b8a6', accentHover: '#2dd4bf' },
  brown: { label: 'Brown', accent: '#b07a4f', accentHover: '#c49167' },
  mono: { label: 'Monochrome', accent: 'linear-gradient(135deg, #f2f2f2 50%, #1a1a1a 50%)' }
};

export const UI_STYLES = ['spotify', 'apple', 'nothing'];

export const AUDIO_QUALITIES = {
  auto: { label: 'Automatic (best available)', bitrateKbps: 0 },
  high: { label: 'High — 320 kbps', bitrateKbps: 320 },
  medium: { label: 'Medium — 192 kbps', bitrateKbps: 192 },
  low: { label: 'Low — 96 kbps', bitrateKbps: 96 }
};

const DEFAULTS = {
  themeMode: 'dark', // 'dark' | 'light' | 'system'
  palette: 'default', // a PALETTES key; 'default' = the interface style's own accent
  uiStyle: 'nothing', // 'spotify' | 'apple' | 'nothing' -- see css/apple.css, css/nothing.css; new installs start in Nothing
  nothingDottedSliders: true, // Nothing style only: dot-matrix seek/volume bars, off = plain lines
  audioQuality: 'auto',
  artBackground: false,
  dynamicAccentColor: false,
  language: 'en_US',
  customCss: '',
  crossfadeSeconds: 0, // 0-12, 0 = off (gapless preloading is always on regardless)
  replayGainEnabled: false,
  catJam: false,
  catJamScale: 1, // 0.5-3, multiplier on the cat's base 110px size
  eqEnabled: false,
  eqGains: [0, 0, 0, 0, 0], // dB, one per EQ_BANDS entry in player.js, -12 to 12
  eqPreset: 'flat',
  loudnessBoostDb: 10, // Android only, 0-20 -- native android.media.audiofx.LoudnessEnhancer gain, see LoudnessPlugin.java
  offlineMode: false, // when on, only downloaded tracks are playable/clickable
  hapticsEnabled: true, // phones: vibration on swipes, long-press menus, pull-to-refresh
  albumArtLookupEnabled: true, // off = never send artist/album/track text to Deezer's search API
  lyricsSearchEnabled: false, // on = index the library's lyrics in the background for search (see lyricsIndex.js)
  autoUpdateCheckEnabled: true, // off = never ping GitHub's releases API in the background
  updatedAt: 0 // bumped on every local change — lets initRemoteSync tell
  // whether this device's settings or the server's saved copy is newer
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    return { ...DEFAULTS };
  }
}

let current = load();
const listeners = [];

// Set once logged in (see initRemoteSync) — updateSettings() pushes to the
// server through this from then on. Settings applied before login (or when
// offline) just stay local until a sync is possible.
let jellyfinClient = null;
let pushTimer = null;

export function getSettings() {
  return current;
}

export function onSettingsChange(callback) {
  listeners.push(callback);
}

export function updateSettings(patch) {
  current = { ...current, ...patch, updatedAt: Date.now() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  applySettings();
  listeners.forEach((cb) => cb(current));
  schedulePush();
}

// Debounced so rapid successive changes (e.g. dragging then nudging a
// slider a couple more times) collapse into one request instead of one per
// change — best-effort throughout, a failed/offline push just means this
// device's settings stay local until the next successful sync.
function schedulePush() {
  if (!jellyfinClient) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    jellyfinClient.saveSyncedSettings(current).catch(() => {});
  }, 1500);
}

// Called once after login (see app.js's enterApp), which awaits this
// before showing the app — a hung fetch on a slow/degraded connection
// (as opposed to no connection at all, which fails fast) would otherwise
// stall app entry indefinitely, so this gives up and falls back to local
// settings after a few seconds rather than risk that.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))
  ]);
}

// Whichever side — this device's local settings, or whatever's saved on
// the server — has the newer updatedAt wins; the other side then adopts
// it, so the same tuning (EQ, theme, loudness boost, etc.) follows the
// account across devices instead of being stuck per-install.
export async function initRemoteSync(client) {
  jellyfinClient = client;
  try {
    const remote = await withTimeout(client.getSyncedSettings(), 4000);
    if (remote && (remote.updatedAt || 0) > (current.updatedAt || 0)) {
      current = { ...DEFAULTS, ...remote };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      applySettings();
      listeners.forEach((cb) => cb(current));
    } else {
      client.saveSyncedSettings(current).catch(() => {});
    }
  } catch (err) {
    // Offline/unreachable at login — already-applied local settings are
    // unaffected, this device just isn't synced for this session.
  }
}

function resolvedThemeMode() {
  if (current.themeMode === 'system') {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return current.themeMode;
}

export function applySettings() {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolvedThemeMode());
  const ui = UI_STYLES.includes(current.uiStyle) ? current.uiStyle : DEFAULTS.uiStyle;
  // A picked accent applies to any style; 'default' (or a palette from an
  // older version that no longer exists) uses the style's own accent:
  // "spotify" (styles.css), "apple" (apple.css) or "nothing" (nothing.css).
  // Community themes still recolor everything -- they target any
  // :root[data-palette].
  const palette = PALETTES[current.palette] && current.palette !== 'default'
    ? current.palette
    : ui;
  root.setAttribute('data-palette', palette);
  root.setAttribute('data-ui', ui);
  root.toggleAttribute('data-nd-line-sliders', current.nothingDottedSliders === false);
  // Custom CSS that sets the app's colors (e.g. a theme from the README's
  // list, @import-ed from src/themes) -- lets apple.css hand colors over.
  const css = current.customCss || '';
  root.toggleAttribute('data-custom-theme', /themes\/[\w.-]+\.css|--(bg|accent|text)\b/.test(css));
}

// "Automatic" = whatever the connection probe in app.js last decided
// (0 = original quality, until it has measured anything).
let autoBitrateKbps = 0;
export function setAutoBitrate(kbps) {
  autoBitrateKbps = kbps || 0;
}
export function getAutoBitrate() {
  return autoBitrateKbps;
}

export function currentBitrateKbps() {
  if (current.audioQuality === 'auto') return autoBitrateKbps;
  return AUDIO_QUALITIES[current.audioQuality]?.bitrateKbps || 0;
}

applySettings();
