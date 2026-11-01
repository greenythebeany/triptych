import { isDesktop, isAndroid } from './platform.js';
import { isDownloaded, getLocalUri } from './downloads.js';

export const RepeatMode = {
  OFF: 'off',
  ALL: 'all',
  ONE: 'one'
};

// Center frequencies (Hz) for the built-in graphic equalizer's peaking
// filters — a standard 5-band spread from sub-bass to presence/air.
export const EQ_BANDS = [60, 250, 1000, 4000, 12000];

// dB gain per band, matching EQ_BANDS' order — hand-tuned starting points,
// not measured curves.
export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0],
  bassBoost: [7, 4, 0, -1, -1],
  noBass: [-8, -5, 0, 1, 1],
  vocalBoost: [-3, -2, 4, 4, 1],
  rock: [5, 3, -2, 3, 4],
  pop: [-1, 2, 4, 2, -1],
  jazz: [3, 2, -1, 2, 3],
  electronic: [5, 3, 0, 2, 5],
  classical: [3, 2, 0, -2, 2]
};

// When to start pre-buffering the next track in the spare <audio> element:
// once the current one is fully downloaded (so the two never compete for a
// slow connection -- a relayed Tailscale link especially), or at the latest
// this many seconds before the end, so gapless playback still has time.
const PRELOAD_DEADLINE_SECONDS = 25;

export class Player {
  constructor(jellyfin, getBitrateKbps = () => 0) {
    this.jellyfin = jellyfin;
    this.getBitrateKbps = getBitrateKbps;

    // Two audio elements so the next track can be pre-buffered (gapless) or
    // crossfaded in while the current one is still playing. `audio` is a
    // getter for whichever is "active" so the rest of the app (seek bar,
    // volume slider, etc.) can keep treating `player.audio` as one stable
    // element without knowing about the swap underneath.
    this._audioA = new Audio();
    this._audioB = new Audio();
    this._activeIsA = true;
    this._wireAudioElement(this._audioA);
    this._wireAudioElement(this._audioB);

    this.baseVolume = 0.25; // matches the 50% default on the (quadratic-taper) volume slider
    this.crossfadeSeconds = 0; // 0 = off, up to 12
    this.replayGainEnabled = false;
    // Id of the track already loaded into the inactive element (a preloaded
    // next track, or the one just skipped away from), or null. Lets
    // next/previous/playAt swap to it instantly instead of a fresh fetch.
    this._inactiveTrackId = null;
    this._transitioning = false;
    this._fadeRAF = null;

    // Shared Web Audio graph (per <audio> element: source -> EQ filter chain
    // -> analyser -> destination), used by both the built-in equalizer and
    // the cat jam beat analyser so they don't fight over the same element —
    // createMediaElementSource() may only be called once per element, ever.
    // Desktop-only: see syncCatJamVisibility() in app.js for why rerouting
    // through Web Audio is unsafe on Android's WebView.
    this._audioCtx = null;
    this._audioGraphs = new WeakMap();
    this.eqEnabled = false;
    this.eqGains = new Array(EQ_BANDS.length).fill(0);

    // A user-adjustable native volume boost on Android (see
    // LoudnessPlugin.java) — android.media.audiofx effects (LoudnessEnhancer
    // here, previously also tried for a real Equalizer) attach to a real
    // playback session, not a hardcoded default, and need
    // MODIFY_AUDIO_SETTINGS declared in the manifest or they fail outright
    // with ERROR_INVALID_OPERATION even with a real session (this app's own
    // silent failure for a while, until that permission was added). No
    // error surfacing here still: a device whose HAL genuinely doesn't
    // support this at all should just quietly get no boost, not a confusing
    // error the user can't act on.
    this._nativeLoudness = isAndroid ? window.Capacitor?.Plugins?.TriptychLoudness : null;
    this._nativeAudioAttempted = false;
    this.loudnessBoostDb = 10; // matches the old hardcoded default, until setLoudnessBoostDb changes it

    // Chromium's own WebView audio pipeline pauses playback on its own the
    // moment Android audio focus is lost (another app's notification
    // sound, switching apps, a brief call ping) — that part isn't
    // optional. Without something reacting to focus being *regained*,
    // though, playback stayed paused indefinitely after any interruption,
    // which is exactly the "stops when backgrounded" bug this fixes: only
    // auto-resume if the pause was actually caused by a focus loss (never
    // override a real, deliberate user pause).
    if (this._nativeLoudness) {
      this._focusAutoPaused = false;
      this._nativeLoudness.requestAudioFocus().catch(() => {});
      this._nativeLoudness.addListener('audioFocusChange', ({ state }) => {
        if (state === 'gain') {
          if (this._focusAutoPaused) {
            this._focusAutoPaused = false;
            this.audio.play().catch((err) => this._logPlayError('focus regain', err));
          }
        } else if (!this.audio.paused) {
          this._focusAutoPaused = true;
        }
      });
    }

    this.queue = [];
    this.originalQueue = [];
    this.currentIndex = -1;
    this.shuffle = false;
    this.repeat = RepeatMode.OFF;
    this.queueSourceId = null; // Id of the album/playlist this queue came from, if any

    this.listeners = {
      trackchange: [],
      trackended: [],
      playstate: [],
      timeupdate: [],
      queuechange: []
    };

    this._applyVolume(this._audioA);
    this._applyVolume(this._audioB);
    this._setupMediaSession();
  }

