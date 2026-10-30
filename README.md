<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/triptych-dark.png" />
    <img src="brand/triptych-light.png" width="120" alt="Triptych logo" />
  </picture>
</p>

<h1 align="center">Triptych</h1>
<p align="center">A sleek, Spotify-styled music client for your own Jellyfin server.</p>

<p align="center">
  <a href="https://github.com/greenythebeany/triptych/releases">
    <img src="download_icon.png" alt="Download Triptych" height="160">
  </a>
</p>

<p align="center">
  <sub>More on the <a href="https://triptych.greenybeany.dev/">Triptych website</a></sub>
</p>

---

Triptych is a personal music client for a self-hosted Jellyfin server. It logs into your own server with your own library and gives you a modern, Spotify-like listening experience across desktop and Android, without any of the server-side bloat of a general-purpose media app.

## Showcase

https://github.com/user-attachments/assets/4d5fa0a4-d05b-4bf4-8921-1810018c48fb



## Features

- Full library browsing: Home, Search, All Songs, Liked Songs, Genres, Albums, Artists, and Playlists
- Gapless playback with optional crossfade (0-12 seconds) between tracks
- ReplayGain-based volume normalization, using loudness data from your server
- Lyrics for the currently playing track, from lrclib.net, your own Jellyfin server, or lyrics.ovh
- Queue view with shuffle and repeat modes
- Native lock-screen and notification media controls on Android, including playback that survives the app going to the background
- Discord Rich Presence on desktop: shows what you're currently listening to, with cover art
- Custom CSS support for further tweaking the look of the app, including a set of ready-made community color schemes (see [Themes](#themes) below)
- Three interface styles (Spotify, Apple Music or Nothing), light and dark themes, a choice of accent colors, plus a blurred cover-art background option
- "Jam on paw level": an optional cat that bounces along with the actual bass of whatever's playing
- 15 language translations (English, French, German, Slovak, Czech, Spanish, Polish, Russian, Ukrainian, Norwegian, Swedish, Finnish, Danish, Dutch, Italian) with more welcome via contribution
- Desktop app built with Electron, Android app built with Capacitor, with one-click in-app updates on desktop

## Installation

Grab the latest build from the [Releases](https://github.com/greenythebeany/triptych/releases/latest) page:

- **Windows**: download and run the installer (`.exe`)
- **Android**: download the `.apk` and install it (you will need to allow installs from your browser or file manager the first time)

On first launch, enter the address of your own Jellyfin server and sign in with your Jellyfin account.

## Themes

Triptych ships a handful of built-in accent palettes, but you can also drop in a full community color scheme through **Settings → Advanced → Custom CSS** — paste one line in and it takes effect immediately, no restart needed:

| Preview | Theme | `@import` line |
| --- | --- | --- |
| ![Catppuccin Mocha](src/themes/previews/catppuccin-mocha.png) | Catppuccin Mocha | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/catppuccin-mocha.css');` |
| ![Catppuccin Macchiato](src/themes/previews/catppuccin-macchiato.png) | Catppuccin Macchiato | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/catppuccin-macchiato.css');` |
| ![Catppuccin Frappé](src/themes/previews/catppuccin-frappe.png) | Catppuccin Frappé | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/catppuccin-frappe.css');` |
| ![Catppuccin Latte](src/themes/previews/catppuccin-latte.png) | Catppuccin Latte | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/catppuccin-latte.css');` |
| ![Dracula](src/themes/previews/dracula.png) | Dracula | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/dracula.css');` |
| ![Nord](src/themes/previews/nord.png) | Nord | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/nord.css');` |
| ![Gruvbox Dark](src/themes/previews/gruvbox-dark.png) | Gruvbox Dark | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/gruvbox-dark.css');` |
| ![Gruvbox Light](src/themes/previews/gruvbox-light.png) | Gruvbox Light | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/gruvbox-light.css');` |
| ![Tokyo Night](src/themes/previews/tokyonight.png) | Tokyo Night | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/tokyonight.css');` |
| ![Rosé Pine](src/themes/previews/rose-pine.png) | Rosé Pine | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/rose-pine.css');` |
| ![Rosé Pine Moon](src/themes/previews/rose-pine-moon.png) | Rosé Pine Moon | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/rose-pine-moon.css');` |
| ![Rosé Pine Dawn](src/themes/previews/rose-pine-dawn.png) | Rosé Pine Dawn | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/rose-pine-dawn.css');` |
| ![Kanagawa](src/themes/previews/kanagawa.png) | Kanagawa | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/kanagawa.css');` |
| ![Solarized Dark](src/themes/previews/solarized-dark.png) | Solarized Dark | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/solarized-dark.css');` |
| ![Solarized Light](src/themes/previews/solarized-light.png) | Solarized Light | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/solarized-light.css');` |
| ![system24](src/themes/previews/system24.png) | system24-inspired | `@import url('https://cdn.jsdelivr.net/gh/greenythebeany/triptych@main/src/themes/system24.css');` |

The theme source files live in [`src/themes/`](src/themes/) if you want to tweak one or build your own.

### Making your own theme

Start from [`src/themes/template.css`](src/themes/template.css) — it lists every CSS custom property the app's colors are built from, with a short comment on what each one controls. Fill in your colors, paste the whole thing into Settings → Advanced → Custom CSS to preview it live, and once you're happy, save it as `src/themes/your-theme-name.css` and open a PR to get it listed in the table above.

## Discord Rich Presence

On desktop, Triptych shows your currently playing track on your Discord profile, with cover art. It connects to your local Discord client automatically — the one extra step is authorizing the app once via **Settings → Audio → Discord Rich Presence → Connect** (or open [this link](https://discord.com/oauth2/authorize?client_id=1534197353056174180) directly).

Cover art is looked up externally by artist/album rather than pulled from your Jellyfin server, since Discord requires images to be served over HTTPS and most self-hosted Jellyfin setups are plain HTTP/LAN-only.

## Building from source

```bash
npm install
npm start          # run the desktop app
npm run dist        # build a Windows installer
```

The Android project lives in `android/` and is a standard Capacitor project — open it in Android Studio, or build from the command line with `./gradlew assembleRelease` after setting up your own signing keystore in `android/keystore/keystore.properties`.

## What's new in 2.3.0

- Triptych now has its own app id (`com.triptych.app`) everywhere, so nothing is called JellyWave anymore
  - **Windows / Linux**: update as usual. Your data folder moves from `JellyWave` to `Triptych` on the first start, and the installer removes the old JellyWave entry; login, settings, downloads and stats stay
  - **Android / iPhone**: Triptych installs as a new app next to JellyWave. Sign in once, then uninstall JellyWave. Settings and listening stats come back from your server; downloaded songs have to be downloaded again
- A new Windows installer: Triptych artwork, a welcome page in your language, and the license agreement to accept

## What's new in 2.2.0

- JellyWave is now **Triptych**: new name, new logo (three bars; in the app the right one takes your accent colour). Your login, settings, downloads and listening stats carry over, and 2.1.0 updates to it like any other version
- Every language fully translated: all 15 languages now cover every screen, setting and message (Wrapped, Import, Storage, the legal menu and more), instead of falling back to English
- Listening calendar by month: each month is its own labelled block, and the calendar wraps on phones instead of needing a sideways scroll

## What's new in 2.1.0

- Search by lyrics: turn it on in Settings → Privacy and Triptych quietly indexes your library's lyrics on your device; then type a line you remember in Search to find the song ("Found in lyrics", with the matching line)
- Listening calendar on the Stats page: a dot for every day of the year, brighter the more you listened, with your number of listening days and longest streak
- Total length on albums, playlists, mixes, Liked Songs and Downloads ("19 songs · 1 hr 14 min")
- Only real plays count: a song counts once at least half of it (or 4 minutes) was heard; skipped songs no longer add plays or leave a resume point
- Listening time no longer shows 0 after an update or reinstall: only one Triptych runs at a time, Stats waits for your other devices' time, and it syncs every 30 seconds and right before an update
- Searching an artist shows them once, not every "feat." / "&" collaboration as a separate artist
- Discord: the cover art now reliably shows on your status for everyone (fewer, combined updates so Discord doesn't drop them)
- Desktop: the window remembers its size, position and maximized state

## What's new in 2.0.7

- Nothing style, light mode: the back/forward arrows at the top of artist pages no longer disappear over the artist photo

## What's new in 2.0.6

- Nothing style: a new "Dotted sliders" switch (Settings → Appearance) turns the dotted seek and volume bars into plain lines, and back

## What's new in 2.0.5

- A third interface style, Nothing, inspired by Nothing OS: black, white and grey with one red accent (which follows the accent color you pick), dot-matrix headings, titles and lyrics, small monospaced labels, thin outline icons, rounded widget-style cards and Settings groups, dotted seek and volume bars, and a full-screen player on a faint dot grid whose cover shrinks while paused
- Small phones (down to 320 x 568, like the iPhone SE): the full-screen player keeps the cover big and tightens the header, title and controls instead, so the volume slider and lyrics are no longer pushed off the bottom, in every style
- Settings on narrow screens: rows with button groups (Theme, Interface style) stack, with the buttons in one even row instead of wrapping
- iPhone: music keeps playing in the background and with the silent switch on, the lock screen / Control Center player always has previous/next and responds, and the volume slider follows the volume buttons again after calls, Siri or switching apps
- Lock screen and headphone play/pause now do exactly what was pressed (they used to toggle)

## What's new in 2.0.4

- A Spotify-style queue: songs you add play in the order you added them, before the rest of the album or playlist, shown separately under "Next in queue" (with a Clear button). They survive starting a new album, shuffling and jumping ahead. While you drag a song to reorder, the other upcoming songs dim
- Automatic streaming quality now actually adapts: it measures your connection and picks original quality or 320/192/96 kbps, re-checking every few minutes and when the network changes (Settings shows what it's using)
- Faster on slow connections: cover images are requested at the size they're shown on your screen, and the next song only preloads once the current one is fully downloaded
- Phones: the "Automatic update check" switch now shows and is respected; Settings no longer shows empty section headings
- Settings layout fixes (long dropdown options, the About credits)

## What's new in 2.0.3

- Pick up where you left off: the queue, song and position are restored (paused) the next time you open Triptych
- A smarter Home: Jump Back In, "Because you listened to…" and Newly Added rows
- Wrapped: on December 31 your year in music arrives as a tap-through story (minutes listened, a drumroll for your top artist over their own background and logo, top songs, biggest month), and stays on Home/Stats until January 7
- Real listening time: stats count the seconds you actually listen, summed across your devices, instead of plays × track length
- Settings → Storage: see and clear downloaded songs; haptic feedback can be turned off on phones
- Fixed the phone's lyrics sheet sometimes showing an old queue above the lyrics, and icons sitting slightly high in their buttons

## What's new in 2.0.2

- Accent colors are back, for both interface styles: Default (Spotify green / Apple red), Blue, Green, Red, Magenta, Purple, Pink, Orange, Yellow, Teal, Brown and Monochrome
- More lyrics sources: if lrclib.net doesn't have a song, Triptych now also checks your own Jellyfin server's lyrics (`.lrc` files / embedded lyrics) and then lyrics.ovh
- Phone volume: the slider now follows the volume buttons instantly on Android, and controls and follows the iPhone's volume on iOS
- iPhone: logging in with a server IP address (e.g. a Tailscale `100.x` address) now works, not just a hostname
- Library is now a clean list (icon, name, chevron) in both styles, and genre tiles lose their gradient
- Apple Music style: shuffle and repeat clearly show when they're on
- Tap the top of the phone's full-screen player to close it
- Fixed the language dropdown showing white-on-white, a hidden switch knob with Monochrome, and the like heart sitting slightly high

## What's new in 2.0.1

- Artist pages: the banner now runs up behind the top bar in the Apple Music style too, and the back/forward and profile buttons get a dark backing over the photo so they stay readable
- Apple Music style: smoother volume and seek sliders (the fill now tracks your finger exactly), and song lists without the alternating row stripes
- Centered the like icon in the full-screen player
- The "What's new" popup now also shows when updating straight from 1.0.x to a later 2.x version
- Updated screenshots

## What's new in 2.0.0

A big one. Highlights:

**New look**
- Interface style setting (Settings → Appearance): the existing Spotify look, or a new Apple Music look with frosted glass, bare rounded artwork, slim pill sliders, a floating mini-player and a full-screen player built around the blurred cover
- Each style has its own default accent (Spotify green / Apple red); the community [Themes](#themes) recolor either style
- Open animations for popups, menus, pages and the player, and a loading screen on start instead of the login form flashing up

**Player**
- Instant skipping: the next song buffers in the background, so Next (and going straight back) starts immediately
- The queue slides up as a sheet from the bottom of the player on desktop and phones; the desktop side panel always shows lyrics, and phones get a full-size lyrics sheet
- Phone gestures: swipe the cover for next/previous, swipe down to close the player, pull down any page to refresh it
- Long song titles scroll instead of being cut off, and the mini-player has previous/next buttons
- Android: the volume slider controls the phone's media volume and follows the volume buttons
- Desktop keyboard shortcuts: Space to play/pause, Ctrl + ← / → for previous/next

**Updates and reliability**
- One-click updates on desktop: new versions download, get verified and install from inside the app, which closes itself cleanly for the installer
- Starting offline goes straight to Downloads instead of an empty Home
- Lyrics retry when the lyrics service is flaky, are remembered for the session, and show a Retry button instead of a false "No lyrics found"
- A "What's new" popup on the first launch after an update
- Fixed the track menu opening while scrolling, queue drag-to-reorder dropping songs in the wrong place, the off-center download spinner, Android's blue tap highlight, and more

## What's new in 1.0.2

- Personal stats (Most Played, On Repeat, Recently Played, the stats page) now sync via your Jellyfin account instead of living in one device's local storage
- A play only counts once a track actually finishes, not just when it starts
- Top Artists now counts each artist on a collab track individually instead of treating "A, B, feat. C" as one distinct artist per lineup
- Connect now properly hands off playback — the sending device stops local audio, and play/pause/skip/seek/volume (desktop, mobile, hardware media keys) all control the connected device until you disconnect or pick something new to play locally
- Connect's device list is now scoped to other Triptych instances only, and has a mobile entry point (it previously lived in a desktop-only part of the player bar)
- Fixed Connect's now-playing display going stale (an HTTP caching issue on repeated session polls)
- Fixed the app reporting itself as "Desktop" to Jellyfin on every platform, and a stale client version number
- Fixed the installer sometimes being unable to close a running instance during an update
- Recently Played is now a single horizontally-scrolling row instead of a grid that could grow several rows tall
- Fixed a couple of broken icon references (the Connect button, the queue drag handle)

## What's new in 1.0.1

- Fixed session getting logged out on transient network/server errors instead of only on an actual expired token
- Sleep timer (stop playback after N minutes, or at the end of the current track)
- Recently played history view, separate from "recently added"
- Keyboard media key support on desktop (play/pause/skip from your keyboard, not just in-app)
- Smart playlists (auto-generated "most played," "on repeat," genre mixes)
- Swipe gestures on Android track lists (swipe to queue / remove)
- Queue drag-to-reorder (drag a queue item to a new position by its handle)
- Dynamic UI accent color pulled from the currently playing album art, Spotify-style (opt-in in Settings)
- Personal listening stats page (top artists/tracks, total listening time), built from local play history
- Built-in 5-band equalizer (desktop)
- Right-click context menu on desktop for tracks and queue items
- Drag-and-drop a track onto a playlist in the sidebar or a playlist card, on desktop
- Spotify Connect-style device handoff, built on Jellyfin's own `/Sessions` API — hand off playback to another device, or let another Jellyfin client cast to Triptych

## Acknowledgements

- [Jellyfin](https://jellyfin.org/) for the media server this app talks to
- [Uicons by Flaticon](https://www.flaticon.com/uicons) for the icon set
- [BlafKing's spicetify-cat-jam-synced](https://github.com/BlafKing/spicetify-cat-jam-synced) for the "Jam on paw level" cat animation

## Legal & Privacy

Triptych is free, open-source, and doesn't run any backend of its own — see [`docs/legal/`](docs/legal/) for the full [Privacy Policy](docs/legal/PRIVACY.md), [Terms of Service](docs/legal/TERMS.md), [Refund Policy](docs/legal/REFUNDS.md), [Cookie & Local Storage Policy](docs/legal/COOKIES.md), [Data Deletion](docs/legal/DATA_DELETION.md), [Third-Party Notices & Licenses](docs/legal/THIRD_PARTY_NOTICES.md), and [Accessibility Statement](docs/legal/ACCESSIBILITY.md). These are also viewable inside the app under **Settings → About → Legal**.

## License

MIT
