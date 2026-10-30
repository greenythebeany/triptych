import './migrate.js'; // must stay first: renames storage keys before other modules read them
import { JellyfinClient, initClientVersion, getClientVersion } from './jellyfin.js';
import { Player, RepeatMode, EQ_PRESETS } from './player.js';
import { fetchLyrics, getCachedLyrics } from './lyrics.js';
import { rememberLyrics, startIndexing, stopIndexing, searchByLyrics, indexStatus, onIndexProgress } from './lyricsIndex.js';
import { addListening, persistLocal as persistListening, getOwnLog, isDirty as listeningDirty, markSynced as listeningSynced, adoptIfLarger, combineLogs, dayKey } from './listening.js';
import { getSettings, updateSettings, applySettings, currentBitrateKbps, setAutoBitrate, getAutoBitrate, initRemoteSync, PALETTES, AUDIO_QUALITIES } from './settings.js';
import { LOCALES, loadLocale, applyTranslations, t } from './i18n.js';
import { setHapticsEnabled, platform, isDesktop, isMobile, isAndroid, sessionStore, windowControls, wireHardwareBackButton, exitApp, requestNotificationPermission, setDiscordActivity, clearDiscordActivity, searchDeezerAlbumArt, hapticImpact } from './platform.js';
import { createConnect } from './connect.js';
import { isSupported as downloadsSupported, isDownloaded, downloadTrack, deleteDownload, onDownloadsChange, getDownloadedTracks, getTotalDownloadedBytes, getLocalImageUri } from './downloads.js';
import { renderGrab } from './grab.js';
import { getPinnedAlbums, isAlbumPinned, togglePinAlbum, onPinnedAlbumsChange } from './pinnedAlbums.js';

// ---------- DOM refs ----------
const loginScreen = document.getElementById('login-screen');
const bootSplash = document.getElementById('boot-splash');

function hideBootSplash() {
  if (!bootSplash || bootSplash.hidden) return;
  bootSplash.classList.add('leaving');
  setTimeout(() => { bootSplash.hidden = true; }, 260);
}
const appRoot = document.getElementById('app');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const btnLogin = document.getElementById('btn-login');
const btnRetryConnection = document.getElementById('btn-retry-connection');

const viewRoot = document.getElementById('view-root');
const playlistListEl = document.getElementById('playlist-list');
const pinnedAlbumsListEl = document.getElementById('pinned-albums-list');
const pinnedAlbumsSectionEl = document.getElementById('pinned-albums-section');
const globalSearchWrap = document.getElementById('global-search-wrap');
const globalSearchInput = document.getElementById('global-search');

const lyricsPanel = document.getElementById('lyrics-panel');
const lyricsBody = document.getElementById('lyrics-body');
const queueBody = document.getElementById('queue-body');
const btnQueueMobile = document.getElementById('btn-queue-mobile');
const btnLyricsMobile = document.getElementById('btn-lyrics-mobile');
const queueSheetTitle = document.getElementById('queue-sheet-title');
const queueSheet = document.getElementById('queue-sheet');
const queueSheetHead = document.getElementById('queue-sheet-head');
const queueSheetBackdrop = document.getElementById('queue-sheet-backdrop');
const nowPlayingArt = document.getElementById('now-playing-art');
const nowPlayingArtWrap = document.querySelector('.now-playing-art-wrap');
const nowPlayingTitle = document.getElementById('now-playing-title');
const nowPlayingArtist = document.getElementById('now-playing-artist');

// Title/artist in the full-screen player: text too long for its column
// slides across to show the end, pauses, and slides back, instead of being
// cut off with an ellipsis. Measured after layout, and again whenever the
// player opens (it has no width while hidden) or the window resizes.
function setMarqueeText(el, text) {
  el.innerHTML = `<span class="marquee-inner">${escapeHtml(text || '')}</span>`;
  el.title = text || '';
  updateMarquee(el);
}

function updateMarquee(el) {
  const inner = el.querySelector('.marquee-inner');
  if (!inner) return;
  el.classList.remove('marquee');
  requestAnimationFrame(() => {
    const overflow = inner.scrollWidth - el.clientWidth;
    if (el.clientWidth > 0 && overflow > 2) {
      el.style.setProperty('--marquee-shift', `${-overflow}px`);
      // ~35px/s of travel, plus the pauses at each end (see the keyframes).
      el.style.setProperty('--marquee-duration', `${Math.max(4, overflow / 35 / 0.6)}s`);
      el.classList.add('marquee');
    }
  });
}

function refreshNowPlayingMarquees() {
  updateMarquee(nowPlayingTitle);
  updateMarquee(nowPlayingArtist);
}
window.addEventListener('resize', refreshNowPlayingMarquees);
const nowPlayingBgArt = document.getElementById('now-playing-bg-art');
const nowPlayingLikeBtn = document.getElementById('now-playing-like-btn');
const nowPlayingDownloadBtn = document.getElementById('now-playing-download-btn');

// Account menu
const btnAccount = document.getElementById('btn-account');
const accountAvatar = document.getElementById('account-avatar');
const accountUsername = document.getElementById('account-username');
const accountMenu = document.getElementById('account-menu');
const accountMenuName = document.getElementById('account-menu-name');
const menuSettings = document.getElementById('menu-settings');
const menuLogout = document.getElementById('menu-logout');

// Settings modal
const settingsOverlay = document.getElementById('settings-overlay');
const btnCloseSettings = document.getElementById('btn-close-settings');
const themeModeToggle = document.getElementById('theme-mode-toggle');
const uiStyleToggle = document.getElementById('ui-style-toggle');
const npVolumeBar = document.getElementById('np-volume-bar');
const paletteGrid = document.getElementById('palette-grid');
const audioQualitySelect = document.getElementById('audio-quality-select');
const languageSelect = document.getElementById('language-select');
const toggleArtBackground = document.getElementById('toggle-art-background');
const toggleDynamicAccentColor = document.getElementById('toggle-dynamic-accent-color');
const crossfadeSlider = document.getElementById('crossfade-slider');
const crossfadeValue = document.getElementById('crossfade-value');
const toggleReplayGain = document.getElementById('toggle-replaygain');
const toggleOfflineMode = document.getElementById('toggle-offline-mode');
const albumArtLookupRow = document.getElementById('album-art-lookup-row');
const toggleAlbumArtLookup = document.getElementById('toggle-album-art-lookup');
const toggleLyricsSearch = document.getElementById('toggle-lyrics-search');
const lyricsIndexStatus = document.getElementById('lyrics-index-status');
const toggleHaptics = document.getElementById('toggle-haptics');
const toggleNothingDots = document.getElementById('toggle-nothing-dots');
const nothingDotsRow = document.getElementById('nothing-dots-row');
const storageSection = document.getElementById('storage-section');
const downloadsUsage = document.getElementById('downloads-usage');
const btnClearDownloads = document.getElementById('btn-clear-downloads');

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

// Settings -> Storage: what the offline downloads take up on this device.
function refreshStorageUI() {
  const count = getDownloadedTracks().length;
  downloadsUsage.textContent = t('settings.downloadsUsage', { count, size: formatBytes(getTotalDownloadedBytes()) });
  btnClearDownloads.disabled = count === 0;
}
const autoUpdateCheckRow = document.getElementById('auto-update-check-row');
const toggleAutoUpdateCheck = document.getElementById('toggle-auto-update-check');
const toggleEqualizer = document.getElementById('toggle-equalizer');
const equalizerToggleRow = document.getElementById('equalizer-toggle-row');
const equalizerBandsRow = document.getElementById('equalizer-bands-row');
const eqBandSliders = document.querySelectorAll('.eq-band-slider');
const btnEqReset = document.getElementById('btn-eq-reset');
const eqPresetSelect = document.getElementById('eq-preset-select');
const loudnessBoostRow = document.getElementById('loudness-boost-row');
const loudnessBoostSlider = document.getElementById('loudness-boost-slider');
const loudnessBoostValue = document.getElementById('loudness-boost-value');
const toggleCatJam = document.getElementById('toggle-cat-jam');
const catJamVideo = document.getElementById('cat-jam');
// Where #cat-jam lives in the desktop layout, so it can be put back after a
// narrow (phone-layout) window moved it onto the cover art.
const catJamHome = { parent: catJamVideo.parentElement, next: catJamVideo.nextSibling };
const catJamScaleRow = document.getElementById('cat-jam-scale-row');
const catJamScaleSlider = document.getElementById('cat-jam-scale-slider');
const catJamScaleValue = document.getElementById('cat-jam-scale-value');
const updateToast = document.getElementById('update-toast');
const updateToastText = document.getElementById('update-toast-text');
const updateToastLink = document.getElementById('update-toast-link');
const updateToastDismiss = document.getElementById('update-toast-dismiss');
const updateToastInstall = document.getElementById('update-toast-install');
const whatsNewOverlay = document.getElementById('whats-new-overlay');
const whatsNewTitle = document.getElementById('whats-new-title');
const whatsNewSubtitle = document.getElementById('whats-new-subtitle');
const whatsNewList = document.getElementById('whats-new-list');
const whatsNewClose = document.getElementById('whats-new-close');

// ---------- What's new (first launch after an update) ----------
// Highlights per release, as icon + i18n key pairs (whatsNew.<key>Title /
// whatsNew.<key>Desc). Only versions listed here get a popup.
const WHATS_NEW = {
  '2.3.0': [
    { icon: 'fi-br-shield-check', key: 'ownIdentity' },
    { icon: 'fi-br-download', key: 'installer' }
  ],
  '2.2.0': [
    { icon: 'fi-br-magic-wand', key: 'rename' },
    { icon: 'fi-br-language', key: 'languages' },
    { icon: 'fi-br-calendar', key: 'calendarMonths' }
  ],
  '2.1.0': [
    { icon: 'fi-br-quote-right', key: 'lyricsSearch' },
    { icon: 'fi-br-calendar', key: 'listeningCalendar' },
    { icon: 'fi-br-hourglass-end', key: 'listTotals' },
    { icon: 'fi-br-check-circle', key: 'realPlays' }
  ],
  '2.0.6': [
    { icon: 'fi-br-settings-sliders', key: 'nothingSliders' }
  ],
  '2.0.5': [
    { icon: 'fi-br-palette', key: 'nothingStyle' },
    { icon: 'fi-br-mobile', key: 'smallScreens' },
    { icon: 'fi-br-headphones', key: 'iosPlayback' }
  ],
  '2.0.4': [
    { icon: 'fi-br-list-music', key: 'queueOrder' },
    { icon: 'fi-br-signal-alt-2', key: 'adaptiveQuality' },
    { icon: 'fi-br-rocket-lunch', key: 'fasterLoading' }
  ],
  '2.0.3': [
    { icon: 'fi-br-play', key: 'resume' },
    { icon: 'fi-br-home', key: 'smartHome' },
    { icon: 'fi-br-gift', key: 'wrapped' },
    { icon: 'fi-br-time-fast', key: 'listenTime' },
    { icon: 'fi-br-download', key: 'storage' }
  ],
  '2.0.0': [
    { icon: 'fi-br-palette', key: 'appleStyle' },
    { icon: 'fi-br-forward', key: 'instantSkip' },
    { icon: 'fi-br-list-music', key: 'sheets' },
    { icon: 'fi-br-hand', key: 'gestures' },
    { icon: 'fi-br-volume', key: 'phoneVolume' },
    { icon: 'fi-br-download', key: 'updates' },
    { icon: 'fi-br-keyboard', key: 'shortcuts' },
    { icon: 'fi-br-sparkles', key: 'polish' }
  ]
};
const LAST_SEEN_VERSION_KEY = 'triptych:lastSeenVersion';
// Captured at load, before this session writes anything: a fresh install
// has none of these yet, so it shouldn't be told what's "new".
const IS_RETURNING_USER = (() => {
  try {
    return ['triptych:settings', 'triptych:privacyNoticeSeen', LAST_SEEN_VERSION_KEY].some((k) => localStorage.getItem(k) !== null);
  } catch (err) {
    return false;
  }
})();

function closeWhatsNew() {
  whatsNewOverlay.hidden = true;
}

function maybeShowWhatsNew() {
  const version = getClientVersion();
  let lastSeen = null;
  try { lastSeen = localStorage.getItem(LAST_SEEN_VERSION_KEY); } catch (err) { /* storage blocked */ }
  if (lastSeen === version) return;
  try { localStorage.setItem(LAST_SEEN_VERSION_KEY, version); } catch (err) { /* storage blocked */ }
  // The newest notes this user hasn't seen yet, not only an exact match --
  // someone jumping straight from 1.0.11 to 2.0.1 should still get 2.0.0's
  // big-update notes even though 2.0.1 itself has no entry.
  const current = parseSemver(version);
  const seen = parseSemver(lastSeen);
  const notesVersion = Object.keys(WHATS_NEW)
    .filter((v) => {
      const pv = parseSemver(v);
      return pv && current && !isNewerVersion(pv, current) && (!seen || isNewerVersion(pv, seen));
    })
    .sort((a, b) => (isNewerVersion(parseSemver(a), parseSemver(b)) ? -1 : 1))[0];
  const items = notesVersion && WHATS_NEW[notesVersion];
  if (!IS_RETURNING_USER || !items) return;

  whatsNewTitle.textContent = t('whatsNew.title', { version: notesVersion });
  whatsNewSubtitle.textContent = t('whatsNew.subtitle');
  whatsNewList.innerHTML = '';
  items.forEach(({ icon, key }) => {
    const li = el('li', 'whats-new-item');
    li.innerHTML = `<div class="whats-new-item-icon"><i class="fi ${icon}"></i></div>
      <div><div class="whats-new-item-title">${escapeHtml(t(`whatsNew.${key}Title`))}</div>
      <div class="whats-new-item-desc">${escapeHtml(t(`whatsNew.${key}Desc`))}</div></div>`;
    whatsNewList.appendChild(li);
  });
  whatsNewOverlay.hidden = false;
  // Keyboard users land on Continue; no focus ring drawn for a popup that
  // simply opened on its own.
  whatsNewClose.focus({ focusVisible: false });
}

whatsNewClose.addEventListener('click', closeWhatsNew);
whatsNewOverlay.addEventListener('click', (evt) => { if (evt.target === whatsNewOverlay) closeWhatsNew(); });
const offlineToast = document.getElementById('offline-toast');
const offlineToastDismiss = document.getElementById('offline-toast-dismiss');
offlineToastDismiss.addEventListener('click', () => { offlineToast.hidden = true; });
const customCssInput = document.getElementById('custom-css-input');
const customCssStyle = document.getElementById('custom-css-style');
const mainBgArt = document.getElementById('main-bg-art');
const mainEl = document.querySelector('.main');
const mainHeaderEl = document.querySelector('.main-header');
const pullRefreshEl = document.getElementById('pull-refresh');
// While a detail backdrop is showing and the page is scrolled to the top,
// the sticky header goes see-through so the art runs up behind the arrows.
function syncHeroHeader() {
  mainEl.classList.toggle('hero-top', mainEl.classList.contains('has-hero') && mainEl.scrollTop < 40);
}
mainEl.addEventListener('scroll', syncHeroHeader, { passive: true });

// Create playlist modal
const btnNewPlaylist = document.getElementById('btn-new-playlist');
const createPlaylistOverlay = document.getElementById('create-playlist-overlay');
const btnCloseCreatePlaylist = document.getElementById('btn-close-create-playlist');
const createPlaylistForm = document.getElementById('create-playlist-form');
const inputPlaylistName = document.getElementById('input-playlist-name');

// Legal & Privacy overlay
const legalOverlay = document.getElementById('legal-overlay');
const btnCloseLegal = document.getElementById('btn-close-legal');
const legalBody = document.getElementById('legal-body');
const btnOpenLegalPrivacy = document.getElementById('btn-open-legal-privacy');
const btnOpenLegalTerms = document.getElementById('btn-open-legal-terms');
const btnOpenLegalThirdParty = document.getElementById('btn-open-legal-thirdparty');
const btnOpenLegalDeletion = document.getElementById('btn-open-legal-deletion');

// First-run privacy notice
const privacyNotice = document.getElementById('privacy-notice');
const privacyNoticeView = document.getElementById('privacy-notice-view');
const privacyNoticeDismiss = document.getElementById('privacy-notice-dismiss');

// Player bar elements
const playerBar = document.getElementById('player-bar');
const playerArt = document.getElementById('player-art');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const btnPlay = document.getElementById('btn-play');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnShuffle = document.getElementById('btn-shuffle');
const btnRepeat = document.getElementById('btn-repeat');
const iconRepeat = document.getElementById('icon-repeat');
const seekBar = document.getElementById('seek-bar');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const volumeBar = document.getElementById('volume-bar');
const volumeIcon = document.getElementById('volume-icon');
const btnLyrics = document.getElementById('btn-lyrics');
const btnCloseLyrics = document.getElementById('btn-close-lyrics');
const btnSleepTimer = document.getElementById('btn-sleep-timer');
const btnSleepTimerMobile = document.getElementById('btn-sleep-timer-mobile');
const sleepTimerMenu = document.getElementById('sleep-timer-menu');
const sleepTimerBadge = document.getElementById('sleep-timer-badge');
const sleepTimerOff = document.getElementById('sleep-timer-off');
const btnConnect = document.getElementById('btn-connect');
const btnConnectMobile = document.getElementById('btn-connect-mobile');
const connectMenu = document.getElementById('connect-menu');
const connectDeviceList = document.getElementById('connect-device-list');

// Mobile full-screen player controls (mirror of the desktop mini-player ones above)
const mobileBtnPlay = document.getElementById('mobile-btn-play');
const mobileIconPlay = document.getElementById('mobile-icon-play');
const mobileIconPause = document.getElementById('mobile-icon-pause');
const mobileBtnPrev = document.getElementById('mobile-btn-prev');
const mobileBtnNext = document.getElementById('mobile-btn-next');
const mobileBtnShuffle = document.getElementById('mobile-btn-shuffle');
const mobileBtnRepeat = document.getElementById('mobile-btn-repeat');
const mobileIconRepeat = document.getElementById('mobile-icon-repeat');
const mobileSeekBar = document.getElementById('mobile-seek-bar');
const mobileTimeCurrent = document.getElementById('mobile-time-current');
const mobileTimeTotal = document.getElementById('mobile-time-total');

// ---------- State ----------
let jellyfin = null;
let player = null;
let connect = null;
let currentLyrics = null;
let lyricsTrackId = null;
let viewHistory = [];
let viewFuture = [];
let allSongsCache = null;
let musicLibraryId = null;
let activePanelTab = 'lyrics';
let playAllBtn = null;
let playAllTrackIds = [];
let cardRegistry = [];

// ---------- Window controls ----------
document.getElementById('btn-min').addEventListener('click', () => windowControls.minimize());
document.getElementById('btn-max').addEventListener('click', () => windowControls.maximize());
document.getElementById('btn-close').addEventListener('click', () => windowControls.close());
if (!isDesktop) document.body.classList.add('platform-' + platform);
// macOS draws its own window buttons in the title bar (see main.js).
if (isDesktop && window.api.os === 'darwin') document.body.classList.add('platform-mac');


// ---------- Utilities ----------
function ticksToSeconds(ticks) {
  return (ticks || 0) / 10000000;
}

// A native range thumb's center travels from thumbWidth/2 to (trackWidth -
// thumbWidth/2), not edge to edge — so a fill drawn as a plain `value%` of
// the track visibly overshoots the thumb early in the range and undershoots
// it late in the range. This maps value% onto that same inset travel range
// so the fill edge and thumb always line up.
function rangeFillPercent(valuePercent, trackEl, thumbWidthPx) {
  const trackWidth = trackEl.clientWidth;
  if (!trackWidth || trackWidth <= thumbWidthPx) return `${valuePercent}%`;
  const usable = trackWidth - thumbWidthPx;
  const fillPx = thumbWidthPx / 2 + (valuePercent / 100) * usable;
  return `${(fillPx / trackWidth) * 100}%`;
}

// "12 songs · 47 min" / "30 songs · 1 hr 52 min" under a list's title, like
// Spotify. Tracks without a known length just don't add to the total.
function trackListSummary(tracks) {
  const count = t(tracks.length === 1 ? 'playlist.songCount' : 'playlist.songCountPlural', { count: tracks.length });
  const seconds = tracks.reduce((sum, tr) => sum + (ticksToSeconds(tr.RunTimeTicks) || 0), 0);
  if (!seconds) return count;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  const length = hours ? t('duration.hoursMinutes', { h: hours, m: minutes }) : t('duration.minutes', { m: Math.max(1, minutes) });
  return `${count} · ${length}`;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Ley Lofaj's collab tracks got imported with badly mangled, sometimes
// self-duplicated join strings ("Ley Lofaj, Dominik Láznička, Ley Lofaj",
// "Ley Lofaj, Ley Lofaj, ...") before the artist-tagging fix landed —
// display those as plain "Ley Lofaj" specifically. NOT a general rule for
// every collab in the library — every other multi-artist credit keeps
// showing its full joined name as before.
function simplifyKnownMangledName(str) {
  const parts = str.toLowerCase().split(/\s*[,;&+/]\s*/).map((s) => s.trim());
  if (parts.includes('ley lofaj')) return 'Ley Lofaj';
  return null;
}

// Jellyfin sometimes stores a multi-artist collab as one un-split "A;B" name
// (unparsed tag delimiter) instead of separate entries — clean that up for display.
function formatDisplayName(name) {
  const str = (name || '').replace(/\s*;\s*/g, ', ').trim();
  return simplifyKnownMangledName(str) || str;
}

// fallback is for a track with genuinely empty Artists/AlbumArtist tags of
// its own (seen in practice: one track in an otherwise normal album,
// server-side data gap) — the surrounding context usually already knows
// the real artist (the album/artist page it's being rendered on), so
// callers can pass that through rather than showing the literal string
// "Unknown Artist" when it isn't actually unknown.
function artistNames(item, fallback) {
  let raw;
  if (item.Artists && item.Artists.length) raw = item.Artists.join(', ');
  else if (item.AlbumArtist) raw = item.AlbumArtist;
  else raw = fallback || t('common.unknownArtist');
  return formatDisplayName(raw);
}

// Cover art conveys real information (which album is playing), so it needs
// a real alt text instead of the alt="" used for purely decorative images —
// screen reader users would otherwise get no indication of what's showing.
function setArtAlt(name, artist) {
  const label = t('player.coverArtAlt', { name: name || '', artist: artist || '' });
  playerArt.alt = label;
  nowPlayingArt.alt = label;
}

// Maps a Jellyfin item Type to the "kind" strings this UI uses internally.
function typeToKind(type) {
  switch (type) {
    case 'Audio': return 'song';
    case 'MusicAlbum': return 'album';
    case 'MusicArtist': return 'artist';
    case 'Playlist': return 'playlist';
    default: return (type || '').toLowerCase();
  }
}

function placeholderArt(kind) {
  return kind === 'artist'
    ? 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23242424"/><circle cx="50" cy="40" r="18" fill="%23444"/><path d="M20 90c0-20 14-32 30-32s30 12 30 32" fill="%23444"/></svg>'
    : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="%23242424"/><path d="M35 30v34a9 9 0 1 0 4 7V42l30-6v24a9 9 0 1 0 4 7V24z" fill="%23555"/></svg>';
}

// Cover art sized for where it's shown: `cssPx` is the on-screen size in
// CSS pixels, scaled by the screen's pixel density and rounded up to a
// 100px step (so the server's resized-image cache gets reused). Small
// thumbnails download a fraction of what they used to, while big views
// (full-screen player, detail headers) still get full resolution.
function imagePx(cssPx) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  return Math.min(1200, Math.max(100, Math.ceil((cssPx * dpr) / 100) * 100));
}

function artUrl(item, kind = 'album', cssPx = 200) {
  return jellyfin.imageUrl(item, 'Primary', imagePx(cssPx)) || placeholderArt(kind);
}

// Server art requests fail outright when offline — for a downloaded track,
// fall back to the copy of the cover saved alongside its audio at download
// time instead of leaving a broken image. Only kicks in on actual load
// failure, so the normal online path (server art) is untouched.
function withOfflineArtFallback(imgEl, track) {
  if (!track?.Id || !isDownloaded(track.Id)) return;
  imgEl.onerror = () => {
    imgEl.onerror = null;
    getLocalImageUri(track.Id).then((uri) => {
      if (uri) imgEl.src = uri;
    });
  };
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

// Plain `.hidden = bool` doesn't reliably reflect to the DOM attribute on
// SVG elements (only HTMLElement defines that IDL property), so toggle
// the attribute directly instead — works for any element type.
function setHidden(node, hidden) {
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

// Keeps the big play/pause button on album/playlist/artist pages in sync
// with whether the track currently playing actually belongs to that page.
function syncPlayAllButton() {
  if (!playAllBtn) return;
  const isThisPlaying = !!(player?.currentTrack && playAllTrackIds.includes(player.currentTrack.Id) && !player.audio.paused);
  setHidden(playAllBtn.querySelector('.icon-play-all-play'), isThisPlaying);
  setHidden(playAllBtn.querySelector('.icon-play-all-pause'), !isThisPlaying);
}

// Keeps album/playlist cards in grids (Home, Albums, Artist page) in sync
// with whether that specific collection is the one currently playing.
function syncCardStates() {
  cardRegistry.forEach(({ id, card, playBtn }) => {
    const isThisPlaying = !!(player?.currentTrack && player.queueSourceId === id && !player.audio.paused);
    card.classList.toggle('playing', isThisPlaying);
    setHidden(playBtn.querySelector('.icon-play-all-play'), isThisPlaying);
    setHidden(playBtn.querySelector('.icon-play-all-pause'), !isThisPlaying);
  });
}

// ---------- Session bootstrap ----------
async function init() {
  // Sent as early as possible, ahead of main.js's background update check
  // (fired ~4s after app ready) -- that's the only way to actually stop the
  // GitHub network call itself rather than just hiding its result.
  if (isDesktop) window.api.updates?.setAutoCheckEnabled?.(getSettings().autoUpdateCheckEnabled !== false);
  if (isMobile) requestNotificationPermission();
  wireUpdateToast();
  if (isDesktop) wireMediaKeys();
  wireSleepTimer();
  wireConnectMenu();
  volumeBar.style.setProperty('--pct', '50%');
  updateVolumeIcon(50);
  await loadLocale(getSettings().language);
  applyTranslations();
  customCssStyle.textContent = getSettings().customCss || '';
  wireSettingsUI();
  wireCreatePlaylistUI();
  wireLegalOverlay();
  wirePrivacyNotice();
  wireBackButton();

  await initClientVersion();
  try {
    await tryRestoreSession();
  } catch (err) {
    // Never leave the boot splash up over a half-started app.
    console.error('Session restore failed', err);
    if (appRoot.hidden) showLogin();
    else hideBootSplash();
  }
}

// A stale/invalid token (401) genuinely needs a fresh login. Anything else —
// a network blip, the server restarting, no connectivity at all — shouldn't
// lock the user out of the app entirely: downloaded tracks (and anything
// else already cached) still need to work with zero network, which is the
// whole point of having offline downloads. Retry a couple of times first in
// case it's just transient, then enter the app anyway on a saved session
// rather than stopping at the login screen — live/server-dependent views
// degrade gracefully on their own (see renderDownloads()) and a dismissible
// banner explains why things might look empty.
async function tryRestoreSession() {
  const saved = await sessionStore.load();
  if (!saved || !saved.serverUrl || !saved.accessToken || !saved.userId) {
    showLogin();
    return;
  }
  jellyfin = new JellyfinClient(saved);

  // No network at all: don't spend seconds on retries that can't succeed --
  // go straight in with the saved session (downloads still work offline).
  if (navigator.onLine === false) {
    await enterApp(saved.username);
    offlineToast.hidden = false;
    return;
  }

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      await jellyfin.ping();
      await enterApp(saved.username);
      return;
    } catch (err) {
      if (err?.status === 401) {
        jellyfin = null;
        await sessionStore.clear();
        showLogin();
        return;
      }
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
        continue;
      }
      // Exhausted retries on a network/server error — keep the saved
      // session and let the user in anyway rather than stranding them on
      // the login screen with no access to their downloads.
      await enterApp(saved.username);
      offlineToast.hidden = false;
      return;
    }
  }
}

