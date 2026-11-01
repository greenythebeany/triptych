// Looks up lyrics for a track, asking every source at once and taking the
// best answer as soon as it's in:
//   synced (LRC):  the user's own Jellyfin server (.lrc / embedded lyrics),
//                  lrclib.net, NetEase Cloud Music, Kugou
//   plain only:    any of the above when they only have unsynced text,
//                  then lyrics.ovh
// A good synced match wins the moment it arrives; plain text is only used
// when no source has synced lyrics. NetEase and Kugou don't send CORS
// headers, so they go through the native side (Electron's main process /
// Capacitor's native HTTP).
//
// Results are cached per track in memory and in IndexedDB, so a track's
// lyrics are only ever looked up once (a "none" is re-checked after a few
// days).
//
// Word-by-word lyrics (Settings -> Appearance, `query.wordSync`): synced
// lines can also carry `words: [{ time, end, text }]`, from Kugou's KRC
// format or lrclib's enhanced LRC (<mm:ss.xx> word tags). With the setting
// on, word-timed lyrics win over line-timed ones, which win over plain.

import { isDesktop, isMobile } from './platform.js';

const LRCLIB_BASE = 'https://lrclib.net/api';
const LYRICS_OVH_BASE = 'https://api.lyrics.ovh/v1';
const NETEASE_BASE = 'https://music.163.com/api';
const KUGOU_BASE = 'https://lyrics.kugou.com';
// lrclib asks clients to identify themselves; browsers can't set
// User-Agent, so it reads this header instead. Unidentified clients get
// half the rate limit -- running out of it was why lyrics failed to load.
const LRCLIB_CLIENT = 'Triptych (https://github.com/greenythebeany/triptych)';

const REQUEST_TIMEOUT_MS = 5000;
const SOURCE_TIMEOUT_MS = 9000;
// A synced match this good is taken immediately; a weaker one waits this
// long for a better one from another source.
const STRONG_MATCH = 0.85;
const SYNCED_GRACE_MS = 500;
// With word-by-word on, line-synced lyrics wait this long for word-timed
// ones (a later word-timed result still replaces them).
const WORD_GRACE_MS = 1500;
// With plain lyrics in hand, stop waiting for synced ones after this long
// (a later synced result still replaces them, see onLyricsUpgraded).
const PLAIN_DEADLINE_MS = 3500;
const MIN_SCORE = 0.6;

// Thrown when nothing was found and at least one source couldn't be
// reached -- distinct from a genuine "no lyrics" (null), so the UI can
// offer Retry.
export class LyricsUnavailableError extends Error {}
class SourceError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- LRC parsing ----------

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

const tagSeconds = (m, s, f) => parseInt(m, 10) * 60 + parseInt(s, 10) + (f ? parseInt(f.padEnd(3, '0'), 10) / 1000 : 0);

// Enhanced LRC: "[00:12.00]<00:12.00>Never <00:12.40>gonna <00:12.90>give".
// Each word runs until the next tag (a trailing tag closes the last word).
function parseWordTags(body, offset) {
  const marks = [...body.matchAll(WORD_TAG)];
  if (marks.length < 2) return null;
  const words = [];
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const text = body.slice(start, marks[i + 1] ? marks[i + 1].index : undefined);
    const time = Math.max(0, tagSeconds(m[1], m[2], m[3]) - offset);
    if (words.length && words[words.length - 1].end == null) words[words.length - 1].end = time;
    if (text.trim()) words.push({ time, end: null, text });
  });
  return words.length ? words : null;
}

export function parseLrc(lrc) {
  if (!lrc) return null;
  const offsetTag = lrc.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  const offset = offsetTag ? parseInt(offsetTag[1], 10) / 1000 : 0;
  const result = [];
  for (const line of lrc.split(/\r?\n/)) {
    const tags = [...line.matchAll(TIME_TAG)];
    if (!tags.length) continue;
    const body = line.replace(TIME_TAG, '');
    const text = body.replace(WORD_TAG, '').trim();
    const words = tags.length === 1 ? parseWordTags(body, offset) : null;
    for (const tag of tags) {
      const time = Math.max(0, tagSeconds(tag[1], tag[2], tag[3]) - offset);
      result.push(words ? { time, text, words } : { time, text });
    }
  }
  result.sort((a, b) => a.time - b.time);
  // Lines that all sit at 0:00 are plain lyrics in LRC clothing.
  return result.length >= 2 && result[result.length - 1].time > 0 ? result : null;
}

