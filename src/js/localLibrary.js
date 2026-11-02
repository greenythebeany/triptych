// "Music on this device" mode: the same interface as JellyfinClient
// (jellyfin.js), backed by audio files scanned on this device instead of a
// server. Tracks, albums, artists and genres are built from the scan in the
// same shape Jellyfin returns them, so the rest of the app doesn't need to
// know which one it's talking to. Things a server would normally keep for
// the account (likes, play counts, playlists) live in local storage here.
// The scan, the files and the covers come from a platform bridge (below):
// the Electron main process (local-library.js) on desktop, the native
// LocalMusicPlugin.java (MediaStore) on Android.

const LIKES_KEY = 'triptych:local:likes';
const PLAYS_KEY = 'triptych:local:plays';
const PLAYLISTS_KEY = 'triptych:local:playlists';
const DEVICE_ID_KEY = 'triptych:deviceId';
const TICKS_PER_SECOND = 1e7;

const ANDROID_ENABLED_KEY = 'triptych:local:enabled';

// Desktop: folders the user picks, scanned by the main process.
function desktopBridge(api) {
  return {
    usesFolders: true,
    isEnabled: () => true,
    async enable() { return true; },
    disable() {},
    getTracks: () => api.getTracks(),
    scan: () => api.scan(),
    onScanProgress: (cb) => api.onScanProgress(cb),
    getLyrics: (id) => api.getLyrics(id),
    getFolders: () => api.getFolders(),
    setFolders: (folders) => api.setFolders(folders),
    pickFolders: () => api.pickFolders(),
    trackUrl: (id) => `tlocal://track/${id}`,
    coverUrl: (tag) => `tlocal://cover/${tag}`
  };
}

// Android: the phone's whole music library (MediaStore), once the user
// turns it on and grants the permission. Files and covers are served by the
// plugin on the app's own origin (see LocalMusicPlugin.java).
function androidBridge(plugin) {
  const enabled = () => {
    try { return localStorage.getItem(ANDROID_ENABLED_KEY) === '1'; } catch (err) { return false; }
  };
  return {
    usesFolders: false,
    isEnabled: enabled,
    // false when the permission was refused.
    async enable() {
      const { granted } = await plugin.requestAccess();
      if (granted) {
        try { localStorage.setItem(ANDROID_ENABLED_KEY, '1'); } catch (err) { /* stays off */ }
      }
      return granted;
    },
    disable() {
      try { localStorage.removeItem(ANDROID_ENABLED_KEY); } catch (err) { /* already off */ }
    },
    async getTracks() {
      if (!enabled()) return [];
      try {
        return (await plugin.getTracks()).tracks || [];
      } catch (err) {
        // Permission taken back in the system settings: an empty library.
        if (err?.code === 'permission') return [];
        throw err;
      }
    },
    // The list is read fresh from MediaStore by getTracks(); nothing to do first.
    async scan() {},
    onScanProgress(cb) {
      const handle = plugin.addListener('scanProgress', cb);
      return () => { Promise.resolve(handle).then((h) => h.remove()).catch(() => {}); };
    },
    async getLyrics() { return null; },
    async getFolders() { return []; },
    async setFolders() { return []; },
    async pickFolders() { return []; },
    trackUrl: (id) => `${location.origin}/_triptych_local_/track/${id}`,
    coverUrl: (tag) => `${location.origin}/_triptych_local_/cover/${tag}`
  };
}

let bridgeCache;
function localBridge() {
  if (bridgeCache === undefined) {
    const plugin = window.Capacitor?.getPlatform?.() === 'android' ? window.Capacitor?.Plugins?.TriptychLocalMusic : null;
    bridgeCache = window.api?.local ? desktopBridge(window.api.local) : plugin ? androidBridge(plugin) : null;
  }
  return bridgeCache;
}

export const isLocalLibrarySupported = () => !!localBridge();
// Whether "Music on this device" is switched on here (always on desktop,
// where it's empty until folders are picked; opt-in on Android).
export const isLocalLibraryEnabled = () => !!localBridge()?.isEnabled();
// Whether this platform picks folders (desktop) or reads the whole device (Android).
export const localLibraryUsesFolders = () => !!localBridge()?.usesFolders;
// Tracks and covers served by this app (local songs), as opposed to remote URLs.
export const isLocalMediaUrl = (url) => typeof url === 'string' && (url.startsWith('tlocal:') || url.includes('/_triptych_local_/'));