function showLogin() {
  loginScreen.hidden = false;
  appRoot.hidden = true;
  hideBootSplash();
}

async function enterApp(username) {
  // Reconciles this device's local settings against whatever's saved on
  // the account server-side (newer one wins — see initRemoteSync) before
  // the app becomes visible, so a synced EQ/theme/etc. takes effect from
  // the first frame instead of flashing this device's old values first.
  // Best-effort: offline/unreachable just leaves local settings as they
  // were, same as any other view that degrades without a server.
  // Fetched alongside the settings sync rather than after it -- one less
  // sequential round trip before home can start loading.
  const libsPromise = jellyfin.getMusicLibraries();
  libsPromise.catch(() => {});
  await initRemoteSync(jellyfin);

  loginScreen.hidden = true;
  appRoot.hidden = false;

  player = new Player(jellyfin, currentBitrateKbps);
  const savedSettings = getSettings();
  player.setCrossfadeSeconds(savedSettings.crossfadeSeconds || 0);
  player.setReplayGainEnabled(!!savedSettings.replayGainEnabled);
  (savedSettings.eqGains || []).forEach((gain, i) => player.setEqualizerBand(i, gain));
  player.setEqualizerEnabled(!!savedSettings.eqEnabled);
  player.setLoudnessBoostDb(savedSettings.loudnessBoostDb ?? 10);
  connect = createConnect(jellyfin, player);
  connect.start();
  connect.onRemoteStateChange(updateRemoteBarUI);

  // Picking something new to play (an album, a track row, a playlist) goes
  // through setQueue/playAt regardless of where the click came from — too
  // many call sites to route each one through a connected check, so instead
  // starting a fresh local play while connected just takes control back,
  // same as it would on Spotify.
  const localSetQueue = player.setQueue.bind(player);
  player.setQueue = (...args) => {
    if (connect.isConnected()) connect.disconnect();
    return localSetQueue(...args);
  };
  const localPlayAt = player.playAt.bind(player);
  player.playAt = (...args) => {
    if (connect.isConnected()) connect.disconnect();
    return localPlayAt(...args);
  };

  wirePlayer();

  accountUsername.textContent = username || '';
  accountMenuName.textContent = username || '';
  const initial = (username || '?').slice(0, 1).toUpperCase();
  const avatarUrl = jellyfin.avatarUrl();
  if (avatarUrl) {
    accountAvatar.innerHTML = `<img src="${avatarUrl}" alt="" />`;
    accountAvatar.querySelector('img').addEventListener('error', () => {
      accountAvatar.textContent = initial;
    }, { once: true });
  } else {
    accountAvatar.textContent = initial;
  }

  // Offline/unreachable: there's no library to browse, so land on
  // Downloads (which works without the server) instead of a failed Home.
  let libs = null;
  try { libs = await libsPromise; } catch (err) { /* offline */ }
  musicLibraryId = libs?.[0]?.Id;

  loadPlaylistSidebar().catch(() => {});
  loadPinnedAlbumsSidebar();
  navigateTo({ view: libs ? 'home' : 'downloads' });
  restoreResumeState();
  if (libs) listeningLoad = loadListeningFromServer().catch(() => {}).finally(maybeAutoOpenWrapped);
  if (libs) startConnectionProbing();
  if (libs && getSettings().lyricsSearchEnabled) setTimeout(startLyricsIndexing, 15000);
  hideBootSplash();
  // After the splash has faded, so it doesn't pop up mid-transition.
  setTimeout(maybeShowWhatsNew, 500);
}

onPinnedAlbumsChange(loadPinnedAlbumsSidebar);

// ---------- Login form ----------
btnRetryConnection.addEventListener('click', async () => {
  btnRetryConnection.disabled = true;
  loginError.hidden = true;
  btnRetryConnection.hidden = true;
  await tryRestoreSession();
  btnRetryConnection.disabled = false;
});

loginForm.addEventListener('submit', async (evt) => {
  evt.preventDefault();
  loginError.hidden = true;
  btnRetryConnection.hidden = true;
  btnLogin.disabled = true;
  btnLogin.textContent = t('login.loggingIn');

  const serverUrl = document.getElementById('input-server').value.trim();
  const username = document.getElementById('input-username').value.trim();
  const password = document.getElementById('input-password').value;
  const remember = document.getElementById('input-remember').checked;

  try {
    const auth = await JellyfinClient.authenticate(serverUrl, username, password);
    jellyfin = new JellyfinClient(auth);
    if (remember) {
      await sessionStore.save(auth);
    }
    await enterApp(auth.username);
  } catch (err) {
    loginError.textContent = translateLoginError(err) || t('login.errorGeneric');
    loginError.hidden = false;
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = t('login.logIn');
  }
});

function translateLoginError(err) {
  if (err?.code === 'wrong_credentials') return t('login.errorWrongCredentials');
  if (err?.code === 'server_error') return t('login.errorServer', { status: err.status });
  return null;
}

// ---------- Account menu ----------
btnAccount.addEventListener('click', (evt) => {
  evt.stopPropagation();
  accountMenu.hidden = !accountMenu.hidden;
});
document.addEventListener('click', (evt) => {
  if (!accountMenu.hidden && !accountMenu.contains(evt.target) && evt.target !== btnAccount) {
    accountMenu.hidden = true;
  }
});

// Every dismissible overlay/menu below only ever closed via a mouse click
// outside it -- a keyboard-only user had no way to back out of one. Escape
// is the universal "close this" key, checked top-down in the order a user
// would expect (innermost/most-recently-opened thing first).
document.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape') return;
  if (!whatsNewOverlay.hidden) { closeWhatsNew(); return; }
  if (!legalOverlay.hidden) { closeLegal(); return; }
  if (!settingsOverlay.hidden) { closeSettings(); return; }
  if (!createPlaylistOverlay.hidden) { closeCreatePlaylist(); return; }
  if (!accountMenu.hidden) { accountMenu.hidden = true; btnAccount.focus(); return; }
  if (!sleepTimerMenu.hidden) { sleepTimerMenu.hidden = true; return; }
  if (!connectMenu.hidden) { connectMenu.hidden = true; }
});

// Player shortcuts: Space = play/pause, Ctrl+Left / Ctrl+Right = previous /
// next (Cmd on a Mac keyboard). Go through the same ui* helpers as the
// buttons, so they also drive a connected Connect device. Skipped while
// typing in a text field or with a popup open, so Space still types a space
// in search, Custom CSS, etc.
document.addEventListener('keydown', (evt) => {
  if (evt.defaultPrevented || evt.altKey || !player?.currentTrack || appRoot.hidden) return;
  if (evt.target.closest?.('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"]')) return;
  if (!whatsNewOverlay.hidden || !legalOverlay.hidden || !settingsOverlay.hidden || !createPlaylistOverlay.hidden) return;
  if (document.querySelector('.wrapped-overlay')) return;
  const mod = evt.ctrlKey || evt.metaKey;
  if (evt.code === 'Space' && !mod && !evt.shiftKey) {
    // Also stops Space from "clicking" whichever button has focus.
    evt.preventDefault();
    uiTogglePlay();
  } else if (mod && evt.key === 'ArrowLeft') {
    evt.preventDefault();
    uiPrevious();
  } else if (mod && evt.key === 'ArrowRight') {
    evt.preventDefault();
    uiNext();
  }
});
menuLogout.addEventListener('click', async () => {
  await sessionStore.clear();
  connect?.stop();
  jellyfin = null;
  player?.audio.pause();
  location.reload();
});
menuSettings.addEventListener('click', () => {
  accountMenu.hidden = true;
  openSettings();
});

// ---------- Settings modal ----------
function wireSettingsUI() {
  Object.entries(LOCALES).forEach(([code, label]) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    languageSelect.appendChild(opt);
  });
  languageSelect.addEventListener('change', async () => {
    updateSettings({ language: languageSelect.value });
    await loadLocale(languageSelect.value);
    applyTranslations();
    populateLocalizedSettingsOptions();
    refreshSettingsUI();
    if (viewHistory.length) renderView(viewHistory[viewHistory.length - 1]);
    await loadPlaylistSidebar();
  });

  populateLocalizedSettingsOptions();

  paletteGrid.addEventListener('click', (evt) => {
    const swatch = evt.target.closest('.palette-swatch');
    if (!swatch) return;
    updateSettings({ palette: swatch.dataset.value });
    refreshSettingsUI();
  });

  themeModeToggle.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateSettings({ themeMode: btn.dataset.value });
      refreshSettingsUI();
    });
  });

  uiStyleToggle.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      updateSettings({ uiStyle: btn.dataset.value });
      refreshSettingsUI();
      updateBgArt(); // Apple style always shows the blurred art behind the player
    });
  });

  audioQualitySelect.addEventListener('change', () => {
    updateSettings({ audioQuality: audioQualitySelect.value });
  });

  toggleArtBackground.addEventListener('change', () => {
    updateSettings({ artBackground: toggleArtBackground.checked });
    updateBgArt();
  });

  toggleDynamicAccentColor.addEventListener('change', () => {
    updateSettings({ dynamicAccentColor: toggleDynamicAccentColor.checked });
    updateDynamicAccentColor();
  });

  crossfadeSlider.addEventListener('input', () => {
    const seconds = Number(crossfadeSlider.value);
    crossfadeValue.textContent = seconds === 0 ? t('settings.crossfadeOff') : `${seconds}s`;
    crossfadeSlider.style.setProperty('--pct', rangeFillPercent((seconds / 12) * 100, crossfadeSlider, 13));
    player?.setCrossfadeSeconds(seconds);
  });
  crossfadeSlider.addEventListener('change', () => {
    updateSettings({ crossfadeSeconds: Number(crossfadeSlider.value) });
  });

  toggleOfflineMode.addEventListener('change', () => {
    updateSettings({ offlineMode: toggleOfflineMode.checked });
    // Re-apply row availability across whatever's currently on screen —
    // per-row state is only set when a row is first built otherwise.
    if (viewHistory.length) renderView(viewHistory[viewHistory.length - 1]);
  });

  toggleReplayGain.addEventListener('change', () => {
    updateSettings({ replayGainEnabled: toggleReplayGain.checked });
    player?.setReplayGainEnabled(toggleReplayGain.checked);
  });

  // The Deezer lookup only exists on desktop (Electron, see platform.js).
  // The update check runs on desktop AND phones (checkForUpdatesOnMobile),
  // so its switch shows on both; only a plain browser has neither.
  if (!isDesktop) setHidden(albumArtLookupRow, true);
  if (!isDesktop && !isMobile) setHidden(autoUpdateCheckRow, true);
  // No empty section headings: hide a section whose rows are all hidden.
  document.querySelectorAll('#settings-overlay .settings-section').forEach((section) => {
    const rows = [...section.querySelectorAll(':scope > .settings-row')];
    if (rows.length && rows.every((r) => r.hidden)) setHidden(section, true);
  });
  toggleNothingDots.addEventListener('change', () => {
    updateSettings({ nothingDottedSliders: toggleNothingDots.checked });
  });
  toggleHaptics.addEventListener('change', () => {
    updateSettings({ hapticsEnabled: toggleHaptics.checked });
    setHapticsEnabled(toggleHaptics.checked);
  });
  // Haptics only exist on phones; Storage only where downloads do.
  setHidden(document.getElementById('haptics-row'), !isMobile);
  setHidden(storageSection, !downloadsSupported());
  setHapticsEnabled(getSettings().hapticsEnabled);
  btnClearDownloads.addEventListener('click', async () => {
    const tracks = getDownloadedTracks();
    if (!tracks.length) return;
    if (!window.confirm(t('settings.clearDownloadsConfirm', { count: tracks.length }))) return;
    btnClearDownloads.disabled = true;
    for (const tr of tracks) await deleteDownload(tr.id).catch(() => {});
    refreshStorageUI();
  });
  onDownloadsChange(refreshStorageUI);

  toggleLyricsSearch.addEventListener('change', () => {
    updateSettings({ lyricsSearchEnabled: toggleLyricsSearch.checked });
    if (toggleLyricsSearch.checked) startLyricsIndexing();
    else stopIndexing();
    refreshLyricsIndexStatus();
  });
  onIndexProgress(showLyricsIndexStatus);
  toggleAlbumArtLookup.addEventListener('change', () => {
    updateSettings({ albumArtLookupEnabled: toggleAlbumArtLookup.checked });
  });
  toggleAutoUpdateCheck.addEventListener('change', () => {
    updateSettings({ autoUpdateCheckEnabled: toggleAutoUpdateCheck.checked });
    window.api?.updates?.setAutoCheckEnabled?.(toggleAutoUpdateCheck.checked);
  });

  // Desktop (Web Audio) and Android (native android.media.audiofx.Equalizer,
  // see LoudnessPlugin.java) both have a working equalizer implementation.
  // iOS gets neither. Android also gets the adjustable native volume boost
  // (Player.setLoudnessBoostDb / LoudnessPlugin.java), independent of the EQ.
  if (!isDesktop && !isAndroid) {
    setHidden(equalizerToggleRow, true);
    setHidden(equalizerBandsRow, true);
  }
  if (!isAndroid) {
    setHidden(loudnessBoostRow, true);
  }

  toggleEqualizer.addEventListener('change', () => {
    updateSettings({ eqEnabled: toggleEqualizer.checked });
    player?.setEqualizerEnabled(toggleEqualizer.checked);
    setHidden(equalizerBandsRow, !toggleEqualizer.checked);
  });

  eqBandSliders.forEach((slider) => {
    const band = Number(slider.dataset.band);
    const valueEl = document.querySelector(`.eq-band-value[data-band-value="${band}"]`);
    slider.addEventListener('input', () => {
      const gain = Number(slider.value);
      valueEl.textContent = gain > 0 ? `+${gain}` : `${gain}`;
      player?.setEqualizerBand(band, gain);
    });
    slider.addEventListener('change', () => {
      const gains = getSettings().eqGains ? [...getSettings().eqGains] : [0, 0, 0, 0, 0];
      gains[band] = Number(slider.value);
      // A manual tweak no longer matches whatever preset was selected.
      eqPresetSelect.value = 'custom';
      setHidden(eqPresetSelect.querySelector('option[value="custom"]'), false);
      updateSettings({ eqGains: gains, eqPreset: 'custom' });
    });
  });

  eqPresetSelect.addEventListener('change', () => {
    const preset = eqPresetSelect.value;
    const gains = EQ_PRESETS[preset] ? [...EQ_PRESETS[preset]] : [0, 0, 0, 0, 0];
    applyEqGainsToUI(gains);
    updateSettings({ eqGains: gains, eqPreset: preset });
  });

  btnEqReset.addEventListener('click', () => {
    eqPresetSelect.value = 'flat';
    applyEqGainsToUI(EQ_PRESETS.flat);
    updateSettings({ eqGains: [...EQ_PRESETS.flat], eqPreset: 'flat' });
  });

  loudnessBoostSlider.addEventListener('input', () => {
    const db = Number(loudnessBoostSlider.value);
    loudnessBoostValue.textContent = `${db} dB`;
    loudnessBoostSlider.style.setProperty('--pct', rangeFillPercent((db / 20) * 100, loudnessBoostSlider, 13));
    player?.setLoudnessBoostDb(db);
  });
  loudnessBoostSlider.addEventListener('change', () => {
    updateSettings({ loudnessBoostDb: Number(loudnessBoostSlider.value) });
  });

  toggleCatJam.addEventListener('change', () => {
    updateSettings({ catJam: toggleCatJam.checked });
    setHidden(catJamScaleRow, !toggleCatJam.checked);
    syncCatJamVisibility();
  });

  catJamScaleSlider.addEventListener('input', () => {
    const scale = Number(catJamScaleSlider.value);
    catJamScaleValue.textContent = `${scale.toFixed(1)}x`;
    catJamVideo.style.setProperty('--cat-scale', scale);
    catJamScaleSlider.style.setProperty('--pct', rangeFillPercent(((scale - 0.5) / 2.5) * 100, catJamScaleSlider, 14));
  });
  catJamScaleSlider.addEventListener('change', () => {
    updateSettings({ catJamScale: Number(catJamScaleSlider.value) });
  });

  let customCssDebounce;
  customCssInput.addEventListener('input', () => {
    customCssStyle.textContent = customCssInput.value;
    clearTimeout(customCssDebounce);
    customCssDebounce = setTimeout(() => {
      updateSettings({ customCss: customCssInput.value });
    }, 400);
  });

  btnCloseSettings.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (evt) => {
    if (evt.target === settingsOverlay) closeSettings();
  });

  refreshSettingsUI();
}

function populateLocalizedSettingsOptions() {
  paletteGrid.innerHTML = '';
  Object.entries(PALETTES).forEach(([key, palette]) => {
    const swatch = el('button', 'palette-swatch');
    swatch.type = 'button';
    swatch.dataset.value = key;
    swatch.innerHTML = `<span class="dot" style="background:${palette.accent}"></span><span>${t(`palette.${key}`)}</span>`;
    paletteGrid.appendChild(swatch);
  });

  audioQualitySelect.innerHTML = '';
  Object.entries(AUDIO_QUALITIES).forEach(([key]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = t(`audioQuality.${key}`);
    audioQualitySelect.appendChild(opt);
  });
}

function updateBgArt() {
  const s = getSettings();
  const track = player?.currentTrack;
  // The Apple Music style's full-screen player is built around the blurred
  // artwork, so it's always on there regardless of the main-page setting.
  const npArt = track && (s.artBackground || s.uiStyle === 'apple');
  if (s.artBackground && track) {
    mainBgArt.style.backgroundImage = `url("${artUrl(track, 'album', 120)}")`;
    mainBgArt.classList.add('visible');
  } else {
    mainBgArt.classList.remove('visible');
  }
  if (npArt) {
    nowPlayingBgArt.style.backgroundImage = `url("${artUrl(track, 'album', 120)}")`;
    nowPlayingBgArt.classList.add('visible');
  } else {
    nowPlayingBgArt.classList.remove('visible');
  }
}

// Dynamic accent color — samples the current track's cover art and overrides
// the palette's --accent/--seek-*/--accent-bg vars via inline styles on <html>
// (inline styles win over any selector-based rule, so this cleanly overrides
// whichever palette is active without touching the palette CSS itself).
let dynamicAccentTrackId = null;

async function updateDynamicAccentColor(track) {
  track = track || player?.currentTrack;
  if (!getSettings().dynamicAccentColor || !track) {
    clearDynamicAccentColor();
    dynamicAccentTrackId = null;
    return;
  }
  if (dynamicAccentTrackId === track.Id) return;
  dynamicAccentTrackId = track.Id;
  const rgb = await extractDominantColor(artUrl(track, 'album', 32));
  // Track may have changed (or the setting been turned off) while we awaited the image.
  if (player?.currentTrack?.Id !== track.Id || !getSettings().dynamicAccentColor) return;
  if (rgb) applyDynamicAccentColor(rgb);
  else clearDynamicAccentColor();
}

// Jellyfin doesn't send CORS headers on image responses by default, which
// taints the canvas and blocks getImageData() with a SecurityError. That's
// expected for many self-hosted setups — fail silently and just skip the
// dynamic color for that track rather than surfacing an error.
function extractDominantColor(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let sumR = 0, sumG = 0, sumB = 0, n = 0;
        let bestSat = -1, bestColor = null;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 128) continue;
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const lightness = max / 255;
          if (lightness < 0.12 || lightness > 0.92) continue; // near-black/near-white make poor accents
          const sat = max === 0 ? 0 : (max - min) / max;
          sumR += r; sumG += g; sumB += b; n++;
          if (sat > bestSat && lightness > 0.25 && lightness < 0.85) {
            bestSat = sat;
            bestColor = [r, g, b];
          }
        }
        if (bestColor && bestSat > 0.15) { resolve(bestColor); return; }
        if (n > 0) { resolve([Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)]); return; }
        resolve(null);
      } catch (err) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
}

function applyDynamicAccentColor(rgb) {
  const [r, g, b] = rgb;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const hex = toHex(rgb);
  const hoverHex = toHex([r + 25, g + 25, b + 25]);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-hover', hoverHex);
  root.style.setProperty('--accent-contrast', luminance > 0.6 ? '#0a0a0a' : '#ffffff');
  root.style.setProperty('--seek-start', hex);
  root.style.setProperty('--seek-end', hoverHex);
  root.style.setProperty('--accent-bg', hex);
}

function clearDynamicAccentColor() {
  const root = document.documentElement;
  ['--accent', '--accent-hover', '--accent-contrast', '--seek-start', '--seek-end', '--accent-bg'].forEach((prop) =>
    root.style.removeProperty(prop)
  );
}

// Discord Rich Presence — no-op on mobile/web (see setDiscordActivity).
// Discord only embeds Rich Presence images served over HTTPS, so a
// Jellyfin server on plain HTTP (typical for a LAN-only setup) can't be used
// directly as the cover art source. Instead, look the album up on Deezer
// (proxied through main.js, since its API doesn't send CORS headers) by
// artist + album name and use its artwork — falling back to the static logo
// asset when nothing matches.
const externalCoverArtCache = new Map(); // "artist|album" (lowercased) -> url or null

async function fetchExternalCoverArt(artist, album, trackName) {
  const key = `${artist}|${album}`.toLowerCase();
  if (externalCoverArtCache.has(key)) return externalCoverArtCache.get(key);
  const url = await searchDeezerAlbumArt(artist, album, trackName);
  externalCoverArtCache.set(key, url);
  return url;
}

// Discord accepts only ~5 presence updates per 20 seconds and silently drops
// the rest. Sending "logo" first and the cover a moment later, plus an
// update per play/pause event, went over that when skipping songs -- the
// dropped update was usually the cover, so everyone saw just the logo.
// Now the cover is looked up first (briefly) and updates are coalesced:
// at most one every 1.5s, always the latest state.
const DISCORD_MIN_GAP_MS = 1500;
const DISCORD_ART_WAIT_MS = 2500;
let discordTimer = null;
let discordLastSent = 0;
let discordSeq = 0;

function updateDiscordPresence() {
  const seq = ++discordSeq;
  clearTimeout(discordTimer);
  const wait = Math.max(0, discordLastSent + DISCORD_MIN_GAP_MS - Date.now());
  discordTimer = setTimeout(() => sendDiscordPresence(seq), wait);
}

async function sendDiscordPresence(seq) {
  const track = player?.currentTrack;
  if (!track || player.audio.paused) {
    discordLastSent = Date.now();
    clearDiscordActivity();
    return;
  }
  const artist = artistNames(track);
  const album = track.Album || '';
  const art = await Promise.race([
    fetchExternalCoverArt(artist, album, track.Name).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), DISCORD_ART_WAIT_MS))
  ]);
  // A newer update was requested while the cover was being looked up.
  if (seq !== discordSeq) return;
  const durationSeconds = ticksToSeconds(track.RunTimeTicks) || player.audio.duration || 0;
  const startTimestamp = Date.now() - player.audio.currentTime * 1000;
  discordLastSent = Date.now();
  setDiscordActivity({
    type: 2, // Listening
    details: track.Name,
    state: artist,
    largeImageKey: art || 'logo',
    largeImageText: album || undefined,
    smallImageKey: 'logo',
    smallImageText: 'Triptych',
    startTimestamp,
    endTimestamp: durationSeconds ? startTimestamp + durationSeconds * 1000 : undefined,
    instance: false
  });
  // The lookup took too long this time; once it lands (cached), send the
  // cover in a single follow-up.
  if (!art && !externalCoverArtCache.has(`${artist}|${album}`.toLowerCase())) {
    fetchExternalCoverArt(artist, album, track.Name).then((late) => {
      if (late && seq === discordSeq) updateDiscordPresence();
    }).catch(() => {});
  }
}

// ---------- Sleep timer ----------
let sleepTimerHandle = null;
let sleepTimerBadgeInterval = null;
let sleepTimerEndAt = null;
let sleepTimerAtEndOfTrack = false;

function clearSleepTimer() {
  if (sleepTimerHandle) clearTimeout(sleepTimerHandle);
  if (sleepTimerBadgeInterval) clearInterval(sleepTimerBadgeInterval);
  sleepTimerHandle = null;
  sleepTimerBadgeInterval = null;
  sleepTimerEndAt = null;
  sleepTimerAtEndOfTrack = false;
  sleepTimerBadge.hidden = true;
  sleepTimerOff.hidden = true;
  btnSleepTimer.classList.remove('active');
  btnSleepTimerMobile.classList.remove('active');
}

function updateSleepTimerBadge() {
  if (!sleepTimerEndAt) return;
  const minutesLeft = Math.max(1, Math.ceil((sleepTimerEndAt - Date.now()) / 60000));
  sleepTimerBadge.textContent = minutesLeft;
  sleepTimerBadge.hidden = false;
}

function setSleepTimer(minutes) {
  clearSleepTimer();
  sleepTimerEndAt = Date.now() + minutes * 60000;
  sleepTimerHandle = setTimeout(() => {
    if (!player.audio.paused) player.togglePlay();
    clearSleepTimer();
  }, minutes * 60000);
  updateSleepTimerBadge();
  sleepTimerBadgeInterval = setInterval(updateSleepTimerBadge, 15000);
  sleepTimerOff.hidden = false;
  btnSleepTimer.classList.add('active');
  btnSleepTimerMobile.classList.add('active');
}

function setSleepTimerEndOfTrack() {
  clearSleepTimer();
  sleepTimerAtEndOfTrack = true;
  sleepTimerBadge.textContent = '•';
  sleepTimerBadge.hidden = false;
  sleepTimerOff.hidden = false;
  btnSleepTimer.classList.add('active');
  btnSleepTimerMobile.classList.add('active');
}

function openSleepTimerMenuNear(triggerEl) {
  const rect = triggerEl.getBoundingClientRect();
  sleepTimerMenu.hidden = false;
  // Flip above the trigger if there's not enough room below (the desktop
  // player-bar button sits at the very bottom of the window).
  const menuHeight = sleepTimerMenu.offsetHeight;
  const opensUp = rect.bottom + menuHeight + 8 > window.innerHeight;
  sleepTimerMenu.style.top = opensUp ? `${rect.top - menuHeight - 8}px` : `${rect.bottom + 8}px`;
  const left = Math.min(rect.left, window.innerWidth - sleepTimerMenu.offsetWidth - 8);
  sleepTimerMenu.style.left = `${Math.max(8, left)}px`;
}