const lrcToPlain = (lrc) => (lrc || '').split(/\r?\n/).map((l) => l.replace(TIME_TAG, '').trim())
  .filter((l) => !/^\[[a-z]+:.*\]$/i.test(l)).join('\n').trim();

// NetEase/Kugou often open with credit lines ("作词 : …", "Composer: …")
// timed at the start of the song -- they aren't lyrics.
const CREDIT_LINE = /^(?:作词|作曲|编曲|制作人|作詞|編曲|製作人|词|曲|混音|和声|吉他|贝斯|鼓|监制|出品|录音|母带|lyricist|lyrics|composer|composed|written|arranger|arranged|producer|produced|mixed|mastered)\s*(?:by)?\s*[:：]/i;
// Kugou also puts a "Title - Artist" line at 0:00. `match` is the
// search result the lyrics belong to.
function stripCredits(lines, match) {
  const titleKey = matchKey(stripTitle(match.title));
  const artistKey = matchKey(splitArtists(match.artist)[0]);
  return lines.filter((l, i) => {
    const text = l.text.trim();
    if (CREDIT_LINE.test(text)) return false;
    if (i < 2 && l.time < 1 && /\s-\s/.test(text)) {
      const key = matchKey(text);
      if ((titleKey && key.includes(titleKey)) || (artistKey && key.includes(artistKey))) return false;
    }
    return true;
  });
}

// ---------- Matching ----------

const VERSION_WORDS = 'remaster(?:ed)?|live|version|ver\\.?|edit|mix|remix|mono|stereo|deluxe|bonus|explicit|clean|acoustic|demo|radio|single|extended|original|anniversary|re-?recorded|taylor.s version|from|feat\\.?|ft\\.?|featuring|with|prod\\.?|ost|soundtrack|session|unplugged|bootleg|official|audio|video|lyrics?|visuali[sz]er|mv|hd|hq|4k|\\d{4}';
const OPEN = '([\\[{（【「『〔<';
const CLOSE = ')\\]}）】」』〕>';
const DECORATED_BRACKET = new RegExp(`\\s*[${OPEN}][^${CLOSE}]*?\\b(?:${VERSION_WORDS})\\b[^${CLOSE}]*[${CLOSE}]`, 'gi');
const ANY_BRACKET = new RegExp(`\\s*[${OPEN}][^${CLOSE}]*[${CLOSE}]`, 'g');
const DECORATED_SUFFIX = new RegExp(`\\s+[-–—]\\s+[^-–—]*\\b(?:${VERSION_WORDS})\\b.*$`, 'i');
const FEAT_SUFFIX = /\s+(?:feat\.?|ft\.?|featuring)\s+[^-–—]*$/i;
const DASH = /\s+[-–—]\s*|\s*[-–—]\s+/;
const TRAILING_JUNK = /\s+(?:official\s+)?(?:lyrics?\s+|music\s+)?(?:video|audio|visuali[sz]er)(?=\s*(?:[-–—]|$))/gi;
const QUOTES = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;

// "Yesterday - Remastered 2009" -> "Yesterday", "Song (feat. X) [Live]" ->
// "Song". Leaves other brackets alone ("(I Can't Get No) Satisfaction").
export function stripTitle(title) {
  return (title || '').normalize('NFKC')
    .replace(DECORATED_BRACKET, '')
    .replace(DECORATED_SUFFIX, '')
    .replace(FEAT_SUFFIX, '')
    .replace(TRAILING_JUNK, '')
    .trim().replace(QUOTES, '').trim();
}

const ARTIST_SPLIT = /\s*(?:[,;/&×、]|\s(?:feat\.?|ft\.?|featuring|with|x|and|vs\.?)\s)\s*/i;
const splitArtists = (artist) => (artist || '').normalize('NFKC').split(ARTIST_SPLIT).map((a) => a.trim()).filter(Boolean);

