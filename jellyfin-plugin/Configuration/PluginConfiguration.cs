using MediaBrowser.Model.Plugins;

namespace Triptych.MusicVideoData.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Apple allows about 20 searches a minute per IP; stay under it.</summary>
    public int SearchesPerMinute { get; set; } = 18;

    /// <summary>Songs without a video are looked at again after this many days.</summary>
    public int RecheckMissesAfterDays { get; set; } = 14;

    /// <summary>
    /// Two-letter App Store country searched first (affects what's found:
    /// e.g. Slovak artists have more videos in the SK/CZ stores). Empty =
    /// the server's metadata country. The US store is always tried after it,
    /// and Japan's for Japanese titles.
    /// </summary>
    public string Country { get; set; } = string.Empty;
}