function wireSleepTimer() {
  const triggers = [btnSleepTimer, btnSleepTimerMobile];
  triggers.forEach((trigger) => {
    trigger.addEventListener('click', (evt) => {
      evt.stopPropagation();
      if (!sleepTimerMenu.hidden) { sleepTimerMenu.hidden = true; return; }
      openSleepTimerMenuNear(trigger);
    });
  });
  document.addEventListener('click', (evt) => {
    if (!sleepTimerMenu.hidden && !sleepTimerMenu.contains(evt.target) && !triggers.includes(evt.target) && !evt.target.closest('.sleep-timer-wrap, #btn-sleep-timer-mobile')) {
      sleepTimerMenu.hidden = true;
    }
  });
  sleepTimerMenu.querySelectorAll('.sleep-timer-option[data-minutes]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setSleepTimer(Number(btn.dataset.minutes));
      sleepTimerMenu.hidden = true;
    });
  });
  sleepTimerMenu.querySelector('[data-end-of-track]').addEventListener('click', () => {
    setSleepTimerEndOfTrack();
    sleepTimerMenu.hidden = true;
  });
  sleepTimerOff.addEventListener('click', () => {
    clearSleepTimer();
    sleepTimerMenu.hidden = true;
  });
}

// ---------- Connect (device handoff) ----------

function openConnectMenuNear(triggerEl) {
  const rect = triggerEl.getBoundingClientRect();
  connectMenu.hidden = false;
  const menuHeight = connectMenu.offsetHeight;
  const opensUp = rect.bottom + menuHeight + 8 > window.innerHeight;
  connectMenu.style.top = opensUp ? `${rect.top - menuHeight - 8}px` : `${rect.bottom + 8}px`;
  const left = Math.min(rect.left, window.innerWidth - connectMenu.offsetWidth - 8);
  connectMenu.style.left = `${Math.max(8, left)}px`;
}

async function loadConnectDevices() {
  if (!connect) {
    connectDeviceList.innerHTML = '';
    connectDeviceList.appendChild(el('div', 'connect-empty', t('connect.empty')));
    return;
  }

  const connected = connect.getConnectedDevice();
  if (connected) {
    connectDeviceList.innerHTML = '';
    const status = el('div', 'connect-status', t('connect.connectedTo', { device: connected.name || 'Device' }));
    connectDeviceList.appendChild(status);
    const disconnectBtn = el('button', 'connect-device-item danger');
    disconnectBtn.type = 'button';
    disconnectBtn.innerHTML = `<span class="connect-device-name">${escapeHtml(t('connect.disconnect'))}</span>`;
    disconnectBtn.addEventListener('click', () => {
      connect.disconnect();
      connectMenu.hidden = true;
    });
    connectDeviceList.appendChild(disconnectBtn);
    return;
  }

  connectDeviceList.innerHTML = `<div class="connect-loading">${escapeHtml(t('connect.loading'))}</div>`;
  const devices = await connect.getDevices();
  connectDeviceList.innerHTML = '';
  if (!devices.length) {
    connectDeviceList.appendChild(el('div', 'connect-empty', t('connect.empty')));
    return;
  }
  devices.forEach((session) => {
    const item = el('button', 'connect-device-item');
    item.type = 'button';
    const deviceName = session.DeviceName || session.Client || 'Device';
    const meta = session.NowPlayingItem
      ? t('connect.nowPlaying', { title: session.NowPlayingItem.Name })
      : (session.Client || '');
    item.innerHTML = `<span class="connect-device-name">${escapeHtml(deviceName)}</span><span class="connect-device-meta">${escapeHtml(meta)}</span>`;
    item.addEventListener('click', async () => {
      connectMenu.hidden = true;
      try {
        await connect.sendToDevice(session.Id, deviceName);
      } catch (err) {
        alert(err.message || t('connect.errorSend'));
      }
    });
    connectDeviceList.appendChild(item);
  });
}

function wireConnectMenu() {
  const triggers = [btnConnect, btnConnectMobile];
  triggers.forEach((trigger) => {
    trigger.addEventListener('click', (evt) => {
      evt.stopPropagation();
      if (!connectMenu.hidden) { connectMenu.hidden = true; return; }
      openConnectMenuNear(trigger);
      loadConnectDevices();
    });
  });
  document.addEventListener('click', (evt) => {
    if (!connectMenu.hidden && !connectMenu.contains(evt.target) && !triggers.includes(evt.target) && !evt.target.closest('#btn-connect, #btn-connect-mobile')) {
      connectMenu.hidden = true;
    }
  });
}

// ---------- Cat Jam ----------
// Real bass-onset detection via Web Audio's AnalyserNode. Rather than
// overlaying a CSS bounce, the detected tempo instead drives the cat video's
// own playbackRate — same idea as the reference Spicetify extension, which
// speeds up/slows down its webm to match the track instead of animating it
// externally. REFERENCE_INTERVAL_MS is the beat interval the source video's
// own bob cycle was authored at (~120bpm); actual detected tempo scales
// speed relative to that.
const REFERENCE_INTERVAL_MS = 500;
let catJamRAF = null;
let catJamBassAvg = 0;
let catJamLastBeatAt = 0;
let catJamBeatIntervalMs = REFERENCE_INTERVAL_MS;

function catJamTick() {
  if (!getSettings().catJam) { catJamRAF = null; return; }
  catJamRAF = requestAnimationFrame(catJamTick);
  if (!player?.currentTrack || player.audio.paused) return;

  // Shares the player's Web Audio graph (see Player.getAnalyser) rather than
  // opening its own — a second createMediaElementSource() on the same
  // <audio> element would throw.
  const analyser = player.getAnalyser(player.audio);
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  const bassBins = 6; // roughly sub-bass/bass range at this fftSize
  let bassSum = 0;
  for (let i = 0; i < bassBins; i++) bassSum += data[i];
  const bass = bassSum / bassBins; // 0-255

  catJamBassAvg = catJamBassAvg * 0.92 + bass * 0.08;

  const now = performance.now();
  if (bass > catJamBassAvg * 1.35 && bass > 40 && now - catJamLastBeatAt > 220) {
    if (catJamLastBeatAt) {
      const interval = now - catJamLastBeatAt;
      // Only trust intervals in a plausible tempo range (~50-220bpm) —
      // a missed or extra detection would otherwise throw the estimate off.
      if (interval > 270 && interval < 1200) {
        catJamBeatIntervalMs = catJamBeatIntervalMs * 0.7 + interval * 0.3;
      }
    }
    catJamLastBeatAt = now;
  }

  const targetRate = REFERENCE_INTERVAL_MS / catJamBeatIntervalMs;
  catJamVideo.playbackRate = Math.min(2, Math.max(0.5, targetRate));
}

function syncCatJamVisibility() {
  const catJamOn = getSettings().catJam;
  const shouldShow = catJamOn && !!player?.currentTrack;

  // A narrow window gets the phone's full-screen player, which covers the
  // desktop cat's spot above the player bar -- sit on the cover art there
  // too (beat-sync keeps running on desktop either way).
  if (!isMobile) {
    if (isPhoneLayout()) {
      if (catJamVideo.parentElement !== nowPlayingArtWrap) nowPlayingArtWrap.appendChild(catJamVideo);
    } else if (catJamVideo.parentElement !== catJamHome.parent) {
      catJamHome.parent.insertBefore(catJamVideo, catJamHome.next);
    }
  }

  if (isMobile) {
    // Mobile: a plain looping overlay on the cover art, no beat-sync — beat
    // detection needs Web Audio's createMediaElementSource, which reroutes
    // the <audio> element permanently for its lifetime and can silence real
    // output entirely on Android's WebView (playback state/timeupdate/the
    // native media notification all keep reporting normally regardless,
    // since none of those depend on where the audio graph routes to — see
    // the desktop branch below, which never runs on Android).
    if (catJamVideo.parentElement !== nowPlayingArtWrap) nowPlayingArtWrap.appendChild(catJamVideo);
    setHidden(catJamVideo, !shouldShow);
    if (shouldShow) {
      catJamVideo.playbackRate = 1;
      catJamVideo.play().catch(() => {});
    }
    return;
  }

  const enabled = isDesktop && catJamOn;
  setHidden(catJamVideo, !shouldShow);
  if (shouldShow) catJamVideo.play().catch(() => {});
  if (enabled && !catJamRAF) catJamTick();
}

function parseSemver(str) {
  const m = String(str || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewerVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function showUpdateToast(version, url, canInstall = false) {
  updateToastText.textContent = t('update.available', { version });
  updateToastLink.href = url;
  // Desktop installs in place (download -> run installer -> Triptych quits
  // itself, see update-checker.js); elsewhere it's just the release link.
  updateToastInstall.hidden = !canInstall;
  updateToast.hidden = false;
}

async function installUpdateNow() {
  const updates = window.api?.updates;
  if (!updates?.download) return;
  updateToastInstall.disabled = true;
  updateToastDismiss.hidden = true;
  updateToastInstall.textContent = t('update.downloading', { percent: 0 });
  const result = await updates.download();
  if (!result?.ok) {
    updateToastInstall.disabled = false;
    updateToastDismiss.hidden = false;
    updateToastInstall.textContent = t('update.install');
    updateToastText.textContent = t('update.failed', { error: result?.error || '' });
    return;
  }
  updateToastInstall.textContent = t('update.installing');
  const started = await updates.install(result.file);
  if (!started?.ok) {
    updateToastInstall.disabled = false;
    updateToastDismiss.hidden = false;
    updateToastInstall.textContent = t('update.install');
    updateToastText.textContent = t('update.failed', { error: started?.error || '' });
  }
}

// Desktop has this via update-checker.js running in Electron's main
// process, but that's a Node-only module — Android has no equivalent, so
// this checks GitHub directly with a plain fetch() instead. App.getInfo()
// reads the actual installed APK's versionName rather than a hardcoded JS
// constant, so this can't drift the way CLIENT_VERSION already has once.
async function checkForUpdatesOnMobile() {
  try {
    const appInfo = await window.Capacitor.Plugins.App.getInfo();
    const current = parseSemver(appInfo.version);
    const res = await fetch('https://api.github.com/repos/greenythebeany/triptych/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return;
    const release = await res.json();
    const latest = parseSemver(release.tag_name) || parseSemver(release.name);
    if (!latest || !current || !isNewerVersion(latest, current)) return;
    showUpdateToast(latest.join('.'), release.html_url);
  } catch (err) {
    // Best-effort — no update check this session, not fatal.
  }
}

function wireUpdateToast() {
  updateToastDismiss.addEventListener('click', () => { updateToast.hidden = true; });
  if (window.api?.updates) {
    window.api.updates.onAvailable((result) => showUpdateToast(result.version, result.url, !!result.canInstall));
    updateToastInstall.addEventListener('click', installUpdateNow);
    window.api.updates.onProgress?.(({ received, total }) => {
      if (!total) return;
      updateToastInstall.textContent = t('update.downloading', { percent: Math.floor((received / total) * 100) });
    });
    // Quitting for the installer: stop playback first, so no audio stream
    // to the server is left open while the app shuts down.
    // Also saves listening time and resume state, so an update never loses
    // the last few minutes.
    window.api.onShuttingDown?.(() => {
      try { player?.audio.pause(); } catch (err) { /* nothing playing */ }
      saveResumeState();
      syncListening();
    });
  } else if (isMobile && getSettings().autoUpdateCheckEnabled !== false) {
    checkForUpdatesOnMobile();
  }
}

function wireMediaKeys() {
  if (!window.api?.mediaKeys) return;
  window.api.mediaKeys.onKey((key) => {
    if (!player) return;
    if (key === 'playpause') uiTogglePlay();
    else if (key === 'next') uiNext();
    else if (key === 'previous') uiPrevious();
    else if (key === 'stop' && !connect?.isConnected() && !player.audio.paused) uiTogglePlay();
  });
}

// ---------- Transport controls: local playback, or the connected remote
// device when one is active (see wireConnectMenu / updateRemoteBarUI) ----------

// ---------- Adaptive "Automatic" streaming quality ----------
// Measures how fast the server actually delivers audio (a short ranged
// download of a real track) and picks the stream quality from that:
// original files on a fast link, transcoded 320/192/96 kbps on slower
// ones (mobile data, a relayed Tailscale connection). Re-checked every few
// minutes and whenever the network changes; the next song uses it.
let lastThroughputMbit = null;
let probeRunning = false;

function bitrateForThroughput(mbit) {
  if (mbit >= 6) return 0;     // original quality (lossless/high-bitrate files need room)
  if (mbit >= 2.5) return 320;
  if (mbit >= 1.2) return 192;
  return 96;
}

async function probeConnection() {
  if (probeRunning || !jellyfin || getSettings().audioQuality !== 'auto' || navigator.onLine === false) return;
  const track = player?.currentTrack || allSongsCache?.[0];
  if (!track?.Id || isDownloaded(track.Id)) return;
  probeRunning = true;
  try {
    const res = await fetch(jellyfin.streamUrl(track, 0), { headers: { Range: 'bytes=0-786431' }, cache: 'no-store' });
    if (!res.body) return;
    // Timed from the first byte, so the server's start-up delay (seeking,
    // a relay hop) isn't mistaken for a slow transfer.
    const reader = res.body.getReader();
    let first = null;
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first === null) first = performance.now();
      else bytes += value.length;
    }
    const secs = first === null ? 0 : (performance.now() - first) / 1000;
    if (bytes < 65536 || secs <= 0) return; // too little to judge
    let mbit = (bytes * 8) / secs / 1e6;
    // The OS's own hints, where available (Android/Chrome): data saver or a
    // known-slow link caps it regardless of one lucky measurement.
    const conn = navigator.connection;
    if (conn?.saveData) mbit = Math.min(mbit, 1.5);
    if (conn?.effectiveType && /(^|-)2g|3g/.test(conn.effectiveType)) mbit = Math.min(mbit, 1.5);
    lastThroughputMbit = mbit;
    setAutoBitrate(bitrateForThroughput(mbit));
    refreshQualityStatus();
  } catch (err) {
    // Measurement failed (offline, server hiccup) -- keep the last choice.
  } finally {
    probeRunning = false;
  }
}

function startConnectionProbing() {
  setTimeout(probeConnection, 4000);
  setInterval(probeConnection, 5 * 60 * 1000);
  navigator.connection?.addEventListener?.('change', () => setTimeout(probeConnection, 1500));
  window.addEventListener('online', () => setTimeout(probeConnection, 1500));
}

// The "Right now: …" line under Settings -> Streaming quality.
function refreshQualityStatus() {
  const status = document.getElementById('quality-status');
  if (!status) return;
  if (getSettings().audioQuality !== 'auto' || lastThroughputMbit === null) { status.hidden = true; return; }
  const kbps = getAutoBitrate();
  const level = kbps ? t('settings.qualityKbps', { kbps }) : t('settings.qualityOriginal');
  status.textContent = t('settings.qualityNow', { level, speed: lastThroughputMbit.toFixed(1) });
  status.hidden = false;
}

// ---------- Listening time (see listening.js) ----------
let otherDeviceListening = []; // the other devices' logs, from the server
// The server load at login. Stats waits for it (briefly), or a fresh install
// -- empty local log -- showed 0 minutes until the next visit to Stats.
let listeningLoad = null;
let listeningTickAt = null;

function trackListeningTick() {
  const now = performance.now();
  const playing = player?.currentTrack && !player.audio.paused && !connect?.isConnected();
  if (playing && listeningTickAt !== null) {
    const delta = (now - listeningTickAt) / 1000;
    // Gaps over ~5s mean we weren't really observing (backgrounded, seek
    // stall...) -- don't credit time we can't vouch for.
    if (delta > 0 && delta < 5) addListening(player.currentTrack.Id, delta);
  }
  listeningTickAt = playing ? now : null;
}

async function loadListeningFromServer() {
  const logs = await jellyfin.getListeningLogs();
  adoptIfLarger(logs[jellyfin.deviceId]);
  otherDeviceListening = Object.entries(logs).filter(([id]) => id !== jellyfin.deviceId).map(([, l]) => l);
}

function syncListening() {
  persistListening();
  if (!listeningDirty() || !jellyfin) return;
  jellyfin.saveListeningLog(getOwnLog()).then(listeningSynced).catch(() => {});
}

function listeningTotals() {
  return combineLogs(otherDeviceListening);
}

// ---------- Resume where you left off ----------
// The queue, song, position, shuffle and repeat are saved locally as they
// change and put back (paused) on the next start. Only a window around the
// current song is kept, so a huge "All Songs" queue doesn't overflow
// localStorage, and only the fields the player and UI actually use.
const RESUME_KEY = 'triptych:resume';
const RESUME_TRACK_FIELDS = ['Id', 'Name', 'Album', 'AlbumId', 'AlbumArtist', 'Artists', 'ArtistItems', 'ImageTags',
  'AlbumPrimaryImageTag', 'RunTimeTicks', 'NormalizationGain', 'UserData', 'Genres', 'Type', '__queued'];
let resumeSaveTimer = null;

function saveResumeState() {
  if (!player?.currentTrack || connect?.isConnected()) return;
  const from = Math.max(0, player.currentIndex - 50);
  const tracks = player.queue.slice(from, from + 500).map((tr) => {
    const slim = {};
    RESUME_TRACK_FIELDS.forEach((k) => { if (tr[k] !== undefined) slim[k] = tr[k]; });
    return slim;
  });
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      tracks,
      index: player.currentIndex - from,
      position: Math.floor(player.audio.currentTime || 0),
      shuffle: player.shuffle,
      repeat: player.repeat,
      savedAt: Date.now()
    }));
  } catch (err) {
    // Storage full/blocked -- resuming is a convenience, skip it.
  }
}

function scheduleResumeSave() {
  clearTimeout(resumeSaveTimer);
  resumeSaveTimer = setTimeout(saveResumeState, 1000);
}

function restoreResumeState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch (err) { /* corrupt */ }
  if (!saved?.tracks?.length) return;
  player.restoreQueue(saved.tracks, saved.index, saved.position, { shuffle: saved.shuffle, repeat: saved.repeat });
  btnShuffle.classList.toggle('active', !!saved.shuffle);
  mobileBtnShuffle.classList.toggle('active', !!saved.shuffle);
  const repeatOn = saved.repeat && saved.repeat !== RepeatMode.OFF;
  btnRepeat.classList.toggle('active', !!repeatOn);
  mobileBtnRepeat.classList.toggle('active', !!repeatOn);
  const repeatIconClass = saved.repeat === RepeatMode.ONE ? 'fi fi-br-arrows-repeat-1' : 'fi fi-br-arrows-repeat';
  iconRepeat.className = repeatIconClass;
  mobileIconRepeat.className = repeatIconClass;
}

function uiTogglePlay() {
  if (connect?.isConnected()) { connect.remoteTogglePlay(); return; }
  player.togglePlay();
}

function uiNext() {
  if (connect?.isConnected()) { connect.remoteNext(); return; }
  player.next(true);
}

function uiPrevious(skipRestart = false) {
  if (connect?.isConnected()) { connect.remotePrevious(); return; }
  player.previous(skipRestart);
}

function uiSeekPercent(pct) {
  if (connect?.isConnected()) { connect.remoteSeekPercent(pct); return; }
  const duration = player.audio.duration || 0;
  player.seekTo((pct / 100) * duration);
}

// Phones: the volume slider drives the phone's real media volume (Android:
// SystemVolumePlugin.java, iOS: TriptychViewController.swift) and follows
// the hardware buttons, like the Spotify/Apple Music apps -- in-app volume
// stays at full so the phone's level is the one that counts. Desktop keeps
// the in-app volume.
const systemVolume = isMobile ? window.Capacitor?.Plugins?.TriptychSystemVolume : null;
let systemVolumeDragging = false;

function showVolumeLevel(pct) {
  volumeBar.value = pct;
  volumeBar.style.setProperty('--pct', rangeFillPercent(pct, volumeBar, 14));
  updateVolumeIcon(pct);
  npVolumeBar.value = pct;
  npVolumeBar.style.setProperty('--pct', rangeFillPercent(pct, npVolumeBar, 14));
}

function initSystemVolume() {
  if (!systemVolume) return;
  player.setVolume(1);
  systemVolume.getVolume().then(({ level }) => showVolumeLevel(Math.round(level * 100))).catch(() => {});
  systemVolume.addListener('volumeChange', ({ level }) => {
    // Don't fight the finger while the slider itself is being dragged.
    if (!systemVolumeDragging && !connect?.isConnected()) showVolumeLevel(Math.round(level * 100));
  });
  // iOS: the audio session goes active once something plays (only then do
  // the hardware buttons report changes), and the level is re-read whenever
  // the app comes back to the front, in case it changed meanwhile.
  if (window.Capacitor?.getPlatform?.() === 'ios') {
    player.on('playstate', () => {
      if (!player.audio.paused) systemVolume.activate().catch(() => {});
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || systemVolumeDragging || connect?.isConnected()) return;
    systemVolume.getVolume().then(({ level }) => showVolumeLevel(Math.round(level * 100))).catch(() => {});
  });
  const endDrag = () => { systemVolumeDragging = false; };
  [volumeBar, npVolumeBar].forEach((bar) => {
    bar.addEventListener('pointerdown', () => { systemVolumeDragging = true; });
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
  });
}

function uiSetVolumePercent(pct) {
  if (connect?.isConnected()) { connect.remoteSetVolume(pct); return; }
  if (systemVolume) {
    systemVolume.setVolume({ level: pct / 100 }).catch(() => {});
    return;
  }
  player.setVolume(sliderToVolume(pct));
}

// Mirrors the connected device's actual playback state into the player bar
// (art/title/artist/seek/time/play state/volume) — called on every Connect
// poll tick, and once with `null` right when a connection drops so the bar
// falls back to reflecting local state again.
function updateRemoteBarUI(session) {
  playerBar.classList.toggle('connected-remote', !!session);
  btnConnect.classList.toggle('active', !!session);
  btnConnectMobile.classList.toggle('active', !!session);
  if (!session) {
    // Disconnected — restore the bar to whatever's actually loaded locally
    // (paused, since it was stopped for the handoff) instead of leaving the
    // last-seen remote track showing.
    const track = player.currentTrack;
    if (track) {
      playerArt.src = artUrl(track, 'album', 64);
      withOfflineArtFallback(playerArt, track);
      playerTitle.textContent = track.Name;
      playerArtist.textContent = artistNames(track);
      nowPlayingArt.src = artUrl(track, 'album', 440);
      withOfflineArtFallback(nowPlayingArt, track);
      setMarqueeText(nowPlayingTitle, track.Name);
      setMarqueeText(nowPlayingArtist, artistNames(track));
      setArtAlt(track.Name, artistNames(track));
      nowPlayingLikeBtn.classList.toggle('liked', !!track.UserData?.IsFavorite);
      setDownloadButtonState(nowPlayingDownloadBtn, isDownloaded(track.Id) ? 'downloaded' : 'idle');
      const playing = !player.audio.paused;
      setHidden(iconPlay, playing);
      setHidden(iconPause, !playing);
      setHidden(mobileIconPlay, playing);
      setHidden(mobileIconPause, !playing);
      const duration = ticksToSeconds(track.RunTimeTicks) || player.audio.duration || 0;
      const current = player.audio.currentTime || 0;
      const pct = duration ? (current / duration) * 100 : 0;
      seekBar.value = pct;
      seekBar.style.setProperty('--pct', rangeFillPercent(pct, seekBar, 14));
      mobileSeekBar.value = pct;
      mobileSeekBar.style.setProperty('--pct', rangeFillPercent(pct, mobileSeekBar, 12));
      timeCurrent.textContent = formatTime(current);
      mobileTimeCurrent.textContent = formatTime(current);
      if (duration) { timeTotal.textContent = formatTime(duration); mobileTimeTotal.textContent = formatTime(duration); }
    }
    if (systemVolume) {
      // Back to local: show the phone's actual media volume again.
      systemVolume.getVolume().then(({ level }) => showVolumeLevel(Math.round(level * 100))).catch(() => {});
      return;
    }
    const volPct = Math.round(Math.sqrt(player.baseVolume) * 100);
    volumeBar.value = volPct;
    volumeBar.style.setProperty('--pct', rangeFillPercent(volPct, volumeBar, 14));
    updateVolumeIcon(volPct);
    return;
  }

  playerBar.hidden = false;
  appRoot.classList.add('has-track');

  const item = session.NowPlayingItem;
  const playState = session.PlayState || {};
  if (item) {
    const art = jellyfin.imageUrl(item) || placeholderArt('album');
    playerArt.src = art;
    playerTitle.textContent = item.Name || '';
    playerArtist.textContent = artistNames(item);
    nowPlayingArt.src = jellyfin.imageUrl(item, 'Primary', 800) || art;
    setMarqueeText(nowPlayingTitle, item.Name || '');
    setMarqueeText(nowPlayingArtist, artistNames(item));
    setArtAlt(item.Name, artistNames(item));
    nowPlayingLikeBtn.classList.toggle('liked', !!item.UserData?.IsFavorite);
    const posSeconds = (playState.PositionTicks || 0) / 10000000;
    const durSeconds = (item.RunTimeTicks || 0) / 10000000;
    const pct = durSeconds ? (posSeconds / durSeconds) * 100 : 0;
    seekBar.value = pct;
    seekBar.style.setProperty('--pct', rangeFillPercent(pct, seekBar, 14));
    mobileSeekBar.value = pct;
    mobileSeekBar.style.setProperty('--pct', rangeFillPercent(pct, mobileSeekBar, 12));
    timeCurrent.textContent = formatTime(posSeconds);
    mobileTimeCurrent.textContent = formatTime(posSeconds);
    timeTotal.textContent = formatTime(durSeconds);
    mobileTimeTotal.textContent = formatTime(durSeconds);
  }

  const playing = !playState.IsPaused;
  setHidden(iconPlay, playing);
  setHidden(iconPause, !playing);
  setHidden(mobileIconPlay, playing);
  setHidden(mobileIconPause, !playing);

  if (playState.VolumeLevel != null) {
    volumeBar.value = playState.VolumeLevel;
    volumeBar.style.setProperty('--pct', rangeFillPercent(playState.VolumeLevel, volumeBar, 14));
    updateVolumeIcon(playState.VolumeLevel);
  }
}

