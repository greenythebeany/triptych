using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Triptych.MusicVideoData;

public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<VideoStore>();
        serviceCollection.AddSingleton<AppleMusicVideos>();
        serviceCollection.AddSingleton<MusicVideoService>();
    }
}
