// Song recommendations from the user's own library: smart shuffle's extra
// songs (see fillSmartShuffle in app.js) and Home's "Because you listened
// to ..." row.
//
// Artists are scored against the "seed" artists (what's playing) from
// several signals, then a song is picked from the best ones:
//   - Deezer's related artists (optional, Settings -> Privacy), matched to
//     library artists by name. Deezer has many same-named artists, so an
//     artist only counts once one of the user's own album/song titles turns
//     up in that Deezer artist's catalog.
//   - Artists featured together on the user's songs.
//   - Artists the user listens to in the same sittings (last-played times).
//   - Jellyfin's instant mix for the playing song.
//   - Shared genres, rare genres counting for more than "Rock" or "Hip-Hop".
// A local scene (Slovak rap leading to other Slovak rap) mostly comes out of
// the features and the listening: no language guessing.

import { matchKey } from './lyrics.js';
import { deezerApiGet } from './platform.js';
import { getSettings } from './settings.js';

const DB_NAME = 'triptych-recommend';
const STORE = 'deezer';
const CACHE_VERSION = 2;
const FOUND_TTL_MS = 30 * 24 * 3600 * 1000;
const NONE_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSION_GAP_MS = 45 * 60 * 1000;
const RECENT_MS = 24 * 3600 * 1000;
const SECOND_DEGREE = 5; // related artists whose own related artists count too

const WEIGHTS = { deezer: 3, collab: 2.5, colisten: 1.5, mix: 1.5, genre: 1.2 };

// ---------- Deezer, cached in IndexedDB ----------

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

async function readStored(key) {
  const db = await openDb();
  if (!db) return undefined;
  const entry = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch (err) {
      resolve(undefined);
    }
  });
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  const ttl = entry.value ? FOUND_TTL_MS : NONE_TTL_MS;
  return Date.now() - entry.at < ttl ? entry.value : undefined;
}

async function writeStored(key, value) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ v: CACHE_VERSION, at: Date.now(), value }, key);
  } catch (err) {
    // Storage full or unavailable -- the memory cache still works.
  }
}

// Two requests at a time at most, well under Deezer's rate limit.
let active = 0;
const waiting = [];
async function deezer(path, params) {
  if (active >= 2) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await deezerApiGet(path, params);
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// "Song (Remastered 2011) [feat. X]" -> "song".
function titleKey(text) {
  return matchKey((text || '').replace(/\s*[([{].*?[)\]}]/g, '').replace(/\s+(?:feat\.?|ft\.?)\s.*$/i, ''));
}

const memo = new Map();
function memoized(key, load) {
  if (!memo.has(key)) {
    memo.set(key, (async () => {
      const stored = await readStored(key);
      if (stored !== undefined) return stored;
      const value = await load();
      if (value !== undefined) writeStored(key, value);
      return value ?? null;
    })().catch(() => null));
  }
  return memo.get(key);
}

async function relatedById(id) {
  return memoized(`rel:${id}`, async () => {
    const data = await deezer(`/artist/${id}/related`, { limit: 25 });
    if (!data) return undefined; // network failure: don't cache
    return (data.data || []).map((a) => ({ id: a.id, name: a.name }));
  });
}

// Profiles of library artists found so far (artist key -> profile or null).
const profiles = new Map();

// A library artist's Deezer profile: { id, genres: { genreId: share },
// related: [{ id, name }] }, or null when Deezer doesn't have them. Deezer
// has many same-named artists, so a candidate only counts once one of the
// user's own song/album titles is in its catalog.
async function deezerProfile(artist) {
  const value = await memoized(`prof:${artist.key}`, async () => {
    const found = await deezer('/search/artist', { q: artist.name, limit: 10 });
    if (!found) return undefined;
    const candidates = (found.data || []).filter((a) => matchKey(a.name) === artist.key).slice(0, 3);
    let best = null;
    let bestHits = 0;
    for (const cand of candidates) {
      const [albums, top] = await Promise.all([
        deezer(`/artist/${cand.id}/albums`, { limit: 100 }),
        deezer(`/artist/${cand.id}/top`, { limit: 50 })
      ]);
      if (!albums && !top) return undefined;
      const titles = new Set([...(albums?.data || []), ...(top?.data || [])].map((x) => titleKey(x.title)));
      let hits = 0;
      for (const t of artist.titles) if (titles.has(t)) hits++;
      if (hits > bestHits) { best = { id: cand.id, albums: albums?.data || [] }; bestHits = hits; }
    }
    if (!best) return null;
    const related = await relatedById(best.id);
    if (!related) return undefined;
    const genres = {};
    best.albums.forEach((al) => { if (al.genre_id > 0) genres[al.genre_id] = (genres[al.genre_id] || 0) + 1; });
    const total = Object.values(genres).reduce((a, b) => a + b, 0);
    for (const g of Object.keys(genres)) genres[g] /= total;
    return { id: best.id, genres, related };
  });
  profiles.set(artist.key, value);
  return value;
}

let profilesLoaded = null;
function loadStoredProfiles() {
  if (!profilesLoaded) {
    profilesLoaded = openDb().then((db) => db && new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve();
          const { key, value: entry } = cursor;
          if (String(key).startsWith('prof:') && entry?.v === CACHE_VERSION && Date.now() - entry.at < (entry.value ? FOUND_TTL_MS : NONE_TTL_MS)) {
            const artistKey = String(key).slice(5);
            if (!profiles.has(artistKey)) profiles.set(artistKey, entry.value);
          }
          cursor.continue();
        };
        req.onerror = () => resolve();
      } catch (err) {
        resolve();
      }
    }));
  }
  return profilesLoaded;
}