function refreshSettingsUI() {
  const s = getSettings();
  languageSelect.value = s.language;
  toggleArtBackground.checked = !!s.artBackground;
  toggleDynamicAccentColor.checked = !!s.dynamicAccentColor;
  crossfadeSlider.value = s.crossfadeSeconds || 0;
  crossfadeValue.textContent = s.crossfadeSeconds ? `${s.crossfadeSeconds}s` : t('settings.crossfadeOff');
  crossfadeSlider.style.setProperty('--pct', rangeFillPercent(((s.crossfadeSeconds || 0) / 12) * 100, crossfadeSlider, 13));
  toggleOfflineMode.checked = !!s.offlineMode;
  toggleAlbumArtLookup.checked = s.albumArtLookupEnabled !== false;
  toggleLyricsSearch.checked = !!s.lyricsSearchEnabled;
  toggleHaptics.checked = s.hapticsEnabled !== false;
  toggleNothingDots.checked = s.nothingDottedSliders !== false;
  setHidden(nothingDotsRow, s.uiStyle !== 'nothing');
  setHapticsEnabled(s.hapticsEnabled);
  refreshStorageUI();
  toggleAutoUpdateCheck.checked = s.autoUpdateCheckEnabled !== false;
  toggleReplayGain.checked = !!s.replayGainEnabled;
  const loudnessBoostDb = s.loudnessBoostDb ?? 10;
  loudnessBoostSlider.value = loudnessBoostDb;
  loudnessBoostValue.textContent = `${loudnessBoostDb} dB`;
  loudnessBoostSlider.style.setProperty('--pct', rangeFillPercent((loudnessBoostDb / 20) * 100, loudnessBoostSlider, 13));
  toggleEqualizer.checked = !!s.eqEnabled;
  setHidden(equalizerBandsRow, !s.eqEnabled);
  const eqPreset = s.eqPreset || 'flat';
  setHidden(eqPresetSelect.querySelector('option[value="custom"]'), eqPreset !== 'custom');
  eqPresetSelect.value = eqPreset;
  const eqGains = s.eqGains || [0, 0, 0, 0, 0];
  eqBandSliders.forEach((slider) => {
    const band = Number(slider.dataset.band);
    const gain = eqGains[band] || 0;
    slider.value = gain;
    const valueEl = document.querySelector(`.eq-band-value[data-band-value="${band}"]`);
    valueEl.textContent = gain > 0 ? `+${gain}` : `${gain}`;
  });
  toggleCatJam.checked = !!s.catJam;
  setHidden(catJamScaleRow, !s.catJam);
  const catScale = s.catJamScale || 1;
  catJamScaleSlider.value = catScale;
  catJamScaleValue.textContent = `${catScale.toFixed(1)}x`;
  catJamScaleSlider.style.setProperty('--pct', rangeFillPercent(((catScale - 0.5) / 2.5) * 100, catJamScaleSlider, 14));
  catJamVideo.style.setProperty('--cat-scale', catScale);
  if (document.activeElement !== customCssInput) customCssInput.value = s.customCss || '';
  themeModeToggle.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === s.themeMode);
  });
  uiStyleToggle.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === (s.uiStyle || 'spotify'));
  });
  paletteGrid.querySelectorAll('.palette-swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.value === s.palette);
  });
  audioQualitySelect.value = s.audioQuality;
}

let settingsTriggerEl = null;
function openSettings() {
  refreshSettingsUI();
  settingsTriggerEl = document.activeElement;
  settingsOverlay.hidden = false;
  btnCloseSettings.focus();
}
function closeSettings() {
  settingsOverlay.hidden = true;
  settingsTriggerEl?.focus();
}

// ---------- Legal & Privacy overlay ----------
let legalTriggerEl = null;
function openLegal(anchor) {
  legalTriggerEl = document.activeElement;
  legalOverlay.hidden = false;
  const target = anchor && document.getElementById(anchor);
  if (target) target.scrollIntoView({ block: 'start' });
  else legalBody.scrollTop = 0;
  btnCloseLegal.focus();
}
function closeLegal() {
  legalOverlay.hidden = true;
  legalTriggerEl?.focus();
}
function wireLegalOverlay() {
  btnCloseLegal.addEventListener('click', closeLegal);
  legalOverlay.addEventListener('click', (evt) => {
    if (evt.target === legalOverlay) closeLegal();
  });
  btnOpenLegalPrivacy.addEventListener('click', () => openLegal('legal-privacy'));
  btnOpenLegalTerms.addEventListener('click', () => openLegal('legal-terms'));
  btnOpenLegalThirdParty.addEventListener('click', () => openLegal('legal-thirdparty'));
  btnOpenLegalDeletion.addEventListener('click', () => openLegal('legal-deletion'));
}

// ---------- First-run privacy notice ----------
// There are no cookies/trackers here to ask consent for, but a few
// background lookups do talk to outside services (see Privacy Policy) --
// disclosed once, up front, rather than left for someone to stumble on in
// a settings menu they may never open.
const PRIVACY_NOTICE_SEEN_KEY = 'triptych:privacyNoticeSeen';
function wirePrivacyNotice() {
  if (!localStorage.getItem(PRIVACY_NOTICE_SEEN_KEY)) setHidden(privacyNotice, false);
  const dismiss = () => {
    localStorage.setItem(PRIVACY_NOTICE_SEEN_KEY, '1');
    setHidden(privacyNotice, true);
  };
  privacyNoticeDismiss.addEventListener('click', dismiss);
  privacyNoticeView.addEventListener('click', () => {
    dismiss();
    openLegal('legal-privacy');
  });
}

// ---------- Create playlist modal ----------
let createPlaylistTriggerEl = null;
function wireCreatePlaylistUI() {
  btnNewPlaylist.addEventListener('click', () => {
    inputPlaylistName.value = '';
    createPlaylistTriggerEl = document.activeElement;
    createPlaylistOverlay.hidden = false;
    inputPlaylistName.focus();
  });
  btnCloseCreatePlaylist.addEventListener('click', closeCreatePlaylist);
  createPlaylistOverlay.addEventListener('click', (evt) => {
    if (evt.target === createPlaylistOverlay) closeCreatePlaylist();
  });
  createPlaylistForm.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const name = inputPlaylistName.value.trim();
    if (!name) return;
    const submitBtn = createPlaylistForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      const created = await jellyfin.createPlaylist(name);
      closeCreatePlaylist();
      await loadPlaylistSidebar();
      navigateTo({ view: 'playlist', id: created.Id, name });
    } catch (err) {
      alert(err.message || t('errors.couldNotCreatePlaylist'));
    } finally {
      submitBtn.disabled = false;
    }
  });
}
function closeCreatePlaylist() {
  createPlaylistOverlay.hidden = true;
  createPlaylistTriggerEl?.focus();
}

// ---------- Hardware back button (Android) ----------
let lastBackPressAt = 0;
function wireBackButton() {
  if (!isMobile) return;
  wireHardwareBackButton(() => {
    // Close whatever's on top first, in the order a user would expect.
    if (!whatsNewOverlay.hidden) { closeWhatsNew(); return; }
    if (!settingsOverlay.hidden) { closeSettings(); return; }
    if (!createPlaylistOverlay.hidden) { closeCreatePlaylist(); return; }
    if (!accountMenu.hidden) { accountMenu.hidden = true; return; }
    if (activeAddMenu) { closeAddToPlaylistMenu(); return; }
    if (queueSheetOpen || lyricsSheetOpen) { closeQueueSheet(); return; }
    if (!lyricsPanel.hidden) { closeNowPlaying(); return; }

    if (viewHistory.length > 1) { goBack(); return; }

    // At root: require a second press within 2s to actually exit.
    const now = Date.now();
    if (now - lastBackPressAt < 2000) {
      exitApp();
    } else {
      lastBackPressAt = now;
    }
  });
}

// ---------- Sidebar / bottom-nav navigation ----------
document.querySelectorAll('.nav-item, .bottom-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => navigateTo({ view: btn.dataset.view }));
});

async function loadPlaylistSidebar() {
  playlistListEl.innerHTML = '';
  const playlists = await jellyfin.getPlaylists();
  if (!playlists.length) {
    playlistListEl.appendChild(el('div', 'playlist-empty', t('playlist.sidebarEmpty')));
    return;
  }
  playlists.forEach((pl) => {
    const item = el('button', 'playlist-item');
    const img = document.createElement('img');
    img.className = 'pl-thumb';
    img.src = artUrl(pl, 'album', 48);
    item.appendChild(img);
    const span = document.createElement('span');
    span.textContent = pl.Name;
    item.appendChild(span);
    item.addEventListener('click', () => navigateTo({ view: 'playlist', id: pl.Id, name: pl.Name }));
    wirePlaylistDropTarget(item, pl.Id);
    playlistListEl.appendChild(item);
  });
}

function loadPinnedAlbumsSidebar() {
  const albums = getPinnedAlbums();
  pinnedAlbumsSectionEl.hidden = !albums.length;
  pinnedAlbumsListEl.innerHTML = '';
  albums.forEach((album) => {
    const item = el('button', 'playlist-item');
    const img = document.createElement('img');
    img.className = 'pl-thumb';
    img.src = artUrl(album, 'album', 48);
    item.appendChild(img);
    const span = document.createElement('span');
    span.textContent = album.Name;
    item.appendChild(span);
    item.addEventListener('click', () => navigateTo({ view: 'album', id: album.Id }));
    pinnedAlbumsListEl.appendChild(item);
  });
}

// ---------- View router with back/forward ----------
function navigateTo(state, pushHistory = true) {
  if (pushHistory && viewHistory.length) viewFuture = [];
  if (pushHistory) viewHistory.push(state);
  renderView(state);
  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  globalSearchWrap.hidden = state.view !== 'search';
  if (state.view === 'search') globalSearchInput.focus();
}

// Reloads whatever page is showing with fresh server data -- the full-
// library cache and the playlist sidebar included, since those are what
// would otherwise keep serving stale results.
async function refreshCurrentView() {
  const state = viewHistory[viewHistory.length - 1] || { view: 'home' };
  allSongsCache = null;
  loadPlaylistSidebar().catch(() => {});
  await renderView(state);
}

// Pull-to-refresh on the main page (phone layout, touch only): pull down
// while scrolled to the very top, let go past the threshold to reload.
function wirePullToRefresh() {
  const THRESHOLD = 70;
  const MAX = 110;
  let startY = 0, startX = 0, pull = 0, tracking = false, axis = null, busy = false;

  const place = (distance, settle) => {
    pullRefreshEl.classList.toggle('settling', !!settle);
    const top = mainHeaderEl.offsetHeight;
    pullRefreshEl.style.transform = `translateY(${top + distance}px) rotate(${distance * 3}deg)`;
    pullRefreshEl.style.opacity = distance > 4 ? String(Math.min(1, distance / THRESHOLD)) : '0';
  };

  mainEl.addEventListener('touchstart', (evt) => {
    if (busy || evt.touches.length !== 1 || !isPhoneLayout() || mainEl.scrollTop > 0) return;
    tracking = true;
    axis = null;
    pull = 0;
    startY = evt.touches[0].clientY;
    startX = evt.touches[0].clientX;
  }, { passive: true });

  mainEl.addEventListener('touchmove', (evt) => {
    if (!tracking) return;
    const dy = evt.touches[0].clientY - startY;
    const dx = evt.touches[0].clientX - startX;
    if (!axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis = Math.abs(dy) > Math.abs(dx) && dy > 0 && mainEl.scrollTop <= 0 ? 'pull' : 'other';
    }
    if (axis !== 'pull') { tracking = false; return; }
    evt.preventDefault(); // stop the page itself from scrolling/bouncing
    pull = Math.min(MAX, dy * 0.5); // rubber-band resistance
    place(pull, false);
  }, { passive: false });

  const end = async () => {
    if (!tracking) return;
    tracking = false;
    if (axis !== 'pull') return;
    if (pull < THRESHOLD) { place(0, true); return; }
    busy = true;
    hapticImpact('light');
    place(THRESHOLD * 0.8, true);
    pullRefreshEl.classList.add('refreshing');
    try {
      await refreshCurrentView();
    } finally {
      pullRefreshEl.classList.remove('refreshing');
      place(0, true);
      busy = false;
    }
  };
  mainEl.addEventListener('touchend', end);
  mainEl.addEventListener('touchcancel', end);
}

function goBack() {
  if (viewHistory.length < 2) return;
  viewFuture.push(viewHistory.pop());
  renderView(viewHistory[viewHistory.length - 1]);
}
function goForward() {
  if (!viewFuture.length) return;
  const state = viewFuture.pop();
  viewHistory.push(state);
  renderView(state);
}

document.getElementById('btn-back').addEventListener('click', goBack);
document.getElementById('btn-forward').addEventListener('click', goForward);

// Mouse "back"/"forward" side buttons (button 3 / button 4) — Chromium would
// otherwise try to navigate the window's own history, which this app doesn't use.
window.addEventListener('mouseup', (evt) => {
  if (evt.button === 3) {
    evt.preventDefault();
    goBack();
  } else if (evt.button === 4) {
    evt.preventDefault();
    goForward();
  }
});

async function renderView(state) {
  viewRoot.innerHTML = '<div class="view-loading" role="status" aria-label="Loading"><div class="loading-spinner"></div></div>';
  mainEl.classList.remove('has-hero', 'hero-top');
  playAllBtn = null;
  playAllTrackIds = [];
  cardRegistry = [];
  try {
    switch (state.view) {
      case 'home': await renderHome(); break;
      case 'search': await renderSearch(); break;
      case 'songs': await renderAllSongs(); break;
      case 'liked': await renderLikedSongs(); break;
      case 'downloads': await renderDownloads(); break;
      case 'grab': await renderGrab(); break;
      case 'library': renderLibrary(); break;
      case 'genres': await renderGenres(); break;
      case 'genre': await renderGenreDetail(state.id, state.name); break;
      case 'albums': await renderAlbums(); break;
      case 'artists': await renderArtists(); break;
      case 'playlist': await renderPlaylistDetail(state.id, state.name); break;
      case 'album': await renderAlbumDetail(state.id); break;
      case 'artist': await renderArtistDetail(state.id, state.name); break;
      case 'stats': await renderStats(); break;
      case 'smartMix': await renderSmartMix(state); break;
      default: await renderHome();
    }
  } catch (err) {
    viewRoot.innerHTML = `<div class="empty-state">Something went wrong: ${err.message}</div>`;
    return;
  }
  syncCardStates();
}

// ---------- Views ----------

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Shares one in-flight request, so the background warm-up from renderHome
// and a view that needs the cache don't both download the whole library.
let allSongsCachePromise = null;
async function ensureAllSongsCache() {
  if (allSongsCache) return allSongsCache;
  if (!allSongsCachePromise) {
    allSongsCachePromise = jellyfin.getAllSongs(musicLibraryId)
      .then((songs) => { allSongsCache = songs; return songs; })
      .finally(() => { allSongsCachePromise = null; });
  }
  return allSongsCachePromise;
}

// A collab track's Artists can be several names ("Avantasia" + "Tobias
// Sammet" + guest features) — count each one individually rather than the
// joined display string, or every distinct lineup becomes its own "artist".
function individualArtistNames(track) {
  if (track.Artists && track.Artists.length) return track.Artists.map(formatDisplayName);
  if (track.AlbumArtist) return [formatDisplayName(track.AlbumArtist)];
  return [];
}

// Some libraries tag collabs as one joined string ("Avantasia, Tobias
// Sammet", "OmenXIII/Palaye Royale") rather than splitting it into separate
// artist credits, so Jellyfin's own ArtistIds filter never associates that
// track with the real artist entity and it only turns up under its own
// one-song pseudo-artist — and the real artist isn't always listed first.
// Split on the common join patterns and check every part, not just a
// startsWith prefix. Punctuation separators (,;&+/) don't need surrounding
// whitespace, since tags join tightly ("Palaye Royale/Kellin Quinn") as
// often as with spaces — but word separators (feat/ft/with/vs) require
// actual whitespace around them, or "with" would split a real single-artist
// name like "Withers" in half.
function splitCreditParts(creditName) {
  return (creditName || '')
    .trim()
    .toLowerCase()
    .split(/\s*[,;&+/]\s*|\s+(?:feat\.?|ft\.?|with|vs\.?)\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function creditIncludesArtist(creditName, targetName) {
  if (!creditName || !targetName) return false;
  const c = creditName.trim().toLowerCase();
  const t = targetName.trim().toLowerCase();
  if (c === t) return true;
  // targetName can itself be a real multi-word group ("Dame, SMART"), not
  // just a single name — match if every name it's made of is present among
  // the credit's own split names, so a further-joined credit like
  // "Dame, Separ, SMART" still folds into the duo's page rather than just
  // the individual members'.
  const targetParts = splitCreditParts(t);
  if (!targetParts.length) return false;
  const creditParts = splitCreditParts(c);
  return targetParts.every((p) => creditParts.includes(p));
}

function trackCredits(track) {
  if (track.Artists && track.Artists.length) return track.Artists;
  if (track.AlbumArtist) return [track.AlbumArtist];
  return [];
}

// "Most Played" / "On Repeat" / "Recently Played" / stats all read Jellyfin's
// own UserData (PlayCount, LastPlayedDate) instead of anything stored
// locally — UserData lives on the account server-side, so these follow the
// user across devices instead of being stuck in one browser's storage.
// `source` defaults to the full library cache; the home page instead passes
// a small server-sorted slice so it doesn't need the whole library first.
function accountRecentlyPlayed(limit = 12, source = allSongsCache) {
  if (!source) return [];
  return source
    .filter((tr) => tr.UserData?.LastPlayedDate)
    .sort((a, b) => new Date(b.UserData.LastPlayedDate) - new Date(a.UserData.LastPlayedDate))
    .slice(0, limit);
}

function accountMostPlayed(limit = 30, source = allSongsCache) {
  if (!source) return [];
  return source
    .filter((tr) => (tr.UserData?.PlayCount || 0) > 0)
    .sort((a, b) => (b.UserData.PlayCount || 0) - (a.UserData.PlayCount || 0))
    .slice(0, limit);
}

function accountOnRepeat(limit = 30, source = allSongsCache) {
  if (!source) return [];
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  return source
    .filter((tr) => (tr.UserData?.PlayCount || 0) >= 3 && tr.UserData?.LastPlayedDate && new Date(tr.UserData.LastPlayedDate).getTime() >= cutoff)
    .sort((a, b) => (b.UserData.PlayCount || 0) - (a.UserData.PlayCount || 0))
    .slice(0, limit);
}

function accountStats() {
  const tracks = allSongsCache || [];
  let totalPlays = 0;
  let totalMs = 0;
  const artistCounts = new Map();
  const albumCounts = new Map();
  const topTracks = [];
  for (const tr of tracks) {
    const count = tr.UserData?.PlayCount || 0;
    if (count <= 0) continue;
    totalPlays += count;
    totalMs += count * ((tr.RunTimeTicks || 0) / 10000);
    individualArtistNames(tr).forEach((artist) => {
      artistCounts.set(artist, (artistCounts.get(artist) || 0) + count);
    });
    if (tr.Album) albumCounts.set(tr.Album, (albumCounts.get(tr.Album) || 0) + count);
    topTracks.push(tr);
  }
  topTracks.sort((a, b) => (b.UserData.PlayCount || 0) - (a.UserData.PlayCount || 0));
  const topArtists = [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([artist, count]) => ({ artist, count }));
  const topAlbums = [...albumCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([album, count]) => ({ album, count }));
  return {
    totalPlays,
    totalMinutes: Math.round(totalMs / 60000),
    topArtists,
    topAlbums,
    topTracks: topTracks.slice(0, 10)
  };
}

function buildSmartMixCard({ title, subtitle, art, onPlay, onOpen }) {
  const card = el('div', 'card');
  const artWrap = el('div', 'card-art-wrap');
  const img = document.createElement('img');
  img.className = 'card-art';
  img.src = art || placeholderArt('album');
  artWrap.appendChild(img);
  const playBtn = el('button', 'card-play-btn');
  playBtn.innerHTML = '<svg class="icon-play-all-play" viewBox="0 0 24 24"><path d="M8 5v14l12-7z"/></svg>';
  playBtn.addEventListener('click', (evt) => { evt.stopPropagation(); onPlay(); });
  artWrap.appendChild(playBtn);
  card.appendChild(artWrap);
  card.appendChild(el('div', 'card-title', escapeHtml(title)));
  if (subtitle) card.appendChild(el('div', 'card-subtitle', escapeHtml(subtitle)));
  // Clicking the card body opens the mix's track list, same as any other
  // collection card — only the dedicated play button starts playback directly.
  card.addEventListener('click', onOpen);
  return card;
}

function buildSmartMixCards(genres, mostPlayed, onRepeat) {
  const cards = [];

  if (mostPlayed.length >= 3) {
    cards.push(buildSmartMixCard({
      title: t('home.mostPlayed'),
      subtitle: t('home.songsCount', { count: mostPlayed.length }),
      art: artUrl(mostPlayed[0]),
      onPlay: () => player.setQueue(mostPlayed, 0, 'smart:most-played'),
      onOpen: () => navigateTo({ view: 'smartMix', mixKind: 'most-played', title: t('home.mostPlayed') })
    }));
  }

  if (onRepeat.length >= 3) {
    cards.push(buildSmartMixCard({
      title: t('home.onRepeat'),
      subtitle: t('home.songsCount', { count: onRepeat.length }),
      art: artUrl(onRepeat[0]),
      onPlay: () => player.setQueue(onRepeat, 0, 'smart:on-repeat'),
      onOpen: () => navigateTo({ view: 'smartMix', mixKind: 'on-repeat', title: t('home.onRepeat') })
    }));
  }

  genres.slice(0, 2).forEach((genre) => {
    cards.push(buildSmartMixCard({
      title: genre.Name,
      subtitle: t('home.genreMix'),
      art: artUrl(genre, 'album'),
      onPlay: async () => {
        const tracks = await jellyfin.getSongsByGenre(genre.Id);
        if (tracks.length) player.setQueue(shuffleArray(tracks).slice(0, 50), 0, `smart:genre:${genre.Id}`);
      },
      onOpen: () => navigateTo({ view: 'smartMix', mixKind: 'genre', genreId: genre.Id, title: genre.Name })
    }));
  });

  return cards;
}

async function renderSmartMix(state) {
  let tracks;
  if (state.mixKind === 'most-played') {
    await ensureAllSongsCache();
    tracks = accountMostPlayed(30);
  } else if (state.mixKind === 'on-repeat') {
    await ensureAllSongsCache();
    tracks = accountOnRepeat(30);
  } else {
    tracks = shuffleArray(await jellyfin.getSongsByGenre(state.genreId)).slice(0, 50);
  }

  viewRoot.innerHTML = '';
  viewRoot.appendChild(buildDetailHeader({
    kind: t('home.madeForYou'),
    title: state.title,
    sub: trackListSummary(tracks),
    art: tracks[0] ? artUrl(tracks[0], 'album', 220) : placeholderArt('album'),
    round: false,
    onPlayAll: tracks.length ? () => player.setQueue(tracks, 0, `smart:${state.mixKind}:${state.genreId || ''}`) : undefined,
    trackIds: tracks.map((tr) => tr.Id)
  }));
  if (!tracks.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('playlist.empty')));
    return;
  }
  viewRoot.appendChild(buildTrackTable(tracks, tracks));
}

// Recently played songs fetched for "On Repeat" -- anything played 3+ times
// in the last two weeks is near the top of a DatePlayed sort, so a few
// hundred covers it without pulling the whole library.
const HOME_RECENT_PLAYED_LIMIT = 300;

// The artist you've played most lately, and albums Jellyfin considers
// similar to their most recently played album (minus their own albums).
async function fillBecauseYouListened(slot, recentTracks, excludeAlbumIds = new Set()) {
  const counts = new Map();
  for (const tr of recentTracks) {
    const artist = tr.ArtistItems?.[0];
    if (!artist?.Id || !tr.AlbumId) continue;
    const entry = counts.get(artist.Id) || { artist, count: 0, albumId: tr.AlbumId };
    entry.count++;
    counts.set(artist.Id, entry);
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!top) return;
  const similar = (await jellyfin.getSimilarItems(top.albumId, 16))
    .filter((al) => al.Type === 'MusicAlbum' && !excludeAlbumIds.has(al.Id) && !(al.AlbumArtist || '').toLowerCase().includes((top.artist.Name || '').toLowerCase()))
    .slice(0, 12);
  if (similar.length < 3 || !slot.isConnected) return;
  slot.appendChild(el('div', 'section-title', escapeHtml(t('home.becauseYouListened', { artist: formatDisplayName(top.artist.Name) }))));
  slot.appendChild(buildCardRow(similar, 'album'));
}

async function renderHome() {
  const [playlists, albums, genres, recentPlayed, topPlayed] = await Promise.all([
    jellyfin.getPlaylists(),
    jellyfin.getLatestAlbums(musicLibraryId, 12),
    jellyfin.getMusicGenres().catch(() => []),
    allSongsCache ? null : jellyfin.getPlayedSongs(musicLibraryId, 'DatePlayed', HOME_RECENT_PLAYED_LIMIT),
    allSongsCache ? null : jellyfin.getPlayedSongs(musicLibraryId, 'PlayCount', 30)
  ]);
  const recentSource = allSongsCache || recentPlayed;
  const topSource = allSongsCache || topPlayed;

  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('home.greeting')));
  // Around New Year, Wrapped gets the top spot on Home too.
  const wrappedBanner = buildWrappedBanner();
  if (wrappedBanner && recentSource?.length) viewRoot.appendChild(wrappedBanner);

  const recentlyPlayed = accountRecentlyPlayed(12, recentSource);
  if (recentlyPlayed.length) {
    viewRoot.appendChild(el('div', 'section-title', t('home.recentlyPlayed')));
    viewRoot.appendChild(buildCardRow(recentlyPlayed, 'song'));
  }

  // Jump back in: the albums behind your most recent plays.
  const recentAlbums = [];
  const seenAlbums = new Set();
  for (const tr of accountRecentlyPlayed(80, recentSource)) {
    if (!tr.AlbumId || seenAlbums.has(tr.AlbumId)) continue;
    seenAlbums.add(tr.AlbumId);
    recentAlbums.push({ Id: tr.AlbumId, AlbumId: tr.AlbumId, Name: tr.Album, AlbumArtist: tr.AlbumArtist || artistNames(tr), Type: 'MusicAlbum' });
    if (recentAlbums.length >= 10) break;
  }
  if (recentAlbums.length >= 2) {
    viewRoot.appendChild(el('div', 'section-title', t('home.jumpBackIn')));
    viewRoot.appendChild(buildCardRow(recentAlbums, 'album'));
  }
  // "Because you listened to X" fills in below once its server call returns.
  const becauseSlot = el('div', '');

  const smartMixCards = buildSmartMixCards(genres, accountMostPlayed(30, topSource), accountOnRepeat(30, recentSource));
  if (smartMixCards.length) {
    viewRoot.appendChild(el('div', 'section-title', t('home.madeForYou')));
    const grid = el('div', 'card-grid');
    smartMixCards.forEach((card) => grid.appendChild(card));
    viewRoot.appendChild(grid);
  }

  viewRoot.appendChild(becauseSlot);
  // Skip albums already shown in Jump Back In.
  fillBecauseYouListened(becauseSlot, accountRecentlyPlayed(60, recentSource), seenAlbums).catch(() => {});

  if (playlists.length) {
    viewRoot.appendChild(el('div', 'section-title', t('home.yourPlaylists')));
    viewRoot.appendChild(buildCardGrid(playlists.slice(0, 12), 'playlist'));
  }

  viewRoot.appendChild(el('div', 'section-title', t('home.recentAlbums')));
  viewRoot.appendChild(buildCardRow(albums.slice(0, 12), 'album'));

  // Warm the full-library cache in the background once home is on screen,
  // so Songs/Stats/artist pages are instant later instead of blocking now.
  if (!allSongsCache) ensureAllSongsCache().catch(() => {});
}