  // TEMPORARY diagnostic — reported symptom: playback doesn't advance to
  // the next track when the current one ends naturally while the app is
  // backgrounded, only resuming once refocused. Every play() call in this
  // class silently swallows its rejection, so a real failure there (e.g.
  // an autoplay-while-backgrounded restriction, network hiccup, etc.) is
  // indistinguishable from any other cause of the same symptom without
  // this. console.error only, not alert() — this can happen while the app
  // isn't even visible, so a popup would be pointless at best.
  _logPlayError(context, err) {
    console.error(`[player] play() failed (${context}):`, err);
  }

  get audio() {
    return this._activeIsA ? this._audioA : this._audioB;
  }

  get _inactiveAudio() {
    return this._activeIsA ? this._audioB : this._audioA;
  }

  _wireAudioElement(el) {
    el.addEventListener('timeupdate', () => {
      if (el !== this.audio) return;
      this._emit('timeupdate');
      this._updateMediaSessionPosition();
      this._checkForTransition();
    });
    el.addEventListener('play', () => {
      if (el !== this.audio) return;
      this._emit('playstate');
      this._setMediaSessionPlaybackState();
    });
    el.addEventListener('pause', () => {
      if (el !== this.audio) return;
      this._emit('playstate');
      this._setMediaSessionPlaybackState();
    });
    el.addEventListener('ended', () => {
      if (el !== this.audio) return;
      this._onEnded();
    });
    // Setting currentTime directly (seekTo, previous()'s restart-to-0) fires
    // no 'play'/'pause' — nothing else notices the position actually moved.
    // Reuse 'playstate' since its listeners (Discord presence, Connect's
    // session progress report) both need to react to a seek the same way
    // they react to a pause: recompute from the current position.
    el.addEventListener('seeked', () => {
      if (el !== this.audio) return;
      this._emit('playstate');
    });
  }

  // ---------- ReplayGain / volume ----------

  _gainMultiplier(track) {
    if (!this.replayGainEnabled || !track || track.NormalizationGain == null) return 1;
    // NormalizationGain is in dB (ReplayGain-style); clamp so a bad/extreme
    // tag can't make a track silent or blow out the speakers.
    const linear = Math.pow(10, track.NormalizationGain / 20);
    return Math.min(2, Math.max(0.1, linear));
  }

  _applyVolume(el, track = this.currentTrack) {
    el.volume = Math.min(1, Math.max(0, this.baseVolume * this._gainMultiplier(track)));
  }

  setVolume(value) {
    this.baseVolume = Math.min(1, Math.max(0, value));
    if (!this._transitioning) this._applyVolume(this.audio);
  }

  setCrossfadeSeconds(seconds) {
    this.crossfadeSeconds = Math.min(12, Math.max(0, seconds));
  }

  setReplayGainEnabled(enabled) {
    this.replayGainEnabled = !!enabled;
    this._applyVolume(this.audio);
  }

  // ---------- Shared Web Audio graph (equalizer + analyser) ----------

  _ensureAudioGraph(el) {
    if (!isDesktop) return null;
    if (!this._audioCtx) this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume().catch(() => {});
    let graph = this._audioGraphs.get(el);
    if (graph) return graph;
    const source = this._audioCtx.createMediaElementSource(el);
    const filters = EQ_BANDS.map((freq, i) => {
      const filter = this._audioCtx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1;
      filter.gain.value = this.eqEnabled ? this.eqGains[i] : 0;
      return filter;
    });
    const analyser = this._audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(filters[0]);
    for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
    filters[filters.length - 1].connect(analyser);
    analyser.connect(this._audioCtx.destination); // keep normal playback audible
    graph = { source, filters, analyser };
    this._audioGraphs.set(el, graph);
    return graph;
  }

  // Used by the cat jam beat detector — shares this same graph rather than
  // opening its own, since a second createMediaElementSource() on the same
  // element would throw.
  getAnalyser(el = this.audio) {
    return this._ensureAudioGraph(el)?.analyser || null;
  }

