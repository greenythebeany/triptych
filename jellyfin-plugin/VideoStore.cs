using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Triptych.MusicVideoData;

/// <summary>
/// What was found for each song, kept in the plugin's data folder
/// (videos.json): the video's link, not the video -- it streams from Apple.
/// </summary>
public sealed class VideoStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };
    private readonly ILogger<VideoStore> _logger;
    private readonly object _saveLock = new();
    private ConcurrentDictionary<Guid, Entry>? _entries;
    private Timer? _saveTimer;

    public VideoStore(ILogger<VideoStore> logger)
    {
        _logger = logger;
    }

    public sealed class Entry
    {
        /// <summary>The preview's link; null = no video found.</summary>
        public string? Url { get; set; }

        /// <summary>Apple's ID for the video (also on the song as its "Apple Music Video" ID).</summary>
        public string? AppleId { get; set; }

        public DateTime Checked { get; set; }

        /// <summary>The plugin wrote AppleId onto the song, so an empty ID later means someone cleared it.</summary>
        public bool WroteId { get; set; }

        /// <summary>Which matcher looked (see AppleMusicVideos.MatcherVersion).</summary>
        public int Matcher { get; set; }
    }

    private string FilePath => Path.Combine(Plugin.Instance!.DataFolderPath, "videos.json");

    private ConcurrentDictionary<Guid, Entry> Entries
    {
        get
        {
            if (_entries is null)
            {
                lock (_saveLock)
                {
                    _entries ??= Load();
                }
            }

            return _entries;
        }
    }

    public Entry? Get(Guid itemId) => Entries.TryGetValue(itemId, out var e) ? e : null;

    public void Set(Guid itemId, Entry entry)
    {
        Entries[itemId] = entry;
        ScheduleSave();
    }

    public (int Found, int Missing) Counts()
    {
        var found = Entries.Values.Count(e => e.Url is not null);
        return (found, Entries.Count - found);
    }

    public void Clear()
    {
        Entries.Clear();
        SaveNow();
    }

    private ConcurrentDictionary<Guid, Entry> Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var data = JsonSerializer.Deserialize<Dictionary<Guid, Entry>>(File.ReadAllText(FilePath), JsonOptions);
                if (data is not null)
                {
                    return new ConcurrentDictionary<Guid, Entry>(data);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not read {Path}; starting empty", FilePath);
        }

        return new ConcurrentDictionary<Guid, Entry>();
    }

    // Batched: a scan finds many songs in a row.
    private void ScheduleSave()
    {
        lock (_saveLock)
        {
            _saveTimer ??= new Timer(_ => SaveNow(), null, Timeout.Infinite, Timeout.Infinite);
            _saveTimer.Change(TimeSpan.FromSeconds(5), Timeout.InfiniteTimeSpan);
        }
    }

    public void SaveNow()
    {
        lock (_saveLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
                var tmp = FilePath + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(Entries, JsonOptions));
                File.Move(tmp, FilePath, true);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not save {Path}", FilePath);
            }
        }
    }
}
