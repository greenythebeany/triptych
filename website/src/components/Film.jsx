import { media } from '../site.js';

// The launch ad, with its voiceover and music: the 16:9 cut on wide screens,
// the 9:16 cut (captions burned in) on phones. CSS shows one of the two; with
// preload="none" only the one that is played gets downloaded. Neither plays by itself.
export default function Film() {
  return (
    <section className="film" aria-labelledby="film-title">
      <div className="split">
        <h2 id="film-title">Forty seconds of Triptych.</h2>
        <p className="lead">The three looks, synced lyrics, Stats and Wrapped, and the settings, recorded in the app. Turn the sound on.</p>
      </div>
      <video
        className="film-video film-wide"
        src={media('ad/triptych-ad-16x9.mp4')}
        poster={media('ad/poster-16x9.jpg')}
        width="1920"
        height="1080"
        controls
        playsInline
        preload="none"
        aria-label="The Triptych launch video, 41 seconds, with voiceover and music"
      >
        <track kind="captions" src={media('ad/triptych-ad-16x9.en.vtt')} srcLang="en" label="English" />
      </video>
      <video
        className="film-video film-tall"
        src={media('ad/triptych-ad-9x16.mp4')}
        poster={media('ad/poster-9x16.jpg')}
        width="720"
        height="1280"
        controls
        playsInline
        preload="none"
        aria-label="The Triptych launch video for phones, 41 seconds, with voiceover, music and captions"
      />
    </section>
  );
}
