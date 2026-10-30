import { media } from '../site.js';

// The showcase from the README. It never plays by itself. Its own page, /watch/,
// is the one Google indexes it from.
export default function Film() {
  return (
    <section className="film" aria-labelledby="film-title">
      <div className="split">
        <h2 id="film-title">Forty seconds of Triptych.</h2>
        <p className="lead">All three looks, an artist page with synced lyrics, your stats and every device, recorded in the app. With music. <a href="watch/">Watch it on its own page</a>.</p>
      </div>
      <video
        className="film-video"
        src={media('v23/triptych-showcase.mp4')}
        poster={media('v23/poster-showcase.jpg')}
        width="1920"
        height="1080"
        controls
        playsInline
        preload="none"
        aria-label="A 40-second showcase of Triptych"
      />
    </section>
  );
}
