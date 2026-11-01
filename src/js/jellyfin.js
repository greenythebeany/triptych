// Minimal Jellyfin REST API client — just what a music client needs.

import { isMobile } from './platform.js';

// Must be unique per install, not per app — the Connect feature (Sessions
// API) tells devices apart by DeviceId, and a shared constant here would
// make every Triptych install look like the same device reconnecting,
// breaking both the "other devices" list and self-exclusion from it.
const DEVICE_ID_KEY = 'triptych:deviceId';
function loadOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = `triptych-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch (err) {
    return `triptych-${Math.random().toString(36).slice(2)}`;
  }
}
const DEVICE_ID = loadOrCreateDeviceId();

// Jellyfin makes a separate artist for every collaboration credit it finds
// in tags ("Pitbull feat. Ne-Yo", "Pitbull & Ke$ha"), so searching one artist
// listed several. A credit like that is dropped when one of its names is
// also in the results on its own; real duo names ("Simon & Garfunkel") stay,
// since neither half exists by itself.
const COLLAB_SPLIT = /\s*(?:,|;|&|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?)\s*/i;
function dedupeCollabArtists(artists) {
  const single = new Set(artists.map((a) => (a.Name || '').trim().toLowerCase()));
  return artists.filter((a) => {
    const parts = (a.Name || '').split(COLLAB_SPLIT).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (parts.length < 2) return true;
    return !parts.some((part) => single.has(part));
  });
}
const CLIENT_NAME = 'Triptych';
// Up to 2.2 the synced settings/listening records were stored under the
// JellyWave name. They are still read (and merged) so nothing is lost, while
// devices on 2.3+ only write the Triptych ones.
const LEGACY_CLIENT_NAME = 'JellyWave';
const PREFS = { listening: 'TriptychListening', settings: 'TriptychSettings' };
const LEGACY_PREFS = { listening: 'JellyWaveListening', settings: 'JellyWaveSettings' };
// Was previously a hardcoded string that had to be bumped by hand on every
// release and repeatedly drifted out of sync with the app's real version
// (stuck reporting 1.0.0, then stuck reporting 1.0.5, both while newer
// versions had already shipped). Now read from the actual installed
// version instead — Electron's app.getVersion() (via preload's IPC bridge)
// on desktop, Capacitor's App.getInfo() on Android/iOS — so it can't go
// stale again. initClientVersion() resolves this once at startup; the
// literal below is only the fallback for the brief window before that
// resolves (or if neither bridge is available, e.g. running in a plain
// browser during development).
let CLIENT_VERSION = '2.4.0';

export function getClientVersion() {
  return CLIENT_VERSION;
}

export async function initClientVersion() {
  try {
    if (window.Capacitor?.Plugins?.App) {
      const info = await window.Capacitor.Plugins.App.getInfo();
      if (info?.version) CLIENT_VERSION = info.version;
    } else if (window.api?.app) {
      const version = await window.api.app.getVersion();
      if (version) CLIENT_VERSION = version;
    }
  } catch (err) {
    // Best-effort — keeps whatever CLIENT_VERSION already was.
  }
}

function authHeader(token) {
  const device = isMobile ? 'Android' : 'Desktop';
  let header = `MediaBrowser Client="${CLIENT_NAME}", Device="${device}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}"`;
  if (token) header += `, Token="${token}"`;
  return header;
}

export class JellyfinClient {
  constructor({ serverUrl, accessToken, userId, avatarTag }) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.userId = userId;
    this.avatarTag = avatarTag || null;
  }

  static async authenticate(serverUrl, username, password) {
    const base = serverUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': authHeader()
      },
      body: JSON.stringify({ Username: username, Pw: password })
    });

    if (!res.ok) {
      if (res.status === 401) {
        const err = new Error('Wrong username or password.');
        err.code = 'wrong_credentials';
        throw err;
      }
      const err = new Error(`Server responded with ${res.status}.`);
      err.code = 'server_error';
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return {
      serverUrl: base,
      accessToken: data.AccessToken,
      userId: data.User.Id,
      username: data.User.Name,
      avatarTag: data.User.PrimaryImageTag || null
    };
  }

  avatarUrl(maxSize = 120) {
    if (!this.avatarTag) return null;
    const params = new URLSearchParams({
      maxWidth: maxSize,
      maxHeight: maxSize,
      quality: 90,
      tag: this.avatarTag,
      api_key: this.accessToken
    });
    return `${this.serverUrl}/Users/${this.userId}/Images/Primary?${params.toString()}`;
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': authHeader(this.accessToken),
      'X-Emby-Token': this.accessToken
    };
  }

  // Public wrapper for downloads.js — it needs to fetch a stream URL itself
  // (in Electron's main process, or Android's WebView) without reaching
  // into this client's internals.
  getAuthHeaders() {
    return this._headers();
  }

  async _get(path, params = {}) {
    const url = new URL(`${this.serverUrl}${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
    let res;
    try {
      // Every GET here is dynamic/user-specific — most importantly, Connect's
      // session polling hits the exact same /Sessions URL every few seconds,
      // and without this the browser's HTTP cache can start quietly serving
      // a stale response instead of actually hitting the server.
      res = await fetch(url, { headers: this._headers(), cache: 'no-store' });
    } catch (err) {
      // fetch itself threw — no response at all (offline, DNS, server down,
      // etc). Distinct from an actual HTTP error response.
      const netErr = new Error(`Could not reach server: ${err.message}`);
      netErr.isNetworkError = true;
      throw netErr;
    }
    if (!res.ok) {
      const err = new Error(`Jellyfin request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // Same network-vs-HTTP-error distinction as _get(), for one-off POSTs
  // that only care whether the call succeeded (Connect's send commands) —
  // a raw fetch() rejection surfaces as the browser's generic "Failed to
  // fetch", which tells the user nothing about what actually went wrong.
  async _fetchOk(url, options, failureMessage) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      const netErr = new Error(`Could not reach server: ${err.message}`);
      netErr.isNetworkError = true;
      throw netErr;
    }
    if (!res.ok) {
      const err = new Error(`${failureMessage} (${res.status}).`);
      err.status = res.status;
      throw err;
    }
  }

  // Hits an authenticated endpoint so a stale/invalid saved token is caught
  // here and sent back to the login screen, instead of silently proceeding
  // into a half-logged-in app that breaks on the first real request.
  // Bounded, so an unreachable server (e.g. Tailscale down) fails fast
  // instead of hanging on the OS's TCP timeout while the splash is up.
  async ping(timeoutMs = 6000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('Server did not respond in time.');
        err.isNetworkError = true;
        reject(err);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this._get('/Users/Me'), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async getMusicLibraries() {
    const data = await this._get(`/Users/${this.userId}/Views`);
    return (data.Items || []).filter((item) => item.CollectionType === 'music');
  }

  async getAllSongs(parentId) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      ParentId: parentId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'Album,SortName',
      SortOrder: 'Ascending',
      Fields: 'PrimaryImageAspectRatio,AlbumArtist,ArtistItems,UserData,Genres,NormalizationGain'
    });
    return data.Items || [];
  }

  // Small, server-sorted queries for the home page, so it doesn't have to
  // wait for the whole library (getAllSongs) just to show a dozen cards.
  async getPlayedSongs(parentId, sortBy, limit) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      ParentId: parentId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      Filters: 'IsPlayed',
      SortBy: sortBy,
      SortOrder: 'Descending',
      Limit: limit,
      Fields: 'PrimaryImageAspectRatio,AlbumArtist,ArtistItems,UserData,Genres,NormalizationGain'
    });
    return data.Items || [];
  }

  async getLatestAlbums(parentId, limit) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      ParentId: parentId,
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: 'DateCreated,SortName',
      SortOrder: 'Descending',
      Limit: limit,
      Fields: 'PrimaryImageAspectRatio,AlbumArtist'
    });
    return data.Items || [];
  }

  async getAlbums(parentId) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      ParentId: parentId,
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
      Fields: 'PrimaryImageAspectRatio,AlbumArtist'
    });
    return data.Items || [];
  }

  async getAlbumsByArtist(artistId) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      ArtistIds: artistId,
      IncludeItemTypes: 'MusicAlbum',
      Recursive: true,
      SortBy: 'PremiereDate,SortName',
      SortOrder: 'Ascending',
      Fields: 'PrimaryImageAspectRatio,AlbumArtist'
    });
    return data.Items || [];
  }

  async getSongsByArtist(artistId) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      ArtistIds: artistId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'Album,SortName',
      SortOrder: 'Ascending',
      Fields: 'PrimaryImageAspectRatio,AlbumArtist,ArtistItems,UserData,Genres,NormalizationGain'
    });
    return data.Items || [];
  }

  async getAlbumTracks(albumId) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      ParentId: albumId,
      IncludeItemTypes: 'Audio',
      SortBy: 'ParentIndexNumber,IndexNumber',
      SortOrder: 'Ascending',
      Fields: 'ArtistItems,UserData,Genres,NormalizationGain'
    });
    return data.Items || [];
  }

  async getArtists(parentId) {
    const data = await this._get(`/Artists`, {
      ParentId: parentId,
      Recursive: true,
      SortBy: 'SortName',
      Fields: 'PrimaryImageAspectRatio'
    });
    const items = data.Items || [];
    // Jellyfin can list the same artist once per library section it appears in —
    // collapse those into a single card by normalized name.
    const seen = new Map();
    for (const item of items) {
      const key = (item.Name || '').trim().toLowerCase();
      if (!seen.has(key)) seen.set(key, item);
    }
    return [...seen.values()];
  }

  async getPlaylists() {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      IncludeItemTypes: 'Playlist',
      Recursive: true,
      SortBy: 'SortName',
      Fields: 'PrimaryImageAspectRatio'
    });
    return data.Items || [];
  }

  // Lyrics the server itself has for a track (.lrc files / embedded tags,
  // Jellyfin 10.9+). null when the track has none (404).
  async getLyrics(itemId) {
    try {
      return await this._get(`/Audio/${itemId}/Lyrics`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async getItem(itemId) {
    return this._get(`/Users/${this.userId}/Items/${itemId}`);
  }

  async getPlaylistItems(playlistId) {
    const data = await this._get(`/Playlists/${playlistId}/Items`, {
      UserId: this.userId,
      Fields: 'ArtistItems,UserData,Genres,NormalizationGain'
    });
    return data.Items || [];
  }

  async createPlaylist(name) {
    const res = await fetch(`${this.serverUrl}/Playlists`, {
      method: 'POST',
      headers: this._headers(),
      // Public defaults to true server-side when omitted — playlists made
      // here are personal by default, not shared with every other account
      // on the server.
      body: JSON.stringify({ Name: name, UserId: this.userId, MediaType: 'Audio', Ids: [], Public: false })
    });
    if (!res.ok) throw new Error(`Could not create playlist (${res.status}).`);
    return res.json();
  }

  async addToPlaylist(playlistId, itemId) {
    const params = new URLSearchParams({ Ids: itemId, UserId: this.userId });
    const res = await fetch(`${this.serverUrl}/Playlists/${playlistId}/Items?${params.toString()}`, {
      method: 'POST',
      headers: this._headers()
    });
    if (!res.ok) throw new Error(`Could not add song to playlist (${res.status}).`);
  }

  // entryId is the playlist-entry id (PlaylistItemId from getPlaylistItems),
  // not the underlying song's own Id — needed so removing one occurrence of
  // a song that appears twice in the same playlist removes only that one.
  async removeFromPlaylist(playlistId, entryId) {
    const params = new URLSearchParams({ entryIds: entryId });
    const res = await fetch(`${this.serverUrl}/Playlists/${playlistId}/Items?${params.toString()}`, {
      method: 'DELETE',
      headers: this._headers()
    });
    if (!res.ok) throw new Error(`Could not remove song from playlist (${res.status}).`);
  }

  async uploadPlaylistImage(playlistId, file) {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const res = await fetch(`${this.serverUrl}/Items/${playlistId}/Images/Primary`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'image/jpeg',
        'X-Emby-Authorization': authHeader(this.accessToken),
        'X-Emby-Token': this.accessToken
      },
      body: base64
    });
    if (!res.ok) throw new Error(`Could not upload image (${res.status}).`);
  }

  async getLikedSongs() {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      Filters: 'IsFavorite',
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'SortName',
      Fields: 'PrimaryImageAspectRatio,ArtistItems,UserData,Genres,NormalizationGain'
    });
    return data.Items || [];
  }

  async likeItem(itemId) {
    const res = await fetch(`${this.serverUrl}/Users/${this.userId}/FavoriteItems/${itemId}`, {
      method: 'POST',
      headers: this._headers()
    });
    if (!res.ok) throw new Error(`Could not like song (${res.status}).`);
  }

  // Marks an item played server-side (increments UserData.PlayCount, bumps
  // LastPlayedDate) — the standard Jellyfin endpoint real clients call on
  // finishing a track. Since UserData travels with the account, not the
  // device, this is what makes play counts/stats follow the user across
  // devices instead of living in this one browser's local storage.
  async markPlayed(itemId) {
    const res = await fetch(`${this.serverUrl}/Users/${this.userId}/PlayedItems/${itemId}`, {
      method: 'POST',
      headers: this._headers()
    });
    if (!res.ok) throw new Error(`Could not mark item played (${res.status}).`);
    return res.json();
  }

  async unlikeItem(itemId) {
    const res = await fetch(`${this.serverUrl}/Users/${this.userId}/FavoriteItems/${itemId}`, {
      method: 'DELETE',
      headers: this._headers()
    });
    if (!res.ok) throw new Error(`Could not unlike song (${res.status}).`);
  }

  async getMusicGenres() {
    const data = await this._get(`/MusicGenres`, {
      UserId: this.userId,
      SortBy: 'SortName',
      Fields: 'PrimaryImageAspectRatio'
    });
    return data.Items || [];
  }

  async getSongsByGenre(genreId) {
    const data = await this._get(`/Users/${this.userId}/Items`, {
      GenreIds: genreId,
      IncludeItemTypes: 'Audio',
      Recursive: true,
      SortBy: 'Album,SortName',
      Fields: 'PrimaryImageAspectRatio,AlbumArtist,ArtistItems,UserData,Genres,NormalizationGain'
    });
    return data.Items || [];
  }

  async search(term) {
    // MusicArtist entities aren't reachable through the generic recursive
    // Items search the way songs/albums/playlists are — they need /Artists.
    const [itemsData, artistsData] = await Promise.all([
      this._get(`/Users/${this.userId}/Items`, {
        SearchTerm: term,
        IncludeItemTypes: 'Audio,MusicAlbum,Playlist',
        Recursive: true,
        Limit: 30,
        Fields: 'PrimaryImageAspectRatio,UserData'
      }),
      this._get(`/Artists`, {
        SearchTerm: term,
        Recursive: true,
        Limit: 20,
        Fields: 'PrimaryImageAspectRatio'
      })
    ]);
    return [...dedupeCollabArtists(artistsData.Items || []), ...(itemsData.Items || [])];
  }

  // ---------- Connect (Sessions API remote control) ----------

  get deviceId() {
    return DEVICE_ID;
  }

  wsUrl() {
    const wsBase = this.serverUrl.replace(/^http/, 'ws');
    const params = new URLSearchParams({ api_key: this.accessToken, deviceId: DEVICE_ID });
    return `${wsBase}/socket?${params.toString()}`;
  }

  // Tells the server this session can be remote-controlled — without this,
  // Jellyfin doesn't consider the session controllable at all, so it's
  // excluded from *every* device's "sessions I can control" query,
  // regardless of what's playing. Real Jellyfin clients call this once
  // right after authenticating; we do the same at Connect startup.
  async registerCapabilities() {
    const res = await fetch(`${this.serverUrl}/Sessions/Capabilities/Full`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        PlayableMediaTypes: ['Audio'],
        SupportedCommands: [
          'VolumeUp', 'VolumeDown', 'Mute', 'Unmute', 'ToggleMute', 'SetVolume',
          'Play', 'Playstate', 'PlayNext', 'PlayMediaSource',
          'SetRepeatMode', 'SetShuffleQueue', 'DisplayMessage'
        ],
        SupportsMediaControl: true,
        SupportsPersistentIdentifier: true
      })
    });
    if (!res.ok) throw new Error(`Could not register session capabilities (${res.status}).`);
  }

  // Sessions this user is allowed to remote-control, excluding this device's
  // own session — that's the actual device list a "Connect" picker shows.
  async getSessions() {
    const data = await this._get('/Sessions', { ControllableByUserId: this.userId });
    // ControllableByUserId returns every session this account can control —
    // including plain jellyfin-web browser tabs and other official clients,
    // not just Triptych. Device handoff only makes sense between Triptych
    // instances, so narrow it to that.
    return (data || []).filter((s) => s.DeviceId !== DEVICE_ID && (s.Client === CLIENT_NAME || s.Client === LEGACY_CLIENT_NAME));
  }

  async sendPlayCommand(sessionId, itemIds, startPositionTicks = 0) {
    const params = new URLSearchParams({
      ItemIds: Array.isArray(itemIds) ? itemIds.join(',') : itemIds,
      StartPositionTicks: String(Math.round(startPositionTicks)),
      PlayCommand: 'PlayNow'
    });
    await this._fetchOk(
      `${this.serverUrl}/Sessions/${sessionId}/Playing?${params.toString()}`,
      { method: 'POST', headers: this._headers() },
      'Could not start playback on that device'
    );
  }

  // command: one of Jellyfin's PlaystateCommand values — Stop, Pause,
  // Unpause, NextTrack, PreviousTrack, Seek (needs SeekPositionTicks).
  async sendPlaystateCommand(sessionId, command, extraParams = {}) {
    const qs = new URLSearchParams(extraParams).toString();
    await this._fetchOk(
      `${this.serverUrl}/Sessions/${sessionId}/Playing/${command}${qs ? `?${qs}` : ''}`,
      { method: 'POST', headers: this._headers() },
      'Could not send command'
    );
  }

  // Non-playstate commands (volume, mute) — name: a GeneralCommandType like
  // 'SetVolume' (Arguments: { Volume: '50' }), 'Mute', 'Unmute'.
  async sendGeneralCommand(sessionId, name, args = {}) {
    await this._fetchOk(
      `${this.serverUrl}/Sessions/${sessionId}/Command`,
      { method: 'POST', headers: this._headers(), body: JSON.stringify({ Name: name, Arguments: args }) },
      'Could not send command'
    );
  }

  // Self-reporting so this device shows up as "Now Playing" and is
  // controllable to other Jellyfin clients — the counterpart to
  // getSessions()/sendPlayCommand() on the controlling side. Best-effort:
  // failures here shouldn't interrupt local playback, so callers swallow errors.
  async reportPlaybackStart(payload) {
    const res = await fetch(`${this.serverUrl}/Sessions/Playing`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Could not report playback start (${res.status}).`);
  }

  async reportPlaybackProgress(payload) {
    const res = await fetch(`${this.serverUrl}/Sessions/Playing/Progress`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Could not report playback progress (${res.status}).`);
  }

  async reportPlaybackStopped(payload) {
    const res = await fetch(`${this.serverUrl}/Sessions/Playing/Stopped`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Could not report playback stop (${res.status}).`);
  }

  // Cross-device settings sync (theme, EQ, loudness boost, etc. — see
  // settings.js) rides on Jellyfin's own DisplayPreferences API, the same
  // mechanism real Jellyfin clients use to persist their own per-user UI
  // state server-side — no custom backend needed, and it follows the
  // account rather than the device. Scoped to a distinct id+client pair so
  // this never collides with preferences any other Jellyfin client
  // (including the official web client) might store under its own name.
  // Listening logs (see listening.js): one entry per device in a separate
  // DisplayPreferences record, so devices never overwrite each other.
  async _getPrefs(id, client) {
    try {
      const data = await this._get(`/DisplayPreferences/${id}`, { userId: this.userId, client });
      return data?.CustomPrefs || {};
    } catch (err) {
      return {};
    }
  }

  async getListeningLogs() {
    // Older devices may still write the legacy record; a device's entry in
    // the new record wins over its legacy one.
    const [legacy, current] = await Promise.all([
      this._getPrefs(LEGACY_PREFS.listening, LEGACY_CLIENT_NAME),
      this._getPrefs(PREFS.listening, CLIENT_NAME)
    ]);
    const logs = {};
    for (const [key, raw] of Object.entries({ ...legacy, ...current })) {
      if (!key.startsWith('log_')) continue;
      try { logs[key.slice(4)] = JSON.parse(raw); } catch (err) { /* skip a corrupt entry */ }
    }
    return logs;
  }

  async saveListeningLog(log) {
    const params = new URLSearchParams({ userId: this.userId, client: CLIENT_NAME });
    // Read-modify-write so the other devices' entries are kept.
    const prefs = { ...(await this._getPrefs(PREFS.listening, CLIENT_NAME)) };
    prefs[`log_${DEVICE_ID}`] = JSON.stringify(log);
    const res = await fetch(`${this.serverUrl}/DisplayPreferences/${PREFS.listening}?${params.toString()}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ Id: PREFS.listening, Client: CLIENT_NAME, CustomPrefs: prefs }),
      keepalive: true
    });
    if (!res.ok) throw new Error(`Could not sync listening time (${res.status}).`);
  }

  get deviceId() {
    return DEVICE_ID;
  }

  // Albums/artists Jellyfin considers similar to the given item.
  async getSimilarItems(itemId, limit = 12) {
    const data = await this._get(`/Items/${itemId}/Similar`, {
      UserId: this.userId,
      Limit: limit,
      Fields: 'PrimaryImageAspectRatio,AlbumArtist'
    });
    return data.Items || [];
  }

  async getSyncedSettings() {
    let raw = (await this._getPrefs(PREFS.settings, CLIENT_NAME)).settings;
    if (!raw) raw = (await this._getPrefs(LEGACY_PREFS.settings, LEGACY_CLIENT_NAME)).settings;
    try {
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  async saveSyncedSettings(settings) {
    const params = new URLSearchParams({ userId: this.userId, client: CLIENT_NAME });
    const res = await fetch(`${this.serverUrl}/DisplayPreferences/${PREFS.settings}?${params.toString()}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        Id: PREFS.settings,
        Client: CLIENT_NAME,
        CustomPrefs: { settings: JSON.stringify(settings) }
      })
    });
    if (!res.ok) throw new Error(`Could not sync settings (${res.status}).`);
  }

  imageUrl(item, type = 'Primary', maxSize = 500) {
    const tag = item.ImageTags && item.ImageTags[type];
    const id = tag ? item.Id : item.AlbumId; // fall back to album art for tracks without their own art
    if (!tag && !item.AlbumId) return null;
    const params = new URLSearchParams({ maxWidth: maxSize, maxHeight: maxSize, quality: 90 });
    if (tag) params.set('tag', tag);
    return `${this.serverUrl}/Items/${id}/Images/${type}?${params.toString()}`;
  }

  // Backdrops live in their own BackdropImageTags array rather than in
  // ImageTags, so they need a separate lookup from imageUrl().
  backdropUrl(item, maxWidth = 1920) {
    const tag = item.BackdropImageTags && item.BackdropImageTags[0];
    if (!tag) return null;
    const params = new URLSearchParams({ maxWidth, quality: 90, tag });
    return `${this.serverUrl}/Items/${item.Id}/Images/Backdrop/0?${params.toString()}`;
  }

  // bitrateKbps: omit (or 0) for direct play at source quality; otherwise the
  // server transcodes down to that ceiling — useful on slow/metered connections.
  streamUrl(item, bitrateKbps = 0) {
    if (!bitrateKbps) {
      const params = new URLSearchParams({
        static: 'true',
        api_key: this.accessToken,
        deviceId: DEVICE_ID
      });
      return `${this.serverUrl}/Audio/${item.Id}/stream?${params.toString()}`;
    }
    const params = new URLSearchParams({
      audioCodec: 'mp3',
      audioBitRate: String(bitrateKbps * 1000),
      api_key: this.accessToken,
      deviceId: DEVICE_ID
    });
    return `${this.serverUrl}/Audio/${item.Id}/stream.mp3?${params.toString()}`;
  }
}
