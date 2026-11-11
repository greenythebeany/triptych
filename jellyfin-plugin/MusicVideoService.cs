using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Triptych.MusicVideoData;

/// <summary>
/// The song -> music video answer. Order: an Apple ID typed into the song's
/// metadata by hand, what a scan already found, then (when allowed) a fresh
/// search, which is saved for everyone.
/// </summary>
public sealed class MusicVideoService
{
    public const string ProviderKey = "TriptychMusicVideo";

    private readonly VideoStore _store;
    private readonly AppleMusicVideos _apple;
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<MusicVideoService> _logger;

    public MusicVideoService(VideoStore store, AppleMusicVideos apple, ILibraryManager libraryManager, ILogger<MusicVideoService> logger)
    {
        _store = store;
        _apple = apple;
        _libraryManager = libraryManager;
        _logger = logger;
    }

    public VideoStore Store => _store;

    /// <summary>True when a scan should (re)search this song.</summary>
    public bool NeedsSearch(Audio song)
    {
        var e = _store.Get(song.Id);
        if (e is null)
        {
            return true;
        }

        if (e.Url is not null)
        {
            return false;
        }

        // Missed by an older, weaker matcher: look again now.
        if (e.Matcher < AppleMusicVideos.MatcherVersion && !e.WroteId)
        {
            return true;
        }

        var days = Math.Max(1, Plugin.Instance?.Configuration.RecheckMissesAfterDays ?? 14);
        return DateTime.UtcNow - e.Checked > TimeSpan.FromDays(days);
    }

    public async Task<string?> GetAsync(Audio song, bool allowSearch, CancellationToken ct)
    {
        var typed = song.GetProviderId(ProviderKey);
        var entry = _store.Get(song.Id);

        if (!string.IsNullOrWhiteSpace(typed))
        {
            if (entry?.Url is not null && entry.AppleId == typed)
            {
                return entry.Url;
            }

            // Picked or changed by hand in Edit Metadata: resolve that ID.
            var picked = await _apple.LookupAsync(typed.Trim(), ct).ConfigureAwait(false);
            _store.Set(song.Id, new VideoStore.Entry { Url = picked?.Url, AppleId = typed.Trim(), Checked = DateTime.UtcNow, WroteId = true });
            return picked?.Url;
        }

        if (entry is not null)
        {
            // Found earlier but the ID was cleared in Edit Metadata: the user said no.
            if (entry.WroteId && entry.Url is not null)
            {
                return null;
            }

            if (entry.Url is not null || !NeedsSearch(song))
            {
                return entry.Url;
            }
        }

        if (!allowSearch)
        {
            return null;
        }

        var artists = song.Artists.Concat(song.AlbumArtists).Where(a => !string.IsNullOrWhiteSpace(a)).Distinct().ToList();
        var match = await _apple.SearchAsync(artists, song.Name ?? string.Empty, ct).ConfigureAwait(false);
        var wrote = false;
        if (match is not null && !string.IsNullOrEmpty(match.AppleId))
        {
            try
            {
                // Shows up in Edit Metadata -> External IDs, where it can be changed or cleared.
                song.SetProviderId(ProviderKey, match.AppleId);
                await _libraryManager.UpdateItemAsync(song, song.GetParent(), ItemUpdateType.MetadataEdit, ct).ConfigureAwait(false);
                wrote = true;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not save the music video ID on {Song}", song.Name);
            }
        }

        _store.Set(song.Id, new VideoStore.Entry { Url = match?.Url, AppleId = match?.AppleId, Checked = DateTime.UtcNow, WroteId = wrote, Matcher = AppleMusicVideos.MatcherVersion });
        return match?.Url;
    }
}