// Comparison key: case, accents, punctuation and spacing ignored; letters
// of every script (CJK included) kept.
export function matchKey(text) {
  return (text || '').normalize('NFKC').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// 0..1: exact, containment, else character-bigram overlap (works the same
// for Latin and CJK text).
function similarity(a, b) {
  const ka = matchKey(a).replace(/ /g, '');
  const kb = matchKey(b).replace(/ /g, '');
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const [short, long] = ka.length < kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 2 && long.includes(short)) return 0.75 + 0.2 * (short.length / long.length);
  if (short.length < 2) return 0;
  const ga = bigrams(ka);
  const gb = bigrams(kb);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0);
  return (2 * overlap) / (ka.length - 1 + kb.length - 1);
}

// One way of reading the track's tags: a title (with looser variants for
// comparing) and its artists.
function makePair(title, artist) {
  const raw = (title || '').trim();
  const stripped = stripTitle(raw) || raw;
  const bare = stripped.replace(ANY_BRACKET, '').trim() || stripped;
  const artists = splitArtists(artist);
  return {
    title: stripped,
    bare,
    titles: [...new Set([raw, stripped, bare].filter(Boolean))],
    artists,
    firstArtist: artists[0] || (artist || '').trim()
  };
}

// Tracks imported from YouTube (grab.js) or ripped from uploads keep the
// video's title, with the uploader as the artist: `Muse - Butterflies and
// Hurricanes (Need for Speed Soundtrack)` by "sync2412", or `"Just Gold" -
// Five Nights at Freddy's`. So besides the tags as they are, a title with a
// dash is also read as "Artist - Title" and "Title - Artist/Show", most
// likely reading first. Searches walk these in order; matching takes the
// best of them.
function prepareQuery(query) {
  const asTagged = makePair(query.title, query.artist);
  const pairs = [asTagged];
  const parts = asTagged.title.replace(QUOTES, '').split(DASH).map((p) => p.trim().replace(QUOTES, '').trim()).filter(Boolean);
  if (parts.length >= 2) {
    const left = parts[0];
    const right = parts.slice(1).join(' - ');
    const artistFirst = makePair(right, left);
    const titleFirst = makePair(left, query.artist);
    const titleThenArtist = makePair(left, right);
    const tagged = query.artist || '';
    if (similarity(right, tagged) >= 0.8) pairs.unshift(titleThenArtist);
    else if (similarity(left, tagged) >= 0.8) pairs.unshift(artistFirst);
    else pairs.unshift(artistFirst, titleFirst);
    if (!pairs.includes(titleThenArtist)) pairs.push(titleThenArtist);
  }
  // `FNAF 4 SONG (BREAK MY MIND) LYRIC VIDEO`: the song is in the brackets.
  for (const [, inner] of asTagged.title.matchAll(/[([（【「『]([^)\]）】」』]{3,})[)\]）】」』]/g)) {
    if (inner.trim().includes(' ') || /[぀-ヿ一-鿿가-힯]/.test(inner)) pairs.push(makePair(inner, query.artist));
  }
  return { ...query, asTagged, pairs, duration: query.durationSeconds || 0 };
}

function scorePair(pair, cand, dd) {
  const candTitles = [cand.title, stripTitle(cand.title)];
  const ts = Math.max(...pair.titles.flatMap((t) => candTitles.map((c) => similarity(t, c))));
  const candArtists = splitArtists(cand.artist);
  const as = pair.artists.length && candArtists.length
    ? Math.max(...pair.artists.flatMap((a) => candArtists.map((c) => similarity(a, c))), similarity(pair.artists.join(' '), cand.artist))
    : 0.5;
  if (ts < 0.6) return 0;
  // Artist names written another way (romanized vs. native script, or an
  // uploader's name) still count when the title and length both match.
  if (as < 0.45 && !(ts >= 0.95 && dd != null && dd <= 2)) return 0;
  const durationScore = dd == null ? 0.1 : dd <= 3 ? 0.2 : dd <= 8 ? 0.1 : 0;
  return ts * 0.5 + Math.max(as, 0.45) * 0.3 + durationScore;
}

