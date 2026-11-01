import Mark from './Mark.jsx';

// Three panels, like the name: your files, the server, the app.
export default function What() {
  return (
    <section className="what" id="what" aria-labelledby="what-title">
      <div className="split">
        <h2 id="what-title">A player for your own music.</h2>
        <p className="lead">
          Streaming apps rent you music. Triptych plays the files you already have: your MP3s and FLACs, ripped CDs,
          old downloads. Keep them on your own <a href="https://jellyfin.org" target="_blank" rel="noreferrer">Jellyfin</a> server
          and listen on your computer and phone in an app that feels like Spotify or Apple Music. No subscription, no ads.
        </p>
      </div>
      <ol className="panels">
        <li>
          <span className="panel-key" aria-hidden="true">A</span>
          <h3>Your music files</h3>
          <p>Albums and songs on your computer, NAS or home server.</p>
        </li>
        <li>
          <span className="panel-key" aria-hidden="true">B</span>
          <h3>Jellyfin server</h3>
          <p>Free software that organizes them and streams them to your devices.</p>
        </li>
        <li className="is-app">
          <Mark className="panel-mark" />
          <h3>Triptych</h3>
          <p>The app you listen with, on Windows, macOS, Linux, Android and iPhone.</p>
        </li>
      </ol>
    </section>
  );
}
