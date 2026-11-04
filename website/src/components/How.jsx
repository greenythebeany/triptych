import Shot from './Shot.jsx';
import { JELLYFIN, NAVIDROME } from '../site.js';

const TREE = [
  ['d1', 'Slipknot'],
  ['d2', 'We Are Not Your Kind'],
  ['d3', '01 Insert Coin.flac'],
  ['d3 on', '02 Unsainted.flac'],
  ['d3', '03 Birth of the Cruel.flac'],
  ['d1', 'Elán'],
  ['d1 more', '…']
];

export default function How() {
  return (
    <section className="how" id="how" aria-labelledby="how-title">
      <h2 id="how-title">Up and running in three steps.</h2>
      <ol className="steps">
        <li className="step">
          <span className="step-n" aria-hidden="true">1</span>
          <div className="step-text">
            <h3>Put your music on a server</h3>
            <p>
              Install Jellyfin or Navidrome on a computer that stays on (a PC, a NAS or a small server) and point it at your music folder.
              It reads your tags and cover art and builds the library. Already running one of them? Skip ahead.
            </p>
            <a className="link" href={JELLYFIN} target="_blank" rel="noreferrer">Get Jellyfin</a>
            {' or '}
            <a className="link" href={NAVIDROME} target="_blank" rel="noreferrer">Navidrome</a>
            {', both free'}
          </div>
          <div className="tree" role="img" aria-label="An example music folder: Music, then Slipknot, then the album We Are Not Your Kind with its FLAC files">
            <div className="tree-head">Music</div>
            {TREE.map(([cls, name]) => <div className={`tree-row ${cls}`} key={name}>{name}</div>)}
          </div>
        </li>
        <li className="step">
          <span className="step-n" aria-hidden="true">2</span>
          <div className="step-text">
            <h3>Install Triptych</h3>
            <p>
              Download it for your devices: an installer for Windows, an APK for Android, an AppImage or snap for Linux,
              and an .ipa you can sideload on iPhone. Install it on as many devices as you like.
            </p>
            <a className="link" href="#download">See all downloads</a>
          </div>
          <ul className="systems" aria-label="Supported systems">
            {['Windows', 'Android', 'Linux', 'iPhone'].map((p) => <li key={p}>{p}</li>)}
          </ul>
        </li>
        <li className="step">
          <span className="step-n" aria-hidden="true">3</span>
          <div className="step-text">
            <h3>Sign in and press play</h3>
            <p>
              Open Triptych, type your server's address and your username and password. Triptych works out whether it's Jellyfin or Navidrome. Your whole library shows up:
              artists, albums, playlists and liked songs. On Jellyfin, your settings follow you to every device too.
            </p>
          </div>
          <div className="phone">
            <Shot name="p-login" width="585" height="1266" alt="The Triptych sign-in screen, asking for a server address, username and password" />
          </div>
        </li>
      </ol>
    </section>
  );
}