// 0 = not this song; otherwise higher is better (max 1).
function scoreCandidate(q, cand) {
  const dd = q.duration && cand.duration ? Math.abs(q.duration - cand.duration) : null;
  if (dd != null && dd > 15) return 0;
  return Math.max(...q.pairs.map((pair) => scorePair(pair, cand, dd)));
}

// Best-scoring candidate, preferring one with synced lyrics when it's
// nearly as good.
function pickBest(q, candidates, hasSynced = () => false) {
  const scored = candidates.map((c) => ({ c, s: scoreCandidate(q, c) })).filter((x) => x.s >= MIN_SCORE);
  if (!scored.length) return null;
  scored.sort((a, b) => (b.s + (hasSynced(b.c) ? 0.08 : 0)) - (a.s + (hasSynced(a.c) ? 0.08 : 0)));
  return { ...scored[0].c, score: scored[0].s };
}

// ---------- HTTP ----------

async function webGet(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    return { status: res.status, headers: res.headers, body: await res.text() };
  } catch (err) {
    throw new SourceError(err?.message || 'network error');
  } finally {
    clearTimeout(timer);
  }
}

// For services without CORS headers.
async function nativeGet(url, timeoutMs) {
  if (isDesktop && window.api?.lyrics) {
    const res = await window.api.lyrics.get(url, timeoutMs);
    if (!res || !res.status) throw new SourceError(res?.error || 'network error');
    return res;
  }
  const http = window.Capacitor?.Plugins?.CapacitorHttp;
  if (isMobile && http) {
    try {
      const res = await http.request({ url, method: 'GET', connectTimeout: timeoutMs, readTimeout: timeoutMs, responseType: 'text' });
      return { status: res.status, body: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) };
    } catch (err) {
      throw new SourceError(err?.message || 'network error');
    }
  }
  return webGet(url, {}, timeoutMs);
}

function parseJson(res) {
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new SourceError('bad response');
  }
}

// ---------- Sources ----------
// Each returns { synced, plain, instrumental, score } or null for "none",
// and throws SourceError when it couldn't be reached.

let lrclibBlockedUntil = 0;

async function lrclibGet(path) {
  if (Date.now() < lrclibBlockedUntil) throw new SourceError('lrclib rate limit');
  for (let attempt = 0; ; attempt++) {
    const res = await webGet(`${LRCLIB_BASE}${path}`, { 'Lrclib-Client': LRCLIB_CLIENT }, REQUEST_TIMEOUT_MS);
    if (res.status === 404) return null;
    if (res.status === 429) {
      // Must be honoured, or lrclib bans the IP for a while.
      const retryAfter = parseInt(res.headers?.get('retry-after'), 10);
      lrclibBlockedUntil = Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000 * (1 + Math.random() * 0.3);
      throw new SourceError('lrclib rate limit');
    }
    // lrclib's edge answers 503 a lot under load; it usually clears quickly.
    if (res.status >= 500 && attempt < 2) { await sleep(attempt ? 1000 : 400); continue; }
    if (res.status !== 200) throw new SourceError(`lrclib responded ${res.status}`);
    return parseJson(res);
  }
}

function fromLrclib(data, score) {
  return {
    synced: parseLrc(data.syncedLyrics),
    plain: data.plainLyrics || lrcToPlain(data.syncedLyrics) || null,
    instrumental: !!data.instrumental,
    score
  };
}

