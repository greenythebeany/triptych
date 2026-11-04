// Navidrome (and other OpenSubsonic/Subsonic servers): the same interface as
// JellyfinClient (jellyfin.js), talking to the Subsonic REST API instead.
// Responses are mapped into the shape Jellyfin returns, the same way
// localLibrary.js does it, so the rest of the app doesn't need to know which
// server it's signed in to. What Subsonic has no API for (settings sync,
// listening logs, Connect, playlist covers) degrades to what music-on-this-
// device mode does: kept on this device, or not there.

const API_VERSION = '1.16.1';
const CLIENT_NAME = 'Triptych';
const TICKS_PER_SECOND = 1e7;
const PAGE = 500;
const DEVICE_ID_KEY = 'triptych:deviceId';

// Subsonic error codes: 40 wrong credentials, 41 token auth not supported
// (LDAP-backed servers), 44 invalid API key, 70 not found.
const AUTH_ERRORS = new Set([40, 41, 44]);
const NOT_FOUND = 70;

// Subsonic token auth sends md5(password + salt), and Web Crypto has no MD5.
// Only run once, at sign-in: the token is what's kept, never the password.
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const words = new Array(((bytes.length + 8) >> 6) * 16 + 16).fill(0);
  bytes.forEach((b, i) => { words[i >> 2] |= b << ((i % 4) * 8); });
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  words[words.length - 2] = bytes.length * 8;
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let blk = 0; blk < words.length; blk += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      let f;
      let g;
      if (r === 0) { f = (b & c) | (~b & d); g = i; }
      else if (r === 1) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (r === 2) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const s = S[r * 4 + (i % 4)];
      const sum = (a + f + K[i] + words[blk + g]) | 0;
      [a, d, c] = [d, c, b];
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  return [a0, b0, c0, d0].map((w) => Array.from({ length: 4 }, (_, i) => ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const byName = (a, b) => (a.Name || '').localeCompare(b.Name || '', undefined, { sensitivity: 'base', numeric: true });
const byDiscTrack = (a, b) => (a.ParentIndexNumber || 1) - (b.ParentIndexNumber || 1) || (a.IndexNumber || 0) - (b.IndexNumber || 0);
const ref = (a) => ({ Id: a.id, Name: a.name });
const yearDate = (year) => (year ? `${year}-01-01T00:00:00.0000000Z` : undefined);
const genreNames = (x) => (x.genres?.length ? x.genres.map((g) => g.name) : x.genre ? [x.genre] : []);

function subsonicError(error) {
  const err = new Error(error?.message || 'Server request failed.');
  err.subsonicCode = error?.code;
  // Same statuses JellyfinClient errors carry, so tryRestoreSession's
  // 401 = sign in again / anything else = keep the session logic still holds.
  if (AUTH_ERRORS.has(error?.code)) err.status = 401;
  else if (error?.code === NOT_FOUND) err.status = 404;
  return err;
}

// Whether the URL is a Subsonic server: /rest/ping answers with a
// subsonic-response even without credentials (as an error), which a Jellyfin
// server never does. Bounded, so an unreachable URL falls through to the
// Jellyfin sign-in (and its error) quickly.
export async function isSubsonicServer(serverUrl, timeoutMs = 6000) {
  const base = serverUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/rest/ping.view?f=json&v=${API_VERSION}&c=${CLIENT_NAME}`, { cache: 'no-store', signal: ctrl.signal });
    if (!res.headers.get('content-type')?.includes('json')) return false;
    const data = await res.json();
    return !!data?.['subsonic-response'];
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class SubsonicClient {
  constructor({ serverUrl, username, salt, accessToken }) {
    this.isSubsonic = true;
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.username = username;
    this.userId = username;
    this.salt = salt;
    this.accessToken = accessToken;
    // id -> 'song' | 'album' | 'artist' | 'playlist', learnt from every
    // response, so getItem() asks the right endpoint first.
    this._kinds = new Map();
    this._songs = new Map();
    this._allSongs = null;
  }

  static async authenticate(serverUrl, username, password) {
    const base = serverUrl.replace(/\/+$/, '');
    const salt = randomSalt();
    const auth = { type: 'subsonic', serverUrl: base, username, userId: username, salt, accessToken: md5(password + salt) };
    try {
      await new SubsonicClient(auth).ping();
    } catch (err) {
      if (err.status === 401) {
        const e = new Error('Wrong username or password.');
        e.code = 'wrong_credentials';
        throw e;
      }
      throw err;
    }
    return auth;
  }

  _params(params = {}) {
    const qs = new URLSearchParams({ u: this.username, t: this.accessToken, s: this.salt, v: API_VERSION, c: CLIENT_NAME, f: 'json' });
    Object.entries(params).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else qs.set(k, v);
    });
    return qs;
  }

  _url(method, params) {
    return `${this.serverUrl}/rest/${method}.view?${this._params(params).toString()}`;
  }

  async _get(method, params) {
    let res;
    try {
      res = await fetch(this._url(method, params), { cache: 'no-store' });
    } catch (err) {
      const netErr = new Error(`Could not reach server: ${err.message}`);
      netErr.isNetworkError = true;
      throw netErr;
    }
    if (!res.ok) {
      const err = new Error(`Server request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = (await res.json())?.['subsonic-response'];
    if (!body) throw new Error('Not a Subsonic server.');
    if (body.status !== 'ok') throw subsonicError(body.error);
    return body;
  }

  // ---------- Mapping into Jellyfin's shapes ----------

  _song(s) {
    this._kinds.set(s.id, 'song');
    const artists = s.artists?.length ? s.artists : s.artistId ? [{ id: s.artistId, name: s.artist }] : [];
    const albumArtists = s.albumArtists?.length ? s.albumArtists : artists.slice(0, 1);
    const track = {
      Id: s.id,
      Type: 'Audio',
      MediaType: 'Audio',
      Name: s.title,
      Album: s.album,
      AlbumId: s.albumId,
      AlbumArtist: s.displayAlbumArtist || albumArtists[0]?.name || s.artist,
      AlbumArtists: albumArtists.map(ref),
      Artists: artists.length ? artists.map((a) => a.name) : [s.artist].filter(Boolean),
      ArtistItems: artists.map(ref),
      IndexNumber: s.track || undefined,
      ParentIndexNumber: s.discNumber || undefined,
      ProductionYear: s.year || undefined,
      PremiereDate: yearDate(s.year),
      DateCreated: s.created,
      RunTimeTicks: Math.round((s.duration || 0) * TICKS_PER_SECOND),
      Genres: genreNames(s),
      // ReplayGain track gain is dB to apply, like Jellyfin's NormalizationGain.
      NormalizationGain: s.replayGain?.trackGain ?? undefined,
      ImageTags: s.coverArt ? { Primary: s.coverArt } : {},
      UserData: {
        IsFavorite: !!s.starred,
        PlayCount: s.playCount || 0,
        Played: !!s.playCount,
        LastPlayedDate: s.played || undefined
      }
    };
    this._songs.set(s.id, track);
    return track;
  }

  _album(a) {
    this._kinds.set(a.id, 'album');
    const artists = a.artists?.length ? a.artists : a.artistId ? [{ id: a.artistId, name: a.artist }] : [];
    return {
      Id: a.id,
      Type: 'MusicAlbum',
      Name: a.name,
      AlbumArtist: a.displayArtist || a.artist,
      AlbumArtists: artists.map(ref),
      ArtistItems: artists.map(ref),
      ChildCount: a.songCount || 0,
      RunTimeTicks: Math.round((a.duration || 0) * TICKS_PER_SECOND),
      ProductionYear: a.year || undefined,
      PremiereDate: yearDate(a.year),
      DateCreated: a.created,
      Genres: genreNames(a),
      ImageTags: a.coverArt ? { Primary: a.coverArt } : {},
      UserData: { IsFavorite: !!a.starred, PlayCount: a.playCount || 0 }
    };
  }

  _artist(a) {
    this._kinds.set(a.id, 'artist');
    return {
      Id: a.id,
      Type: 'MusicArtist',
      Name: a.name,
      ChildCount: a.albumCount || 0,
      ImageTags: a.coverArt ? { Primary: a.coverArt } : {},
      UserData: { IsFavorite: !!a.starred }
    };
  }

  _playlist(p) {
    this._kinds.set(p.id, 'playlist');
    return {
      Id: p.id,
      Type: 'Playlist',
      Name: p.name,
      ChildCount: p.songCount || 0,
      RunTimeTicks: Math.round((p.duration || 0) * TICKS_PER_SECOND),
      ImageTags: p.coverArt ? { Primary: p.coverArt } : {}
    };
  }

  // ---------- Session / account ----------

  // Bounded like JellyfinClient.ping(), so an unreachable server fails fast.
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
      return await Promise.race([this._get('ping'), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  avatarUrl() { return null; }
  // Auth rides in every URL's query, so downloads need no headers.
  getAuthHeaders() { return {}; }

  get deviceId() {
    try { return localStorage.getItem(DEVICE_ID_KEY) || 'subsonic'; } catch (err) { return 'subsonic'; }
  }

  async getMusicLibraries() {
    const data = await this._get('getMusicFolders');
    const folders = data.musicFolders?.musicFolder || [];
    // The app browses the first library; with several, browsing them all
    // (no musicFolderId) matches what Navidrome's own UI shows by default.
    if (folders.length !== 1) return [{ Id: 'all', Name: 'Music', CollectionType: 'music' }];
    return [{ Id: String(folders[0].id), Name: folders[0].name, CollectionType: 'music' }];
  }

  _folder(parentId) {
    return parentId && parentId !== 'all' ? parentId : undefined;
  }

  // ---------- Library ----------

  async _paged(fetchPage) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await fetchPage(offset);
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  // An empty search3 query lists every song (OpenSubsonic, Navidrome).
  // Shared by getPlayedSongs and anything else asking at the same time, so
  // home doesn't page through the whole library twice on startup.
  getAllSongs(parentId) {
    const fresh = this._allSongs && Date.now() - this._allSongs.at < 30000 && this._allSongs.parentId === parentId;
    if (!fresh) {
      const promise = this._paged(async (offset) => {
        const data = await this._get('search3', {
          query: '', songCount: PAGE, songOffset: offset, artistCount: 0, albumCount: 0, musicFolderId: this._folder(parentId)
        });
        return (data.searchResult3?.song || []).map((s) => this._song(s));
      }).then((songs) => songs.sort((a, b) => (a.Album || '').localeCompare(b.Album || '') || byDiscTrack(a, b) || byName(a, b)));
      promise.catch(() => { this._allSongs = null; });
      this._allSongs = { promise, at: Date.now(), parentId };
    }
    return this._allSongs.promise;
  }

  // Subsonic has no song-level "recently/most played" list; derived from
  // every song's own played date and play count.
  async getPlayedSongs(parentId, sortBy, limit) {
    const songs = (await this.getAllSongs(parentId)).filter((s) => s.UserData.PlayCount > 0);
    const key = sortBy === 'PlayCount'
      ? (s) => s.UserData.PlayCount
      : (s) => Date.parse(s.UserData.LastPlayedDate || 0) || 0;
    return songs.sort((a, b) => key(b) - key(a)).slice(0, limit);
  }

  async _albumList(type, parentId, size, offset = 0) {
    const data = await this._get('getAlbumList2', { type, size, offset, musicFolderId: this._folder(parentId) });
    return (data.albumList2?.album || []).map((a) => this._album(a));
  }

  getLatestAlbums(parentId, limit) {
    return this._albumList('newest', parentId, limit);
  }

  getAlbums(parentId) {
    return this._paged((offset) => this._albumList('alphabeticalByName', parentId, PAGE, offset));
  }

  async _artistAlbums(artistId) {
    const data = await this._get('getArtist', { id: artistId });
    return (data.artist?.album || []).map((a) => this._album(a));
  }

  async getAlbumsByArtist(artistId) {
    const albums = await this._artistAlbums(artistId);
    return albums.sort((a, b) => (a.ProductionYear || 0) - (b.ProductionYear || 0) || byName(a, b));
  }

  async getSongsByArtist(artistId) {
    const albums = await this._artistAlbums(artistId);
    const lists = await Promise.all(albums.map((al) => this.getAlbumTracks(al.Id).catch(() => [])));
    return lists.flat();
  }

  async getAlbumTracks(albumId) {
    const data = await this._get('getAlbum', { id: albumId });
    if (data.album) this._album(data.album);
    return (data.album?.song || []).map((s) => this._song(s)).sort(byDiscTrack);
  }

  async getArtists(parentId) {
    const data = await this._get('getArtists', { musicFolderId: this._folder(parentId) });
    const artists = (data.artists?.index || []).flatMap((idx) => idx.artist || []);
    return artists.map((a) => this._artist(a)).sort(byName);
  }

  async getMusicGenres() {
    const data = await this._get('getGenres');
    return (data.genres?.genre || [])
      .filter((g) => g.value && g.songCount)
      .map((g) => ({ Id: g.value, Name: g.value, Type: 'MusicGenre', ChildCount: g.songCount }))
      .sort(byName);
  }

  // Subsonic genres have no ids; the name is the id.
  getSongsByGenre(genreId) {
    return this._paged(async (offset) => {
      const data = await this._get('getSongsByGenre', { genre: genreId, count: PAGE, offset });
      return (data.songsByGenre?.song || []).map((s) => this._song(s));
    });
  }

  async getItem(itemId) {
    const fetchers = {
      song: async () => this._song((await this._get('getSong', { id: itemId })).song),
      album: async () => this._album((await this._get('getAlbum', { id: itemId })).album),
      artist: async () => this._artist((await this._get('getArtist', { id: itemId })).artist),
      playlist: async () => this._playlist((await this._get('getPlaylist', { id: itemId })).playlist)
    };
    const known = this._kinds.get(itemId);
    const order = known ? [known, ...Object.keys(fetchers).filter((k) => k !== known)] : Object.keys(fetchers);
    let lastErr;
    for (const kind of order) {
      try {
        return await fetchers[kind]();
      } catch (err) {
        if (err.status !== 404) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  // Similar albums: Subsonic only knows similar artists (getArtistInfo2,
  // from Last.fm when the server has it set up), so their newest albums
  // stand in. Empty without Last.fm; home just shows fewer cards then.
  async getSimilarItems(itemId, limit = 12) {
    let artistId = itemId;
    if (this._kinds.get(itemId) !== 'artist') {
      const item = await this.getItem(itemId);
      artistId = item.Type === 'MusicArtist' ? item.Id : item.AlbumArtists?.[0]?.Id || item.ArtistItems?.[0]?.Id;
    }
    if (!artistId) return [];
    const data = await this._get('getArtistInfo2', { id: artistId, count: limit });
    const similar = (data.artistInfo2?.similarArtist || []).filter((a) => a.id).slice(0, limit);
    const albums = await Promise.all(similar.map((a) => this._artistAlbums(a.id).catch(() => [])));
    return albums
      .map((list) => list.sort((a, b) => (b.ProductionYear || 0) - (a.ProductionYear || 0))[0])
      .filter(Boolean);
  }

  async getInstantMix(itemId, limit = 60) {
    const data = await this._get('getSimilarSongs', { id: itemId, count: limit });
    return (data.similarSongs?.song || []).map((s) => this._song(s));
  }

  async search(term) {
    const [data, playlists] = await Promise.all([
      this._get('search3', { query: term, artistCount: 20, albumCount: 30, songCount: 30 }),
      this.getPlaylists().catch(() => [])
    ]);
    const res = data.searchResult3 || {};
    const q = term.trim().toLowerCase();
    return [
      ...(res.artist || []).map((a) => this._artist(a)),
      ...(res.song || []).map((s) => this._song(s)),
      ...(res.album || []).map((a) => this._album(a)),
      ...playlists.filter((pl) => (pl.Name || '').toLowerCase().includes(q))
    ];
  }

  // OpenSubsonic getLyricsBySongId (synced, from .lrc or tags); older
  // servers only have getLyrics by artist + title (plain text).
  async getLyrics(itemId) {
    try {
      const data = await this._get('getLyricsBySongId', { id: itemId });
      const list = data.lyricsList?.structuredLyrics || [];
      const best = list.find((l) => l.synced) || list[0];
      if (!best?.line?.length) return null;
      return {
        Lyrics: best.line.map((l) => (best.synced
          ? { Text: l.value || '', Start: Math.round((l.start || 0) * 10000) }
          : { Text: l.value || '' }))
      };
    } catch (err) {
      if (err.status === 404) return null;
      if (err.isNetworkError) throw err;
    }
    const song = this._songs.get(itemId) || (await this.getItem(itemId).catch(() => null));
    if (!song) return null;
    const data = await this._get('getLyrics', { artist: song.Artists?.[0] || song.AlbumArtist, title: song.Name }).catch(() => null);
    const text = data?.lyrics?.value;
    if (!text) return null;
    return { Lyrics: text.split(/\r?\n/).map((line) => ({ Text: line.trim() })) };
  }

  // ---------- Likes and plays ----------

  async getLikedSongs() {
    const data = await this._get('getStarred2');
    return (data.starred2?.song || []).map((s) => this._song(s)).sort(byName);
  }

  async likeItem(itemId) {
    await this._get('star', { id: itemId });
    const song = this._songs.get(itemId);
    if (song) song.UserData.IsFavorite = true;
  }

  async unlikeItem(itemId) {
    await this._get('unstar', { id: itemId });
    const song = this._songs.get(itemId);
    if (song) song.UserData.IsFavorite = false;
  }

  // A scrobble with submission=true is Subsonic's "this was played": play
  // count and last played go up on the account, as Jellyfin's PlayedItems.
  async markPlayed(itemId) {
    await this._get('scrobble', { id: itemId, submission: true, time: Date.now() });
    return {};
  }

  // ---------- Playlists ----------

  async getPlaylists() {
    const data = await this._get('getPlaylists');
    return (data.playlists?.playlist || []).map((p) => this._playlist(p)).sort(byName);
  }

  // Subsonic removes playlist entries by position, and the app removes rows
  // without reloading the playlist, so a bare index would go stale after the
  // first removal. The entry id keeps the song id too (see removeFromPlaylist).
  async getPlaylistItems(playlistId) {
    const data = await this._get('getPlaylist', { id: playlistId });
    return (data.playlist?.entry || []).map((s, i) => ({ ...this._song(s), PlaylistItemId: `${i}:${s.id}` }));
  }

  async createPlaylist(name) {
    const data = await this._get('createPlaylist', { name });
    // Subsonic before 1.14 returned nothing; find the new one by name then.
    if (data.playlist?.id) return { Id: data.playlist.id };
    const made = (await this.getPlaylists()).filter((pl) => pl.Name === name).pop();
    return { Id: made?.Id };
  }

  async addToPlaylist(playlistId, itemId) {
    await this._get('updatePlaylist', { playlistId, songIdToAdd: itemId });
  }

  // Re-reads the playlist and removes the occurrence of that song closest
  // to where it was, so earlier removals shifting positions don't matter.
  async removeFromPlaylist(playlistId, entryId) {
    const sep = entryId.indexOf(':');
    const wasAt = Number(entryId.slice(0, sep));
    const songId = entryId.slice(sep + 1);
    const data = await this._get('getPlaylist', { id: playlistId });
    const positions = (data.playlist?.entry || []).map((s, i) => (s.id === songId ? i : -1)).filter((i) => i >= 0);
    if (!positions.length) return;
    const index = positions.reduce((best, i) => (Math.abs(i - wasAt) < Math.abs(best - wasAt) ? i : best));
    await this._get('updatePlaylist', { playlistId, songIndexToRemove: index });
  }

  // No Subsonic API for playlist covers; the app hides the control.
  canUploadPlaylistImage() { return false; }

  async uploadPlaylistImage() {
    throw new Error('This server does not support playlist covers.');
  }

  // ---------- No Subsonic equivalent: harmless no-ops ----------

  // No per-user storage on a Subsonic server: settings and listening logs
  // stay on this device, as in music-on-this-device mode.
  async getListeningLogs() { return {}; }
  async saveListeningLog() {}
  async getSyncedSettings() { return null; }
  async saveSyncedSettings() {}
  // No Sessions API / websocket: Connect shows no other devices.
  async registerCapabilities() {}
  async getSessions() { return []; }
  wsUrl() { return null; }

  // Now playing on the server (other clients' "who's listening"); the play
  // itself is counted by markPlayed.
  async reportPlaybackStart(payload) {
    if (payload?.ItemId) await this._get('scrobble', { id: payload.ItemId, submission: false });
  }

  async reportPlaybackProgress() {}
  async reportPlaybackStopped() {}

  // ---------- URLs ----------

  imageUrl(item, type = 'Primary', maxSize = 500) {
    if (type !== 'Primary' || !item) return null;
    const id = item.ImageTags?.Primary || (item.AlbumId ? `al-${item.AlbumId}` : null);
    if (!id) return null;
    const params = this._params({ id, size: maxSize });
    params.delete('f');
    return `${this.serverUrl}/rest/getCoverArt.view?${params.toString()}`;
  }

  artistPhotoUrl(artistId, maxSize = 600) {
    return this.imageUrl({ ImageTags: { Primary: `ar-${artistId}` } }, 'Primary', maxSize);
  }

  backdropUrl() { return null; }

  // bitrateKbps 0: the original file (format=raw, so a server-side
  // transcoding default for this player doesn't apply); otherwise MP3 at
  // that ceiling, as JellyfinClient.streamUrl does.
  streamUrl(item, bitrateKbps = 0) {
    const params = this._params(bitrateKbps
      ? { id: item.Id, format: 'mp3', maxBitRate: bitrateKbps }
      : { id: item.Id, format: 'raw' });
    params.delete('f');
    return `${this.serverUrl}/rest/stream.view?${params.toString()}`;
  }
}
