// Search by lyrics. Jellyfin doesn't index lyrics and no public lyrics
// service searches by lyric text for apps, so Triptych keeps its own index
// on this device: the lyrics of the library's songs, fetched slowly in the
// background through the same sources as the lyrics view (see lyrics.js),
// stored in IndexedDB. Searching then matches a typed line locally.
//
// Only runs when Settings > Privacy > "Search by lyrics" is on, since it
// sends every song's title/artist to the lyrics services (see PRIVACY.md).

const DB_NAME = 'triptych-lyrics';
const STORE = 'lyrics';
const NONE_RETRY_MS = 30 * 24 * 3600 * 1000; // re-check "no lyrics" monthly
const GAP_MS = 2500; // a lookup every few seconds -- leaves lrclib's rate limit to the lyrics view

let dbPromise = null;
let entries = null; // Map trackId -> { text, norm, none, at }
let running = false;
let stopRequested = false;
const progressListeners = [];

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

// Lowercase, accents and punctuation stripped, single spaces: "Don't stop"
// matches "dont stop", "Láska" matches "laska".
export function normalizeLyricText(text) {
  return (text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function loadAll() {
  if (entries) return entries;
  entries = new Map();
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const v = cursor.value;
        entries.set(cursor.key, { ...v, norm: v.none ? '' : normalizeLyricText(v.text) });
        cursor.continue();
      };
      req.onerror = () => resolve();
    });
  } catch (err) {
    // IndexedDB unavailable -- index stays in memory for this session.
  }
  return entries;
}

async function put(trackId, value) {
  const all = await loadAll();
  all.set(trackId, { ...value, norm: value.none ? '' : normalizeLyricText(value.text) });
  try {
    const db = await openDb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, trackId);
  } catch (err) {
    // Same as above.
  }
}

function lyricsText(result) {
  if (!result) return '';
  if (result.synced?.length) return result.synced.map((l) => l.text).filter(Boolean).join('\n');
  return result.plain || '';
}

// Lyrics the user opened anyway (lyrics view) go into the index for free.
export function rememberLyrics(trackId, result) {
  if (!trackId) return;
  const text = lyricsText(result);
  if (text) put(trackId, { text, at: Date.now() });
}

export function onIndexProgress(callback) {
  progressListeners.push(callback);
}

export async function indexStatus(trackIds) {
  const all = await loadAll();
  const done = trackIds.filter((id) => all.has(id)).length;
  const withLyrics = trackIds.filter((id) => all.get(id) && !all.get(id).none).length;
  return { done, total: trackIds.length, withLyrics };
}

// Works through the library in the background, one song at a time.
// `queryFor(track)` builds the lyrics.js query; `fetchLyrics` is lyrics.js's.
export async function startIndexing(tracks, queryFor, fetchLyrics) {
  if (running) return;
  running = true;
  stopRequested = false;
  const all = await loadAll();
  const now = Date.now();
  const todo = tracks.filter((tr) => {
    const e = all.get(tr.Id);
    return !e || (e.none && now - (e.at || 0) > NONE_RETRY_MS);
  });
  const ids = tracks.map((tr) => tr.Id);
  for (const track of todo) {
    if (stopRequested) break;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
    try {
      const result = await fetchLyrics({ ...queryFor(track), background: true });
      const text = lyricsText(result);
      await put(track.Id, text ? { text, at: Date.now() } : { none: true, at: Date.now() });
    } catch (err) {
      // A service was unreachable -- leave it for a later session.
    }
    const status = await indexStatus(ids);
    progressListeners.forEach((cb) => cb(status));
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  running = false;
}

export function stopIndexing() {
  stopRequested = true;
}

// Songs whose lyrics contain the typed words, best (exact phrase) first,
// with the matching line for display. Needs a few words to be meaningful.
export async function searchByLyrics(term, limit = 20) {
  const q = normalizeLyricText(term);
  if (q.length < 8 || q.split(' ').length < 2) return [];
  const all = await loadAll();
  const words = q.split(' ');
  const hits = [];
  for (const [id, e] of all) {
    if (e.none || !e.norm) continue;
    let score = 0;
    if (e.norm.includes(q)) score = 2;
    else if (words.length >= 3 && words.every((w) => e.norm.includes(w))) score = 1;
    if (!score) continue;
    const lines = e.text.split('\n');
    const line = lines.find((l) => normalizeLyricText(l).includes(q))
      || lines.find((l) => { const n = normalizeLyricText(l); return words.filter((w) => n.includes(w)).length >= Math.ceil(words.length / 2); })
      || '';
    hits.push({ id, score, line: line.trim() });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