async function lookupLrclib(q) {
  const tagged = q.asTagged;
  if (!tagged.title || !tagged.firstArtist) return null;
  // Exact lookup with the tags as they are -- the usual hit for a properly
  // tagged library.
  const params = new URLSearchParams({ track_name: tagged.titles[0], artist_name: tagged.artists.length ? tagged.artists.join(', ') : tagged.firstArtist });
  if (q.album) params.set('album_name', q.album);
  if (q.duration) params.set('duration', Math.round(q.duration));
  // get-cached: lrclib's own database only. Plain /get also tries outside
  // sources on a miss and, under load, answers those with 503 -- which used
  // to surface as "Couldn't load lyrics" for any song lrclib didn't have.
  const exact = await lrclibGet(`/get-cached?${params}`);
  if (exact && (exact.syncedLyrics || exact.plainLyrics || exact.instrumental)) return fromLrclib(exact, 1);

  const toCand = (r) => ({ ...r, title: r.trackName, artist: r.artistName });
  const synced = (c) => !!c.syncedLyrics;
  const first = q.pairs[0];
  const searches = [
    ...q.pairs.slice(0, 2).filter((p) => p.title && p.firstArtist).map((p) => ({ track_name: p.title, artist_name: p.firstArtist })),
    { q: `${first.bare} ${first.firstArtist}`.trim() }
  ];
  for (const search of searches) {
    const results = await lrclibGet(`/search?${new URLSearchParams(search)}`);
    const best = pickBest(q, (results || []).map(toCand), synced);
    if (best) return fromLrclib(best, best.score);
  }
  return null;
}

// Jellyfin's /Audio/{id}/Lyrics shape: Lyrics[{ Text, Start }], Start in
// 100ns ticks (absent/null for unsynced lyrics). It's the track's own
// file, so it's always the right song.
async function lookupJellyfin(q) {
  if (!q.fromServer) return null;
  let data;
  try {
    data = await q.fromServer();
  } catch (err) {
    throw new SourceError(err?.message);
  }
  const lines = (data && data.Lyrics) || [];
  if (!lines.length) return null;
  const synced = lines.length >= 2 && lines.every((l) => l.Start != null) && lines.some((l) => l.Start > 0);
  const plain = lines.map((l) => l.Text || '').join('\n').trim();
  return {
    synced: synced ? lines.map((l) => ({ time: l.Start / 1e7, text: (l.Text || '').trim() })) : null,
    plain: plain || null,
    instrumental: false,
    score: 1
  };
}

async function lookupNetease(q) {
  const search = async (s) => {
    const res = await nativeGet(`${NETEASE_BASE}/search/get?${new URLSearchParams({ s, type: 1, limit: 10 })}`, REQUEST_TIMEOUT_MS);
    if (res.status !== 200) throw new SourceError(`netease responded ${res.status}`);
    const songs = parseJson(res)?.result?.songs || [];
    return songs.map((s) => ({ id: s.id, title: s.name, artist: (s.artists || []).map((a) => a.name).join(', '), duration: (s.duration || 0) / 1000 }));
  };
  // NetEase searches free text: "title artist" for the likeliest readings,
  // then the title alone (catches artists written in another script).
  const terms = [...new Set([...q.pairs.map((p) => `${p.bare} ${p.firstArtist}`.trim()), q.pairs[0].bare])].filter(Boolean).slice(0, 4);
  let best = null;
  for (const term of terms) {
    best = pickBest(q, await search(term));
    if (best) break;
  }
  if (!best) return null;
  const res = await nativeGet(`${NETEASE_BASE}/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`, REQUEST_TIMEOUT_MS);
  if (res.status !== 200) throw new SourceError(`netease responded ${res.status}`);
  const data = parseJson(res);
  const lrc = data?.lrc?.lyric || '';
  if (data?.nolyric || /纯音乐，请欣赏/.test(lrc)) return { synced: null, plain: null, instrumental: true, score: best.score };
  const parsed = parseLrc(lrc);
  const synced = parsed ? stripCredits(parsed, best) : null;
  const plain = lrcToPlain(lrc).split('\n').filter((l) => !CREDIT_LINE.test(l)).join('\n').trim();
  if (!synced?.length && !plain) return null;
  return { synced: synced?.length >= 2 ? synced : null, plain: plain || null, instrumental: false, score: best.score };
}

// Kugou's KRC: base64 of "krc1" + zlib data XOR-ed with a fixed key, which
// inflates to lines like "[12000,3400]<0,400,0>Never<400,500,0> gonna".
const KRC_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];

async function decodeKrc(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length - 4);
  for (let i = 4; i < bin.length; i++) bytes[i - 4] = bin.charCodeAt(i) ^ KRC_KEY[(i - 4) % 16];
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).text();
}