async function renderSearch() {
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('search.title')));
  const resultsEl = el('div', 'card-grid');
  viewRoot.appendChild(resultsEl);

  let debounceTimer;
  globalSearchInput.oninput = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const term = globalSearchInput.value.trim();
      resultsEl.innerHTML = '';
      if (!term) return;
      let items;
      try {
        items = await jellyfin.search(term);
      } catch (err) {
        resultsEl.appendChild(el('div', 'empty-state', t('search.failed', { error: err.message })));
        return;
      }
      if (!items.length) {
        resultsEl.appendChild(el('div', 'empty-state', t('search.noResults')));
        return;
      }
      items.forEach((item) => resultsEl.appendChild(buildCard(item, typeToKind(item.Type))));
      appendLyricMatches(term, resultsEl);
    }, 300);
  };
}

// "Found in lyrics": songs whose lyrics contain the typed line (see
// lyricsIndex.js), each with the matching line. Shown under the normal
// results; a hint instead when lyrics search is turned off.
async function appendLyricMatches(term, resultsEl) {
  const words = term.trim().split(/\s+/).length;
  if (words < 2) return;
  resultsEl.parentElement?.querySelectorAll('.lyric-matches').forEach((old) => old.remove());
  const section = el('div', 'lyric-matches');
  if (!getSettings().lyricsSearchEnabled) {
    if (words < 4) return;
    section.appendChild(el('div', 'empty-state lyric-hint', escapeHtml(t('search.lyricsOff'))));
    resultsEl.after(section);
    return;
  }
  const hits = await searchByLyrics(term);
  if (globalSearchInput.value.trim() !== term || !hits.length) return;
  await ensureAllSongsCache().catch(() => {});
  const byId = new Map((allSongsCache || []).map((tr) => [tr.Id, tr]));
  const tracks = hits.map((h) => byId.get(h.id)).filter(Boolean);
  if (!tracks.length) return;
  section.appendChild(el('div', 'section-title', escapeHtml(t('search.lyricsMatches'))));
  hits.forEach((hit) => {
    const track = byId.get(hit.id);
    if (!track) return;
    const row = el('button', 'lyric-hit');
    row.type = 'button';
    row.innerHTML = `<img src="${artUrl(track, 'album', 48)}" alt="" loading="lazy">
      <span class="lyric-hit-text"><span class="lyric-hit-title">${escapeHtml(track.Name)}</span>
      <span class="lyric-hit-artist">${escapeHtml(artistNames(track))}</span>
      ${hit.line ? `<span class="lyric-hit-line">“${escapeHtml(hit.line)}”</span>` : ''}</span>`;
    row.addEventListener('click', () => player.setQueue(tracks, tracks.indexOf(track)));
    section.appendChild(row);
  });
  resultsEl.parentElement?.querySelectorAll('.lyric-matches').forEach((old) => old.remove());
  resultsEl.after(section);
}

async function startLyricsIndexing() {
  if (!getSettings().lyricsSearchEnabled) return;
  await ensureAllSongsCache().catch(() => {});
  if (allSongsCache?.length) startIndexing(allSongsCache, lyricsQueryFor, fetchLyrics);
}

function showLyricsIndexStatus(status) {
  if (!lyricsIndexStatus) return;
  lyricsIndexStatus.textContent = getSettings().lyricsSearchEnabled && status.total
    ? t('settings.lyricsSearchStatus', { done: status.done, total: status.total, found: status.withLyrics })
    : '';
}

async function refreshLyricsIndexStatus() {
  if (!getSettings().lyricsSearchEnabled) { showLyricsIndexStatus({ total: 0 }); return; }
  await ensureAllSongsCache().catch(() => {});
  showLyricsIndexStatus(await indexStatus((allSongsCache || []).map((tr) => tr.Id)));
}

async function renderAllSongs() {
  await ensureAllSongsCache();
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('songs.title')));
  if (!allSongsCache.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('songs.empty')));
    return;
  }
  viewRoot.appendChild(buildTrackTable(allSongsCache, allSongsCache));
}

async function renderLikedSongs() {
  const liked = await jellyfin.getLikedSongs();
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('liked.title')));
  if (!liked.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('liked.empty')));
    return;
  }
  viewRoot.appendChild(el('div', 'view-sub', escapeHtml(trackListSummary(liked))));
  viewRoot.appendChild(buildTrackTable(liked, liked, { isLikedView: true }));
}

// A downloaded track's own metadata (name/album/artist/art tag) is enough to
// list it even if it's no longer reachable from the live library — e.g. it
// was removed from the server, or the cache just hasn't loaded it yet — but
// prefer the real cached item when we have one so it behaves identically to
// every other track row (accurate UserData, art, etc.).
function downloadedEntryToTrack(entry) {
  return {
    Id: entry.id,
    Name: entry.name,
    Album: entry.album,
    Artists: entry.artist ? [entry.artist] : [],
    AlbumArtist: entry.artist,
    AlbumId: entry.albumId,
    ImageTags: entry.imageTag ? { Primary: entry.imageTag } : {},
    RunTimeTicks: entry.runTimeTicks
  };
}

async function renderDownloads() {
  const entries = getDownloadedTracks().sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('downloads.title')));
  if (!entries.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('downloads.empty')));
    return;
  }
  // Best-effort only — this view's whole point is working while offline, so
  // a failed/slow server fetch here must never block it. Falls back to each
  // download's own saved metadata (name/album/artist/art) when the cache
  // isn't available, which is enough to list and play the track either way.
  await ensureAllSongsCache().catch(() => {});
  const cacheById = new Map((allSongsCache || []).map((tr) => [tr.Id, tr]));
  const tracks = entries.map((entry) => cacheById.get(entry.id) || downloadedEntryToTrack(entry));
  viewRoot.appendChild(el('div', 'view-sub', escapeHtml(trackListSummary(tracks))));
  viewRoot.appendChild(buildTrackTable(tracks, tracks));
}

// Listening calendar: one dot per day of the current year, brighter the more
// was heard that day, as one small block per month (weeks as columns, Mon..Sun
// top to bottom, month name above) that wrap onto new lines on narrow screens, with
// the number of days listened and the longest streak. Per-day totals only
// exist from 2.0.8 on, so earlier days stay empty.
function buildListeningCalendar(listened) {
  const now = new Date();
  const year = now.getFullYear();
  const days = listened.years[year]?.days || {};
  const wrap = el('div', 'listen-cal-wrap');
  wrap.appendChild(el('div', 'section-title', escapeHtml(t('stats.calendar'))));
  const months = el('div', 'listen-cal');
  const start = new Date(year, 0, 1);
  let grid = null;
  const values = Object.values(days);
  const max = Math.max(1, ...values);
  let listenedDays = 0;
  let streak = 0;
  let best = 0;
  const locale = document.documentElement.lang || undefined;
  for (let d = new Date(start); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    if (d.getDate() === 1) {
      const month = el('div', `cal-month${d.getMonth() === now.getMonth() ? ' cal-month-now' : ''}`);
      month.appendChild(el('div', 'cal-month-name', escapeHtml(d.toLocaleDateString(locale, { month: 'short' }))));
      grid = el('div', 'cal-grid');
      const lead = (d.getDay() + 6) % 7; // Monday-first offset of the 1st
      for (let i = 0; i < lead; i++) grid.appendChild(el('span', 'cal-cell cal-pad'));
      month.appendChild(grid);
      months.appendChild(month);
    }
    const secs = days[dayKey(d)] || 0;
    const future = d > now;
    const level = secs >= 60 ? Math.min(4, 1 + Math.floor((secs / max) * 4)) : 0;
    const cell = el('span', `cal-cell${future ? ' cal-future' : ''}${level ? ` l${level}` : ''}`);
    const mins = Math.round(secs / 60);
    cell.title = `${d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}: ${mins ? t('duration.minutes', { m: mins }) : '—'}`;
    grid.appendChild(cell);
    if (secs >= 60) {
      listenedDays++;
      streak++;
      best = Math.max(best, streak);
    } else if (!future) {
      streak = 0;
    }
  }
  wrap.appendChild(months);
  wrap.appendChild(el('div', 'stat-note listen-cal-note', escapeHtml(listenedDays
    ? t('stats.calendarNote', { days: listenedDays, streak: best })
    : t('stats.calendarEmpty'))));
  return wrap;
}

async function renderStats() {
  await ensureAllSongsCache();
  // Other devices' listening time comes from the server at login; wait for
  // it (briefly) so a fresh install doesn't show only its own empty log.
  if (listeningLoad) await Promise.race([listeningLoad, new Promise((r) => setTimeout(r, 4000))]);
  const stats = accountStats();
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('stats.title')));

  // Wrapped entry point -- only around New Year (see wrappedYearAvailable).
  const wrappedBanner = buildWrappedBanner();
  if (wrappedBanner && stats.totalPlays) viewRoot.appendChild(wrappedBanner);

  if (!stats.totalPlays) {
    viewRoot.appendChild(el('div', 'empty-state', t('stats.empty')));
    return;
  }

  // Measured listening time when there is some; before that, the old
  // plays x track-length estimate, marked as such.
  const listened = listeningTotals();
  const listenedSeconds = Object.values(listened.years).reduce((sum, b) => sum + b.total, 0);
  const measured = listenedSeconds >= 60;
  const totalMinutes = measured ? Math.round(listenedSeconds / 60) : stats.totalMinutes;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const timeLabel = `${measured ? '' : '≈ '}${hours > 0 ? `${hours}h ${mins}m` : `${mins}m`}`;
  const timeNote = measured
    ? t('stats.since', { date: new Date(listened.since).toLocaleDateString(document.documentElement.lang || undefined) })
    : t('stats.estimated');

  const summary = el('div', 'stats-summary');
  summary.appendChild(el('div', 'stat-box', `<div class="stat-value">${stats.totalPlays}</div><div class="stat-label">${escapeHtml(t('stats.totalPlays'))}</div>`));
  summary.appendChild(el('div', 'stat-box', `<div class="stat-value">${escapeHtml(timeLabel)}</div><div class="stat-label">${escapeHtml(t('stats.timeListened'))}</div><div class="stat-note">${escapeHtml(timeNote)}</div>`));
  summary.appendChild(el('div', 'stat-box', `<div class="stat-value">${stats.topArtists.length}</div><div class="stat-label">${escapeHtml(t('stats.artistsPlayed'))}</div>`));
  viewRoot.appendChild(summary);
  viewRoot.appendChild(buildListeningCalendar(listened));

  const playsLabel = (count) => t(count === 1 ? 'stats.plays' : 'stats.playsPlural', { count });

  if (stats.topTracks.length) {
    viewRoot.appendChild(el('div', 'section-title', t('stats.topTracks')));
    viewRoot.appendChild(buildCardGrid(stats.topTracks, 'song'));
  }

  const buildRankedList = (rows, labelKey) => {
    const list = el('div', 'stats-list');
    rows.forEach((row, i) => {
      const item = el('div', 'stats-list-row');
      item.innerHTML = `<span class="stats-list-rank">${i + 1}</span><span class="stats-list-name">${escapeHtml(row[labelKey])}</span><span class="stats-list-count">${escapeHtml(playsLabel(row.count))}</span>`;
      list.appendChild(item);
    });
    return list;
  };

  if (stats.topArtists.length) {
    viewRoot.appendChild(el('div', 'section-title', t('stats.topArtists')));
    viewRoot.appendChild(buildRankedList(stats.topArtists, 'artist'));
  }

  if (stats.topAlbums.length) {
    viewRoot.appendChild(el('div', 'section-title', t('stats.topAlbums')));
    viewRoot.appendChild(buildRankedList(stats.topAlbums, 'album'));
  }
}

async function renderAlbums() {
  const albums = await jellyfin.getAlbums(musicLibraryId);
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('albums.title')));
  if (!albums.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('albums.empty')));
    return;
  }
  viewRoot.appendChild(buildCardGrid(albums, 'album'));
}

// Real-world artist name variants Jellyfin has no way to know are the same
// act — it only groups by the exact literal name string found in file tags,
// with no online identity lookup. Each pair is unordered (either side can be
// the one a library actually has tagged); whichever entity has real cover
// art wins as the visible card, since which spelling "should" be canonical
// isn't as important as not losing a real photo behind a placeholder one.
// Add more pairs here as they turn up.
const KNOWN_ARTIST_NAME_PAIRS = [
  ['ghost b.c.', 'ghost'], // US trademark dispute forced this name 2012-2015; same Swedish band
  ['ke$ha', 'kesha'] // stylized vs. plain spelling of the same artist's name, split across imports
];

// Given one artist's name, finds the other name in its known pair (if any),
// lowercase. Symmetric — works from either side of the pair.
function pairedNameFor(name) {
  const key = (name || '').trim().toLowerCase();
  const pair = KNOWN_ARTIST_NAME_PAIRS.find((p) => p.includes(key));
  if (!pair) return null;
  return pair[0] === key ? pair[1] : pair[0];
}

// Drop whichever entity of a known name pair is the duplicate — its
// albums/songs get folded into the surviving one's page instead (see
// renderArtistDetail), so it's pure duplicate noise in the browse grid.
// The one with real cover art survives; if neither/both have art, the
// second name in the pair wins (arbitrary but stable).
function dropKnownAliasArtists(artists) {
  const byName = new Map(artists.map((a) => [(a.Name || '').trim().toLowerCase(), a]));
  const dropIds = new Set();
  for (const [nameA, nameB] of KNOWN_ARTIST_NAME_PAIRS) {
    const a = byName.get(nameA);
    const b = byName.get(nameB);
    if (!a || !b) continue;
    const keepA = !!a.ImageTags?.Primary && !b.ImageTags?.Primary;
    dropIds.add(keepA ? b.Id : a.Id);
  }
  return artists.filter((a) => !dropIds.has(a.Id));
}

// Drop artist entities that are really just a joined collab credit for an
// artist that already has its own real entry ("Avantasia, Alice Cooper" when
// "Avantasia" itself exists) — those tracks are folded into the real
// artist's page (see creditIncludesArtist / renderArtistDetail), so the
// compound entity is pure duplicate noise in the browse grid.
function dropCompoundDuplicateArtists(artists) {
  return artists.filter((a) => {
    const parts = splitCreditParts(a.Name || '');
    // The real artist isn't always listed first ("Huddy/Palaye Royale",
    // "OmenXIII/Palaye Royale" both put the well-known name second), so hide
    // this as a redundant joined credit if ANY other artist's (possibly
    // itself multi-part, e.g. "Dame, SMART") name is fully contained in
    // this one (renderArtistDetail's merge logic already pulls it into
    // every matching artist's page). A joined name with no standalone match
    // anywhere (like "Dame, Smart" before "Dame, SMART" existed as its own
    // artist) stays visible, since hiding it would leave nowhere to find it
    // at all — adding the missing name as a real artist on the server is
    // what makes it start counting here too.
    if (parts.length < 2) return true;
    // A compound entity with its own real art (not the placeholder) is
    // itself a genuine, distinct thing — e.g. "Dame, SMART" as a duo with
    // their own EP — not noise from one track crediting several people.
    // Jellyfin only assigns an artist its own image deliberately, so this
    // stops a real 2-name group from being folded away just because one of
    // its members (e.g. "Dame" alone) also happens to be a real solo
    // artist; only bare, art-less joins like "Dame, Separ, SMART" get
    // hidden and merged into it.
    if (a.ImageTags?.Primary) return true;
    // creditIncludesArtist (not a plain single-token Set lookup) is what
    // lets this match a real artist whose own name is itself multi-part —
    // "Dame, SMART, Juraj" needs both "dame" AND "smart" present to fold
    // into "Dame, SMART", which a single-token check can never satisfy
    // since neither "Dame" nor "SMART" exists as its own standalone entry.
    return !artists.some((other) => other !== a && creditIncludesArtist(a.Name, other.Name));
  });
}

// Some artists' collab tracks got imported with badly mangled, sometimes
// self-duplicated join strings ("Ley Lofaj, Dominik Láznička, Ley Lofaj",
// "Petrofski, Petrofski, Toyota Va...") before their tagging got cleaned
// up, scattering one artist's catalog across several server-side entities
// that dropCompoundDuplicateArtists can't fully collapse (there's no bare
// entity for them to fold into in every case). Each name here gets treated
// as fragments of one artist. Scoped to specific known artists by name, not
// a general system for every collab in the library — add more here only
// once a real case turns up, the same way Petrofski joined Ley Lofaj.
const FRAGMENTED_ARTIST_NAMES = ['ley lofaj', 'petrofski'];

function fragmentedArtistNameOf(name) {
  return FRAGMENTED_ARTIST_NAMES.find((known) => splitCreditParts(name || '').includes(known)) || null;
}

// Collapses every fragment entity of the same fragmented artist down to one
// representative (preferring the bare name, then one with real art) so the
// browse grid shows exactly one card per artist instead of one per mangled
// import.
function mergeFragmentedArtists(artists) {
  let result = artists;
  for (const known of FRAGMENTED_ARTIST_NAMES) {
    const fragments = result.filter((a) => fragmentedArtistNameOf(a.Name) === known);
    if (fragments.length < 2) continue;
    const canonical =
      fragments.find((a) => (a.Name || '').trim().toLowerCase() === known) ||
      fragments.find((a) => a.ImageTags?.Primary) ||
      fragments[0];
    const fragmentIds = new Set(fragments.map((a) => a.Id));
    result = result.filter((a) => a.Id === canonical.Id || !fragmentIds.has(a.Id));
  }
  return result;
}

async function renderArtists() {
  const rawArtists = await jellyfin.getArtists(musicLibraryId);
  const artists = mergeFragmentedArtists(dropKnownAliasArtists(dropCompoundDuplicateArtists(rawArtists)));
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('artists.title')));
  if (!artists.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('artists.empty')));
    return;
  }

  const searchWrap = el('div', 'inline-search');
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = t('artists.searchPlaceholder');
  searchWrap.appendChild(searchInput);
  viewRoot.appendChild(searchWrap);

  const gridWrap = el('div');
  viewRoot.appendChild(gridWrap);

  const renderGrid = (list) => {
    gridWrap.innerHTML = '';
    if (!list.length) {
      gridWrap.appendChild(el('div', 'empty-state', t('artists.noMatches')));
      return;
    }
    gridWrap.appendChild(buildCardGrid(list, 'artist'));
  };
  renderGrid(artists);

  searchInput.addEventListener('input', () => {
    const term = searchInput.value.trim().toLowerCase();
    renderGrid(term ? artists.filter((a) => (a.Name || '').toLowerCase().includes(term)) : artists);
  });
}

// Phone-layout only: the sidebar's categories collapsed into one tappable list.
function renderLibrary() {
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('nav.library')));
  const grid = el('div', 'card-grid library-grid');
  const entries = [
    { view: 'songs', icon: 'fi-br-list-music', label: t('nav.songs') },
    { view: 'liked', icon: 'fi-br-heart', label: t('nav.liked') },
    { view: 'downloads', icon: 'fi-br-download', label: t('nav.downloads') },
    { view: 'genres', icon: 'fi-br-guitars', label: t('nav.genres') },
    { view: 'albums', icon: 'fi-br-album', label: t('nav.albums') },
    { view: 'artists', icon: 'fi-br-user', label: t('nav.artists') },
    { view: 'stats', icon: 'fi-br-stats', label: t('nav.stats') }
  ];
  entries.forEach(({ view, icon, label }) => {
    const card = el('div', 'card genre-card library-tile');
    card.innerHTML = `<i class="fi ${icon} library-tile-icon"></i><div class="genre-card-title library-tile-label">${escapeHtml(label)}</div><i class="fi fi-br-angle-small-right library-tile-chevron"></i>`;
    card.addEventListener('click', () => navigateTo({ view }));
    grid.appendChild(card);
  });
  viewRoot.appendChild(grid);

  viewRoot.appendChild(el('div', 'section-title', t('nav.playlists')));
  const plGrid = el('div', 'card-grid');
  viewRoot.appendChild(plGrid);
  jellyfin.getPlaylists().then((playlists) => {
    if (!playlists.length) {
      plGrid.replaceWith(el('div', 'empty-state', t('playlist.sidebarEmpty')));
      return;
    }
    playlists.forEach((pl) => plGrid.appendChild(buildCard(pl, 'playlist')));
  });
}

async function renderGenres() {
  const genres = await jellyfin.getMusicGenres();
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', t('genres.title')));
  if (!genres.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('genres.empty')));
    return;
  }
  const grid = el('div', 'card-grid');
  genres.forEach((genre) => {
    const card = el('div', 'card genre-card');
    card.appendChild(el('div', 'genre-card-title', escapeHtml(genre.Name)));
    card.addEventListener('click', () => navigateTo({ view: 'genre', id: genre.Id, name: genre.Name }));
    grid.appendChild(card);
  });
  viewRoot.appendChild(grid);
}

async function renderGenreDetail(id, name) {
  const songs = await jellyfin.getSongsByGenre(id);
  viewRoot.innerHTML = '';
  viewRoot.appendChild(el('div', 'view-title', name || t('genres.title')));
  if (!songs.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('genres.emptyDetail')));
    return;
  }
  viewRoot.appendChild(buildTrackTable(songs, songs));
}

async function renderPlaylistDetail(id, name) {
  const [playlist, tracks] = await Promise.all([
    jellyfin.getItem(id),
    jellyfin.getPlaylistItems(id)
  ]);
  const displayName = name || playlist.Name;
  viewRoot.innerHTML = '';
  viewRoot.appendChild(buildDetailHeader({
    kind: t('kind.playlist'),
    title: displayName,
    sub: trackListSummary(tracks),
    art: jellyfin.imageUrl(playlist, 'Primary', imagePx(220)) || (tracks[0] ? artUrl(tracks[0], 'album', 220) : placeholderArt('album')),
    round: false,
    onPlayAll: tracks.length ? () => player.setQueue(tracks, 0, id) : undefined,
    trackIds: tracks.map((t) => t.Id),
    downloadTracks: tracks,
    onChangeArt: async (file) => {
      try {
        await jellyfin.uploadPlaylistImage(id, file);
        await loadPlaylistSidebar();
        await renderPlaylistDetail(id, displayName);
      } catch (err) {
        alert(err.message || t('errors.couldNotUploadArt'));
      }
    }
  }));
  if (!tracks.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('playlist.empty')));
    return;
  }
  viewRoot.appendChild(buildTrackTable(tracks, tracks, { sourceId: id, playlistId: id }));
}

async function renderAlbumDetail(id) {
  const tracks = await jellyfin.getAlbumTracks(id);
  const first = tracks[0];
  viewRoot.innerHTML = '';
  viewRoot.appendChild(buildDetailHeader({
    kind: t('kind.album'),
    title: first?.Album || 'Album',
    sub: tracks.length ? `${artistNames(first)} · ${trackListSummary(tracks)}` : artistNames(first || {}),
    art: first ? artUrl(first, 'album', 220) : placeholderArt('album'),
    round: false,
    onPlayAll: tracks.length ? () => player.setQueue(tracks, 0, id) : undefined,
    trackIds: tracks.map((t) => t.Id),
    downloadTracks: tracks,
    pinAlbum: tracks.length ? { Id: id, Name: first?.Album || 'Album', AlbumId: id } : undefined
  }));
  if (!tracks.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('album.empty')));
    return;
  }
  viewRoot.appendChild(buildTrackTable(tracks, tracks, { hideArt: true, sourceId: id, fallbackArtist: artistNames(first || {}) }));
}

async function renderArtistDetail(id, name) {
  const [artistItem, albums, serverSongs, allSongs] = await Promise.all([
    jellyfin.getItem(id),
    jellyfin.getAlbumsByArtist(id),
    jellyfin.getSongsByArtist(id),
    ensureAllSongsCache()
  ]);
  const targetName = name || artistItem.Name;
  const knownIds = new Set(serverSongs.map((tr) => tr.Id));
  const extraSongs = allSongs.filter((tr) => !knownIds.has(tr.Id) && trackCredits(tr).some((c) => creditIncludesArtist(c, targetName)));
  let songs = extraSongs.length ? [...serverSongs, ...extraSongs] : serverSongs;

  // Same reasoning as the songs merge above: an album entirely credited to
  // a joined name ("Avantasia, Michael Kiske, ...") never turns up via the
  // server's ArtistIds filter, so pull in whichever albums the merged extra
  // songs belong to that aren't already in the list.
  const knownAlbumIds = new Set(albums.map((al) => al.Id));
  const extraAlbumIds = [...new Set(extraSongs.map((tr) => tr.AlbumId).filter((aid) => aid && !knownAlbumIds.has(aid)))];
  const extraAlbums = extraAlbumIds.length
    ? (await Promise.all(extraAlbumIds.map((aid) => jellyfin.getItem(aid).catch(() => null)))).filter(Boolean)
    : [];
  if (extraAlbums.length) albums.push(...extraAlbums);

  // Known real-world name-pair entities (e.g. "Ghost B.C." / "Ghost",
  // "Ke$ha" / "Kesha") are genuinely separate Artist entries on the server —
  // the paired name's albums/songs live under its own artist ID, so the
  // ArtistIds filter above never finds them no matter which side of the
  // pair this page's own ID belongs to. Look the paired name up and fold
  // its catalog in the same way, so nothing found by dropKnownAliasArtists
  // (which hides the duplicate's own card) goes missing from browsing
  // entirely.
  const pairedName = pairedNameFor(targetName);
  if (pairedName) {
    const rawArtists = await jellyfin.getArtists(musicLibraryId);
    const aliasArtists = rawArtists.filter((a) => (a.Name || '').trim().toLowerCase() === pairedName && a.Id !== id);
    if (aliasArtists.length) {
      const [aliasAlbumLists, aliasSongLists] = await Promise.all([
        Promise.all(aliasArtists.map((a) => jellyfin.getAlbumsByArtist(a.Id))),
        Promise.all(aliasArtists.map((a) => jellyfin.getSongsByArtist(a.Id)))
      ]);
      const seenAlbumIds = new Set(albums.map((al) => al.Id));
      for (const list of aliasAlbumLists) {
        for (const al of list) {
          if (!seenAlbumIds.has(al.Id)) {
            seenAlbumIds.add(al.Id);
            albums.push(al);
          }
        }
      }
      const seenSongIds = new Set(songs.map((tr) => tr.Id));
      const aliasSongs = [];
      for (const list of aliasSongLists) {
        for (const tr of list) {
          if (!seenSongIds.has(tr.Id)) {
            seenSongIds.add(tr.Id);
            aliasSongs.push(tr);
          }
        }
      }
      if (aliasSongs.length) songs = [...songs, ...aliasSongs];
    }
  }

  // This artist's catalog may be scattered across several mangled fragment
  // entities (see mergeFragmentedArtists) -- pull every other fragment's
  // songs and albums into this one page too, same pooling pattern as the
  // alias merge above.
  const fragmentedName = fragmentedArtistNameOf(targetName);
  if (fragmentedName) {
    const rawArtists = await jellyfin.getArtists(musicLibraryId);
    const fragmentArtists = rawArtists.filter((a) => fragmentedArtistNameOf(a.Name) === fragmentedName && a.Id !== id);
    if (fragmentArtists.length) {
      const [fragmentAlbumLists, fragmentSongLists] = await Promise.all([
        Promise.all(fragmentArtists.map((a) => jellyfin.getAlbumsByArtist(a.Id))),
        Promise.all(fragmentArtists.map((a) => jellyfin.getSongsByArtist(a.Id)))
      ]);
      const seenAlbumIds = new Set(albums.map((al) => al.Id));
      for (const list of fragmentAlbumLists) {
        for (const al of list) {
          if (!seenAlbumIds.has(al.Id)) {
            seenAlbumIds.add(al.Id);
            albums.push(al);
          }
        }
      }
      const seenSongIds = new Set(songs.map((tr) => tr.Id));
      const fragmentSongs = [];
      for (const list of fragmentSongLists) {
        for (const tr of list) {
          if (!seenSongIds.has(tr.Id)) {
            seenSongIds.add(tr.Id);
            fragmentSongs.push(tr);
          }
        }
      }
      if (fragmentSongs.length) songs = [...songs, ...fragmentSongs];
    }
  }

  viewRoot.innerHTML = '';
  viewRoot.appendChild(buildDetailHeader({
    kind: t('kind.artist'),
    title: name || artistItem.Name || (albums[0] ? artistNames(albums[0]) : (songs[0] ? artistNames(songs[0]) : 'Artist')),
    sub: `${t(songs.length === 1 ? 'playlist.songCount' : 'playlist.songCountPlural', { count: songs.length })} · ${albums.length} ${t('kind.album').toLowerCase()}${albums.length === 1 ? '' : 's'}`,
    art: jellyfin.imageUrl(artistItem, 'Primary') || placeholderArt('artist'),
    // Only use the artist's own logo -- imageUrl() would otherwise fall back
    // to an album's image of the same type.
    logo: artistItem.ImageTags?.Logo ? jellyfin.imageUrl(artistItem, 'Logo', 800) : null,
    backdrop: jellyfin.backdropUrl(artistItem),
    round: true,
    onPlayAll: songs.length ? () => player.setQueue(songs, 0, id) : undefined,
    trackIds: songs.map((t) => t.Id)
  }));

  if (!albums.length && !songs.length) {
    viewRoot.appendChild(el('div', 'empty-state', t('artists.empty2')));
    return;
  }

  if (songs.length) {
    viewRoot.appendChild(el('div', 'section-title', t('artists.songsSection')));
    viewRoot.appendChild(buildTrackTable(songs, songs, { sourceId: id, fallbackArtist: targetName }));
  }

  if (albums.length) {
    viewRoot.appendChild(el('div', 'section-title', t('artists.albumsSection')));
    viewRoot.appendChild(buildCardGrid(albums, 'album'));
  }
}

