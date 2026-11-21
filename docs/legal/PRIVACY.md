# Privacy Policy

_Last updated: 2026-11-21_

Triptych is a client app for a Jellyfin or Navidrome media server **you host yourself**. The developer does not run any backend for Triptych, does not receive analytics or telemetry from your copy of the app, and cannot see your library, your account, or what you play.

Triptych is a free, open-source (MIT-licensed) personal project maintained by one developer (GitHub: [greenythebeany](https://github.com/greenythebeany)). There is no company behind it. The only contact channel is [GitHub Issues on the triptych repo](https://github.com/greenythebeany/triptych/issues) — that's also where to report a privacy, accessibility, or licensing concern.

This document is also available inside the app itself, under **Settings → About → Legal**.

## Data that stays on your device

- **Your server session** (server address, username, access token — for Navidrome, a salted hash made from your password at sign-in; the password itself is never stored) — saved to a local file (`session.dat` in Triptych's app-data folder) using your OS's encryption (Electron `safeStorage`) when the OS supports it. If your OS doesn't support that encryption, the file is saved as plain text instead — worth knowing if your device disk itself isn't encrypted.
- **App preferences** (theme, language, audio settings, etc.) — stored in local browser storage on desktop, and via the Capacitor Preferences plugin on Android. On Jellyfin, these also sync to your own server's user-data store so they follow you between your own devices — that sync target is your server, never the developer. Navidrome has no such store, so with Navidrome they stay on each device.
- **Downloaded tracks** — saved as ordinary audio files in Triptych's app-data folder for offline playback.
- **Music on this device** (desktop, optional) — if you pick music folders, Triptych reads the audio files in them and their tags (title, artist, album, track number, length, cover art). The folder list and the tags it read are saved in `local-library.json`, and smaller copies of the cover art in a `local-covers` folder, both in Triptych's app-data folder; likes, play counts and playlists for these songs are kept in local storage. Your files are only read, never changed, moved or uploaded anywhere — not even to your own server. Removing a folder in Settings → Music on this device and rescanning removes its songs and covers from these files.
- **Music on this device** (Android, optional) — only if you turn it on, Triptych asks for Android's permission to read music ("Music and audio"; "Storage" on Android 12 and older) and reads the phone's music library: each song's title, artist, album, track number, year, genre and length, and the album covers, which are cached in Triptych's cache folder. Your files are only read, never changed or uploaded, and the permission can be taken back any time in the system settings (Apps → Triptych → Permissions); Settings → Music on this device → Turn off stops Triptych from reading them.
- **Listening stats** (top artists/tracks, play history) — computed from your local playback and stored the same way as preferences, above.

## Data sent to other services (never to the developer)

- **Your own Jellyfin or Navidrome server** — the app talks to it directly with your credentials to stream your library. This is infrastructure you control.
- **GitHub (api.github.com)** — a background check for a newer Triptych release. Sends a generic app identifier, nothing that identifies you. Can be turned off in Settings → Privacy.
- **Deezer (api.deezer.com)** — when your server (or a song file on this device) has no cover art for a track, the current artist/album/track name is sent to Deezer's public search to find one. No account or personal identifier is sent. While Discord Rich Presence is connected, the playing song's artist/album is also looked up this way so your Discord status can show a cover anyone can see. Can be turned off in Settings → Privacy.
- **Deezer related artists (api.deezer.com)** — in smart shuffle, and for Home's "Because you listened to…" row, the names of the artists you're playing are sent to Deezer's public artist API to find similar artists, along with requests for those artists' album and top-track lists (compared on your device with your own song and album titles, so a same-named artist isn't mistaken for yours). The answers are cached on your device for up to 30 days, so each artist is only looked up now and then. No account or personal identifier is sent. Can be turned off in Settings → Privacy ("Online related artists lookup"); smart shuffle then works from your library and listening history only.
- **Lyrics: lrclib.net, NetEase Cloud Music, Kugou and lyrics.ovh** — when you view lyrics, the current track's title, artist, album and length are sent to lrclib.net's public lyrics API, and its title, artist and length to NetEase Cloud Music's and Kugou's public lyrics search, at the same time as your own server is asked; the title and first artist also go to lyrics.ovh. No account or personal identifier is sent. Lyrics found (or the fact that a song has none) are cached on your device, per track, so each song is only looked up once; the next song in your queue is looked up ahead of time while lyrics are open. If you turn on **Search by lyrics** (Settings → Privacy, off by default), the same lookups also run in the background for the songs in your library, one every few seconds, and the lyrics found are stored on your device so you can search them; turning it off stops this.
- **Music videos: Apple (itunes.apple.com)** — when a song plays and neither your server nor the Triptych Music Video Data plugin has a video for it, the song's title and artist are sent to Apple's public iTunes Search API to find its official music video. No account or personal identifier is sent; the result is cached on your device for 30 days. The video itself (a 30-second preview) then streams from Apple's servers, which see your IP address like any video host. Can be turned off in Settings → Appearance ("Music videos from Apple"); "Canvas videos" turns all videos off.
- **Triptych Music Video Data (optional plugin on your Jellyfin server)** — if you install it, your server sends each song's title and artist to the same Apple API, ahead of time, and keeps only the links it finds (a small `videos.json` in the plugin's folder, plus an "Apple Music Video" ID on each song). That happens between your server and Apple; nothing goes to the developer.
- **Discord** — only if you explicitly connect it in Settings → Audio → Discord Rich Presence. While connected, the currently playing track/artist and its cover art URL are sent to your local Discord client so it can show on your Discord profile. Off by default; disconnect any time.
- **YouTube / YouTube Music / SoundCloud** — only if you use the "Import" feature to paste a link, which fetches that specific media directly to your device. See the [Terms of Service](TERMS.md) for the responsibility that comes with this feature.

## Triptych in your browser (triptych.greenybeany.dev/app)

The browser version is the same app, loaded as plain files from the Triptych website (GitHub Pages). **It runs entirely in your browser, and your browser talks straight to your own server.** There is no Triptych backend in between:

- **The website doesn't take any data from your server or your account.** Your server address, username, access token, library, playlists, likes and what you play are never sent to, seen by or stored on the website or the developer. They only travel between your browser and your server.
- **What the browser keeps** (your server session, preferences, listening stats, cached lyrics and music-video links) is saved in that browser's own storage on your device (local storage and IndexedDB for the site), like the desktop app keeps it on your computer. Signing out, or clearing the site's data in your browser, removes all of it.
- **Your server has to allow the site** to talk to it (its CORS / reverse-proxy settings). That's a setting on your server about which pages may connect to it; nothing is shared with the developer by it.
- **GitHub, as the host,** only serves the app's files and sees the usual request data any web server sees (your IP address and browser), under [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). It never sees your server, your login or your music.
- The optional lookups below (lyrics, cover art, music videos, related artists) work the same way in the browser, straight from your browser to those services. NetEase and Kugou aren't used in the browser.

## This website

The Triptych website (triptych.greenybeany.dev) is a static page hosted on GitHub Pages. It sets no cookies and has no analytics, ads or trackers. GitHub, as the host, receives the usual request data any web server sees (such as your IP address and browser) and handles it under [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). To show the latest version and link straight to the download files, your browser asks GitHub's public API (api.github.com) for the latest release; nothing about you is added to that request. Fonts and images are served from the site itself.

## Children's data

Triptych has no sign-up, no account creation of its own, and no data collection by the developer, so there's nothing here that depends on a user's age — the developer never receives personal data regardless of who's using the app. That said, Triptych is not directed at children, and using it requires access to a Jellyfin or Navidrome server, which should be set up and supervised by an adult.

## Email

Triptych does not send email, does not run a mailing list, and does not collect email addresses. There's no "unsubscribe" link anywhere because no such messages exist.

## Related documents

- [Terms of Service](TERMS.md)
- [Refund Policy](REFUNDS.md)
- [Cookie & Local Storage Policy](COOKIES.md)
- [Data Deletion](DATA_DELETION.md)
- [Third-Party Notices & Licenses](THIRD_PARTY_NOTICES.md)
- [Accessibility Statement](ACCESSIBILITY.md)