function parseKrc(krc) {
  const lines = [];
  for (const raw of krc.split(/\r?\n/)) {
    const head = raw.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;
    const start = parseInt(head[1], 10);
    const words = [...raw.slice(head[0].length).matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)]
      .map((m) => ({ time: (start + parseInt(m[1], 10)) / 1000, end: (start + parseInt(m[1], 10) + parseInt(m[2], 10)) / 1000, text: m[3] }))
      .filter((w) => w.text);
    const text = words.map((w) => w.text).join('').trim();
    lines.push(words.some((w) => w.text.trim()) ? { time: start / 1000, text, words } : { time: start / 1000, text });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines.length >= 2 ? lines : null;
}

function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function lookupKugou(q) {
  let best = null;
  for (const pair of q.pairs.slice(0, 2)) {
    if (!pair.bare) continue;
    const keyword = pair.firstArtist ? `${pair.firstArtist} - ${pair.bare}` : pair.bare;
    const params = new URLSearchParams({ ver: 1, man: 'yes', client: 'pc', keyword, hash: '' });
    if (q.duration) params.set('duration', Math.round(q.duration * 1000));
    const res = await nativeGet(`${KUGOU_BASE}/search?${params}`, REQUEST_TIMEOUT_MS);
    if (res.status !== 200) throw new SourceError(`kugou responded ${res.status}`);
    const candidates = (parseJson(res)?.candidates || [])
      .map((c) => ({ id: c.id, accesskey: c.accesskey, title: c.song, artist: c.singer, duration: (c.duration || 0) / 1000 }));
    best = pickBest(q, candidates);
    if (best) break;
  }
  if (!best) return null;
  if (q.wordSync) {
    try {
      const krc = await nativeGet(`${KUGOU_BASE}/download?${new URLSearchParams({ ver: 1, client: 'pc', id: best.id, accesskey: best.accesskey, fmt: 'krc', charset: 'utf8' })}`, REQUEST_TIMEOUT_MS);
      const content = krc.status === 200 && parseJson(krc)?.content;
      const parsed = content ? parseKrc(await decodeKrc(content)) : null;
      const synced = parsed ? stripCredits(parsed, best) : null;
      if (synced?.length >= 2) {
        return { synced, plain: synced.map((l) => l.text).join('\n'), instrumental: false, score: best.score };
      }
    } catch (err) {
      // No KRC for this song (or no DecompressionStream) -- plain LRC below.
    }
  }
  const dl = await nativeGet(`${KUGOU_BASE}/download?${new URLSearchParams({ ver: 1, client: 'pc', id: best.id, accesskey: best.accesskey, fmt: 'lrc', charset: 'utf8' })}`, REQUEST_TIMEOUT_MS);
  if (dl.status !== 200) throw new SourceError(`kugou responded ${dl.status}`);
  const content = parseJson(dl)?.content;
  if (!content) return null;
  const lrc = decodeBase64Utf8(content);
  const parsed = parseLrc(lrc);
  const synced = parsed ? stripCredits(parsed, best) : null;
  const plain = lrcToPlain(lrc).split('\n').filter((l) => !CREDIT_LINE.test(l)).join('\n').trim();
  if (!synced?.length && !plain) return null;
  return { synced: synced?.length >= 2 ? synced : null, plain: plain || null, instrumental: false, score: best.score };
}

// lyrics.ovh matches literally on one artist and the title.
async function lookupLyricsOvh(q) {
  for (const { firstArtist, bare } of q.pairs.slice(0, 2).filter((p) => p.firstArtist && p.bare)) {
    const res = await webGet(`${LYRICS_OVH_BASE}/${encodeURIComponent(firstArtist)}/${encodeURIComponent(bare)}`, {}, REQUEST_TIMEOUT_MS);
    if (res.status === 404) continue;
    if (res.status !== 200) throw new SourceError(`lyrics.ovh responded ${res.status}`);
    const plain = (parseJson(res)?.lyrics || '').replace(/\r\n/g, '\n').replace(/^Paroles de la chanson .*\n/, '').trim();
    if (plain) return { synced: null, plain, instrumental: false, score: 0.7 };
  }
  return null;
}