// Looks up, in the background, the artists the user plays most that have no
// profile yet, so related and genre matches can reach them too.
let warming = false;
async function warmProfiles(index) {
  if (warming || getSettings().relatedArtistsLookupEnabled === false) return;
  warming = true;
  try {
    const todo = [...index.artists.values()]
      .filter((a) => a.plays > 0 && !profiles.has(a.key) && !memo.has(`prof:${a.key}`))
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 40);
    for (const artist of todo) {
      if (getSettings().relatedArtistsLookupEnabled === false) break;
      await deezerProfile(artist);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    warming = false;
  }
}

function genreOverlapOf(a, b) {
  let sum = 0;
  for (const g of Object.keys(a)) if (b[g]) sum += Math.min(a[g], b[g]);
  return sum;
}

// Library artist key -> closeness 0..1.3 from Deezer: related artists (also
// the other way round, and a step further for less), plus shared genres.
async function deezerScores(artist, index) {
  const out = new Map();
  if (getSettings().relatedArtistsLookupEnabled === false || !artist) return out;
  const prof = await deezerProfile(artist);
  if (!prof) return out;
  const rel = new Map();
  const add = (name, score) => {
    const key = matchKey(name);
    if (index.artists.has(key) && score > (rel.get(key) || 0)) rel.set(key, score);
  };
  prof.related.forEach((a, rank) => add(a.name, 1 - rank / 30));
  const further = await Promise.all(prof.related.slice(0, SECOND_DEGREE).map((a) => relatedById(a.id)));
  further.forEach((list, i) => (list || []).forEach((a, rank) => add(a.name, 0.4 * (1 - i / 10) * (1 - rank / 30))));
  for (const [key, other] of profiles) {
    if (!other || key === artist.key || !index.artists.has(key)) continue;
    const rank = other.related.findIndex((a) => matchKey(a.name) === artist.key);
    if (rank >= 0) add(index.artists.get(key).name, 0.8 * (1 - rank / 30));
    const g = genreOverlapOf(prof.genres, other.genres);
    if (g > 0) out.set(key, 0.4 * g);
  }
  for (const [key, v] of rel) out.set(key, (out.get(key) || 0) + v);
  return out;
}