// Local ids start with a source prefix containing a non-hex letter (lt = track,
// al = album, ar = artist, ge = genre, pl = playlist), so they can never clash
// with Jellyfin's all-hex ids.
export const isLocalItemId = (id) => typeof id === 'string' && /^(lt|al|ar|ge|pl)/.test(id);

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage full or blocked: the change just won't survive a restart.
  }
}

// Stable short ids for albums/artists/genres, derived from their names.
function nameId(prefix, value) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${prefix}${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

const fold = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const byName = (a, b) => (a.Name || '').localeCompare(b.Name || '', undefined, { sensitivity: 'base', numeric: true });

// [mm:ss.xx] lines -> Jellyfin's lyrics shape ({ Lyrics: [{ Text, Start }] },
// Start in ticks), which is what lyrics.js reads from the server.
function lrcToJellyfin(text) {
  const lines = [];
  let synced = false;
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (stamps.length) {
      synced = true;
      for (const m of stamps) {
        const seconds = Number(m[1]) * 60 + Number(m[2].replace(':', '.'));
        lines.push({ Text: body, Start: Math.round(seconds * TICKS_PER_SECOND) });
      }
    } else if (!/^\[[a-z]+:/i.test(raw)) {
      lines.push({ Text: raw.trim() });
    }
  }
  if (synced) return lines.filter((l) => l.Start != null).sort((a, b) => a.Start - b.Start);
  while (lines.length && !lines[lines.length - 1].Text) lines.pop();
  return lines;
}

export class LocalLibraryClient {
  constructor() {
    this.isLocal = true;
    this.serverUrl = null;
    this.userId = 'local';
    this._build([]);
  }

  // Reads the last scan from the main process. Call scan() to refresh it.
  async load() {
    this._build(await localBridge().getTracks());
    return this;
  }

  async scan(onProgress) {
    const off = onProgress ? localBridge().onScanProgress(onProgress) : null;
    try {
      await localBridge().scan();
      // Inside the try: on Android the progress events come while this runs.
      this._build(await localBridge().getTracks());
    } finally {
      off?.();
    }
    return this;
  }

  getFolders() { return localBridge().getFolders(); }
  setFolders(folders) { return localBridge().setFolders(folders); }
  pickFolders() { return localBridge().pickFolders(); }
  enable() { return localBridge().enable(); }
  disable() { localBridge().disable(); }
  get trackCount() { return this._tracks.length; }
  get albumCount() { return this._albums.length; }

  _build(raw) {
    const likes = new Set(readJson(LIKES_KEY, []));
    const plays = readJson(PLAYS_KEY, {});
    const artists = new Map();
    const albums = new Map();
    const genres = new Map();
    const artistRef = (name) => {
      const key = fold(name);
      let artist = artists.get(key);
      if (!artist) {
        artist = { Id: nameId('ar', key), Name: name, Type: 'MusicArtist', ImageTags: {}, _latest: 0 };
        artists.set(key, artist);
      }
      return artist;
    };

    this._tracks = raw.map((tr) => {
      const artistNames = tr.artists?.length ? tr.artists : [tr.albumArtist || 'Unknown Artist'];
      const albumArtist = tr.albumArtist || artistNames[0];
      const albumName = tr.album || 'Unknown Album';
      const albumKey = `${fold(albumArtist)}\u0000${fold(albumName)}`;
      const albumId = nameId('al', albumKey);
      const artistItems = artistNames.map((n) => artistRef(n)).map((a) => ({ Id: a.Id, Name: a.Name }));
      const albumArtistRef = artistRef(albumArtist);
      const genreItems = (tr.genres || []).map((g) => {
        const key = fold(g);
        if (!genres.has(key)) genres.set(key, { Id: nameId('ge', key), Name: g, Type: 'MusicGenre' });
        return { Id: genres.get(key).Id, Name: genres.get(key).Name };
      });
      const play = plays[tr.id];
      const track = {
        Id: tr.id,
        Type: 'Audio',
        MediaType: 'Audio',
        Name: tr.title,
        Album: albumName,
        AlbumId: albumId,
        AlbumArtist: albumArtist,
        AlbumArtists: [{ Id: albumArtistRef.Id, Name: albumArtistRef.Name }],
        Artists: artistNames,
        ArtistItems: artistItems,
        IndexNumber: tr.track || undefined,
        ParentIndexNumber: tr.disc || undefined,
        ProductionYear: tr.year || undefined,
        PremiereDate: tr.year ? `${tr.year}-01-01T00:00:00.0000000Z` : undefined,
        DateCreated: new Date(tr.addedMs || 0).toISOString(),
        RunTimeTicks: Math.round((tr.duration || 0) * TICKS_PER_SECOND),
        Genres: genreItems.map((g) => g.Name),
        GenreItems: genreItems,
        NormalizationGain: tr.gain ?? undefined,
        ImageTags: tr.cover ? { Primary: tr.cover } : {},
        UserData: {
          IsFavorite: likes.has(tr.id),
          PlayCount: play?.c || 0,
          Played: !!play?.c,
          LastPlayedDate: play?.d || undefined
        }
      };

      let album = albums.get(albumKey);
      if (!album) {
        album = {
          Id: albumId,
          Type: 'MusicAlbum',
          Name: albumName,
          AlbumArtist: albumArtist,
          AlbumArtists: [{ Id: albumArtistRef.Id, Name: albumArtistRef.Name }],
          ArtistItems: [{ Id: albumArtistRef.Id, Name: albumArtistRef.Name }],
          ImageTags: {},
          ChildCount: 0,
          RunTimeTicks: 0,
          _added: 0,
          _artistIds: new Set(),
          _tracks: []
        };
        albums.set(albumKey, album);
      }
      album.ChildCount++;
      album.RunTimeTicks += track.RunTimeTicks;
      album._added = Math.max(album._added, tr.addedMs || 0);
      if (tr.year && !album.ProductionYear) {
        album.ProductionYear = tr.year;
        album.PremiereDate = track.PremiereDate;
      }
      if (tr.cover && !album.ImageTags.Primary) album.ImageTags.Primary = tr.cover;
      if (!album.Genres && track.Genres.length) album.Genres = track.Genres;
      album._artistIds.add(albumArtistRef.Id);
      artistItems.forEach((a) => album._artistIds.add(a.Id));
      album._tracks.push(track);
      return track;
    });

    const artistsById = new Map([...artists.values()].map((a) => [a.Id, a]));
    for (const album of albums.values()) {
      album.DateCreated = new Date(album._added).toISOString();
      album._tracks.sort((a, b) => (a.ParentIndexNumber || 1) - (b.ParentIndexNumber || 1) || (a.IndexNumber || 0) - (b.IndexNumber || 0) || byName(a, b));
      // No artist photos on disk: an artist's newest album cover stands in.
      if (album.ImageTags.Primary) {
        for (const id of album._artistIds) {
          const artist = artistsById.get(id);
          if (artist && (album.ProductionYear || 0) >= artist._latest) {
            artist._latest = album.ProductionYear || 0;
            artist.ImageTags = { Primary: album.ImageTags.Primary };
          }
        }
      }
    }

    this._albums = [...albums.values()];
    this._artists = [...artists.values()];
    this._genres = [...genres.values()].sort(byName);
    this._byId = new Map();
    for (const list of [this._tracks, this._albums, this._artists, this._genres]) {
      list.forEach((item) => this._byId.set(item.Id, item));
    }
  }

  // ---------- Session / account (nothing to sign in to) ----------

  async ping() { return {}; }
  avatarUrl() { return null; }
  getAuthHeaders() { return {}; }

  get deviceId() {
    try { return localStorage.getItem(DEVICE_ID_KEY) || 'local'; } catch (err) { return 'local'; }
  }

  async getMusicLibraries() {
    return [{ Id: 'local', Name: 'Local', CollectionType: 'music' }];
  }

  // ---------- Library ----------

  async getAllSongs() {
    return this._albums.slice().sort(byName).flatMap((al) => al._tracks);
  }

  async getPlayedSongs(_parentId, sortBy, limit) {
    const played = this._tracks.filter((tr) => tr.UserData.PlayCount > 0);
    const key = sortBy === 'PlayCount'
      ? (tr) => tr.UserData.PlayCount
      : (tr) => Date.parse(tr.UserData.LastPlayedDate || 0) || 0;
    return played.sort((a, b) => key(b) - key(a)).slice(0, limit);
  }

  async getLatestAlbums(_parentId, limit) {
    return this._albums.slice().sort((a, b) => b._added - a._added || byName(a, b)).slice(0, limit);
  }

  async getAlbums() {
    return this._albums.slice().sort(byName);
  }

  async getAlbumsByArtist(artistId) {
    return this._albums
      .filter((al) => al._artistIds.has(artistId))
      .sort((a, b) => (a.ProductionYear || 0) - (b.ProductionYear || 0) || byName(a, b));
  }

  async getSongsByArtist(artistId) {
    const albums = await this.getAlbums();
    return albums.flatMap((al) => al._tracks).filter((tr) =>
      tr.ArtistItems.some((a) => a.Id === artistId) || tr.AlbumArtists.some((a) => a.Id === artistId));
  }

  async getAlbumTracks(albumId) {
    return (this._byId.get(albumId)?._tracks || []).slice();
  }

  async getArtists() {
    return this._artists.slice().sort(byName);
  }

  async getMusicGenres() {
    return this._genres.slice();
  }

  async getSongsByGenre(genreId) {
    return this._tracks.filter((tr) => tr.GenreItems.some((g) => g.Id === genreId));
  }

  async getItem(itemId) {
    const item = this._byId.get(itemId) || this._playlists().find((pl) => pl.Id === itemId);
    if (!item) {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
    return item;
  }

  // Albums sharing a genre with this one, by other artists.
  async getSimilarItems(itemId, limit = 12) {
    const album = this._byId.get(itemId);
    const genres = new Set((album?.Genres || []).map(fold));
    if (!genres.size) return [];
    return this._albums
      .filter((al) => al.Id !== itemId && al.AlbumArtist !== album.AlbumArtist && (al.Genres || []).some((g) => genres.has(fold(g))))
      .sort(() => Math.random() - 0.5)
      .slice(0, limit);
  }

  async search(term) {
    const q = fold(term);
    if (!q) return [];
    const hit = (s) => fold(s).includes(q);
    const artists = this._artists.filter((a) => hit(a.Name)).slice(0, 20);
    const songs = this._tracks.filter((tr) => hit(tr.Name)).slice(0, 30);
    const albums = this._albums.filter((al) => hit(al.Name)).slice(0, 30);
    const playlists = this._playlists().filter((pl) => hit(pl.Name));
    return [...artists, ...[...songs, ...albums, ...playlists].slice(0, 30)];
  }

  async getLyrics(itemId) {
    const found = await localBridge().getLyrics(itemId);
    if (!found) return null;
    const lines = found.synced
      ? found.synced.map((l) => ({ Text: l.text, Start: Math.round(l.ms * 10000) }))
      : lrcToJellyfin(found.text || '');
    return lines.length ? { Lyrics: lines } : null;
  }

  // ---------- Likes and plays (kept on this device) ----------

  async getLikedSongs() {
    return this._tracks.filter((tr) => tr.UserData.IsFavorite).sort(byName);
  }

  _setLiked(itemId, liked) {
    const likes = new Set(readJson(LIKES_KEY, []));
    if (liked) likes.add(itemId);
    else likes.delete(itemId);
    writeJson(LIKES_KEY, [...likes]);
    const track = this._byId.get(itemId);
    if (track?.UserData) track.UserData.IsFavorite = liked;
  }

  async likeItem(itemId) { this._setLiked(itemId, true); }
  async unlikeItem(itemId) { this._setLiked(itemId, false); }

  async markPlayed(itemId) {
    const plays = readJson(PLAYS_KEY, {});
    const entry = { c: (plays[itemId]?.c || 0) + 1, d: new Date().toISOString() };
    plays[itemId] = entry;
    writeJson(PLAYS_KEY, plays);
    const track = this._byId.get(itemId);
    if (track?.UserData) Object.assign(track.UserData, { PlayCount: entry.c, Played: true, LastPlayedDate: entry.d });
    return track?.UserData || {};
  }

  // ---------- Playlists (kept on this device) ----------

  _playlistStore() {
    return readJson(PLAYLISTS_KEY, []);
  }

  _playlists() {
    return this._playlistStore().map((pl) => ({
      Id: pl.id,
      Name: pl.name,
      Type: 'Playlist',
      ChildCount: pl.items.length,
      ImageTags: pl.image ? { Primary: 'custom' } : {},
      _image: pl.image || null
    }));
  }

  _savePlaylists(list) {
    writeJson(PLAYLISTS_KEY, list);
  }

  async getPlaylists() {
    return this._playlists().sort(byName);
  }

  async getPlaylistItems(playlistId) {
    const pl = this._playlistStore().find((p) => p.id === playlistId);
    if (!pl) return [];
    return pl.items
      .map((entry) => {
        const track = this._byId.get(entry.trackId);
        return track ? { ...track, PlaylistItemId: entry.entryId } : null;
      })
      .filter(Boolean);
  }

  async createPlaylist(name) {
    const list = this._playlistStore();
    const id = `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    list.push({ id, name, items: [] });
    this._savePlaylists(list);
    return { Id: id };
  }

  async addToPlaylist(playlistId, itemId) {
    const list = this._playlistStore();
    const pl = list.find((p) => p.id === playlistId);
    if (!pl) throw new Error('Could not add song to playlist.');
    pl.items.push({ entryId: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, trackId: itemId });
    this._savePlaylists(list);
  }

  async removeFromPlaylist(playlistId, entryId) {
    const list = this._playlistStore();
    const pl = list.find((p) => p.id === playlistId);
    if (!pl) return;
    pl.items = pl.items.filter((e) => e.entryId !== entryId);
    this._savePlaylists(list);
  }

  // Stored as a small JPEG data URL next to the playlist.
  async uploadPlaylistImage(playlistId, file) {
    const bitmap = await createImageBitmap(file);
    const size = Math.min(400, Math.max(bitmap.width, bitmap.height));
    const scale = size / Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const list = this._playlistStore();
    const pl = list.find((p) => p.id === playlistId);
    if (!pl) throw new Error('Could not upload image.');
    pl.image = canvas.toDataURL('image/jpeg', 0.85);
    this._savePlaylists(list);
  }

  // ---------- Server-only features: harmless no-ops ----------

  async getListeningLogs() { return {}; }
  async saveListeningLog() {}
  async getSyncedSettings() { return null; }
  async saveSyncedSettings() {}
  async registerCapabilities() {}
  async getSessions() { return []; }
  async reportPlaybackStart() {}
  async reportPlaybackProgress() {}
  async reportPlaybackStopped() {}
  wsUrl() { return null; }

  // ---------- URLs ----------

  imageUrl(item, type = 'Primary') {
    if (type !== 'Primary' || !item) return null;
    if (item.Type === 'Playlist') {
      return item._image || this._playlists().find((pl) => pl.Id === item.Id)?._image || null;
    }
    const tag = item.ImageTags?.Primary || this._byId.get(item.AlbumId)?.ImageTags?.Primary || this._byId.get(item.Id)?.ImageTags?.Primary;
    return tag ? localBridge().coverUrl(tag) : null;
  }

  artistPhotoUrl(artistId) {
    return this.imageUrl(this._byId.get(artistId));
  }

  backdropUrl() { return null; }

  streamUrl(item) {
    return localBridge().trackUrl(item.Id);
  }
}

// Signed in to Jellyfin *and* using music on this device: one library made
// of both. Lists are merged; anything about a single item goes to whichever
// source it came from (see isLocalItemId); everything else (Connect, sync,
// downloads, the account) is the server's.
const byNameKey = (item) => fold(item.Name);

export class CombinedClient {
  constructor(server, local) {
    this.server = server;
    this.local = local;
    // Server artist/genre id -> the local one with the same name, so an
    // artist or genre page shows songs from both.
    this._aliases = new Map();
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop];
        const value = target.server[prop];
        return typeof value === 'function' ? value.bind(target.server) : value;
      }
    });
  }

  // Server unreachable: the music on this device still shows.
  _srv(promise) {
    return promise.catch((err) => {
      if (err?.isNetworkError) return [];
      throw err;
    });
  }

  async getMusicLibraries() {
    try {
      return await this.server.getMusicLibraries();
    } catch (err) {
      if (err?.isNetworkError && this.local.trackCount) return this.local.getMusicLibraries();
      throw err;
    }
  }

  _for(id) {
    return isLocalItemId(id) ? this.local : this.server;
  }

  // Server first; a local entry with the same name is folded into it.
  _mergeByName(serverItems, localItems) {
    const byKey = new Map(serverItems.map((item) => [byNameKey(item), item]));
    const extra = [];
    for (const item of localItems) {
      const match = byKey.get(byNameKey(item));
      if (match) this._aliases.set(match.Id, item.Id);
      else extra.push(item);
    }
    return [...serverItems, ...extra].sort(byName);
  }

  async _withAlias(id, fn) {
    const lists = [await fn(this._for(id), id)];
    const alias = this._aliases.get(id);
    if (alias) lists.push(await fn(this.local, alias));
    return lists.flat();
  }

  get trackCount() { return this.local.trackCount; }
  get albumCount() { return this.local.albumCount; }
  getFolders() { return this.local.getFolders(); }
  setFolders(folders) { return this.local.setFolders(folders); }
  pickFolders() { return this.local.pickFolders(); }
  async scan(onProgress) { await this.local.scan(onProgress); return this; }

  async getAllSongs(parentId) {
    const [a, b] = await Promise.all([this._srv(this.server.getAllSongs(parentId)), this.local.getAllSongs()]);
    return [...a, ...b];
  }

  async getPlayedSongs(parentId, sortBy, limit) {
    const [a, b] = await Promise.all([this._srv(this.server.getPlayedSongs(parentId, sortBy, limit)), this.local.getPlayedSongs(parentId, sortBy, limit)]);
    const key = sortBy === 'PlayCount'
      ? (tr) => tr.UserData?.PlayCount || 0
      : (tr) => Date.parse(tr.UserData?.LastPlayedDate || 0) || 0;
    return [...a, ...b].sort((x, y) => key(y) - key(x)).slice(0, limit);
  }

  async getLatestAlbums(parentId, limit) {
    const [a, b] = await Promise.all([this._srv(this.server.getLatestAlbums(parentId, limit)), this.local.getLatestAlbums(parentId, limit)]);
    const added = (al) => Date.parse(al.DateCreated || 0) || 0;
    return [...a, ...b].sort((x, y) => added(y) - added(x)).slice(0, limit);
  }

  async getAlbums(parentId) {
    const [a, b] = await Promise.all([this._srv(this.server.getAlbums(parentId)), this.local.getAlbums()]);
    return [...a, ...b].sort(byName);
  }

  async getArtists(parentId) {
    const [a, b] = await Promise.all([this._srv(this.server.getArtists(parentId)), this.local.getArtists()]);
    return this._mergeByName(a, b);
  }

  async getMusicGenres() {
    const [a, b] = await Promise.all([this._srv(this.server.getMusicGenres()), this.local.getMusicGenres()]);
    return this._mergeByName(a, b);
  }

  getAlbumsByArtist(artistId) { return this._withAlias(artistId, (src, id) => src.getAlbumsByArtist(id)); }
  getSongsByArtist(artistId) { return this._withAlias(artistId, (src, id) => src.getSongsByArtist(id)); }
  getSongsByGenre(genreId) { return this._withAlias(genreId, (src, id) => src.getSongsByGenre(id)); }

  async getLikedSongs() {
    const [a, b] = await Promise.all([this._srv(this.server.getLikedSongs()), this.local.getLikedSongs()]);
    return [...a, ...b];
  }

  async getPlaylists() {
    const [a, b] = await Promise.all([this._srv(this.server.getPlaylists()), this.local.getPlaylists()]);
    return [...a, ...b].sort(byName);
  }

  async search(term) {
    const [a, b] = await Promise.all([this._srv(this.server.search(term)), this.local.search(term)]);
    const isArtist = (item) => item.Type === 'MusicArtist';
    return [...this._mergeByName(a.filter(isArtist), b.filter(isArtist)), ...a.filter((i) => !isArtist(i)), ...b.filter((i) => !isArtist(i))];
  }

  getItem(id) { return this._for(id).getItem(id); }
  getAlbumTracks(id) { return this._for(id).getAlbumTracks(id); }
  getSimilarItems(id, limit) { return this._for(id).getSimilarItems(id, limit); }
  getLyrics(id) { return this._for(id).getLyrics(id); }
  likeItem(id) { return this._for(id).likeItem(id); }
  unlikeItem(id) { return this._for(id).unlikeItem(id); }
  markPlayed(id) { return this._for(id).markPlayed(id); }
  getPlaylistItems(id) { return this._for(id).getPlaylistItems(id); }
  removeFromPlaylist(id, entryId) { return this._for(id).removeFromPlaylist(id, entryId); }
  uploadPlaylistImage(id, file) { return this._for(id).uploadPlaylistImage(id, file); }

  // A server playlist can't hold a file that only exists on this device.
  async addToPlaylist(playlistId, itemId) {
    if (isLocalItemId(itemId) && !isLocalItemId(playlistId)) {
      const err = new Error('Songs on this device can only go into playlists on this device.');
      err.code = 'local_to_server_playlist';
      throw err;
    }
    return this._for(playlistId).addToPlaylist(playlistId, itemId);
  }

  imageUrl(item, type, maxSize) { return this._for(item?.Id).imageUrl(item, type, maxSize); }
  artistPhotoUrl(id, maxSize) { return this._for(id).artistPhotoUrl(id, maxSize); }
  backdropUrl(item, maxWidth) { return this._for(item?.Id).backdropUrl(item, maxWidth); }
  streamUrl(item, bitrateKbps) { return this._for(item?.Id).streamUrl(item, bitrateKbps); }
}