// ---------- Reusable builders ----------
function buildCardGrid(items, kind) {
  const grid = el('div', 'card-grid');
  items.forEach((item) => grid.appendChild(buildCard(item, kind)));
  return grid;
}

// A single horizontally-scrolling row instead of a wrapping grid — for
// sections where the list can get long and a multi-row grid would push
// everything else down the page.
function buildCardRow(items, kind) {
  const wrap = el('div', 'card-row-wrap');
  const row = el('div', 'card-row');
  items.forEach((item) => row.appendChild(buildCard(item, kind)));
  wrap.appendChild(row);

  // Not everyone's mouse has horizontal/tilt scroll — let a normal vertical
  // wheel scroll the row while hovering it, and back that up with visible
  // nav arrows (desktop only; touch already scrolls this natively).
  row.addEventListener('wheel', (evt) => {
    if (evt.deltaY === 0) return;
    evt.preventDefault();
    row.scrollBy({ left: evt.deltaY, behavior: 'auto' });
  }, { passive: false });

  const scrollAmount = () => Math.max(300, row.clientWidth * 0.8);
  const prevBtn = el('button', 'card-row-nav card-row-nav-prev', '<i class="fi fi-br-angle-small-left"></i>');
  prevBtn.type = 'button';
  prevBtn.addEventListener('click', () => row.scrollBy({ left: -scrollAmount(), behavior: 'smooth' }));
  const nextBtn = el('button', 'card-row-nav card-row-nav-next', '<i class="fi fi-br-angle-small-right"></i>');
  nextBtn.type = 'button';
  nextBtn.addEventListener('click', () => row.scrollBy({ left: scrollAmount(), behavior: 'smooth' }));
  wrap.appendChild(prevBtn);
  wrap.appendChild(nextBtn);

  return wrap;
}

function buildCard(item, kind) {
  const card = el('div', kind === 'artist' ? 'card artist-card' : 'card');
  const artWrap = el('div', 'card-art-wrap');
  const img = document.createElement('img');
  img.className = 'card-art';
  const placeholder = placeholderArt(kind === 'artist' ? 'artist' : 'album');
  img.src = artUrl(item, kind === 'artist' ? 'artist' : 'album');
  // The URL can be well-formed but still 404 — e.g. a stale/mismatched
  // image tag on the item itself (seen in practice: an artist's albums
  // grid showing a broken image for an album whose own detail page, which
  // resolves art from its first track instead of the album item, loads
  // the same cover just fine). Try that same trick here first — find any
  // track from this album already in the in-memory cache and use its art
  // — before giving up to the placeholder, rather than showing a broken
  // image when the real cover is one click away from working.
  let triedTrackFallback = false;
  img.addEventListener('error', () => {
    if (!triedTrackFallback) {
      triedTrackFallback = true;
      const trackArt = kind === 'album' && allSongsCache?.find((tr) => tr.AlbumId === item.Id);
      if (trackArt) { img.src = artUrl(trackArt); return; }
    }
    img.src = placeholder;
  });
  artWrap.appendChild(img);

  if (kind === 'album' || kind === 'playlist' || kind === 'song') {
    const playBtn = el('button', 'card-play-btn');
    playBtn.innerHTML =
      '<svg class="icon-play-all-play" viewBox="0 0 24 24"><path d="M8 5v14l12-7z"/></svg>' +
      '<svg class="icon-play-all-pause" viewBox="0 0 24 24" hidden><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    playBtn.addEventListener('click', async (evt) => {
      evt.stopPropagation();
      if (player.currentTrack && player.queueSourceId === item.Id) player.togglePlay();
      else await playCollection(item, kind);
    });
    artWrap.appendChild(playBtn);

    if (kind === 'album' || kind === 'playlist') {
      cardRegistry.push({ id: item.Id, card, playBtn });
    }
  }
  card.appendChild(artWrap);

  const title = el('div', 'card-title', escapeHtml(formatDisplayName(item.Name) || t('common.unknown')));
  card.appendChild(title);

  let subtitle = '';
  if (kind === 'album') subtitle = artistNames(item);
  else if (kind === 'playlist') subtitle = 'Playlist';
  else if (kind === 'artist') subtitle = 'Artist';
  else if (kind === 'song') subtitle = artistNames(item);
  if (subtitle) card.appendChild(el('div', 'card-subtitle', escapeHtml(subtitle)));

  card.addEventListener('click', () => openCollection(item, kind));
  if (kind === 'playlist') wirePlaylistDropTarget(card, item.Id);
  return card;
}

async function openCollection(item, kind) {
  if (kind === 'album') navigateTo({ view: 'album', id: item.Id });
  else if (kind === 'artist') navigateTo({ view: 'artist', id: item.Id, name: formatDisplayName(item.Name) });
  else if (kind === 'playlist') navigateTo({ view: 'playlist', id: item.Id, name: item.Name });
  else if (kind === 'song') {
    await ensureAllSongsCache();
    const idx = allSongsCache.findIndex((t) => t.Id === item.Id);
    if (idx >= 0) player.setQueue(allSongsCache, idx);
    else player.setQueue([item], 0);
  }
}

async function playCollection(item, kind) {
  if (kind === 'album') {
    const tracks = await jellyfin.getAlbumTracks(item.Id);
    if (tracks.length) player.setQueue(tracks, 0, item.Id);
  } else if (kind === 'playlist') {
    const tracks = await jellyfin.getPlaylistItems(item.Id);
    if (tracks.length) player.setQueue(tracks, 0, item.Id);
  } else if (kind === 'song') {
    await openCollection(item, kind);
  }
}

function buildDetailHeader({ kind, title, sub, art, logo, backdrop, round, onPlayAll, trackIds, onChangeArt, downloadTracks, pinAlbum }) {
  const wrap = el('div', '');
  if (backdrop) {
    // Preload so a missing/stale backdrop just leaves the normal background
    // instead of an empty banner.
    const probe = new Image();
    probe.addEventListener('load', () => {
      if (!wrap.isConnected) return; // navigated away before it loaded
      const bd = el('div', 'detail-backdrop');
      bd.style.backgroundImage = `url("${backdrop}")`;
      // Reach up under the sticky header (its height differs on mobile).
      bd.style.setProperty('--header-h', `${mainHeaderEl.offsetHeight}px`);
      wrap.classList.add('has-backdrop');
      wrap.prepend(bd);
      mainEl.classList.add('has-hero');
      syncHeroHeader();
    }, { once: true });
    probe.src = backdrop;
  }
  const header = el('div', 'detail-header');
  const artWrap = el('div', 'detail-art-wrap');
  const img = document.createElement('img');
  img.className = round ? 'detail-art round' : 'detail-art';
  img.src = art;
  // Same reasoning as buildCard's fallback — a resolved URL can still 404
  // on a stale/mismatched image tag.
  img.addEventListener('error', () => { img.src = placeholderArt(round ? 'artist' : 'album'); }, { once: true });
  artWrap.appendChild(img);

  if (onChangeArt) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) onChangeArt(fileInput.files[0]);
    });
    const editBtn = el('button', 'detail-art-edit', '<i class="fi fi-br-camera"></i>');
    editBtn.type = 'button';
    editBtn.title = t('track.changeCoverArt');
    editBtn.addEventListener('click', () => fileInput.click());
    artWrap.appendChild(editBtn);
    artWrap.appendChild(fileInput);
  }
  header.appendChild(artWrap);

  const meta = el('div', 'detail-meta');
  meta.appendChild(el('div', 'detail-kind', kind));
  const titleEl = el('div', 'detail-title', escapeHtml(title || ''));
  if (logo) {
    const logoImg = document.createElement('img');
    logoImg.className = 'detail-logo';
    logoImg.alt = title || '';
    logoImg.addEventListener('load', () => titleEl.replaceWith(logoImg), { once: true });
    logoImg.src = logo;
  }
  meta.appendChild(titleEl);
  if (sub) meta.appendChild(el('div', 'detail-sub', escapeHtml(sub)));
  header.appendChild(meta);
  wrap.appendChild(header);

  if (onPlayAll) {
    const actions = el('div', 'detail-actions');
    const playBtn = el('button', 'play-all-btn');
    playBtn.innerHTML =
      '<svg class="icon-play-all-play" viewBox="0 0 24 24"><path d="M8 5v14l12-7z"/></svg>' +
      '<svg class="icon-play-all-pause" viewBox="0 0 24 24" hidden><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>';
    playBtn.addEventListener('click', () => {
      if (player.currentTrack && (trackIds || []).includes(player.currentTrack.Id)) {
        player.togglePlay();
      } else {
        onPlayAll();
      }
    });
    actions.appendChild(playBtn);

    if (downloadTracks && downloadTracks.length && downloadsSupported()) {
      const dlBtn = el('button', 'detail-download-btn');
      dlBtn.type = 'button';
      wireAlbumDownloadButton(dlBtn, downloadTracks);
      actions.appendChild(dlBtn);
    }

    if (pinAlbum) {
      const pinBtn = el('button', 'detail-pin-btn', '<i class="fi fi-br-thumbtack"></i>');
      pinBtn.type = 'button';
      wirePinButton(pinBtn, pinAlbum);
      actions.appendChild(pinBtn);
    }

    wrap.appendChild(actions);

    playAllBtn = playBtn;
    playAllTrackIds = trackIds || [];
    syncPlayAllButton();
  } else {
    playAllBtn = null;
    playAllTrackIds = [];
  }
  return wrap;
}

// ---------- Offline downloads ----------

function downloadButtonIcon(state) {
  // A CSS ring rather than the icon font's spinner glyph -- the glyph isn't
  // centered in its own box, so it visibly wobbled off-center while rotating.
  if (state === 'downloading') return '<span class="download-spinner" aria-hidden="true"></span>';
  if (state === 'downloaded') return '<i class="fi fi-br-check"></i>';
  return '<i class="fi fi-br-download"></i>';
}

function setDownloadButtonState(btn, state) {
  btn.innerHTML = downloadButtonIcon(state);
  btn.classList.toggle('downloaded', state === 'downloaded');
  btn.classList.toggle('downloading', state === 'downloading');
  btn.title = state === 'downloaded' ? t('track.removeDownload') : t('track.download');
}

function wireDownloadButton(btn, track, row) {
  setDownloadButtonState(btn, isDownloaded(track.Id) ? 'downloaded' : 'idle');
  btn.addEventListener('click', async (evt) => {
    evt.stopPropagation();
    if (isDownloaded(track.Id)) {
      await deleteDownload(track.Id);
      setDownloadButtonState(btn, 'idle');
      if (row) applyOfflineRowState(row, track);
      return;
    }
    setDownloadButtonState(btn, 'downloading');
    try {
      await downloadTrack(track, jellyfin);
      setDownloadButtonState(btn, 'downloaded');
    } catch (err) {
      setDownloadButtonState(btn, 'idle');
      alert(err.message || t('errors.couldNotDownload'));
    }
    if (row) applyOfflineRowState(row, track);
  });
}

function albumDownloadState(tracks) {
  const downloaded = tracks.filter((tr) => isDownloaded(tr.Id)).length;
  if (downloaded === tracks.length) return 'downloaded';
  return 'idle';
}

function wireAlbumDownloadButton(btn, tracks) {
  const refresh = () => setDownloadButtonState(btn, albumDownloadState(tracks));
  refresh();
  btn.addEventListener('click', async (evt) => {
    evt.stopPropagation();
    if (albumDownloadState(tracks) === 'downloaded') {
      setDownloadButtonState(btn, 'downloading');
      await Promise.all(tracks.map((tr) => (isDownloaded(tr.Id) ? deleteDownload(tr.Id) : Promise.resolve())));
      refresh();
      return;
    }
    setDownloadButtonState(btn, 'downloading');
    for (const track of tracks) {
      if (isDownloaded(track.Id)) continue;
      try {
        await downloadTrack(track, jellyfin);
      } catch (err) {
        refresh();
        alert(err.message || t('errors.couldNotDownload'));
        return;
      }
    }
    refresh();
  });
}

function wirePinButton(btn, album) {
  const refresh = () => {
    const pinned = isAlbumPinned(album.Id);
    btn.classList.toggle('pinned', pinned);
    btn.title = t(pinned ? 'album.unpin' : 'album.pin');
  };
  refresh();
  btn.addEventListener('click', (evt) => {
    evt.stopPropagation();
    togglePinAlbum(album);
    refresh();
  });
}

// Offline Mode (a Settings toggle, not literal network detection) restricts
// playback to already-downloaded tracks — everything else is visibly
// disabled rather than clickable-but-guaranteed-to-fail.
function applyOfflineRowState(row, track) {
  const unavailable = !!getSettings().offlineMode && !isDownloaded(track.Id);
  row.classList.toggle('offline-unavailable', unavailable);
}

function buildTrackTable(tracks, queueRef, opts = {}) {
  const table = el('table', 'track-table');
  const thead = el('thead', '', `<tr><th style="width:36px">${t('track.index')}</th><th>${t('track.title')}</th><th style="width:26%">${t('track.album')}</th><th style="width:92px"></th><th style="width:60px;text-align:right">${t('track.time')}</th></tr>`);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  tracks.forEach((track, idx) => {
    const row = el('tr', 'track-row');
    row.dataset.id = track.Id;

    const idxCell = el('td', 'track-index');
    idxCell.innerHTML = `<span class="track-index-num">${idx + 1}</span><svg class="track-index-play" viewBox="0 0 24 24" width="14" height="14"><path d="M8 5v14l12-7z"/></svg>`;
    row.appendChild(idxCell);

    const titleCell = document.createElement('td');
    const titleWrap = el('div', 'track-title-cell');
    if (!opts.hideArt) {
      const img = document.createElement('img');
      img.src = artUrl(track, 'album', 48);
      withOfflineArtFallback(img, track);
      titleWrap.appendChild(img);
    }
    const textWrap = el('div', 'track-title-text');
    textWrap.innerHTML = `<span class="t-name">${escapeHtml(track.Name)}</span><span class="t-artist">${escapeHtml(artistNames(track, opts.fallbackArtist))}</span>`;
    titleWrap.appendChild(textWrap);
    titleCell.appendChild(titleWrap);
    row.appendChild(titleCell);

    row.appendChild(el('td', 'track-album-cell', escapeHtml(track.Album || '')));

    const addCell = el('td', 'track-add-cell');
    const addCellInner = el('div', 'track-add-inner');
    addCell.appendChild(addCellInner);

    const likeBtn = el('button', track.UserData?.IsFavorite ? 'track-add-btn liked' : 'track-add-btn', '<i class="fi fi-br-heart"></i>');
    likeBtn.type = 'button';
    likeBtn.title = t('track.like');
    likeBtn.addEventListener('click', async (evt) => {
      evt.stopPropagation();
      const liked = !track.UserData?.IsFavorite;
      likeBtn.classList.toggle('liked', liked);
      track.UserData = { ...(track.UserData || {}), IsFavorite: liked };
      try {
        if (liked) await jellyfin.likeItem(track.Id);
        else await jellyfin.unlikeItem(track.Id);
      } catch (err) {
        likeBtn.classList.toggle('liked', !liked);
        track.UserData.IsFavorite = !liked;
        alert(err.message || t('errors.couldNotUpdateLike'));
      }
    });
    addCellInner.appendChild(likeBtn);

    const addBtn = el('button', 'track-add-btn', '<i class="fi fi-br-add"></i>');
    addBtn.type = 'button';
    addBtn.title = t('track.addToPlaylist');
    addBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      openAddToPlaylistMenu(track, addBtn);
    });
    addCellInner.appendChild(addBtn);

    if (downloadsSupported()) {
      const downloadBtn = el('button', 'track-add-btn track-download-btn');
      downloadBtn.type = 'button';
      wireDownloadButton(downloadBtn, track, row);
      addCellInner.appendChild(downloadBtn);
    }

    row.appendChild(addCell);

    row.appendChild(el('td', 'track-duration', formatTime(ticksToSeconds(track.RunTimeTicks))));

    applyOfflineRowState(row, track);

    row.addEventListener('click', () => {
      if (row.classList.contains('offline-unavailable')) return;
      const startIdx = queueRef.findIndex((t) => t.Id === track.Id);
      player.setQueue(queueRef, startIdx >= 0 ? startIdx : 0);
    });

    // Swipe right always queues the track up next; swipe left's meaning
    // depends on what list this is — remove from playlist, unlike, or
    // (elsewhere, like All Songs/Album) nothing, since there's no sensible
    // "remove" for those.
    let onSwipeLeft = null;
    if (opts.playlistId && track.PlaylistItemId) {
      onSwipeLeft = async () => {
        try {
          await jellyfin.removeFromPlaylist(opts.playlistId, track.PlaylistItemId);
          row.remove();
        } catch (err) {
          alert(err.message || t('errors.couldNotRemoveFromPlaylist'));
        }
      };
    } else if (opts.isLikedView) {
      onSwipeLeft = async () => {
        try {
          await jellyfin.unlikeItem(track.Id);
          row.remove();
        } catch (err) {
          alert(err.message || t('errors.couldNotUpdateLike'));
        }
      };
    }
    const openTrackMenu = (x, y) => openContextMenu(syntheticPointerEvent(x, y), buildTrackContextMenuItems(track, {
      queueRef,
      anchorEl: row,
      onRemove: onSwipeLeft
    }));
    wireSwipeActions(row, {
      onSwipeRight: () => player.enqueue(track),
      onSwipeLeft,
      // Right-click opens this on desktop; there's no equivalent gesture on
      // mobile otherwise, so "Add to playlist" (and everything else in this
      // menu) was completely unreachable there.
      onLongPress: isMobile ? (x, y) => openTrackMenu(x, y) : undefined
    });
    wireTrackDragSource(row, track);

    if (isDesktop) {
      row.addEventListener('contextmenu', (evt) => {
        evt.preventDefault();
        openTrackMenu(evt.clientX, evt.clientY);
      });
    }

    tbody.appendChild(row);
  });

  table.appendChild(tbody);

  // highlightPlayingRow() only runs on the player's own trackchange event —
  // it never fires just because a table got (re)built, so a freshly rendered
  // view (navigating back to it, or it auto-advancing while you're elsewhere)
  // needs its own sync here or the currently playing row shows unhighlighted.
  const currentId = player?.currentTrack?.Id;
  if (currentId) {
    tbody.querySelectorAll('.track-row').forEach((row) => {
      row.classList.toggle('playing', row.dataset.id === currentId);
    });
  }

  return table;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Swipe right = onSwipeRight (e.g. add to queue), swipe left = onSwipeLeft
// (e.g. remove) — mobile only. Omit whichever side has no meaningful action
// for a given row (e.g. no swipe-left on a plain "All Songs" row, since
// there's nothing sensible to remove it from) and that direction just won't
// drag. onSwipeLeft is expected to remove the row from the DOM itself (via
// a re-render) once its own async work finishes — this only animates it.
function wireSwipeActions(rowEl, { onSwipeRight, onSwipeLeft, onLongPress } = {}) {
  if (!isMobile || (!onSwipeRight && !onSwipeLeft && !onLongPress)) return;
  const THRESHOLD = 70;
  const LONG_PRESS_MS = 500;
  let startX = 0, startY = 0, dx = 0, dragging = false, decided = false, horizontal = false;
  let longPressTimer = null;

  // So it's clear what letting go will do, before it happens — see the
  // .swipe-icon rules in styles.css for how these get revealed mid-swipe.
  // Table rows (<tr>) only accept <td>/<th> children — appending anything
  // else directly makes the browser generate an anonymous table cell to
  // wrap it, which silently adds an extra column and wrecks the row's
  // layout (confirmed on-device). Appending into an existing <td> instead
  // keeps the DOM valid; position:absolute still positions the icon
  // relative to the row itself (the nearest *positioned* ancestor, per
  // .track-row/.queue-row's position:relative), not that cell, so it still
  // spans the row's full width correctly either way.
  // The first <td> (track index/play-icon cell) already has its own hover/
  // playing play indicator — hosting the swipe icon there too (still just
  // a DOM-attachment point, position:absolute means it renders relative
  // to the row regardless of which cell it's actually in) put both icons
  // in the same cramped spot. The last cell (track time) has nothing else
  // in it.
  const iconHost = (rowEl.tagName === 'TR' ? rowEl.querySelector('td:last-child') : rowEl) || rowEl;
  if (onSwipeRight) iconHost.appendChild(el('i', 'fi fi-br-list-music swipe-icon swipe-icon-queue'));
  if (onSwipeLeft) iconHost.appendChild(el('i', 'fi fi-br-trash swipe-icon swipe-icon-remove'));

  rowEl.style.touchAction = 'pan-y';

  rowEl.addEventListener('touchstart', (evt) => {
    if (evt.touches.length !== 1) return;
    startX = evt.touches[0].clientX;
    startY = evt.touches[0].clientY;
    dx = 0; dragging = true; decided = false; horizontal = false;
    if (onLongPress) {
      const pressX = startX, pressY = startY;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        // Only fires if the touch is still down and never turned into a
        // horizontal swipe — touchmove/touchend below cancel this timer
        // the moment either of those becomes true.
        dragging = false;
        hapticImpact('medium');
        onLongPress(pressX, pressY);
      }, LONG_PRESS_MS);
    }
  }, { passive: true });

  rowEl.addEventListener('touchmove', (evt) => {
    if (!dragging) return;
    const x = evt.touches[0].clientX;
    const y = evt.touches[0].clientY;
    const rawDx = x - startX;
    if (!decided) {
      if (Math.abs(rawDx) < 8 && Math.abs(y - startY) < 8) return;
      horizontal = Math.abs(rawDx) > Math.abs(y - startY);
      decided = true;
      // Any real movement means it's a swipe or a scroll, not a press --
      // a slow vertical scroll used to outlast the timer and pop the menu.
      clearTimeout(longPressTimer);
    }
    if (!horizontal) return;
    if ((rawDx > 0 && !onSwipeRight) || (rawDx < 0 && !onSwipeLeft)) return;
    dx = rawDx;
    evt.preventDefault();
    rowEl.style.transform = `translateX(${dx}px)`;
    rowEl.classList.toggle('swipe-queue', dx > 20);
    rowEl.classList.toggle('swipe-remove', dx < -20);
  }, { passive: false });

  const finish = () => {
    clearTimeout(longPressTimer);
    if (!dragging) return;
    dragging = false;
    rowEl.style.transition = 'transform 0.18s ease';
    if (horizontal && dx > THRESHOLD && onSwipeRight) {
      hapticImpact('light');
      onSwipeRight();
      rowEl.style.transform = 'translateX(0)';
    } else if (horizontal && dx < -THRESHOLD && onSwipeLeft) {
      hapticImpact('medium');
      rowEl.style.transform = 'translateX(-100%)';
      rowEl.style.opacity = '0';
      onSwipeLeft();
    } else {
      rowEl.style.transform = '';
    }
    setTimeout(() => {
      rowEl.style.transition = '';
      rowEl.classList.remove('swipe-queue', 'swipe-remove');
    }, 200);
    dx = 0;
  };
  rowEl.addEventListener('touchend', finish);
  rowEl.addEventListener('touchcancel', finish);
}

