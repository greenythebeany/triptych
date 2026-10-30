# Privacy Policy

_Last updated: 2026-10-23_

Triptych is a client app for a Jellyfin media server **you host yourself**. The developer does not run any backend for Triptych, does not receive analytics or telemetry from your copy of the app, and cannot see your library, your account, or what you play.

Triptych is a free, open-source (MIT-licensed) personal project maintained by one developer (GitHub: [greenythebeany](https://github.com/greenythebeany)). There is no company behind it. The only contact channel is [GitHub Issues on the triptych repo](https://github.com/greenythebeany/triptych/issues) — that's also where to report a privacy, accessibility, or licensing concern.

This document is also available inside the app itself, under **Settings → About → Legal**.

## Data that stays on your device

- **Your Jellyfin session** (server address, username, access token) — saved to a local file (`session.dat` in Triptych's app-data folder) using your OS's encryption (Electron `safeStorage`) when the OS supports it. If your OS doesn't support that encryption, the file is saved as plain text instead — worth knowing if your device disk itself isn't encrypted.
- **App preferences** (theme, language, audio settings, etc.) — stored in local browser storage on desktop, and via the Capacitor Preferences plugin on Android. These also sync to your own Jellyfin server's user-data store so they follow you between your own devices — that sync target is your server, never the developer.
- **Downloaded tracks** — saved as ordinary audio files in Triptych's app-data folder for offline playback.
- **Listening stats** (top artists/tracks, play history) — computed from your local playback and stored the same way as preferences, above.

## Data sent to other services (never to the developer)

- **Your own Jellyfin server** — the app talks to it directly with your credentials to stream your library. This is infrastructure you control.
- **GitHub (api.github.com)** — a background check for a newer Triptych release. Sends a generic app identifier, nothing that identifies you. Can be turned off in Settings → Privacy.
- **Deezer (api.deezer.com)** — when your server has no cover art for a track, the current artist/album/track name is sent to Deezer's public search to find one. No account or personal identifier is sent. While Discord Rich Presence is connected, the playing song's artist/album is also looked up this way so your Discord status can show a cover anyone can see. Can be turned off in Settings → Privacy.
- **Lyrics: lrclib.net, then lyrics.ovh** — when you view lyrics, the current track's title, artist, album and length are sent to lrclib.net's public lyrics API to find them. If lrclib and your own Jellyfin server don't have them, the title and first artist are also sent to lyrics.ovh. No account or personal identifier is sent; lyrics are only kept in memory while the app is open. If you turn on **Search by lyrics** (Settings → Privacy, off by default), the same lookups also run in the background for the songs in your library, about one per second, and the lyrics found are stored on your device so you can search them; turning it off stops this.
- **Discord** — only if you explicitly connect it in Settings → Audio → Discord Rich Presence. While connected, the currently playing track/artist and its cover art URL are sent to your local Discord client so it can show on your Discord profile. Off by default; disconnect any time.
- **YouTube / YouTube Music / SoundCloud** — only if you use the "Import" feature to paste a link, which fetches that specific media directly to your device. See the [Terms of Service](TERMS.md) for the responsibility that comes with this feature.

## This website

The Triptych website (triptych.greenybeany.dev) is a static page hosted on GitHub Pages. It sets no cookies and has no analytics, ads or trackers. GitHub, as the host, receives the usual request data any web server sees (such as your IP address and browser) and handles it under [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement). To show the latest version and link straight to the download files, your browser asks GitHub's public API (api.github.com) for the latest release; nothing about you is added to that request. Fonts and images are served from the site itself.

## Children's data

Triptych has no sign-up, no account creation of its own, and no data collection by the developer, so there's nothing here that depends on a user's age — the developer never receives personal data regardless of who's using the app. That said, Triptych is not directed at children, and using it requires access to a Jellyfin server, which should be set up and supervised by an adult.

## Email

Triptych does not send email, does not run a mailing list, and does not collect email addresses. There's no "unsubscribe" link anywhere because no such messages exist.

## Related documents

- [Terms of Service](TERMS.md)
- [Refund Policy](REFUNDS.md)
- [Cookie & Local Storage Policy](COOKIES.md)
- [Data Deletion](DATA_DELETION.md)
- [Third-Party Notices & Licenses](THIRD_PARTY_NOTICES.md)
- [Accessibility Statement](ACCESSIBILITY.md)