  // Desktop uses the Web Audio graph above. Android routes through the
  // native plugin instead (see LoudnessPlugin.java's Equalizer section) --
  // Web Audio's createMediaElementSource() is what the constructor's audio
  // graph comment calls unsafe on Android's WebView (risks silencing real
  // output entirely), so this never touches that path there. iOS has
  // neither yet.
  setEqualizerEnabled(enabled) {
    this.eqEnabled = !!enabled;
    if (isAndroid) {
      this._nativeLoudness?.setEqualizerEnabled({ enabled: this.eqEnabled }).catch(() => {});
      return;
    }
    if (this.eqEnabled) {
      // Build both elements' graphs up front so the setting stays audible
      // across gapless/crossfade swaps between them, not just the active one.
      this._ensureAudioGraph(this._audioA);
      this._ensureAudioGraph(this._audioB);
    }
    this._applyEqGains();
  }

  setEqualizerBand(index, gainDb) {
    if (index < 0 || index >= this.eqGains.length) return;
    this.eqGains[index] = Math.min(12, Math.max(-12, gainDb));
    if (isAndroid) {
      this._nativeLoudness?.setEqualizerBand({ band: index, gainDb: this.eqGains[index] }).catch(() => {});
      return;
    }
    if (this.eqEnabled) this._applyEqGains();
  }

  _applyEqGains() {
    for (const el of [this._audioA, this._audioB]) {
      const graph = this._audioGraphs.get(el);
      if (!graph) continue;
      graph.filters.forEach((filter, i) => {
        filter.gain.value = this.eqEnabled ? this.eqGains[i] : 0;
      });
    }
  }

  // Attempted once, the first time real playback starts (an output stream
  // needs to genuinely exist for a session-0 native effect to attach to at
  // all). No error surfacing: a device whose HAL genuinely doesn't support
  // this should just quietly get no boost, not a confusing error the user
  // can't act on either way.
  _tryNativeLoudnessBoost() {
    if (!this._nativeLoudness || this._nativeAudioAttempted) return;
    this._nativeAudioAttempted = true;
    this._nativeLoudness.setLoudnessGain({ gainMillibels: Math.round(this.loudnessBoostDb * 100) }).catch(() => {});
  }

  // Android only. Takes effect immediately if a real playback session
  // already exists to attach to (see _tryNativeLoudnessBoost above for why
  // one might not yet); otherwise the new value just becomes what gets
  // applied whenever that first attach happens.
  setLoudnessBoostDb(db) {
    this.loudnessBoostDb = Math.min(20, Math.max(0, db));
    if (this._nativeAudioAttempted) {
      this._nativeLoudness?.setLoudnessGain({ gainMillibels: Math.round(this.loudnessBoostDb * 100) }).catch(() => {});
    }
  }

  // ---------- MediaSession (lock-screen / notification controls) ----------
  //
  // Two backends: the plain Web MediaSession API (Electron desktop, browsers)
  // and, on Capacitor native builds, the @capgo/capacitor-media-session
  // plugin — the WebView's own navigator.mediaSession does NOT surface a real
  // Android system notification/foreground service, only real Chrome does,
  // so native builds need the plugin for lock-screen controls and for
  // playback to survive the app going to the background.

  // iOS is the exception: WebKit itself publishes the playing <audio> to
  // iOS's Now Playing (lock screen, Control Center) and fills it from
  // navigator.mediaSession. The plugin writing to the same Now Playing info
  // and remote commands raced with WebKit -- whichever wrote last won, so the
  // controls sometimes lost previous/next or stopped responding.
  _nativeMediaSession() {
    if (typeof window === 'undefined') return null;
    if (window.Capacitor?.getPlatform?.() === 'ios' && 'mediaSession' in navigator) return null;
    return window.Capacitor?.Plugins?.MediaSession || null;
  }

  // Lock screen / headphone play and pause are explicit: toggling could
  // pause when the system asked to play (e.g. after an interruption).
  _remotePlay() {
    if (this.currentTrack && this.audio.paused) this.togglePlay();
  }

  _remotePause() {
    if (!this.audio.paused) this.audio.pause();
  }

