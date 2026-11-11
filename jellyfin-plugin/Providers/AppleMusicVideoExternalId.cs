using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;

namespace Triptych.MusicVideoData.Providers;

/// <summary>
/// "Apple Music Video" in a song's Edit Metadata -> External IDs: the video
/// the plugin picked. Type another video's Apple ID to change it, clear it to
/// turn the video off for that song.
/// </summary>
public class AppleMusicVideoExternalId : IExternalId
{
    public string ProviderName => "Apple Music Video";

    public string Key => MusicVideoService.ProviderKey;

    public ExternalIdMediaType? Type => null;

    public bool Supports(IHasProviderIds item) => item is Audio;
}
