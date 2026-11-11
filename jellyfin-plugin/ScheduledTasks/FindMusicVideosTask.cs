using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Triptych.MusicVideoData.ScheduledTasks;

/// <summary>
/// Dashboard -> Scheduled Tasks -> Triptych -> Find music videos. Goes through
/// every song not looked up yet (and misses older than the recheck window),
/// at Apple's pace (~18 a minute). Safe to stop and resume.
/// </summary>
public class FindMusicVideosTask : IScheduledTask
{
    private readonly ILibraryManager _libraryManager;
    private readonly MusicVideoService _service;
    private readonly ILogger<FindMusicVideosTask> _logger;

    public FindMusicVideosTask(ILibraryManager libraryManager, MusicVideoService service, ILogger<FindMusicVideosTask> logger)
    {
        _libraryManager = libraryManager;
        _service = service;
        _logger = logger;
    }

    public string Name => "Find music videos";

    public string Key => "TriptychFindMusicVideos";

    public string Description => "Looks up every song's music video for Triptych's Now Playing canvas.";

    public string Category => "Triptych";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var songs = _libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = new[] { BaseItemKind.Audio },
            Recursive = true,
            IsVirtualItem = false
        }).OfType<Audio>().Where(_service.NeedsSearch).ToList();

        _logger.LogInformation("Looking up music videos for {Count} songs", songs.Count);
        var found = 0;
        for (var i = 0; i < songs.Count; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (await _service.GetAsync(songs[i], allowSearch: true, cancellationToken).ConfigureAwait(false) is not null)
                {
                    found++;
                }
            }
            catch (AppleMusicVideos.RateLimitedException)
            {
                _logger.LogInformation("Apple is rate limiting; waiting 5 minutes");
                await Task.Delay(TimeSpan.FromMinutes(5), cancellationToken).ConfigureAwait(false);
                i--;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Music video lookup failed for {Song}", songs[i].Name);
            }

            progress.Report(100.0 * (i + 1) / Math.Max(1, songs.Count));
        }

        _service.Store.SaveNow();
        _logger.LogInformation("Music videos: {Found} of {Count} songs found", found, songs.Count);
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        // At every start (only songs not looked up yet) and daily, so new
        // music gets its videos without anyone clicking anything.
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromHours(24).Ticks
        };
    }
}