// In priority order -- used to break ties between plain-text answers.
const SOURCES = [
  { name: 'jellyfin', run: lookupJellyfin },
  { name: 'lrclib', run: lookupLrclib },
  { name: 'netease', run: lookupNetease },
  { name: 'kugou', run: lookupKugou },
  { name: 'lyricsovh', run: lookupLyricsOvh }
];

function withTimeout(promise, ms) {
  return Promise.race([promise, sleep(ms).then(() => { throw new SourceError('timeout'); })]);
}

// Some lyrics are typed with a Cyrillic lookalike in the middle of a Latin
// word (lrclib's "Prеsne" has a Cyrillic е): it reads the same, but the
// dot-matrix font has no Cyrillic, so that one letter showed up in a
// fallback font. Words that mix the two scripts get the lookalikes swapped
// for Latin; all-Cyrillic words (Russian, Ukrainian lyrics) are left alone.
const CYRILLIC_LOOKALIKES = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', һ: 'h',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S'
};
const MIXED_WORD = /\S*\p{Script=Latin}\S*/gu;
function fixLookalikes(text) {
  if (!text || !/\p{Script=Cyrillic}/u.test(text)) return text;
  return text.replace(MIXED_WORD, (word) => (/\p{Script=Cyrillic}/u.test(word)
    ? word.replace(/\p{Script=Cyrillic}/gu, (c) => CYRILLIC_LOOKALIKES[c] || c)
    : word));
}
const fixLine = (l) => ({
  ...l,
  text: fixLookalikes(l.text),
  ...(l.words ? { words: l.words.map((w) => ({ ...w, text: fixLookalikes(w.text) })) } : {})
});

const hasWords = (r) => !!r?.synced?.some((l) => l.words?.length > 1);
const strip = ({ synced, plain, instrumental, source }) => ({
  synced: synced ? synced.map(fixLine) : null,
  plain: plain ? fixLookalikes(plain) : null,
  instrumental: !!instrumental,
  wordSynced: !!synced?.some((l) => l.words?.length > 1),
  source
});

// Runs every source in parallel. Resolves { result, complete } with the
// first strong synced match (or the best synced one after a short grace
// period); with plain lyrics only once synced ones are clearly not coming;
// result null when no source had any -- `complete` false if some of them
// couldn't be asked, so that "none" isn't cached. Rejects only when no
// source could be reached at all. `onLate` gets a synced result that turns
// up after plain lyrics were already returned, or word-timed lyrics that turn
// up after line-timed ones (word-by-word on).
function lookupLyrics(query, onLate) {
  const q = prepareQuery(query);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let pending = SOURCES.length;
    let failed = 0;
    let bestSynced = null;
    let instrumental = null;
    const plains = [];
    let settled = null; // what was resolved: 'synced' | 'plain' | 'other'
    let graceTimer = null;
    let plainTimer = null;
    // 0 plain, 1 line-synced, 2 word-synced (only counts when asked for).
    const tier = (r) => (r?.synced?.length ? (q.wordSync && hasWords(r) ? 2 : 1) : 0);
    const topTier = q.wordSync ? 2 : 1;
    let shownTier = -1;

    const done = (value, kind) => {
      if (settled) return;
      settled = kind;
      shownTier = value ? tier(value) : -1;
      clearTimeout(graceTimer);
      clearTimeout(plainTimer);
      resolve({ result: value && strip(value), complete: true });
    };
    const bestPlain = () => plains.sort((a, b) => a.priority - b.priority)[0];
    const finishAll = () => {
      if (bestSynced) return done(bestSynced, 'synced');
      if (plains.length) return done(bestPlain(), 'plain');
      if (instrumental) return done(instrumental, 'other');
      if (settled) return;
      settled = 'other';
      if (failed === SOURCES.length) reject(new LyricsUnavailableError('No lyrics source could be reached'));
      else resolve({ result: null, complete: failed === 0 });
    };

    SOURCES.forEach((src, priority) => {
      withTimeout(Promise.resolve().then(() => src.run(q)), SOURCE_TIMEOUT_MS).then((r) => {
        if (!r) return;
        r.source = src.name;
        r.priority = priority;
        if (r.synced?.length) {
          if (settled) {
            if (settled !== 'other' && tier(r) > shownTier) { shownTier = tier(r); onLate?.(strip(r)); }
            return;
          }
          if (!bestSynced || tier(r) > tier(bestSynced) || (tier(r) === tier(bestSynced) && r.score > bestSynced.score)) bestSynced = r;
          if (tier(bestSynced) === topTier && bestSynced.score >= STRONG_MATCH) done(bestSynced, 'synced');
          else if (!graceTimer) graceTimer = setTimeout(() => done(bestSynced, 'synced'), tier(bestSynced) === topTier ? SYNCED_GRACE_MS : WORD_GRACE_MS);
        } else if (r.plain) {
          plains.push(r);
          if (!plainTimer && !settled) {
            plainTimer = setTimeout(() => { if (!bestSynced) done(bestPlain(), 'plain'); }, Math.max(0, PLAIN_DEADLINE_MS - (Date.now() - started)));
          }
        } else if (r.instrumental) {
          instrumental = r;
        }
      }, () => { failed++; }).finally(() => {
        if (--pending === 0) finishAll();
      });
    });
  });
}