// ---------- Library index ----------

// Tags often hold several artists in one name ("Separ, Peter Pann",
// "Saul; Hasan"). "/" only splits between longer names, so AC/DC stays one.
const NAME_SPLIT = /\s*[;,]\s*|\s+(?:feat\.?|ft\.?|featuring)\s+|(?<=\S{3})\s*\/\s*(?=\S{2})/i;

function trackArtistNames(track) {
  let names = [];
  if (track.ArtistItems?.length) names = track.ArtistItems.map((a) => a.Name).filter(Boolean);
  else if (track.Artists?.length) names = track.Artists;
  else if (track.AlbumArtist) names = [track.AlbumArtist];
  return names.flatMap((n) => n.split(NAME_SPLIT)).map((n) => n.trim()).filter(Boolean);
}

export function trackArtistKeys(track) {
  return [...new Set(trackArtistNames(track).map(matchKey).filter(Boolean))];
}

function bump(map, a, b, by) {
  let inner = map.get(a);
  if (!inner) map.set(a, (inner = new Map()));
  inner.set(b, (inner.get(b) || 0) + by);
}

function buildIndex(tracks) {
  const artists = new Map(); // key -> { key, name, tracks, plays, genres: Map, titles: Set }
  const collab = new Map();
  const genreArtists = new Map();
  for (const tr of tracks) {
    const names = trackArtistNames(tr);
    const keys = [];
    names.forEach((name) => {
      const key = matchKey(name);
      if (!key || keys.includes(key)) return;
      keys.push(key);
      let a = artists.get(key);
      if (!a) artists.set(key, (a = { key, name, tracks: [], plays: 0, genres: new Map(), titles: new Set() }));
      a.tracks.push(tr);
      a.plays += tr.UserData?.PlayCount || 0;
      a.titles.add(titleKey(tr.Name));
      if (tr.Album) a.titles.add(titleKey(tr.Album));
      (tr.Genres || []).forEach((g) => {
        const gk = matchKey(g);
        if (gk) a.genres.set(gk, (a.genres.get(gk) || 0) + 1);
      });
    });
    for (const a of keys) for (const b of keys) if (a !== b) bump(collab, a, b, 1);
  }
  for (const a of artists.values()) {
    a.titles.delete('');
    for (const g of a.genres.keys()) genreArtists.set(g, (genreArtists.get(g) || 0) + 1);
  }
  // Each artist's genre shares, scaled by how rare the genre is in the
  // library: sharing "Hip-Hop" says little, sharing "Slovak rap" a lot.
  const total = artists.size || 1;
  const maxIdf = Math.log(1 + total);
  for (const a of artists.values()) {
    const sum = [...a.genres.values()].reduce((x, y) => x + y, 0) || 1;
    a.genreVec = new Map();
    for (const [g, n] of a.genres) a.genreVec.set(g, (n / sum) * (Math.log(1 + total / genreArtists.get(g)) / maxIdf));
  }

  // Sittings: songs played within SESSION_GAP_MS of each other. Jellyfin
  // only keeps each song's last play, so this is a sketch, but it's the
  // user's own taste.
  const played = tracks
    .map((tr) => ({ tr, at: Date.parse(tr.UserData?.LastPlayedDate || '') || 0 }))
    .filter((p) => p.at)
    .sort((a, b) => a.at - b.at);
  const colisten = new Map();
  const sittings = new Map(); // artist key -> sittings they're in
  let sitting = [];
  const closeSitting = () => {
    const keys = [...new Set(sitting.flatMap((tr) => trackArtistKeys(tr)))];
    if (keys.length > 1 && keys.length < 40) {
      const w = 1 / Math.sqrt(keys.length);
      for (const a of keys) {
        sittings.set(a, (sittings.get(a) || 0) + 1);
        for (const b of keys) if (a !== b) bump(colisten, a, b, w);
      }
    }
    sitting = [];
  };
  let last = 0;
  for (const p of played) {
    if (last && p.at - last > SESSION_GAP_MS) closeSitting();
    sitting.push(p.tr);
    last = p.at;
  }
  closeSitting();
  // Relative to how often each turns up at all, or the artists played most
  // would look close to everyone; the +3 keeps one shared sitting between
  // two rarely played artists from counting as much as a habit.
  for (const [a, inner] of colisten) {
    for (const [b, v] of inner) inner.set(b, v / Math.sqrt((sittings.get(a) + 3) * (sittings.get(b) + 3)));
  }

  // Genres most of the library has ("Music", "Rock") say nothing.
  const genericGenres = new Set([...genreArtists].filter(([, n]) => n / total > 0.3).map(([g]) => g));

  return { artists, collab, colisten, genericGenres };
}

