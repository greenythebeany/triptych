import Mark from './Mark.jsx';
import { BASE, GITHUB, ISSUES, RELEASES } from '../site.js';

export default function Footer() {
  return (
    <footer className="foot">
      <a className="foot-brand" href="#top"><Mark className="foot-mark" />Triptych</a>
      <nav className="foot-links" aria-label="More">
        <a href={GITHUB}>Source code</a>
        <a href={RELEASES}>Releases</a>
        <a href={ISSUES}>Issues</a>
        <a href={`${BASE}terms/`}>Terms</a>
        <a href={`${BASE}privacy/`}>Privacy</a>
      </nav>
      <p className="foot-note">Free and open source under the MIT license. Not affiliated with Jellyfin, Navidrome, Spotify, Apple or Nothing; their names belong to their owners.</p>
    </footer>
  );
}
