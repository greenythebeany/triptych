using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Triptych.MusicVideoData.Configuration;

namespace Triptych.MusicVideoData;

/// <summary>
/// Triptych Music Video Data: finds each song's official music video
/// (Apple's free iTunes Search API, a 30-second HD preview) ahead of time
/// and keeps the match on the server, so Triptych shows it instantly.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static readonly Guid PluginId = Guid.Parse("6c1f3f2e-5b7a-4c1e-9a8d-2f4b7e3a9c10");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Triptych Music Video Data";

    public override Guid Id => PluginId;

    public override string Description => "Finds every song's music video ahead of time for Triptych's Now Playing canvas.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = Name,
            EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html"
        };
    }
}