// ---------- Cache ----------
// Memory + IndexedDB, keyed by Jellyfin track id (or the lookup itself for
// tracks without one). Found lyrics and confirmed "none" are kept;
// failures aren't, so the next view retries. Also dedupes concurrent
// lookups of the same track (prefetch + display).

const DB_NAME = 'triptych-lyrics-cache';
const STORE = 'tracks';
const CACHE_VERSION = 2;
const FOUND_TTL_MS = 90 * 24 * 3600 * 1000;
const NONE_TTL_MS = 3 * 24 * 3600 * 1000;

const cache = new Map();
const inFlight = new Map();
const upgradeListeners = [];
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
  const ttl = entry.result ? FOUND_TTL_MS : NONE_TTL_MS;
  return Date.now() - entry.at < ttl ? entry.result : undefined;
}

async function writeStored(key, result) {
  const db = await openDb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ v: CACHE_VERSION, at: Date.now(), result }, key);
  } catch (err) {
    // Storage full or unavailable -- the memory cache still works.
  }
}

function cacheKey(query) {
  const mode = query.wordSync ? ':w' : '';
  if (query.trackId) return `id:${query.trackId}${mode}`;
  const { title, artist, album, durationSeconds } = query;
  return [title, artist, album, Math.round(durationSeconds || 0)].map((v) => (v ?? '')).join('\u0001').toLowerCase() + mode;
}

// Called with (trackId, result) when synced lyrics turn up for a track
// whose plain lyrics were already shown.
export function onLyricsUpgraded(callback) {
  upgradeListeners.push(callback);
}

export function getCachedLyrics(query) {
  const key = cacheKey(query);
  return cache.has(key) ? { hit: true, value: cache.get(key) } : { hit: false };
}

// `query.background` (the lyrics search index): skips the memory cache, so
// a whole library's lyrics don't pile up in memory.
export async function fetchLyrics(query) {
  const key = cacheKey(query);
  if (query.background && !cache.has(key)) {
    const stored = await readStored(key);
    if (stored !== undefined) return stored;
    const { result, complete } = await lookupLyrics(query);
    if (complete) writeStored(key, result);
    return result;
  }
  if (cache.has(key)) return cache.get(key);
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = (async () => {
    const stored = await readStored(key);
    if (stored !== undefined) return { result: stored, complete: true };
    const lookup = await lookupLyrics(query, (better) => {
      cache.set(key, better);
      writeStored(key, better);
      upgradeListeners.forEach((cb) => cb(query.trackId, better));
    });
    if (lookup.complete) writeStored(key, lookup.result);
    return lookup;
  })()
    .then(({ result, complete }) => {
      if (cache.get(key)?.synced) return cache.get(key); // upgraded meanwhile
      if (complete) cache.set(key, result);
      return result;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