// ---------- Player wiring ----------
function wirePlayer() {
  btnPlay.addEventListener('click', () => uiTogglePlay());
  btnPrev.addEventListener('click', () => uiPrevious());
  btnNext.addEventListener('click', () => uiNext());
  btnShuffle.addEventListener('click', () => {
    player.toggleShuffle();
    btnShuffle.classList.toggle('active', player.shuffle);
    mobileBtnShuffle.classList.toggle('active', player.shuffle);
  });
  btnRepeat.addEventListener('click', () => {
    const mode = player.cycleRepeat();
    btnRepeat.classList.toggle('active', mode !== RepeatMode.OFF);
    mobileBtnRepeat.classList.toggle('active', mode !== RepeatMode.OFF);
    const repeatIconClass = mode === RepeatMode.ONE ? 'fi fi-br-arrows-repeat-1' : 'fi fi-br-arrows-repeat';
    iconRepeat.className = repeatIconClass;
    mobileIconRepeat.className = repeatIconClass;
  });

  // Mobile full-screen player controls — same player calls as the desktop ones.
  mobileBtnPlay.addEventListener('click', () => uiTogglePlay());
  mobileBtnPrev.addEventListener('click', () => uiPrevious());
  mobileBtnNext.addEventListener('click', () => uiNext());
  mobileBtnShuffle.addEventListener('click', () => {
    player.toggleShuffle();
    btnShuffle.classList.toggle('active', player.shuffle);
    mobileBtnShuffle.classList.toggle('active', player.shuffle);
  });
  mobileBtnRepeat.addEventListener('click', () => btnRepeat.click());
  mobileSeekBar.addEventListener('input', () => {
    const pct = Number(mobileSeekBar.value);
    mobileSeekBar.style.setProperty('--pct', rangeFillPercent(pct, mobileSeekBar, 12));
  });
  mobileSeekBar.addEventListener('change', () => {
    uiSeekPercent(Number(mobileSeekBar.value));
    mobileSeekBar.style.setProperty('--pct', rangeFillPercent(Number(mobileSeekBar.value), mobileSeekBar, 12));
  });

  // Tapping the mini-player (but not its play button) opens the full-screen panel.
  playerBar.addEventListener('click', (evt) => {
    if (!document.body.classList.contains('platform-mobile') && window.innerWidth > 820) return;
    // Its own transport buttons (play, plus prev/next in the Apple style)
    // shouldn't also open the full-screen player.
    if (evt.target.closest('#btn-play, #btn-prev, #btn-next')) return;
    openNowPlaying();
  });

  seekBar.addEventListener('input', () => {
    const pct = Number(seekBar.value);
    seekBar.style.setProperty('--pct', rangeFillPercent(pct, seekBar, 14));
  });
  seekBar.addEventListener('change', () => {
    uiSeekPercent(Number(seekBar.value));
    seekBar.style.setProperty('--pct', rangeFillPercent(Number(seekBar.value), seekBar, 14));
  });

  volumeBar.addEventListener('input', () => {
    const val = Number(volumeBar.value);
    uiSetVolumePercent(val);
    volumeBar.style.setProperty('--pct', rangeFillPercent(val, volumeBar, 14));
    updateVolumeIcon(val);
    npVolumeBar.value = val;
    npVolumeBar.style.setProperty('--pct', rangeFillPercent(val, npVolumeBar, 14));
  });
  // The full-screen player's volume row (Apple style) just drives the main
  // volume slider, so both stay in sync through the one code path.
  npVolumeBar.addEventListener('input', () => {
    volumeBar.value = npVolumeBar.value;
    volumeBar.dispatchEvent(new Event('input'));
  });
  npVolumeBar.value = volumeBar.value;
  npVolumeBar.style.setProperty('--pct', rangeFillPercent(Number(volumeBar.value), npVolumeBar, 14));

  btnLyrics.addEventListener('click', () => {
    if (!lyricsPanel.hidden) { closeNowPlaying(); return; }
    openNowPlaying();
  });
  btnCloseLyrics.addEventListener('click', () => closeNowPlaying());
  // Phones: tapping anywhere on the empty top strip closes the full-screen
  // player too, not just the small arrow/grabber (its own buttons -- cast,
  // sleep, lyrics, queue -- still do their own thing).
  document.querySelector('.lyrics-header').addEventListener('click', (evt) => {
    if (!isPhoneLayout() || evt.target.closest('button')) return;
    closeNowPlaying();
  });
  wireNowPlayingGestures();

  nowPlayingLikeBtn.addEventListener('click', async () => {
    const track = player.currentTrack;
    if (!track) return;
    const liked = !track.UserData?.IsFavorite;
    nowPlayingLikeBtn.classList.toggle('liked', liked);
    track.UserData = { ...(track.UserData || {}), IsFavorite: liked };
    try {
      if (liked) await jellyfin.likeItem(track.Id);
      else await jellyfin.unlikeItem(track.Id);
    } catch (err) {
      nowPlayingLikeBtn.classList.toggle('liked', !liked);
      track.UserData.IsFavorite = !liked;
      alert(err.message || t('errors.couldNotUpdateLike'));
    }
  });

  nowPlayingDownloadBtn.addEventListener('click', async () => {
    const track = player.currentTrack;
    if (!track) return;
    if (isDownloaded(track.Id)) {
      await deleteDownload(track.Id);
      setDownloadButtonState(nowPlayingDownloadBtn, 'idle');
      return;
    }
    setDownloadButtonState(nowPlayingDownloadBtn, 'downloading');
    try {
      await downloadTrack(track, jellyfin);
      setDownloadButtonState(nowPlayingDownloadBtn, 'downloaded');
    } catch (err) {
      setDownloadButtonState(nowPlayingDownloadBtn, 'idle');
      alert(err.message || t('errors.couldNotDownload'));
    }
  });

  btnQueueMobile.addEventListener('click', openQueueSheet);
  btnLyricsMobile.addEventListener('click', openLyricsSheet);
  // On phones, tapping the lyrics preview under the controls expands it
  // into the sheet (like Spotify); inside the sheet, tapping a line seeks.
  lyricsBody.addEventListener('click', (evt) => {
    if (!isPhoneLayout() || lyricsBody.parentElement === queueSheet) return;
    evt.stopPropagation();
    openLyricsSheet();
  }, true);
  wirePullToRefresh();
  initSystemVolume();
  // Crossing the phone-layout breakpoint moves the cat between its spots.
  window.matchMedia('(max-width: 820px)').addEventListener('change', syncCatJamVisibility);
  wireQueueSheet();

  player.on('queuechange', () => {
    if (queueSheetOpen || (!lyricsPanel.hidden && activePanelTab === 'queue')) renderQueue();
    scheduleResumeSave();
  });
  player.on('trackchange', scheduleResumeSave);
  player.on('playstate', scheduleResumeSave);
  player.on('timeupdate', trackListeningTick);
  player.on('playstate', trackListeningTick);
  player.on('trackchange', () => { listeningTickAt = null; });
  setInterval(persistListening, 15000);
  // Often enough that closing the app (or an update restarting it) loses
  // at most half a minute on the server copy.
  setInterval(syncListening, 30000);
  window.addEventListener('pagehide', syncListening);
  document.addEventListener('visibilitychange', () => { if (document.hidden) syncListening(); });
  // Position: every 10s while playing, and right away when the app goes to
  // the background or closes (the last chance on phones).
  setInterval(() => { if (!player.audio.paused) saveResumeState(); }, 10000);
  window.addEventListener('pagehide', saveResumeState);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveResumeState(); });

  player.on('trackchange', () => {
    const track = player.currentTrack;
    if (!track) return;
    playerBar.hidden = false;
    appRoot.classList.add('has-track');
    const art = artUrl(track, 'album', 64);
    playerArt.src = art;
    withOfflineArtFallback(playerArt, track);
    playerTitle.textContent = track.Name;
    playerArtist.textContent = artistNames(track);
    timeTotal.textContent = formatTime(ticksToSeconds(track.RunTimeTicks));
    seekBar.value = 0;
    seekBar.style.setProperty('--pct', rangeFillPercent(0, seekBar, 14));
    mobileSeekBar.value = 0;
    mobileSeekBar.style.setProperty('--pct', rangeFillPercent(0, mobileSeekBar, 12));
    highlightPlayingRow(track.Id);

    nowPlayingArt.src = artUrl(track, 'album', 440);
    withOfflineArtFallback(nowPlayingArt, track);
    setMarqueeText(nowPlayingTitle, track.Name);
    setMarqueeText(nowPlayingArtist, artistNames(track));
    setArtAlt(track.Name, artistNames(track));
    nowPlayingLikeBtn.classList.toggle('liked', !!track.UserData?.IsFavorite);
    setDownloadButtonState(nowPlayingDownloadBtn, isDownloaded(track.Id) ? 'downloaded' : 'idle');
    syncPlayAllButton();
    syncCardStates();
    updateBgArt();
    updateDynamicAccentColor(track);
    updateDiscordPresence();
    syncCatJamVisibility();

    if (queueSheetOpen) renderQueue();
    if (!lyricsPanel.hidden) {
      if (activePanelTab === 'lyrics') loadLyricsForCurrentTrack();
      else renderQueue();
    } else {
      currentLyrics = null;
      lyricsTrackId = null;
    }
  });

  // Only fires when a track actually finishes (natural end, gapless swap, or
  // crossfade handoff) — not on a manual skip — so this is what should count
  // as "a play" server-side. Marking it played on Jellyfin's account, rather
  // than tracking locally, is what makes Most Played/On Repeat/stats follow
  // the user across devices.
  player.on('trackended', (track) => {
    if (!track?.Id) return;
    jellyfin.markPlayed(track.Id).then(() => {
      // Optimistic local update so Home/Stats reflect it immediately,
      // without waiting for a full re-fetch of allSongsCache.
      const cached = allSongsCache?.find((tr) => tr.Id === track.Id);
      if (cached) {
        cached.UserData = { ...(cached.UserData || {}), PlayCount: (cached.UserData?.PlayCount || 0) + 1, LastPlayedDate: new Date().toISOString() };
      }
    }).catch(() => {});
  });

  onDownloadsChange(() => {
    const current = viewHistory[viewHistory.length - 1];
    if (current?.view === 'downloads') renderView(current);
  });

  player.on('playstate', () => {
    const playing = !player.audio.paused;
    lyricsPanel.classList.toggle('is-paused', !playing);
    setHidden(iconPlay, playing);
    setHidden(iconPause, !playing);
    setHidden(mobileIconPlay, playing);
    setHidden(mobileIconPause, !playing);
    syncPlayAllButton();
    syncCardStates();
    updateDiscordPresence();
  });

  player.on('timeupdate', () => {
    // Jellyfin's RunTimeTicks is available immediately from metadata and is
    // always accurate; audio.duration can read as NaN/Infinity or simply be
    // stale for a moment on some Android WebView + transcoded-stream
    // combinations before the media pipeline finishes probing the file.
    const ticksSeconds = ticksToSeconds(player.currentTrack?.RunTimeTicks);
    const audioDuration = player.audio.duration;
    const duration = ticksSeconds || (isFinite(audioDuration) ? audioDuration : 0);
    const current = player.audio.currentTime || 0;
    const pct = duration ? (current / duration) * 100 : 0;
    seekBar.value = pct;
    seekBar.style.setProperty('--pct', rangeFillPercent(pct, seekBar, 14));
    mobileSeekBar.value = pct;
    mobileSeekBar.style.setProperty('--pct', rangeFillPercent(pct, mobileSeekBar, 12));
    timeCurrent.textContent = formatTime(current);
    mobileTimeCurrent.textContent = formatTime(current);
    if (duration) { timeTotal.textContent = formatTime(duration); mobileTimeTotal.textContent = formatTime(duration); }
    updateActiveLyricLine(current);

    // "End of track" sleep timer: pause just short of the natural end so it
    // never lets the next track start, rather than pausing after the fact.
    if (sleepTimerAtEndOfTrack && duration && duration - current < 0.5) {
      player.togglePlay();
      clearSleepTimer();
    }
  });
}

// Quadratic taper: a slider that moves linearly in perceived loudness needs
// the underlying gain to grow with the square of the position, since human
// hearing perceives loudness roughly logarithmically.
// Pushes a full set of 5 band gains into the slider UI + the live player —
// used by preset selection and the reset button, which both replace all
// bands at once (unlike a single slider drag, handled inline where it's wired).
function applyEqGainsToUI(gains) {
  eqBandSliders.forEach((slider) => {
    const band = Number(slider.dataset.band);
    const gain = gains[band] || 0;
    slider.value = gain;
    const valueEl = document.querySelector(`.eq-band-value[data-band-value="${band}"]`);
    if (valueEl) valueEl.textContent = gain > 0 ? `+${gain}` : `${gain}`;
    player?.setEqualizerBand(band, gain);
  });
}

function sliderToVolume(pos) {
  const t = Math.max(0, Math.min(100, pos)) / 100;
  return t * t;
}

function updateVolumeIcon(val) {
  let iconClass;
  if (val <= 0) iconClass = 'fi-br-volume-slash';
  else if (val <= 33) iconClass = 'fi-br-volume-off';
  else if (val <= 66) iconClass = 'fi-br-volume-down';
  else iconClass = 'fi-br-volume';
  volumeIcon.className = 'volume-icon fi ' + iconClass;
}

let activeAddMenu = null;

async function openAddToPlaylistMenu(track, anchorEl) {
  closeAddToPlaylistMenu();

  const menu = el('div', 'account-menu add-playlist-menu');
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 216)}px`;
  menu.appendChild(el('div', 'account-menu-name', t('track.addToPlaylist')));

  const playlists = await jellyfin.getPlaylists();
  if (!playlists.length) {
    menu.appendChild(el('div', 'playlist-empty', t('playlist.sidebarEmpty')));
  } else {
    playlists.forEach((pl) => {
      const item = el('button', '', escapeHtml(pl.Name));
      item.type = 'button';
      item.addEventListener('click', async () => {
        try {
          await jellyfin.addToPlaylist(pl.Id, track.Id);
        } catch (err) {
          alert(err.message || t('errors.couldNotAddToPlaylist'));
        }
        closeAddToPlaylistMenu();
      });
      menu.appendChild(item);
    });
  }

  document.body.appendChild(menu);
  activeAddMenu = menu;

  setTimeout(() => {
    document.addEventListener('click', closeAddToPlaylistMenu, { once: true });
  }, 0);
}

function closeAddToPlaylistMenu() {
  if (activeAddMenu) {
    activeAddMenu.remove();
    activeAddMenu = null;
  }
}

// ---------- Drag-and-drop a track onto a playlist (desktop) ----------
const TRACK_DND_TYPE = 'application/x-triptych-track-id';

function wireTrackDragSource(row, track) {
  if (!isDesktop) return;
  row.draggable = true;
  row.addEventListener('dragstart', (evt) => {
    evt.dataTransfer.setData(TRACK_DND_TYPE, track.Id);
    evt.dataTransfer.effectAllowed = 'copy';
    row.classList.add('dragging-source');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging-source'));
}

function wirePlaylistDropTarget(target, playlistId) {
  if (!isDesktop) return;
  target.addEventListener('dragover', (evt) => {
    if (!evt.dataTransfer.types.includes(TRACK_DND_TYPE)) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'copy';
    target.classList.add('drop-target-active');
  });
  target.addEventListener('dragleave', () => target.classList.remove('drop-target-active'));
  target.addEventListener('drop', async (evt) => {
    if (!evt.dataTransfer.types.includes(TRACK_DND_TYPE)) return;
    evt.preventDefault();
    target.classList.remove('drop-target-active');
    const trackId = evt.dataTransfer.getData(TRACK_DND_TYPE);
    if (!trackId) return;
    try {
      await jellyfin.addToPlaylist(playlistId, trackId);
    } catch (err) {
      alert(err.message || t('errors.couldNotAddToPlaylist'));
    }
  });
}

// ---------- Right-click context menus (desktop) / long-press (mobile) ----------
// openContextMenu() only needs clientX/clientY plus no-op preventDefault/
// stopPropagation (there's no real event to suppress for a synthesized
// long-press) — this lets both input types share the exact same menu code.
function syntheticPointerEvent(x, y) {
  return { clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} };
}

let activeContextMenu = null;

function closeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

// items: array of { label, icon, danger, onClick } or the string 'separator'.
function openContextMenu(evt, items) {
  evt.preventDefault();
  evt.stopPropagation();
  closeContextMenu();
  closeAddToPlaylistMenu();

  const menu = el('div', 'account-menu context-menu');
  items.forEach((item) => {
    if (item === 'separator') { menu.appendChild(el('div', 'context-menu-sep')); return; }
    const btn = el('button', item.danger ? 'danger' : '', `<i class="fi ${item.icon}"></i><span>${escapeHtml(item.label)}</span>`);
    btn.type = 'button';
    btn.addEventListener('click', () => { closeContextMenu(); item.onClick(); });
    menu.appendChild(btn);
  });

  document.body.appendChild(menu);
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(evt.clientX, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(evt.clientY, window.innerHeight - height - 8))}px`;
  activeContextMenu = menu;

  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

// Shared menu contents for a single track — used by both track-table rows
// and queue rows. `queueCtx` carries the queue this track lives in (so
// "Play" can start the right list) plus optional playlist/queue-removal info.
function buildTrackContextMenuItems(track, queueCtx = {}) {
  const items = [];
  items.push({
    label: t('player.play'),
    icon: 'fi-br-play',
    onClick: queueCtx.onPlay || (() => {
      const list = queueCtx.queueRef || [track];
      const startIdx = list.findIndex((tr) => tr.Id === track.Id);
      player.setQueue(list, startIdx >= 0 ? startIdx : 0);
    })
  });
  items.push({
    label: t('queue.addToQueue'),
    icon: 'fi-br-list-music',
    onClick: () => player.enqueue(track)
  });
  items.push({
    label: track.UserData?.IsFavorite ? t('queue.unlike') : t('track.like'),
    icon: 'fi-br-heart',
    onClick: async () => {
      const liked = !track.UserData?.IsFavorite;
      track.UserData = { ...(track.UserData || {}), IsFavorite: liked };
      try {
        if (liked) await jellyfin.likeItem(track.Id);
        else await jellyfin.unlikeItem(track.Id);
        syncCardStates();
      } catch (err) {
        track.UserData.IsFavorite = !liked;
        alert(err.message || t('errors.couldNotUpdateLike'));
      }
    }
  });
  items.push({
    label: t('track.addToPlaylist'),
    icon: 'fi-br-add',
    onClick: (evt) => openAddToPlaylistMenu(track, queueCtx.anchorEl || document.body)
  });
  if (downloadsSupported()) {
    const downloaded = isDownloaded(track.Id);
    items.push({
      label: downloaded ? t('track.removeDownload') : t('track.download'),
      icon: downloaded ? 'fi-br-trash' : 'fi-br-download',
      onClick: async () => {
        try {
          if (downloaded) await deleteDownload(track.Id);
          else await downloadTrack(track, jellyfin);
        } catch (err) {
          alert(err.message || t('errors.couldNotDownload'));
        }
      }
    });
  }
  items.push('separator');
  if (track.AlbumId) {
    items.push({ label: t('kind.album'), icon: 'fi-br-album', onClick: () => navigateTo({ view: 'album', id: track.AlbumId }) });
  }
  if (track.ArtistItems?.length) {
    const artist = track.ArtistItems[0];
    items.push({ label: t('kind.artist'), icon: 'fi-br-user', onClick: () => navigateTo({ view: 'artist', id: artist.Id, name: formatDisplayName(artist.Name) }) });
  }
  if (queueCtx.onRemove) {
    items.push('separator');
    items.push({ label: t('queue.remove'), icon: 'fi-br-trash', danger: true, onClick: queueCtx.onRemove });
  }
  return items;
}

// Same test the mini-player tap uses to decide the panel is the phone's
// full-screen player (where the queue lives in the bottom sheet instead).
function isPhoneLayout() {
  return document.body.classList.contains('platform-mobile') || window.innerWidth <= 820;
}

// The phone's bottom sheet shows either the queue or the full lyrics.
// Both move their existing body element in rather than duplicating it, so
// rendering/syncing code keeps working on the same node.
let queueSheetOpen = false;
let lyricsSheetOpen = false;
let lyricsReturnTimer = null;
// Where #lyrics-body lives in the full-screen player, to put it back.
const lyricsBodyHome = { parent: lyricsBody.parentElement, next: lyricsBody.nextSibling };

function showSheet(titleKey) {
  queueSheetTitle.dataset.i18n = titleKey;
  queueSheetTitle.textContent = t(titleKey);
  queueSheet.style.transform = '';
  queueSheet.classList.add('open');
  queueSheet.setAttribute('aria-hidden', 'false');
  queueSheetBackdrop.classList.add('open');
}

function hideSheet() {
  queueSheet.style.transform = '';
  queueSheet.classList.remove('open', 'lyrics-mode');
  queueSheet.setAttribute('aria-hidden', 'true');
  queueSheetBackdrop.classList.remove('open');
}

function returnLyricsBody() {
  clearTimeout(lyricsReturnTimer);
  if (lyricsBody.parentElement !== lyricsBodyHome.parent) {
    lyricsBodyHome.parent.insertBefore(lyricsBody, lyricsBodyHome.next);
  }
}

function openQueueSheet() {
  if (queueSheetOpen) return;
  // The sheet holds one thing at a time: make sure the lyrics aren't still
  // in it (they may be mid-way back to the player after a close).
  lyricsSheetOpen = false;
  returnLyricsBody();
  queueSheetOpen = true;
  queueSheet.classList.remove('lyrics-mode');
  queueSheet.appendChild(queueBody);
  setHidden(queueBody, false);
  showSheet('nowPlaying.queueTab');
  renderQueue();
  // Start with what plays next in view rather than the top of a long list.
  const playing = queueBody.querySelector('.queue-row.playing');
  queueBody.scrollTop = playing ? Math.max(0, playing.offsetTop - 40) : 0;
}

function openLyricsSheet() {
  if (lyricsSheetOpen) return;
  // The queue list stays parked in the sheet after the queue is closed --
  // hide it, or it shows (stale) above the lyrics.
  queueSheetOpen = false;
  setHidden(queueBody, true);
  lyricsSheetOpen = true;
  clearTimeout(lyricsReturnTimer);
  queueSheet.appendChild(lyricsBody);
  setHidden(lyricsBody, false);
  queueSheet.classList.add('lyrics-mode');
  showSheet('nowPlaying.lyricsTab');
  loadLyricsForCurrentTrack();
  const activeLine = lyricsBody.querySelector('.lyric-line.active');
  if (activeLine) centerLyricLine(activeLine, false);
}

function closeQueueSheet() {
  if (!queueSheetOpen && !lyricsSheetOpen) return;
  queueSheetOpen = false;
  if (lyricsSheetOpen) {
    lyricsSheetOpen = false;
    // Back into the player once the sheet has slid away, not mid-slide.
    lyricsReturnTimer = setTimeout(returnLyricsBody, 300);
  }
  hideSheet();
}

// Drag the sheet's header down to dismiss it, like a native bottom sheet.
function wireQueueSheet() {
  queueSheetBackdrop.addEventListener('click', closeQueueSheet);
  let startY = null;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  queueSheetHead.addEventListener('pointerdown', (evt) => {
    startY = evt.clientY;
    lastY = evt.clientY;
    lastT = performance.now();
    velocity = 0;
    queueSheet.classList.add('dragging');
    queueSheetHead.setPointerCapture(evt.pointerId);
  });
  queueSheetHead.addEventListener('pointermove', (evt) => {
    if (startY === null) return;
    const now = performance.now();
    velocity = (evt.clientY - lastY) / Math.max(1, now - lastT);
    lastY = evt.clientY;
    lastT = now;
    const dy = Math.max(0, evt.clientY - startY);
    queueSheet.style.transform = `translateY(${dy}px)`;
  });
  const end = (evt) => {
    if (startY === null) return;
    const dy = Math.max(0, evt.clientY - startY);
    startY = null;
    queueSheet.classList.remove('dragging');
    // A tap on the header (no drag) also closes it, like Spotify's handle.
    if (dy > queueSheet.offsetHeight * 0.25 || velocity > 0.6 || dy < 4) closeQueueSheet();
    else queueSheet.style.transform = '';
  };
  queueSheetHead.addEventListener('pointerup', end);
  queueSheetHead.addEventListener('pointercancel', end);
}

// ---------- Full-screen player open/close + gestures ----------
let nowPlayingCloseTimer = null;

function openNowPlaying() {
  // Reopened mid-close: drop the slide-out so it doesn't hide afterwards.
  clearTimeout(nowPlayingCloseTimer);
  lyricsPanel.style.transition = '';
  lyricsPanel.style.transform = '';
  lyricsPanel.hidden = false;
  lyricsPanel.scrollTop = 0; // undo any shift an older build's scrollIntoView left behind
  showPanelTab(activePanelTab);
  refreshNowPlayingMarquees();
  // Its fill depends on the slider's width, which is 0 while the player
  // is closed -- recompute now that it's laid out.
  npVolumeBar.style.setProperty('--pct', rangeFillPercent(Number(npVolumeBar.value), npVolumeBar, 14));
}

// Slides the phone's full-screen player down before hiding it (desktop's
// side panel just hides). Also used to finish a swipe-down from wherever
// the finger left it, since the transition starts from the current transform.
function closeNowPlaying() {
  closeQueueSheet();
  if (lyricsPanel.hidden) return;
  if (!isPhoneLayout()) { lyricsPanel.hidden = true; return; }
  clearTimeout(nowPlayingCloseTimer);
  lyricsPanel.style.transition = 'transform 0.26s cubic-bezier(0.4, 0, 1, 1)';
  // Force the current position to be committed before animating away.
  void lyricsPanel.offsetHeight;
  lyricsPanel.style.transform = 'translateY(100%)';
  nowPlayingCloseTimer = setTimeout(() => {
    lyricsPanel.hidden = true;
    lyricsPanel.style.transition = '';
    lyricsPanel.style.transform = '';
  }, 270);
}

// On the cover art: swipe left/right for next/previous track (the art
// follows the finger, then slides out and the new cover slides in), swipe
// down to close the player. Pointer Events, so it also works with a mouse
// in a narrow desktop window.
function wireNowPlayingGestures() {
  const target = nowPlayingArtWrap;
  target.style.touchAction = 'none';
  let startX = 0, startY = 0, axis = null, pointerId = null, startT = 0;

  const reset = () => {
    target.style.transition = '';
    target.style.transform = '';
    target.style.opacity = '';
  };

  target.addEventListener('pointerdown', (evt) => {
    if (!isPhoneLayout() || evt.button > 0) return;
    pointerId = evt.pointerId;
    startX = evt.clientX;
    startY = evt.clientY;
    startT = performance.now();
    axis = null;
    target.setPointerCapture(pointerId);
  });

  target.addEventListener('pointermove', (evt) => {
    if (evt.pointerId !== pointerId) return;
    const dx = evt.clientX - startX;
    const dy = evt.clientY - startY;
    if (!axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis === 'x') {
      target.style.transition = 'none';
      target.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      target.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 500));
    } else if (dy > 0) {
      lyricsPanel.style.transition = 'none';
      lyricsPanel.style.transform = `translateY(${dy}px)`;
    }
  });

  const end = (evt) => {
    if (evt.pointerId !== pointerId) return;
    pointerId = null;
    const dx = evt.clientX - startX;
    const dy = evt.clientY - startY;
    const fast = performance.now() - startT < 250;

    if (axis === 'x') {
      const width = target.offsetWidth || 300;
      const commit = Math.abs(dx) > width * 0.3 || (fast && Math.abs(dx) > 40);
      if (!commit || !player?.currentTrack) {
        target.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        target.style.transform = '';
        target.style.opacity = '';
        setTimeout(reset, 220);
        return;
      }
      const dir = dx < 0 ? -1 : 1; // -1 = next (swiped left)
      hapticImpact('light');
      target.style.transition = 'transform 0.16s ease-in, opacity 0.16s ease-in';
      target.style.transform = `translateX(${dir * width * 1.2}px) rotate(${dir * 8}deg)`;
      target.style.opacity = '0';
      setTimeout(() => {
        if (dir < 0) uiNext();
        else uiPrevious(true);
        // New cover comes in from the opposite side.
        target.style.transition = 'none';
        target.style.transform = `translateX(${-dir * width * 0.6}px)`;
        void target.offsetWidth;
        target.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.22s ease-out';
        target.style.transform = '';
        target.style.opacity = '';
        setTimeout(reset, 240);
      }, 160);
    } else if (axis === 'y') {
      const height = lyricsPanel.offsetHeight || window.innerHeight;
      if (dy > height * 0.2 || (fast && dy > 60)) {
        closeNowPlaying();
      } else {
        lyricsPanel.style.transition = 'transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)';
        lyricsPanel.style.transform = '';
        setTimeout(() => { lyricsPanel.style.transition = ''; }, 240);
      }
    }
    axis = null;
  };
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}