function normalized(map) {
  const out = new Map();
  if (!map) return out;
  const max = Math.max(0, ...map.values());
  if (max > 0) for (const [k, v] of map) out.set(k, v / max);
  return out;
}

function genreOverlap(a, b) {
  let sum = 0;
  for (const [g, w] of a) if (b.has(g)) sum += Math.min(w, b.get(g));
  return sum;
}

// ---------- Recommender ----------

// getLibrary: () => Promise<track[]>; getInstantMix: (trackId) =>
// Promise<track[]> (server songs only, [] otherwise); canPlay: (track) =>
// false for songs that can't play right now (offline mode).
export function createRecommender({ getLibrary, getInstantMix, canPlay = () => true }) {
  let index = null;
  let indexedFrom = null;
  const mixCache = new Map();
  const sessionPlayed = new Set();
  const declined = new Set();

  async function ensureIndex() {
    const tracks = await getLibrary();
    if (tracks !== indexedFrom) {
      index = buildIndex(tracks || []);
      indexedFrom = tracks;
    }
    return index;
  }

  async function mixScores(trackId) {
    if (!trackId) return new Map();
    if (!mixCache.has(trackId)) {
      mixCache.set(trackId, Promise.resolve(getInstantMix(trackId)).then((items) => {
        const counts = new Map();
        (items || []).forEach((tr) => trackArtistKeys(tr).forEach((k) => counts.set(k, (counts.get(k) || 0) + 1)));
        return normalized(counts);
      }).catch(() => new Map()));
    }
    return mixCache.get(trackId);
  }

  // Artist key -> score for a set of weighted seed artists.
  async function scoreArtists(seeds, mixTrack) {
    const idx = await ensureIndex();
    // Jellyfin's instant mix goes by genre: with only generic genres it's
    // a random pick from the library, so it's left out.
    const mixTrackId = (mixTrack?.Genres || []).some((g) => !idx.genericGenres.has(matchKey(g))) ? mixTrack.Id : null;
    await loadStoredProfiles();
    warmProfiles(idx).catch(() => {});
    const scores = new Map();
    const add = (key, v) => { if (v > 0) scores.set(key, (scores.get(key) || 0) + v); };
    const [mix, ...deezerPerSeed] = await Promise.all([
      mixScores(mixTrackId),
      ...seeds.map((s) => deezerScores(idx.artists.get(s.key), idx).catch(() => new Map()))
    ]);
    // Each seed's scores are scaled to its best match before weighting, so
    // the song the user picked leads even when little is known about it.
    seeds.forEach((seed, i) => {
      const artist = idx.artists.get(seed.key);
      if (!artist) return;
      const own = new Map();
      const addOwn = (key, v) => { if (v > 0) own.set(key, (own.get(key) || 0) + v); };
      const collab = normalized(idx.collab.get(seed.key));
      // Absolute, not scaled to the best match: one shared sitting
      // shouldn't count as a habit just because it's all there is.
      const colisten = new Map([...(idx.colisten.get(seed.key) || [])].map(([k, v]) => [k, Math.min(1, v * 2)]));
      for (const [k, v] of deezerPerSeed[i]) addOwn(k, WEIGHTS.deezer * v);
      for (const [k, v] of collab) addOwn(k, WEIGHTS.collab * v);
      for (const [k, v] of colisten) addOwn(k, WEIGHTS.colisten * v);
      if (artist.genreVec.size) {
        for (const other of idx.artists.values()) {
          if (other.key !== seed.key) addOwn(other.key, WEIGHTS.genre * genreOverlap(artist.genreVec, other.genreVec));
        }
      }
      if (seed.first) for (const [k, v] of mix) addOwn(k, WEIGHTS.mix * v);
      own.delete(seed.key);
      for (const [k, v] of normalized(own)) add(k, seed.weight * v);
    });
    for (const s of seeds) scores.delete(s.key);
    return scores;
  }

  function eligible(track, exclude) {
    if (exclude.has(track.Id) || declined.has(track.Id) || sessionPlayed.has(track.Id) || !canPlay(track)) return false;
    const last = Date.parse(track.UserData?.LastPlayedDate || '') || 0;
    return Date.now() - last > RECENT_MS;
  }

  // An artist's songs without the seed artists on them: a feature on the
  // playing artist's own song isn't a recommendation.
  function ownTracks(artist, seedKeys) {
    return artist.tracks.filter((tr) => !trackArtistKeys(tr).some((k) => seedKeys.has(k)));
  }

  function weightedPick(items, weightOf) {
    const total = items.reduce((sum, it) => sum + weightOf(it), 0);
    let r = Math.random() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  return {
    // A song for after `seedTracks` (most relevant first), or null.
    // exclude: track ids already queued; avoidArtists: artist keys of the
    // last few recommendations, so they don't repeat.
    async pick(seedTracks, { exclude = new Set(), avoidArtists = new Set() } = {}) {
      const seedWeights = [1, 0.5, 0.25];
      const seeds = [];
      seedTracks.slice(0, seedWeights.length).forEach((tr, i) => {
        trackArtistKeys(tr).forEach((key) => {
          const known = seeds.find((s) => s.key === key);
          if (known) known.weight += seedWeights[i];
          else seeds.push({ key, weight: seedWeights[i], first: i === 0 });
        });
      });
      if (!seeds.length) return null;
      const scores = await scoreArtists(seeds, seedTracks[0]);
      const seedKeys = new Set(seeds.map((s) => s.key));
      const ranked = [...scores.entries()]
        .map(([key, score]) => ({ key, score: avoidArtists.has(key) ? score * 0.25 : score, tracks: ownTracks(index.artists.get(key), seedKeys).filter((tr) => eligible(tr, exclude)) }))
        .filter((c) => c.tracks.length && c.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      if (!ranked.length) return null;
      // The closest artists by far most of the time, the rest now and then.
      const top = ranked[0].score;
      const artist = weightedPick(ranked.filter((c) => c.score >= top * 0.45), (c) => c.score ** 3);
      const track = weightedPick(artist.tracks, (tr) => (tr.UserData?.IsFavorite ? 3 : 1) + Math.min(2, (tr.UserData?.PlayCount || 0) / 5));
      return { track, artistKey: artist.key };
    },

    // Library artists most like `artistName`, best first.
    async similarArtists(artistName, limit = 10) {
      const idx = await ensureIndex();
      const key = matchKey(artistName);
      if (!idx.artists.has(key)) return [];
      const scores = await scoreArtists([{ key, weight: 1, first: true }], null);
      const seedKeys = new Set([key]);
      return [...scores.entries()]
        .filter(([, score]) => score > 0.1)
        .map(([k, score]) => ({ ...idx.artists.get(k), tracks: ownTracks(idx.artists.get(k), seedKeys), score }))
        .filter((a) => a.tracks.length)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    notePlayed(trackId) {
      if (trackId) sessionPlayed.add(trackId);
    },

    decline(trackId) {
      if (trackId) declined.add(trackId);
    }
  };
}
