using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Triptych.MusicVideoData;

/// <summary>
/// Apple's free iTunes Search API (no key): a song's official music video as
/// a 30-second HD preview. Only an exact artist + title match counts -- a
/// different song's video is worse than none. Same matching as Triptych's
/// own fallback (canvasVideo.js), so the app and the server agree.
/// </summary>
public sealed partial class AppleMusicVideos
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private double _tokens = Burst;
    private DateTime _refilled = DateTime.UtcNow;
    private const double Burst = 4;
    private DateTime _blockedUntil = DateTime.MinValue;

    public AppleMusicVideos(IHttpClientFactory httpClientFactory)
    {
        _httpClientFactory = httpClientFactory;
    }

    public sealed record Match(string Url, string AppleId);

    /// <summary>Thrown while Apple is refusing requests (rate limit); try again later.</summary>
    public sealed class RateLimitedException : Exception
    {
        public RateLimitedException() : base("Apple is rate limiting searches.") { }
    }

    /// <summary>Bumped when matching gets better: songs missed by an older version are looked at again.</summary>
    public const int MatcherVersion = 3;

    private sealed record Video(string Artist, string Title, string Url, string Id);

    // An artist's whole video list, fetched once and matched against every
    // song by them (a scan goes artist by artist, so this saves most requests).
    private readonly ConcurrentDictionary<string, (DateTime At, List<Video> Videos)> _artistVideos = new();

    public async Task<Match?> SearchAsync(IReadOnlyList<string> artists, string trackName, CancellationToken ct)
    {
        var names = artists.Select(Words).Where(n => n.Length > 0).Distinct().ToList();
        var song = CleanTitle(trackName);
        var title = Words(song);
        if (names.Count == 0 || title.Length == 0)
        {
            return null;
        }

        bool ByArtist(Video v) =>
            names.Any(n => v.Artist == n || v.Artist.Contains(n, StringComparison.Ordinal) || n.Contains(v.Artist, StringComparison.Ordinal));

        bool Fits(Video v) =>
            ByArtist(v)
            && v.Title.Length > 0
            && (v.Title == title || v.Title.StartsWith(title + " ", StringComparison.Ordinal) || title.StartsWith(v.Title + " ", StringComparison.Ordinal));

        // 1. The artist's (and co-artists') video lists.
        var artistKnown = false;
        foreach (var n in names.Take(3))
        {
            var list = await ArtistVideosAsync(n, ct).ConfigureAwait(false);
            // Only the artist's own videos count: for a name Apple doesn't
            // know it returns other artists (Hard Rico -> Doja Cat ...).
            artistKnown |= list.Any(ByArtist);
            var hit = list.FirstOrDefault(Fits);
            if (hit is not null)
            {
                return new Match(hit.Url, hit.Id);
            }
        }

        // Apple has this artist's videos, just not this song's.
        if (artistKnown)
        {
            return null;
        }

        // 2. Apple knows the artist by another name ("mgk"): by title.
        foreach (var term in new[] { Query(names[0], Words(song)), Query(Words(song)) }.Distinct())
        {
            var hit = (await SearchVideosAsync(term, null, 25, ct).ConfigureAwait(false)).FirstOrDefault(Fits);
            if (hit is not null)
            {
                return new Match(hit.Url, hit.Id);
            }
        }

        return null;
    }

    private async Task<List<Video>> ArtistVideosAsync(string artist, CancellationToken ct)
    {
        if (_artistVideos.TryGetValue(artist, out var cached) && DateTime.UtcNow - cached.At < TimeSpan.FromHours(12))
        {
            return cached.Videos;
        }

        var videos = await SearchVideosAsync(Query(artist), "artistTerm", 200, ct).ConfigureAwait(false);
        _artistVideos[artist] = (DateTime.UtcNow, videos);
        return videos;
    }

    private async Task<List<Video>> SearchVideosAsync(string term, string? attribute, int limit, CancellationToken ct)
    {
        var query = new Dictionary<string, string>
        {
            ["term"] = term,
            ["media"] = "musicVideo",
            ["entity"] = "musicVideo",
            ["limit"] = limit.ToString(CultureInfo.InvariantCulture),
            ["country"] = Country
        };
        if (attribute is not null)
        {
            query["attribute"] = attribute;
        }

        using var doc = await GetAsync("search", query, ct).ConfigureAwait(false);
        var list = new List<Video>();
        if (doc is null)
        {
            return list;
        }

        foreach (var r in doc.RootElement.GetProperty("results").EnumerateArray())
        {
            var url = r.TryGetProperty("previewUrl", out var p) ? p.GetString() : null;
            if (string.IsNullOrEmpty(url))
            {
                continue;
            }

            list.Add(new Video(
                Words(r.TryGetProperty("artistName", out var a) ? a.GetString() : null),
                Words(CleanTitle(r.TryGetProperty("trackName", out var t) ? t.GetString() ?? string.Empty : string.Empty)),
                url,
                IdOf(r)));
        }

        return list;
    }

    /// <summary>A video picked by hand (its Apple ID typed into the song's metadata).</summary>
    public async Task<Match?> LookupAsync(string appleId, CancellationToken ct)
    {
        using var doc = await GetAsync("lookup", new Dictionary<string, string>
        {
            ["id"] = appleId,
            ["entity"] = "musicVideo",
            ["country"] = Country
        }, ct).ConfigureAwait(false);
        if (doc is null)
        {
            return null;
        }

        foreach (var r in doc.RootElement.GetProperty("results").EnumerateArray())
        {
            if (r.TryGetProperty("previewUrl", out var p) && !string.IsNullOrEmpty(p.GetString()))
            {
                return new Match(p.GetString()!, IdOf(r));
            }
        }

        return null;
    }

    private static string Country => Plugin.Instance?.Configuration.Country is { Length: 2 } c ? c : "US";

    private static string IdOf(JsonElement r) =>
        r.TryGetProperty("trackId", out var id) ? id.GetInt64().ToString(CultureInfo.InvariantCulture) : string.Empty;

    // One request at a time, a token bucket under Apple's ~20 a minute: a
    // song asked for right now answers at once (bursts of 4), a scan settles
    // into the steady rate. A refusal (403/429) pauses everything 5 minutes.
    private async Task<JsonDocument?> GetAsync(string path, Dictionary<string, string> query, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (DateTime.UtcNow < _blockedUntil)
            {
                throw new RateLimitedException();
            }

            var perSecond = Math.Clamp(Plugin.Instance?.Configuration.SearchesPerMinute ?? 18, 1, 20) / 60.0;
            var now = DateTime.UtcNow;
            _tokens = Math.Min(Burst, _tokens + (now - _refilled).TotalSeconds * perSecond);
            _refilled = now;
            if (_tokens < 1)
            {
                await Task.Delay(TimeSpan.FromSeconds((1 - _tokens) / perSecond), ct).ConfigureAwait(false);
                _tokens = 1;
                _refilled = DateTime.UtcNow;
            }

            _tokens -= 1;

            var qs = string.Join('&', query.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));
            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(15);
            using var res = await client.GetAsync(new Uri($"https://itunes.apple.com/{path}?{qs}"), ct).ConfigureAwait(false);
            if (res.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)
            {
                _blockedUntil = DateTime.UtcNow.AddMinutes(5);
                throw new RateLimitedException();
            }

            if ((int)res.StatusCode >= 500)
            {
                throw new HttpRequestException($"Apple answered {(int)res.StatusCode}");
            }

            if (!res.IsSuccessStatusCode)
            {
                return null;
            }

            var stream = await res.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            return await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    // "$" reads as "s" (Ke$ha), no brackets or accents, letters and digits only.
    public static string Words(string? s)
    {
        var t = (s ?? string.Empty).Replace('$', 's').ToLowerInvariant();
        t = Brackets().Replace(t, string.Empty).Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(t.Length);
        foreach (var ch in t)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark)
            {
                continue;
            }

            sb.Append(char.IsLetterOrDigit(ch) ? ch : ' ');
        }

        return Spaces().Replace(sb.ToString(), " ").Trim();
    }

    // Apple's search does better without "(From the Motion Picture ...)",
    // "feat. ..." or "- Remastered".
    public static string CleanTitle(string name)
    {
        var t = Brackets().Replace(name ?? string.Empty, string.Empty);
        t = Featuring().Replace(t, string.Empty);
        t = VersionSuffix().Replace(t, string.Empty);
        return t.Trim();
    }

    private static string Query(params string[] parts)
    {
        var q = Spaces().Replace(string.Join(' ', parts.Where(p => !string.IsNullOrWhiteSpace(p))), " ").Trim();
        if (q.Length > 80)
        {
            q = q[..80];
            var cut = q.LastIndexOf(' ');
            if (cut > 0)
            {
                q = q[..cut];
            }
        }

        return q;
    }

    [GeneratedRegex(@"\s*[(\[].*?[)\]]")]
    private static partial Regex Brackets();

    [GeneratedRegex(@"\s+(feat\.?|ft\.?|featuring)\s.*$", RegexOptions.IgnoreCase)]
    private static partial Regex Featuring();

    [GeneratedRegex(@"\s+-\s+.*(remaster|version|edit|mix|live).*$", RegexOptions.IgnoreCase)]
    private static partial Regex VersionSuffix();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Spaces();
}
