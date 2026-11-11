using System.Net.Mime;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Triptych.MusicVideoData.Api;

/// <summary>
/// What Triptych asks: GET /TriptychMusicVideo/Items/{id} -> { "Url": "..." },
/// or { "Url": null } when the song has no video (so the app doesn't search
/// again itself). 404 = not a song.
/// </summary>
[ApiController]
[Authorize]
[Route("TriptychMusicVideo")]
[Produces(MediaTypeNames.Application.Json)]
public class MusicVideoController : ControllerBase
{
    private readonly MusicVideoService _service;
    private readonly ILibraryManager _libraryManager;

    public MusicVideoController(MusicVideoService service, ILibraryManager libraryManager)
    {
        _service = service;
        _libraryManager = libraryManager;
    }

    [HttpGet("Items/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> GetMusicVideo([FromRoute] Guid itemId, CancellationToken ct)
    {
        if (_libraryManager.GetItemById(itemId) is not Audio song)
        {
            return NotFound();
        }

        try
        {
            // Not scanned yet: search now (once), so it works before the
            // first scan finishes.
            var url = await _service.GetAsync(song, allowSearch: true, ct).ConfigureAwait(false);
            return Ok(new { Url = url });
        }
        catch (AppleMusicVideos.RateLimitedException)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }
    }

    [HttpGet("Stats")]
    [Authorize(Policy = "RequiresElevation")]
    public ActionResult GetStats()
    {
        var (found, missing) = _service.Store.Counts();
        return Ok(new { Found = found, Missing = missing });
    }

    [HttpPost("Reset")]
    [Authorize(Policy = "RequiresElevation")]
    public ActionResult Reset()
    {
        _service.Store.Clear();
        return NoContent();
    }
}