  _setupMediaSession() {
    // Windows SMTC button/seek events arrive over IPC (main.js forwards them
    // from the native addon), not through navigator.mediaSession -- Electron
    // never routes real OS media-key presses into the page the way it would
    // for a proper Chrome tab. Wired unconditionally alongside whichever
    // branch below actually applies to this platform.
    window.api?.smtc?.onEvent((event) => {
      switch (event.kind) {
        case 'play': case 'pause': case 'toggle': this.togglePlay(); break;
        case 'next': this.next(true); break;
        case 'previous': this.previous(); break;
        case 'stop': if (!this.audio.paused) this.togglePlay(); break;
        case 'setposition': if (event.positionMs != null) this.seekTo(event.positionMs / 1000); break;
        case 'seekforward': this.seekTo(Math.min(this.audio.duration || Infinity, this.audio.currentTime + 10)); break;
        case 'seekbackward': this.seekTo(Math.max(0, this.audio.currentTime - 10)); break;
        case 'seekby': if (event.positionMs != null) this.seekTo(Math.max(0, this.audio.currentTime + event.positionMs / 1000)); break;
      }
    });

    const native = this._nativeMediaSession();
    if (native) {
      native.setActionHandler({ action: 'play' }, () => this._remotePlay());
      native.setActionHandler({ action: 'pause' }, () => this._remotePause());
      native.setActionHandler({ action: 'previoustrack' }, () => this.previous());
      native.setActionHandler({ action: 'nexttrack' }, () => this.next(true));
      native.setActionHandler({ action: 'seekto' }, (details) => {
        if (details?.seekTime != null) this.seekTo(details.seekTime);
      });
      native.setActionHandler({ action: 'seekbackward' }, () => {
        this.seekTo(Math.max(0, this.audio.currentTime - 10));
      });
      native.setActionHandler({ action: 'seekforward' }, () => {
        this.seekTo(Math.min(this.audio.duration || Infinity, this.audio.currentTime + 10));
      });
      return;
    }
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => this._remotePlay());
    navigator.mediaSession.setActionHandler('pause', () => this._remotePause());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
    navigator.mediaSession.setActionHandler('nexttrack', () => this.next(true));
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) this.seekTo(details.seekTime);
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      this.seekTo(Math.max(0, this.audio.currentTime - (details.seekOffset || 10)));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      this.seekTo(Math.min(this.audio.duration || Infinity, this.audio.currentTime + (details.seekOffset || 10)));
    });
  }

  _updateMediaSessionMetadata() {
    const track = this.currentTrack;
    const artist = track ? ((track.Artists && track.Artists.length ? track.Artists.join(', ') : track.AlbumArtist) || '') : '';
    // Each declared size needs to actually BE that size — every entry
    // pointed at the same fixed-resolution URL before, just relabeled, so
    // an OS picking the "96x96" entry for a small icon (or "512x512" for a
    // blurred background) actually got whatever the real image's fixed
    // size was regardless. That mismatch is a plausible cause of the
    // distorted-looking artwork seen on a phone's cross-device media
    // controls for a desktop session. Jellyfin resizes server-side via its
    // own maxSize param, so this asks for a real image at each size.
    //
    // Largest first: the standard Web MediaSession API picks by matching
    // `sizes` to the actual display context regardless of array order, but
    // the native Android plugin (@capgo/capacitor-media-session) doesn't
    // parse `sizes` at all — it just uses artwork[0] unconditionally. With
    // ascending order that was the 96x96 entry, stretched to fill the much
    // larger notification/lock-screen art area — hence the pixelation.
    const artwork = track
      ? [512, 384, 256, 192, 96].map((size) => ({ src: this.jellyfin.imageUrl(track, 'Primary', size), sizes: `${size}x${size}`, type: 'image/jpeg' })).filter((a) => a.src)
      : [];

    // Windows SMTC (via the native addon -- see main.js/native/smtc): a
    // separate sink from the Web MediaSession API below, since Electron's
    // Chromium build never bridges navigator.mediaSession to the OS on
    // Windows the way real Chrome does. Runs alongside, not instead of, the
    // branches below so Capacitor/browser builds are unaffected.
    window.api?.smtc?.setMetadata({
      title: track?.Name || '',
      artist,
      album: track?.Album || '',
      coverUrl: track ? this.jellyfin.imageUrl(track, 'Primary', 512) : null,
      durationMs: track?.RunTimeTicks ? track.RunTimeTicks / 10000 : null
    });

    const native = this._nativeMediaSession();
    if (native) {
      native.setMetadata({ title: track?.Name || '', artist, album: track?.Album || '', artwork }).catch(() => {});
      return;
    }
    if (!('mediaSession' in navigator)) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const local = artwork.find((a) => a.src.startsWith('tlocal:'));
    if (!local) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: track.Name || '', artist, album: track.Album || '', artwork });
      return;
    }
    // MediaMetadata only takes http(s)/data/blob images, so a cover from a
    // file on this device (tlocal://, see localLibrary.js) goes in as a blob.
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.Name || '', artist, album: track.Album || '' });
    fetch(local.src).then((res) => res.blob()).then((blob) => {
      if (this.currentTrack !== track) return;
      if (this._mediaSessionBlobUrl) URL.revokeObjectURL(this._mediaSessionBlobUrl);
      this._mediaSessionBlobUrl = URL.createObjectURL(blob);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.Name || '', artist, album: track.Album || '',
        artwork: [{ src: this._mediaSessionBlobUrl, sizes: '512x512', type: 'image/jpeg' }]
      });
    }).catch(() => {});
  }

  _setMediaSessionPlaybackState() {
    const state = this.audio.paused ? 'paused' : 'playing';
    window.api?.smtc?.setPlayback(state, this.audio.currentTime * 1000);

    const native = this._nativeMediaSession();
    if (native) {
      native.setPlaybackState({ playbackState: state }).catch(() => {});
      return;
    }
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = state;
  }

  _updateMediaSessionPosition() {
    const duration = this.audio.duration;
    if (!isFinite(duration) || duration <= 0) return;
    const position = Math.min(this.audio.currentTime, duration);
    const playbackRate = this.audio.playbackRate || 1;

    const native = this._nativeMediaSession();
    if (native) {
      native.setPositionState({ duration, playbackRate, position }).catch(() => {});
      return;
    }
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate, position });
    } catch (err) {
      // Some WebView versions throw if called with stale/invalid state; harmless to skip.
    }
  }

  on(event, callback) {
    this.listeners[event]?.push(callback);
  }

  _emit(event, payload) {
    // A queued song that starts playing has been "used up": drop its mark,
    // or a later shuffle could land it back among the pending ones.
    if (event === 'trackchange' && this.currentTrack?.__queued) delete this.currentTrack.__queued;
    this.listeners[event]?.forEach((cb) => cb(payload));
  }

  get currentTrack() {
    return this.currentIndex >= 0 ? this.queue[this.currentIndex] : null;
  }

  setQueue(tracks, startIndex = 0, sourceId = null) {
    this._cancelTransition();
    // Songs the user queued and hasn't heard yet carry over to the new
    // album/playlist, still next in line (like Spotify).
    const pending = this.pendingQueued();
    this.originalQueue = [...tracks];
    this.queue = this.shuffle ? this._shuffled(tracks) : [...tracks];
    const startTrackId = tracks[startIndex]?.Id;
    this.currentIndex = this.shuffle ? this.queue.findIndex((t) => t.Id === startTrackId) : startIndex;
    if (pending.length && this.currentIndex >= 0) {
      this.queue.splice(this.currentIndex + 1, 0, ...pending);
      this.originalQueue.splice(startIndex + 1, 0, ...pending);
    }
    this.queueSourceId = sourceId;
    this._emit('queuechange');
    this._loadCurrent(true);
  }

  // ---------- "Add to queue" ----------
  // Songs added with "Add to queue" are their own entries, marked
  // `__queued`, and form a block right after the current song. New ones
  // join the END of that block, so they play in the order they were added,
  // before the rest of the album/playlist ("Next up").

  // Index just past the queued block (= currentIndex + 1 when it's empty).
  _queuedBlockEnd() {
    let i = this.currentIndex + 1;
    while (i < this.queue.length && this.queue[i]?.__queued) i++;
    return i;
  }

  pendingQueued() {
    if (this.currentIndex < 0) return [];
    return this.queue.slice(this.currentIndex + 1, this._queuedBlockEnd());
  }

  clearQueued() {
    const pending = this.pendingQueued();
    if (!pending.length) return;
    this.queue.splice(this.currentIndex + 1, pending.length);
    this.originalQueue = this.originalQueue.filter((e) => !pending.includes(e));
    this._emit('queuechange');
  }

  // Puts back a queue saved from a previous session (see the resume code in
  // app.js): same order, same song, same position, but paused -- the user
  // presses play to carry on.
  restoreQueue(tracks, index, positionSeconds = 0, { shuffle = false, repeat } = {}) {
    if (!tracks?.length) return;
    this._cancelTransition();
    this.queue = [...tracks];
    this.originalQueue = [...tracks];
    this.shuffle = !!shuffle;
    if (repeat) this.repeat = repeat;
    this.currentIndex = Math.min(Math.max(0, index || 0), tracks.length - 1);
    this.queueSourceId = null;
    this._emit('queuechange');
    const el = this.audio;
    if (positionSeconds > 1) {
      const seek = () => { try { el.currentTime = positionSeconds; } catch (err) { /* not seekable yet */ } };
      el.addEventListener('loadedmetadata', seek, { once: true });
    }
    this._loadCurrent(false);
  }

  // Inserts a single track to play right after whatever's currently
  // playing (not appended at the end) — if nothing is playing yet, this
  // just starts it instead. Also inserted into originalQueue at the
  // equivalent position, so it stays right after the same track if the
  // user later turns shuffle off.
  enqueue(track) {
    // A copy, so the flag never leaks onto the shared library track object.
    const entry = { ...track, __queued: true };
    if (this.currentIndex < 0 || !this.queue.length) {
      this.setQueue([entry], 0);
      return;
    }
    const at = this._queuedBlockEnd();
    const before = this.queue[at - 1];
    this.queue.splice(at, 0, entry);
    const originalIdx = this.originalQueue.indexOf(before);
    this.originalQueue.splice(originalIdx >= 0 ? originalIdx + 1 : this.originalQueue.length, 0, entry);
    this._emit('queuechange');
  }

  // Removes one queue entry by its position in the (possibly shuffled)
  // queue. Refuses to remove the currently playing track — swipe-to-remove
  // is for upcoming/past entries, not what's actively playing.
  removeFromQueueAt(index) {
    if (index < 0 || index >= this.queue.length || index === this.currentIndex) return;
    const [removed] = this.queue.splice(index, 1);
    const originalIdx = this.originalQueue.indexOf(removed);
    if (originalIdx >= 0) this.originalQueue.splice(originalIdx, 1);
    if (index < this.currentIndex) this.currentIndex -= 1;
    this._emit('queuechange');
  }

  // Moves one upcoming queue entry to a new position. Like removeFromQueueAt,
  // this only touches "Up Next" — moving the currently playing entry itself
  // isn't a meaningful operation here.
  reorderQueueAt(fromIndex, toIndex) {
    if (
      fromIndex < 0 || fromIndex >= this.queue.length ||
      toIndex < 0 || toIndex >= this.queue.length ||
      fromIndex === toIndex ||
      fromIndex === this.currentIndex || toIndex === this.currentIndex
    ) return;
    let [moved] = this.queue.splice(fromIndex, 1);
    // Dropped inside the "Next in queue" block -> becomes a queued song;
    // dragged out of it -> a normal one.
    const blockEnd = this._queuedBlockEnd() - (fromIndex < this.currentIndex ? 1 : 0);
    const intoBlock = toIndex > this.currentIndex - (fromIndex < this.currentIndex ? 1 : 0) && toIndex <= blockEnd;
    if (intoBlock && !moved.__queued) {
      const copy = { ...moved, __queued: true };
      const oi = this.originalQueue.indexOf(moved);
      if (oi >= 0) this.originalQueue[oi] = copy;
      moved = copy;
    } else if (!intoBlock && moved.__queued) {
      delete moved.__queued;
    }
    this.queue.splice(toIndex, 0, moved);
    if (fromIndex < this.currentIndex && toIndex >= this.currentIndex) this.currentIndex -= 1;
    else if (fromIndex > this.currentIndex && toIndex <= this.currentIndex) this.currentIndex += 1;
    // Unshuffled, the queue IS the original order -- keep it in sync so a
    // later shuffle on/off round-trip doesn't undo the reorder.
    if (!this.shuffle) this.originalQueue = [...this.queue];
    this._emit('queuechange');
  }

  _shuffled(tracks) {
    const arr = [...tracks];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  toggleShuffle() {
    this._cancelTransition();
    const current = this.currentTrack;
    // Queued songs aren't shuffled in -- they stay next, in order.
    const pending = this.pendingQueued();
    const base = this.originalQueue.filter((e) => !pending.includes(e));
    this.shuffle = !this.shuffle;
    this.queue = this.shuffle ? this._shuffled(base) : [...base];
    this.currentIndex = current ? this.queue.indexOf(current) : -1;
    if (this.currentIndex < 0 && current) this.currentIndex = this.queue.findIndex((t) => t.Id === current.Id);
    if (pending.length && this.currentIndex >= 0) this.queue.splice(this.currentIndex + 1, 0, ...pending);
    this._emit('queuechange');
  }

  cycleRepeat() {
    const order = [RepeatMode.OFF, RepeatMode.ALL, RepeatMode.ONE];
    const next = order[(order.indexOf(this.repeat) + 1) % order.length];
    this.repeat = next;
    return next;
  }

  _loadCurrent(autoplay) {
    this._cancelTransition();
    const track = this.currentTrack;
    if (!track) return;
    const el = this.audio;

    if (isDownloaded(track.Id)) {
      // Resolving a local URI is async even on desktop (kept consistent
      // with Android's native filesystem bridge) — metadata/trackchange
      // still fire immediately below so the UI updates without waiting.
      getLocalUri(track.Id).then((uri) => {
        if (this.currentTrack?.Id !== track.Id || el !== this.audio) return; // stale by the time this resolved
        el.src = uri || this.jellyfin.streamUrl(track, this.getBitrateKbps());
        this._applyVolume(el, track);
        if (autoplay) el.play().then(() => this._tryNativeLoudnessBoost()).catch((err) => this._logPlayError('_loadCurrent (downloaded)', err));
      });
    } else {
      el.src = this.jellyfin.streamUrl(track, this.getBitrateKbps());
      this._applyVolume(el, track);
      if (autoplay) el.play().then(() => this._tryNativeLoudnessBoost()).catch((err) => this._logPlayError('_loadCurrent (stream)', err));
    }

    this._updateMediaSessionMetadata();
    this._setMediaSessionPlaybackState();
    this._emit('trackchange');
  }

  playAt(index) {
    if (index < 0 || index >= this.queue.length) return;
    this._cancelTransition();
    // Jumping past the queued songs (tapping something further down "Next
    // up") keeps them next in line instead of leaving them behind.
    const blockEnd = this._queuedBlockEnd();
    if (index >= blockEnd && blockEnd > this.currentIndex + 1) {
      const pending = this.queue.splice(this.currentIndex + 1, blockEnd - this.currentIndex - 1);
      index -= pending.length;
      this.queue.splice(index + 1, 0, ...pending);
    }
    if (index !== this.currentIndex && this._swapToInactive(index)) return;
    this.currentIndex = index;
    this._loadCurrent(true);
  }

  togglePlay() {
    if (!this.currentTrack) return;
    if (this.audio.paused) this.audio.play().catch((err) => this._logPlayError('togglePlay', err));
    else this.audio.pause();
  }

  next(userTriggered = true) {
    this._cancelTransition();
    if (this.queue.length === 0) return;
    if (this.repeat === RepeatMode.ONE && !userTriggered) {
      this._loadCurrent(true);
      return;
    }
    let nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.queue.length) {
      if (this.repeat === RepeatMode.ALL) nextIndex = 0;
      else return this._stopAtEnd();
    }
    if (this._swapToInactive(nextIndex)) return;
    this.currentIndex = nextIndex;
    this._loadCurrent(true);
  }

  // skipRestart: always go to the previous track (swipe gesture), instead
  // of restarting the current one when it's more than 3s in (the button).
  previous(skipRestart = false) {
    this._cancelTransition();
    if (this.queue.length === 0) return;
    if (!skipRestart && this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }
    let prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) prevIndex = this.repeat === RepeatMode.ALL ? this.queue.length - 1 : 0;
    if (prevIndex !== this.currentIndex && this._swapToInactive(prevIndex)) return;
    this.currentIndex = prevIndex;
    this._loadCurrent(true);
  }

  _onEnded() {
    // A crossfade is timed off periodic timeupdate polling, not the audio
    // element's exact real end — so the outgoing element's genuine 'ended'
    // event can fire a beat before the fade's own RAF loop finishes. If we
    // let that fall through to next()/_loadCurrent() here, it reloads the
    // incoming track from scratch, discarding the fade already in progress
    // and audibly restarting it. The fade's own completion (in
    // _beginCrossfade's step()) already advances the queue once it's done —
    // just let it finish.
    if (this._transitioning) return;

    // The <audio> element's own 'ended' event only fires when a track has
    // genuinely played to its natural end — unlike 'trackchange', which also
    // fires on manual skips. This is the one place that should count as a
    // real, completed play (server-side PlayCount, stats, etc.).
    this._emit('trackended', this.currentTrack);

    // If the next track is already buffered in the inactive element, swap
    // to it instantly (gapless) instead of doing a fresh network fetch.
    if (this.crossfadeSeconds === 0) {
      const autoIndex = this._autoNextIndex();
      if (autoIndex >= 0 && this._swapToInactive(autoIndex)) return;
    }
    this.next(false);
  }

  _stopAtEnd() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this._emit('playstate');
  }

  seekTo(seconds) {
    this.audio.currentTime = seconds;
  }

  // ---------- Gapless preloading / crossfade ----------

  _peekNextTrack() {
    if (this.repeat === RepeatMode.ONE) return this.queue[this.currentIndex];
    let nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.queue.length) {
      if (this.repeat === RepeatMode.ALL) nextIndex = 0;
      else return null;
    }
    return this.queue[nextIndex] || null;
  }

  _advanceIndexForNext() {
    if (this.repeat === RepeatMode.ONE) return;
    let nextIndex = this.currentIndex + 1;
    if (nextIndex >= this.queue.length) nextIndex = 0; // only reachable when repeat === ALL, per _peekNextTrack
    this.currentIndex = nextIndex;
  }

  // Index auto-advance would move to (same rules as _peekNextTrack), or -1.
  _autoNextIndex() {
    if (this.repeat === RepeatMode.ONE) return this.currentIndex;
    const nextIndex = this.currentIndex + 1;
    if (nextIndex < this.queue.length) return nextIndex;
    return this.repeat === RepeatMode.ALL && this.queue.length ? 0 : -1;
  }

  // Makes queue[index] current by swapping to the inactive element, if that
  // track is what it already holds. The outgoing element keeps its track,
  // so skipping straight back is instant too. Returns false (caller does a
  // normal _loadCurrent) when there's nothing usable buffered.
  _swapToInactive(index) {
    const track = this.queue[index];
    const incoming = this._inactiveAudio;
    if (!track || this._inactiveTrackId !== track.Id || !incoming.src || incoming.error) return false;
    const outgoing = this.audio;
    this._inactiveTrackId = this.currentTrack?.Id || null;
    this.currentIndex = index;
    this._activeIsA = !this._activeIsA;
    outgoing.pause();
    if (incoming.currentTime) incoming.currentTime = 0;
    this._applyVolume(incoming, track);
    incoming.play().then(() => this._tryNativeLoudnessBoost()).catch((err) => {
      this._logPlayError('_swapToInactive', err);
      // Buffered element turned out not to be playable -- currentIndex is
      // already right, so just load this track fresh.
      if (this.audio === incoming) this._loadCurrent(true);
    });
    this._updateMediaSessionMetadata();
    this._setMediaSessionPlaybackState();
    this._emit('trackchange');
    return true;
  }

  _checkForTransition() {
    const el = this.audio;
    const duration = el.duration;
    if (!isFinite(duration) || duration <= 0 || el.paused) return;
    const remaining = duration - el.currentTime;

    if (this._transitioning) return;
    if (this.crossfadeSeconds > 0 && remaining <= this.crossfadeSeconds) {
      this._beginCrossfade();
    } else if (this._isFullyBuffered(el) || remaining <= PRELOAD_DEADLINE_SECONDS) {
      this._preloadNext();
    }
  }

  _isFullyBuffered(el) {
    const ranges = el.buffered;
    if (!ranges || !ranges.length || !isFinite(el.duration)) return false;
    // The range holding the playhead reaches (nearly) the end of the file.
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= el.currentTime + 0.5 && ranges.end(i) >= el.duration - 0.5) return true;
    }
    return false;
  }

  _preloadNext() {
    const nextTrack = this._peekNextTrack();
    const inactive = this._inactiveAudio;
    if (!nextTrack || (this._inactiveTrackId === nextTrack.Id && !inactive.error)) return;
    // Downloaded tracks load from local storage near-instantly anyway.
    if (isDownloaded(nextTrack.Id)) return;
    const url = this.jellyfin.streamUrl(nextTrack, this.getBitrateKbps());
    this._inactiveTrackId = nextTrack.Id;
    inactive.preload = 'auto';
    inactive.src = url;
    this._applyVolume(inactive, nextTrack);
    inactive.load();
    // Forget it the moment the preload fails (network hiccup, etc.), so a
    // skip does a fresh load and the next timeupdate can retry.
    inactive.addEventListener('error', () => {
      if (inactive.src === url && this._inactiveTrackId === nextTrack.Id) this._inactiveTrackId = null;
    }, { once: true });
  }

  _beginCrossfade() {
    const nextTrack = this._peekNextTrack();
    if (!nextTrack) return;
    this._transitioning = true;
    const outgoingTrack = this.currentTrack;

    const outgoing = this.audio;
    const incoming = this._inactiveAudio;
    // Reuse the early preload if it's this track, rather than refetching.
    if (this._inactiveTrackId !== nextTrack.Id || incoming.error || !incoming.src) {
      incoming.src = this.jellyfin.streamUrl(nextTrack, this.getBitrateKbps());
    }
    this._inactiveTrackId = null;
    incoming.currentTime = 0;
    incoming.volume = 0;
    incoming.play().catch((err) => this._logPlayError('_beginCrossfade', err));

    const fadeMs = this.crossfadeSeconds * 1000;
    const outgoingTarget = outgoing.volume;
    const incomingTarget = Math.min(1, Math.max(0, this.baseVolume * this._gainMultiplier(nextTrack)));
    const startedAt = performance.now();

    const step = () => {
      const t = Math.min(1, (performance.now() - startedAt) / fadeMs);
      outgoing.volume = outgoingTarget * (1 - t);
      incoming.volume = incomingTarget * t;
      if (t < 1) {
        // setTimeout, not requestAnimationFrame: rAF callbacks simply never
        // fire while the page/WebView is hidden (backgrounded app), so a
        // crossfade started right before backgrounding would freeze here
        // forever with _transitioning stuck true — which made _onEnded()
        // ignore the outgoing track's real 'ended' event too, stalling
        // playback dead until the app was refocused. setTimeout still runs
        // in the background (just throttled to ~1/s by the browser), and
        // since `t` is computed off real elapsed time rather than tick
        // count, a chunkier background cadence still fades correctly.
        this._fadeRAF = setTimeout(step, 16);
        return;
      }
      outgoing.pause();
      outgoing.currentTime = 0;
      this._emit('trackended', outgoingTrack);
      const incomingFailed = !!incoming.error;
      this._advanceIndexForNext();
      this._activeIsA = !this._activeIsA;
      this._transitioning = false;
      this._inactiveTrackId = outgoingTrack?.Id || null;
      this._fadeRAF = null;
      this._updateMediaSessionMetadata();
      this._setMediaSessionPlaybackState();
      this._emit('trackchange');
      // The fade completes on a timer regardless of whether `incoming`
      // actually loaded/played — if it silently failed, currentIndex is
      // already correctly advanced, so just retry loading that track fresh
      // instead of leaving playback stuck on a broken element.
      if (incomingFailed) this._loadCurrent(true);
    };
    this._fadeRAF = setTimeout(step, 16);
  }

  _cancelTransition() {
    if (this._fadeRAF) clearTimeout(this._fadeRAF);
    this._fadeRAF = null;
    if (this._transitioning) {
      // A manual skip mid-crossfade: stop whichever element was fading in
      // on the side that's about to become inactive again. It's part-way
      // into the next track, so don't treat it as a clean preload.
      this._inactiveAudio.pause();
      this._inactiveTrackId = null;
    }
    this._transitioning = false;
  }
}
