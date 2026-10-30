// The site's copy that is also used outside its own section (structured data).

// The order of the hero carousel: Nothing first, then Spotify and Apple Music.
export const LOOKS = [
  { key: 'nothing', label: 'Nothing', caption: 'Black and white, one red light, dot-matrix lyrics.', alt: 'Triptych in the Nothing look, playing Unsainted by Slipknot with synced lyrics' },
  { key: 'spotify', label: 'Spotify', caption: 'Dark cards, a green accent, big bold type.', alt: 'Triptych in the Spotify look, on the Slipknot artist page with lyrics on the right' },
  { key: 'apple', label: 'Apple Music', caption: 'Frosted glass, bare rounded artwork, slim pill sliders.', alt: 'Triptych in the Apple Music look, on the same artist page with red accents' }
];

export const FEATURES = [
  ['Gapless & crossfade', 'Gapless playback, with an optional 0–12 second crossfade between songs.'],
  ['ReplayGain', 'Even volume across your library, using loudness data your server already has.'],
  ['Stats & Wrapped', 'Real listening time, your top songs and artists, and a year in review every December.'],
  ['Equalizer', 'A five-band EQ with presets, and a loudness boost on Android.'],
  ['Themes & custom CSS', 'Light and dark, a dozen accent colors, community color schemes, or your own CSS.'],
  ['Discord status', 'On desktop, show what you are listening to, cover art included.'],
  ['Cast & sleep timer', 'Send playback to other Jellyfin devices, or stop the music after a set time.'],
  ['15 languages', 'English, Slovak, Czech, German, French, Spanish, Polish and more.']
];

export const FAQ = [
  ['Is Triptych free?', 'Yes. It is free and open source, with no subscription, ads or account of ours to sign up for.'],
  ['Do I need a Jellyfin server?', 'Yes. Triptych plays music from a Jellyfin server, and does not include music of its own. Jellyfin is free too, and runs on Windows, macOS, Linux and most NAS boxes.'],
  ['Can I play Spotify or Apple Music songs with it?', 'No. Triptych plays music files you own that are on your Jellyfin server. The Spotify, Apple Music and Nothing options only change how the app looks.'],
  ['Does it work away from home?', 'Yes, as long as your phone can reach your server, for example through a VPN like Tailscale or a public address. Songs you download play with no connection at all.'],
  ['What happens to my data?', 'Your library and listening history stay on your device and your own server. A few optional lookups (missing cover art, lyrics and update checks) talk to outside services, and the Privacy Policy lists exactly what is sent.'],
  ['Which devices are supported?', 'Windows, macOS, Linux, Android and iPhone. The Mac app is not signed by Apple, so it needs one extra step the first time you open it (see Opening Triptych on a Mac, under Download). On iPhone the app is installed by sideloading an unsigned .ipa, for example with AltStore or Sideloadly.']
];