// The player panel always shows lyrics; the queue opens as a sheet over it
// (openQueueSheet), on desktop and phones alike. 'queue' is still accepted
// so older callers just open that sheet.
function showPanelTab(tab) {
  if (tab === 'queue') openQueueSheet();
  activePanelTab = 'lyrics';
  setHidden(lyricsBody, false);
  loadLyricsForCurrentTrack();
}

function buildQueueRow(track, idx, isPlaying) {
  const row = el('div', isPlaying ? 'queue-row playing' : 'queue-row');
  row.dataset.idx = idx;
  const img = document.createElement('img');
  img.src = artUrl(track, 'album', 48);
  row.appendChild(img);
  const text = el('div', 'queue-row-text');
  text.innerHTML = `<div class="queue-row-title">${escapeHtml(track.Name)}</div><div class="queue-row-artist">${escapeHtml(artistNames(track))}</div>`;
  row.appendChild(text);
  row.addEventListener('click', () => player.playAt(idx));

  const openQueueRowMenu = (x, y) => openContextMenu(syntheticPointerEvent(x, y), buildTrackContextMenuItems(track, {
    onPlay: () => player.playAt(idx),
    anchorEl: row,
    onRemove: isPlaying ? null : () => player.removeFromQueueAt(idx)
  }));

  // Can't remove/reorder what's currently playing this way — only "Up Next" rows.
  if (!isPlaying) {
    wireSwipeActions(row, {
      // Delay the actual removal slightly so the slide-out animation has
      // time to play before renderQueue() (triggered by queuechange) wipes
      // and rebuilds the whole list out from under it.
      onSwipeLeft: () => setTimeout(() => player.removeFromQueueAt(idx), 180),
      onLongPress: isMobile ? openQueueRowMenu : undefined
    });
    const handle = el('div', 'queue-row-handle', '<i class="fi fi-br-grip-dots-vertical"></i>');
    handle.addEventListener('click', (evt) => evt.stopPropagation());
    row.appendChild(handle);
    wireQueueDragHandle(handle, row);
  }

  if (isDesktop) {
    row.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      openQueueRowMenu(evt.clientX, evt.clientY);
    });
  }

  return row;
}

// Drag-to-reorder via a dedicated handle (rather than the whole row) so it
// never has to be disambiguated from the swipe-to-remove gesture on the
// same row — Pointer Events unify mouse (desktop) and touch (mobile).
function wireQueueDragHandle(handle, row) {
  // Pointer Events and Touch Events are separate, parallel systems —
  // stopPropagation() on the pointerdown below does NOT stop the browser's
  // own native touchstart from also firing and bubbling up to the row's
  // OWN touch listeners (wireSwipeActions' long-press timer among them).
  // Without this, starting a drag from the handle also started that
  // timer in parallel, and after 500ms it popped the context menu mid-
  // drag, hijacking the gesture — confirmed on-device. Stopping the touch
  // event here, at the handle itself before it ever bubbles to the row,
  // is what actually prevents that.
  handle.addEventListener('touchstart', (evt) => evt.stopPropagation(), { passive: true });
  handle.addEventListener('pointerdown', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    let startY = evt.clientY;
    const fromIdx = Number(row.dataset.idx);
    // The rows on screen were rendered relative to this; currentIndex can
    // move mid-drag (a song ending), which used to skew the drop index.
    const baseIndex = player.currentIndex;
    queueDragActive = true;
    row.classList.add('dragging');
    // Everything but the grabbed row dims, so it's clear what's moving.
    row.parentElement?.classList.add('queue-dragging');
    try { handle.setPointerCapture(evt.pointerId); } catch (err) { /* moves still reach the handle */ }

    const onMove = (moveEvt) => {
      let dy = moveEvt.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      row.style.zIndex = '10';

      // Swap DOM position with whichever sibling row the dragged row's
      // center has now crossed, live, so the list visibly reshuffles as you
      // drag rather than only snapping into place on release. Direction is
      // read from the siblings' CURRENT DOM order (not their original
      // render index) so it stays correct after earlier swaps this same
      // drag, including reversing direction mid-drag.
      // Keep swapping until the row's center sits between its neighbours --
      // a fast drag can cross several rows in one move event, and handling
      // only one per event left the DOM order (and so the drop slot) behind
      // the finger.
      for (let guard = 0; guard < 200; guard++) {
        const rowRect = row.getBoundingClientRect();
        const rowCenter = rowRect.top + rowRect.height / 2;
        const prev = row.previousElementSibling?.matches('.queue-row:not(.playing)') ? row.previousElementSibling : null;
        const next = row.nextElementSibling?.matches('.queue-row:not(.playing)') ? row.nextElementSibling : null;
        const centerOf = (r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2; };
        let target = null;
        if (next && rowCenter > centerOf(next)) target = () => row.parentElement.insertBefore(row, next.nextSibling);
        else if (prev && rowCenter < centerOf(prev)) target = () => row.parentElement.insertBefore(row, prev);
        if (!target) break;
        // The DOM move shifts the row's untransformed position; compensate
        // startY by exactly that (offsetTop ignores transforms, and this
        // also accounts for any gap/margin between rows) so the row stays
        // under the finger instead of jumping.
        const before = row.offsetTop;
        target();
        startY += row.offsetTop - before;
        dy = moveEvt.clientY - startY;
        row.style.transform = `translateY(${dy}px)`;
      }
    };

    const onUp = () => {
      // Never let a failed release leave the row grabbed or the list dimmed.
      try { handle.releasePointerCapture(evt.pointerId); } catch (err) { /* capture already gone */ }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      row.classList.remove('dragging');
      row.parentElement?.classList.remove('queue-dragging');
      row.style.transform = '';
      row.style.zIndex = '';
      // Read the drop target straight from the final DOM order rather than
      // tracking it incrementally during the drag above — a running tracker
      // based on each sibling's original render index only stays correct
      // for crossings in one direction, and goes wrong the moment a drag
      // reverses direction partway through.
      queueDragActive = false;
      const siblings = row.parentElement ? [...row.parentElement.querySelectorAll('.queue-row:not(.playing)')] : [];
      const toIdx = baseIndex + 1 + siblings.indexOf(row);
      if (siblings.length && toIdx !== fromIdx) {
        hapticImpact('light');
        player.reorderQueueAt(fromIdx, toIdx);
      }
      // Catch up on anything that changed while the drag held renders off
      // (a no-op re-render if reorderQueueAt above already triggered one).
      if (queueRenderPending) renderQueue();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

// Rebuilding the list mid-drag (e.g. on trackchange) would yank the dragged
// row out from under the finger -- defer it until the drop instead.
let queueDragActive = false;
let queueRenderPending = false;

function renderQueue() {
  if (queueDragActive) {
    queueRenderPending = true;
    return;
  }
  queueRenderPending = false;
  queueBody.innerHTML = '';
  if (!player.queue.length) {
    queueBody.appendChild(el('div', 'queue-empty', escapeHtml(t('nowPlaying.queueEmpty'))));
    return;
  }

  const current = player.currentTrack;
  if (current) {
    queueBody.appendChild(el('div', 'queue-section-title', escapeHtml(t('nowPlaying.nowPlayingSection'))));
    queueBody.appendChild(buildQueueRow(current, player.currentIndex, true));
  }

  // Songs you added yourself ("Add to queue"), in the order you added
  // them, then the rest of what you started ("Next up").
  const queued = player.pendingQueued();
  if (queued.length) {
    const head = el('div', 'queue-section-title queue-section-head');
    head.appendChild(el('span', '', escapeHtml(t('nowPlaying.nextInQueue'))));
    const clear = el('button', 'queue-clear-btn', escapeHtml(t('nowPlaying.clearQueue')));
    clear.type = 'button';
    clear.addEventListener('click', () => player.clearQueued());
    head.appendChild(clear);
    queueBody.appendChild(head);
    queued.forEach((track, offset) => {
      queueBody.appendChild(buildQueueRow(track, player.currentIndex + 1 + offset, false));
    });
  }
  const restStart = player.currentIndex + 1 + queued.length;
  const upNext = player.queue.slice(restStart);
  if (upNext.length) {
    queueBody.appendChild(el('div', 'queue-section-title', escapeHtml(t('nowPlaying.upNext'))));
    upNext.forEach((track, offset) => {
      queueBody.appendChild(buildQueueRow(track, restStart + offset, false));
    });
  }
}

function highlightPlayingRow(trackId) {
  document.querySelectorAll('.track-row').forEach((row) => {
    row.classList.toggle('playing', row.dataset.id === trackId);
  });
}

function lyricsQueryFor(track) {
  return {
    title: track.Name,
    artist: artistNames(track),
    album: track.Album,
    durationSeconds: ticksToSeconds(track.RunTimeTicks),
    // Second source, after lrclib: the server's own lyrics for this track.
    fromServer: jellyfin ? () => jellyfin.getLyrics(track.Id) : null
  };
}

// Warms the lyrics cache for whatever plays next, so skipping ahead shows
// them immediately. Best-effort; failures just mean a normal lookup later.
function prefetchNextLyrics() {
  const next = player?.queue?.[player.currentIndex + 1];
  if (next) fetchLyrics(lyricsQueryFor(next)).catch(() => {});
}

async function loadLyricsForCurrentTrack() {
  const track = player.currentTrack;
  if (!track) return;
  if (lyricsTrackId === track.Id && currentLyrics) return;
  lyricsTrackId = track.Id;
  const query = lyricsQueryFor(track);
  // Already looked up this session: render straight away, no spinner text.
  if (!getCachedLyrics(query).hit) {
    lyricsBody.innerHTML = `<div class="lyrics-empty">${escapeHtml(t('nowPlaying.lookingUpLyrics'))}</div>`;
  }

  let result;
  try {
    result = await fetchLyrics(query);
  } catch (err) {
    if (lyricsTrackId !== track.Id) return;
    // lrclib didn't answer (after retries) -- not the same as "no lyrics".
    currentLyrics = null;
    lyricsTrackId = null; // so reopening the panel tries again
    lyricsBody.innerHTML = '';
    const box = el('div', 'lyrics-empty', escapeHtml(t('nowPlaying.lyricsFailed')));
    const retry = el('button', 'lyrics-retry-btn', escapeHtml(t('nowPlaying.retry')));
    retry.type = 'button';
    retry.addEventListener('click', () => loadLyricsForCurrentTrack());
    box.appendChild(retry);
    lyricsBody.appendChild(box);
    return;
  }

  rememberLyrics(track.Id, result);
  if (lyricsTrackId !== track.Id) return; // track changed while fetching
  currentLyrics = result;
  prefetchNextLyrics();

  if (!result || (!result.synced && !result.plain)) {
    lyricsBody.innerHTML = `<div class="lyrics-empty">${escapeHtml(t('nowPlaying.noLyrics'))}</div>`;
    return;
  }

  lyricsBody.innerHTML = '';
  if (result.synced && result.synced.length) {
    result.synced.forEach((line) => {
      const p = el('p', 'lyric-line', escapeHtml(line.text || ' '));
      p.dataset.time = line.time;
      p.addEventListener('click', () => player.seekTo(line.time));
      lyricsBody.appendChild(p);
    });
  } else if (result.plain) {
    result.plain.split('\n').forEach((line) => {
      lyricsBody.appendChild(el('p', 'lyric-line', escapeHtml(line || ' ')));
    });
  }
}

function updateActiveLyricLine(currentTime) {
  if (lyricsPanel.hidden || !currentLyrics || !currentLyrics.synced) return;
  const lines = lyricsBody.querySelectorAll('.lyric-line');
  if (!lines.length) return;
  let activeIdx = -1;
  lines.forEach((line, i) => {
    const t = Number(line.dataset.time);
    if (!isNaN(t) && t <= currentTime) activeIdx = i;
  });
  lines.forEach((line, i) => line.classList.toggle('active', i === activeIdx));
  if (activeIdx >= 0) centerLyricLine(lines[activeIdx], true);
}

// Scrolls only the lyrics list itself. scrollIntoView() would also scroll
// every ancestor -- including the overflow:hidden full-screen player --
// shoving the whole player (header icons and all) up off the screen.
function centerLyricLine(line, smooth) {
  const top = line.offsetTop - (lyricsBody.clientHeight - line.offsetHeight) / 2;
  lyricsBody.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

// ---------- Wrapped (year in review) ----------
// Unlocks on December 31 at 0:00 (device time) and opens by itself once
// that day; it can be reopened from Stats until January 7, as a recap of
// the year that just ended. Returns that year, or null outside the window.
function wrappedYearAvailable(now = new Date()) {
  if (now.getMonth() === 11 && now.getDate() === 31) return now.getFullYear();
  if (now.getMonth() === 0 && now.getDate() <= 7) return now.getFullYear() - 1;
  return null;
}

const WRAPPED_SEEN_KEY = 'triptych:wrappedSeen';

// "Your {year} Wrapped" banner (Home + Stats), or null outside the window.
function buildWrappedBanner() {
  const year = wrappedYearAvailable();
  if (!year) return null;
  const banner = el('button', 'wrapped-banner', `<div class="wrapped-banner-title">${escapeHtml(t('wrapped.bannerTitle', { year }))}</div><div class="wrapped-banner-sub">${escapeHtml(t('wrapped.bannerSub'))}</div><i class="fi fi-br-angle-small-right"></i>`);
  banner.type = 'button';
  banner.addEventListener('click', () => openWrapped(year));
  return banner;
}

// Called once the app is up: opens the year's Wrapped the first time the
// app is opened inside the window (after any "What's new" popup).
function maybeAutoOpenWrapped() {
  const year = wrappedYearAvailable();
  if (!year) return;
  try { if (localStorage.getItem(WRAPPED_SEEN_KEY) === String(year)) return; } catch (err) { return; }
  const tryOpen = () => {
    if (!whatsNewOverlay.hidden) { setTimeout(tryOpen, 1000); return; }
    try { localStorage.setItem(WRAPPED_SEEN_KEY, String(year)); } catch (err) { /* ignore */ }
    openWrapped(year);
  };
  setTimeout(tryOpen, 1500);
}
// A tap-through story: minutes listened, top artist, top songs, biggest
// month. Uses the measured listening time for the year once there's a
// meaningful amount of it (30+ min); before that, an all-time recap from
// play counts, clearly labelled as such.
// Adds the top artist's photo, background and logo from Jellyfin (the same
// images the artist page uses), so the top-artist slide can show them.
async function withArtistImages(data) {
  const ta = data?.topArtist;
  const tr = ta?.track;
  if (!ta) return data;
  ta.albumArt = tr ? artUrl(tr, 'album', 220) : placeholderArt('artist');
  const ref = tr?.ArtistItems?.find((a) => formatDisplayName(a.Name) === ta.name) || tr?.ArtistItems?.[0];
  if (!ref?.Id) return data;
  ta.photo = `${jellyfin.serverUrl}/Items/${ref.Id}/Images/Primary?maxWidth=600&quality=90`;
  const item = await jellyfin.getItem(ref.Id).catch(() => null);
  if (item) {
    ta.backdrop = jellyfin.backdropUrl(item, 1600);
    ta.logo = item.ImageTags?.Logo ? jellyfin.imageUrl(item, 'Logo', 800) : null;
  }
  return data;
}

async function buildWrappedData(year) {
  return withArtistImages(await buildWrappedDataRaw(year));
}

async function buildWrappedDataRaw(year) {
  await ensureAllSongsCache();
  const byId = new Map((allSongsCache || []).map((tr) => [tr.Id, tr]));
  const yearLog = listeningTotals().years[year];

  if (yearLog && yearLog.total >= 1800) {
    const songs = Object.entries(yearLog.tracks)
      .map(([id, secs]) => ({ track: byId.get(id), secs }))
      .filter((r) => r.track)
      .sort((a, b) => b.secs - a.secs);
    const artists = new Map();
    for (const { track, secs } of songs) {
      for (const name of individualArtistNames(track)) artists.set(name, (artists.get(name) || 0) + secs);
    }
    const topArtist = [...artists.entries()].sort((a, b) => b[1] - a[1])[0];
    const monthIdx = yearLog.months.indexOf(Math.max(...yearLog.months));
    return {
      allTime: false,
      year,
      minutes: Math.round(yearLog.total / 60),
      topArtist: topArtist && { name: topArtist[0], detail: t('wrapped.minutesTogether', { minutes: Math.round(topArtist[1] / 60) }), track: songs.find((r) => individualArtistNames(r.track).includes(topArtist[0]))?.track },
      topSongs: songs.slice(0, 5).map((r) => ({ track: r.track, detail: t('wrapped.minutesShort', { minutes: Math.max(1, Math.round(r.secs / 60)) }) })),
      topMonth: yearLog.months[monthIdx] > 0 ? { index: monthIdx, minutes: Math.round(yearLog.months[monthIdx] / 60) } : null
    };
  }

  const stats = accountStats();
  if (!stats.totalPlays) return null;
  const topArtistName = stats.topArtists[0]?.artist;
  return {
    allTime: true,
    year,
    minutes: stats.totalMinutes,
    topArtist: topArtistName && {
      name: topArtistName,
      detail: t(stats.topArtists[0].count === 1 ? 'stats.plays' : 'stats.playsPlural', { count: stats.topArtists[0].count }),
      track: stats.topTracks.find((tr) => individualArtistNames(tr).includes(topArtistName))
    },
    topSongs: stats.topTracks.slice(0, 5).map((tr) => ({ track: tr, detail: t((tr.UserData?.PlayCount || 0) === 1 ? 'stats.plays' : 'stats.playsPlural', { count: tr.UserData?.PlayCount || 0 }) })),
    topMonth: null
  };
}

function wrappedSlides(data) {
  const slides = [];
  const monthName = (i) => new Date(2000, i, 1).toLocaleDateString(document.documentElement.lang || undefined, { month: 'long' });
  slides.push({
    theme: 'a',
    html: `<div class="wr-kicker">Triptych</div>
      <div class="wr-big">${escapeHtml(data.allTime ? t('wrapped.introAllTime') : t('wrapped.introTitle', { year: data.year }))}</div>
      <div class="wr-sub">${escapeHtml(t('wrapped.tapToContinue'))}</div>`
  });
  slides.push({
    theme: 'b',
    html: `<div class="wr-kicker">${escapeHtml(t('wrapped.minutesTitle'))}</div>
      <div class="wr-huge">${data.allTime ? '≈ ' : ''}${data.minutes.toLocaleString(document.documentElement.lang || undefined)}</div>
      <div class="wr-big">${escapeHtml(t('wrapped.minutesUnit'))}</div>
      <div class="wr-sub">${escapeHtml(data.allTime ? t('wrapped.estimatedNote') : t('wrapped.hoursNote', { hours: Math.round(data.minutes / 60) }))}</div>`
  });
  if (data.topArtist) {
    const ta = data.topArtist;
    // With a background photo: it fills the slide, and the logo (or name)
    // sits on it. Without one: the round artist photo, as before.
    const name = ta.logo
      ? `<img class="wr-logo" src="${ta.logo}" alt="${escapeHtml(ta.name)}" onerror="this.outerHTML='<div class=&quot;wr-big&quot;>${escapeHtml(ta.name).replace(/'/g, '&#39;')}</div>'" />`
      : `<div class="wr-big">${escapeHtml(ta.name)}</div>`;
    const photo = ta.backdrop ? '' : `<img class="wr-art round" src="${ta.photo || ta.albumArt}" alt="" onerror="this.onerror=null;this.src='${ta.albumArt}'" />`;
    slides.push({
      theme: 'f',
      drumroll: true,
      duration: DRUMROLL_HIT_MS,
      html: `<div class="wr-kicker">${escapeHtml(t('wrapped.drumrollKicker'))}</div>
        <div class="wr-drum">🥁</div>
        <div class="wr-big wr-drum-text">${escapeHtml(t('wrapped.drumroll'))}</div>`
    });
    slides.push({
      theme: 'c',
      music: ta.track || null,
      bg: ta.backdrop || null,
      html: `<div class="wr-kicker">${escapeHtml(t('wrapped.topArtistTitle'))}</div>
        ${photo}
        ${name}
        <div class="wr-sub">${escapeHtml(ta.detail)}</div>`
    });
  }
  if (data.topSongs.length) {
    slides.push({
      theme: 'd',
      html: `<div class="wr-kicker">${escapeHtml(t('wrapped.topSongsTitle'))}</div>
        <ol class="wr-list">${data.topSongs.map((s, i) => `<li><span class="wr-rank">${i + 1}</span><img src="${artUrl(s.track, 'album', 56)}" alt="" /><span class="wr-li-text"><span class="wr-li-title">${escapeHtml(s.track.Name)}</span><span class="wr-li-sub">${escapeHtml(artistNames(s.track))} · ${escapeHtml(s.detail)}</span></span></li>`).join('')}</ol>`
    });
  }
  if (data.topMonth) {
    slides.push({
      theme: 'e',
      html: `<div class="wr-kicker">${escapeHtml(t('wrapped.topMonthTitle'))}</div>
        <div class="wr-huge wr-month">${escapeHtml(monthName(data.topMonth.index))}</div>
        <div class="wr-sub">${escapeHtml(t('wrapped.topMonthNote', { minutes: data.topMonth.minutes.toLocaleString(document.documentElement.lang || undefined) }))}</div>`
    });
  }
  slides.push({
    theme: 'a',
    html: `<div class="wr-big">${escapeHtml(t('wrapped.outroTitle'))}</div>
      <div class="wr-sub">${escapeHtml(t('wrapped.outroSub'))}</div>
      ${data.topSongs.length ? `<button type="button" class="wr-play">${escapeHtml(t('wrapped.playTop'))}</button>` : ''}`
  });
  return slides;
}

// The drumroll before the top artist: a recorded roll that ends on a hit
// at ~4.15s (assets/drumroll.mp3 -- Kevin MacLeod, CC BY 3.0, see the
// third-party notices). The artist is revealed right on that hit.
const DRUMROLL_HIT_MS = 4200;
function playDrumroll() {
  const audio = new Audio('assets/drumroll.mp3');
  audio.volume = 0.85;
  audio.play().catch(() => {});
  return () => {
    // Let the final hit ring out over the reveal unless the user skipped
    // ahead before it -- then cut the roll off.
    if (audio.currentTime < DRUMROLL_HIT_MS / 1000 - 0.1) {
      audio.pause();
    }
  };
}

// Background music for Wrapped: a song from about a third of the way in
// (past slow intros), faded in, faded out when Wrapped closes.
function playWrappedMusic(track) {
  const audio = new Audio(jellyfin.streamUrl(track, currentBitrateKbps()));
  audio.volume = 0;
  audio.addEventListener('loadedmetadata', () => {
    if (isFinite(audio.duration)) audio.currentTime = Math.min(60, audio.duration * 0.33);
  }, { once: true });
  audio.play().catch(() => {});
  let fade = setInterval(() => {
    audio.volume = Math.min(0.6, audio.volume + 0.04);
    if (audio.volume >= 0.6) { clearInterval(fade); fade = null; }
  }, 100);
  return () => {
    if (fade) clearInterval(fade);
    const out = setInterval(() => {
      audio.volume = Math.max(0, audio.volume - 0.06);
      if (audio.volume <= 0) {
        clearInterval(out);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    }, 60);
  };
}

async function openWrapped(year) {
  let data;
  try { data = await buildWrappedData(year); } catch (err) { data = null; }
  if (!data) return;
  const slides = wrappedSlides(data);
  const overlay = el('div', 'wrapped-overlay');
  overlay.innerHTML = `<div class="wr-bars">${slides.map(() => '<span><i></i></span>').join('')}</div>
    <button type="button" class="wr-close" aria-label="${escapeHtml(t('common.close'))}"><i class="fi fi-br-cross-small"></i></button>
    <div class="wr-stage"></div>`;
  document.body.appendChild(overlay);
  const stage = overlay.querySelector('.wr-stage');
  const bars = [...overlay.querySelectorAll('.wr-bars i')];
  let index = 0;
  let timer = null;
  const SLIDE_MS = 6000;

  // What's playing in the app pauses for Wrapped and resumes after.
  const resumeAfter = !!(player?.currentTrack && !player.audio.paused && !connect?.isConnected());
  if (resumeAfter) player.audio.pause();
  let stopDrum = null;
  let stopMusic = null;

  const close = () => {
    clearTimeout(timer);
    stopDrum?.();
    stopMusic?.();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (resumeAfter) player.audio.play().catch(() => {});
  };
  const show = (i) => {
    if (i < 0) i = 0;
    if (i >= slides.length) { close(); return; }
    index = i;
    const slide = slides[i];
    stopDrum?.();
    stopDrum = slide.drumroll ? playDrumroll() : null;
    // The top artist's song starts on their slide and keeps playing for
    // the rest of the story.
    if (slide.music && !stopMusic) stopMusic = playWrappedMusic(slide.music);
    const duration = slide.duration || SLIDE_MS;
    stage.className = `wr-stage wr-theme-${slides[i].theme}${slides[i].bg ? ' wr-has-bg' : ''}`;
    stage.style.backgroundImage = slides[i].bg
      ? `linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.85) 100%), url("${slides[i].bg}")`
      : '';
    stage.innerHTML = `<div class="wr-slide">${slides[i].html}</div>`;
    bars.forEach((b, bi) => {
      b.style.transition = 'none';
      b.style.width = bi < i ? '100%' : '0%';
    });
    void bars[i].offsetWidth;
    bars[i].style.transition = `width ${duration}ms linear`;
    bars[i].style.width = '100%';
    clearTimeout(timer);
    // The last slide stays until the user closes it or plays.
    if (i < slides.length - 1) timer = setTimeout(() => show(index + 1), duration);
    stage.querySelector('.wr-play')?.addEventListener('click', (evt) => {
      evt.stopPropagation();
      player.setQueue(data.topSongs.map((s) => s.track), 0, 'wrapped');
      close();
    });
  };
  const onKey = (evt) => {
    if (evt.key === 'Escape') close();
    else if (evt.key === 'ArrowRight' || evt.key === ' ') { evt.preventDefault(); show(index + 1); }
    else if (evt.key === 'ArrowLeft') show(index - 1);
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.wr-close').addEventListener('click', close);
  // Tap the left third to go back, anywhere else to go forward; swipe too.
  let touchX = null;
  stage.addEventListener('touchstart', (evt) => { touchX = evt.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (evt) => {
    if (touchX === null) return;
    const dx = evt.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) { evt.preventDefault(); show(index + (dx < 0 ? 1 : -1)); }
  });
  stage.addEventListener('click', (evt) => {
    const rect = stage.getBoundingClientRect();
    show(index + (evt.clientX - rect.left < rect.width / 3 ? -1 : 1));
  });
  hapticImpact('light');
  show(0);
}

init().catch((err) => {
  console.error('Startup failed', err);
  if (appRoot.hidden) showLogin();
  else hideBootSplash();
});
