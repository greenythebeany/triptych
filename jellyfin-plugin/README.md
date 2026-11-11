# Triptych Music Video Data (Jellyfin plugin)

A small Jellyfin plugin that finds every song's **official music video** ahead of time, so Triptych can play it behind Now Playing the moment the song starts.

- It looks each song up in Apple's free iTunes Search API, which has 30-second HD previews (mostly 1080p) of official music videos. It matches the artist's whole video list first, ignores accents ("Nerieš", "Måneskin") and treats "feat." credits as co-artists. Only an exact artist + title match counts: a different song's video is worse than none.
- It keeps **only the link** on your server (`videos.json` in the plugin's data folder, well under 1 MB for thousands of songs). The video itself streams from Apple when it plays; nothing is downloaded or stored.
- It adds an **Apple Music Video** ID to every song (Edit Metadata → External IDs), so you can see what was picked, swap it, or clear it to turn the video off for that song.
- It runs by itself: at every server start, only for songs not looked up yet, and once a day for new music. Its pace is about 18 searches a minute, under Apple's limit; the first pass takes roughly an hour per 1,000 songs.

Requires **Jellyfin 10.11**.

## Install

### From the plugin catalog (recommended)

1. In Jellyfin, open **Dashboard → Plugins → Repositories** (the **Manage repositories** button in 10.11) and add a repository:
   - Name: `Triptych`
   - URL: `https://github.com/greenythebeany/triptych/releases/latest/download/jellyfin-plugin-manifest.json`
2. Open **Catalog**, find **Triptych Music Video Data** (under Metadata) and click **Install**.
3. Restart Jellyfin (**Dashboard → Restart**).

New versions then show up in the catalog like any other plugin's.

### By hand

1. Download `triptych-music-video-data_<version>.zip` from the [latest release](https://github.com/greenythebeany/triptych/releases/latest).
2. Unzip it into a folder named `Triptych Music Video Data_<version>` inside Jellyfin's `plugins` folder:
   - Docker (linuxserver.io image): `<your config folder>/data/plugins/`
   - Debian/Ubuntu package: `/var/lib/jellyfin/plugins/`
   - Windows: `%ProgramData%\Jellyfin\Server\plugins\`
3. Restart Jellyfin.

## After installing

- The first scan starts by itself after the restart. Follow it under **Dashboard → Scheduled Tasks → Triptych → Find music videos**; you can also run it from there.
- **Dashboard → Plugins → Triptych Music Video Data** shows how many songs have a video. You can also change the pace (searches per minute), how long a "no video" is kept before trying again (14 days), the App Store country (some videos exist only in some countries), and **Forget all results** to search everything again.
- Triptych 2.6.0 or newer picks it up on its own; there's nothing to set in the app. A song that hasn't been scanned yet is looked up on the server the first time it plays, then saved for everyone.

## Picking or removing a video by hand

Open a song's **Edit Metadata** in Jellyfin. Under **External IDs**, the **Apple Music Video** field holds the ID of the video the plugin picked.

- **Another video:** paste its Apple ID. It's the number at the end of its Apple Music link, e.g. `https://music.apple.com/us/music-video/believer/1234567890` → `1234567890`.
- **No video for this song:** clear the field. The plugin leaves it empty from then on.

## Songs Apple doesn't have

Apple has videos for most big international releases, but very few for, say, Slovak rap. For those, add your own videos: make a **Music Videos** library in Jellyfin and name the files like the song (title, with the artist in the tags or folder). Triptych plays your own video for a song first, before Apple's.

## Building

```bash
dotnet build -c Release
```

The output is `bin/Release/net9.0/Triptych.MusicVideoData.dll`. It must be built against the same Jellyfin version the server runs (`Jellyfin.Controller` in the `.csproj`), or Jellyfin refuses to load it.
