// Abstracts the bits that differ between the three shells this app can run
// in: the Electron desktop build (window.api from preload.js), a Capacitor
// native build (window.Capacitor.Plugins.*, injected automatically by the
// native runtime — no bundler/import needed), and a plain browser fallback.

const SESSION_KEY = 'triptych_session';

const isElectron = typeof window !== 'undefined' && !!window.api;
const isCapacitorNative =
  typeof window !== 'undefined' &&
  !!window.Capacitor &&
  typeof window.Capacitor.isNativePlatform === 'function' &&
  window.Capacitor.isNativePlatform();

export const platform = isElectron ? 'electron' : isCapacitorNative ? 'mobile' : 'web';
export const isDesktop = platform === 'electron';
export const isMobile = platform === 'mobile';
// Distinct from isMobile — some features (native equalizer) only have an
// Android implementation, not iOS, so callers need to tell the two apart.
export const isAndroid = isCapacitorNative && window.Capacitor.getPlatform?.() === 'android';

function preferences() {
  return window.Capacitor?.Plugins?.Preferences || null;
}

export const sessionStore = {
  async save(data) {
    if (isElectron) return window.api.session.save(data);
    const prefs = preferences();
    const json = JSON.stringify(data);
    if (prefs) await prefs.set({ key: SESSION_KEY, value: json });
    else localStorage.setItem(SESSION_KEY, json);
    return { ok: true };
  },
  async load() {
    if (isElectron) return window.api.session.load();
    const prefs = preferences();
    let raw;
    if (prefs) {
      const res = await prefs.get({ key: SESSION_KEY });
      raw = res.value;
    } else {
      raw = localStorage.getItem(SESSION_KEY);
    }
    return raw ? JSON.parse(raw) : null;
  },
  async clear() {
    if (isElectron) return window.api.session.clear();
    const prefs = preferences();
    if (prefs) await prefs.remove({ key: SESSION_KEY });
    else localStorage.removeItem(SESSION_KEY);
    return { ok: true };
  }
};

export const windowControls = {
  minimize: () => isElectron && window.api.window.minimize(),
  maximize: () => isElectron && window.api.window.maximize(),
  close: () => isElectron && window.api.window.close(),
  onStateChange: (cb) => { if (isElectron) window.api.window.onStateChange(cb); }
};

// Hardware back button (Android). `onBack` runs on every press; return true
// from it if you handled it (closed a panel, navigated back), false/nothing
// to let the caller fall through to its own root/exit logic.
export function wireHardwareBackButton(onBack) {
  const app = window.Capacitor?.Plugins?.App;
  if (!app) return;
  app.addListener('backButton', () => onBack());
}

export function exitApp() {
  window.Capacitor?.Plugins?.App?.exitApp();
}

// style: 'light' | 'medium' | 'heavy' — matches Haptics' ImpactStyle values,
// passed as a plain string since the plugin's own enum isn't importable
// without a bundler (see the module header note above).
// Settings -> Haptic feedback (app.js keeps this in sync with the setting).
let hapticsEnabled = true;
export function setHapticsEnabled(enabled) {
  hapticsEnabled = enabled !== false;
}

export function hapticImpact(style = 'light') {
  if (!hapticsEnabled) return;
  window.Capacitor?.Plugins?.Haptics?.impact({ style }).catch(() => {});
}

// Android 13+ requires this to be granted at runtime before the media
// notification (posted by the native MediaSession plugin's foreground
// service) will actually show — without it playback still works, the
// notification/lock-screen controls just stay invisible.
export async function requestNotificationPermission() {
  const localNotifications = window.Capacitor?.Plugins?.LocalNotifications;
  if (!localNotifications) return;
  try {
    await localNotifications.requestPermissions();
  } catch (err) {
    // Not fatal — worst case the media notification doesn't show.
  }
}

// Discord Rich Presence — desktop-only. Discord's local RPC socket isn't
// reachable from a mobile app, so this is a no-op anywhere but Electron.
export async function setDiscordActivity(activity) {
  if (!isDesktop) return;
  try {
    await window.api.discord.setActivity(activity);
  } catch (err) {
    // Discord not running, or RPC hiccup — not worth surfacing to the user.
  }
}

export async function clearDiscordActivity() {
  if (!isDesktop) return;
  try {
    await window.api.discord.clearActivity();
  } catch (err) {
    // Same as above.
  }
}

export async function searchDeezerAlbumArt(artist, album, trackName) {
  if (!isDesktop) return null;
  // Settings → Privacy → "Online album art lookup" -- this is the only
  // outbound call in the app that sends free-text derived from a user's
  // library, so it gets its own explicit opt-out. Imported lazily to avoid
  // a load-order/circular-import dependency between the two modules.
  const { getSettings } = await import('./settings.js');
  if (!getSettings().albumArtLookupEnabled) return null;
  try {
    return await window.api.deezer.searchAlbumArt(artist, album, trackName);
  } catch (err) {
    return null;
  }
}

// Deezer's artist API (related artists for smart shuffle, see
// recommend.js). No CORS headers, so desktop goes through the main process
// and phones through Capacitor's native HTTP. The caller checks the privacy
// setting. Resolves to the parsed JSON, or null on any failure.
export async function deezerApiGet(path, params = {}) {
  try {
    if (isDesktop) return await window.api.deezer.get(path, params);
    const http = window.Capacitor?.Plugins?.CapacitorHttp;
    if (!isMobile || !http) return null;
    const qs = new URLSearchParams(params).toString();
    const res = await http.request({ url: `https://api.deezer.com${path}${qs ? `?${qs}` : ''}`, method: 'GET', connectTimeout: 10000, readTimeout: 10000 });
    if (res.status !== 200) return null;
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch (err) {
    return null;
  }
}
