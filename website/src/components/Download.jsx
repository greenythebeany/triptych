import { useLatestRelease } from '../site.js';

// The whole band is the Windows link; the other systems sit under it.
export default function Download() {
  const r = useLatestRelease();
  return (
    <section className="download" id="download" aria-labelledby="download-title">
      <a className="band" href={r.windows}>
        <span className="band-note">Starts the download for Windows. Other systems are below.</span>
        <svg className="band-arrow" viewBox="0 0 48 48" aria-hidden="true"><path d="M14 34 34 14M18 14h16v16" fill="none" stroke="currentColor" strokeWidth="4" /></svg>
        <h2 id="download-title" className="band-word">Download</h2>
      </a>
      <ul className="others">
        <li><a href={r.macArm}>Mac, Apple silicon</a></li>
        <li><a href={r.macIntel}>Mac, Intel</a></li>
        <li><a href={r.android}>Android, APK</a></li>
        <li><a href={r.appimage}>Linux, AppImage</a></li>
        <li><a href={r.snap}>Linux, snap</a></li>
        <li><a href={r.ipa}>iPhone, unsigned .ipa</a></li>
      </ul>
      <p className="fine">
        {r.version ? `Latest ${r.version}. ` : 'Latest release. '}
        Windows updates itself from inside the app; on iPhone, sideload with AltStore or Sideloadly.
        After installing, open Triptych, enter your Jellyfin server address and sign in.
      </p>
      <details className="mac-help" id="mac">
        <summary>Opening Triptych on a Mac</summary>
        <p>
          Triptych is not signed with a paid Apple developer account, so the first time you open it
          macOS stops it with a warning. This is what to do, once:
        </p>
        <ol>
          <li>Pick the right file: Apple silicon for Macs with an M1 chip or newer, Intel for older Macs. Apple menu, About This Mac, shows which you have.</li>
          <li>Open the .dmg and drag Triptych into Applications.</li>
          <li>Open Triptych from Applications. macOS says it cannot check the app for malware. Click Done.</li>
          <li>Open System Settings, then Privacy &amp; Security. Scroll down to the message about Triptych and click Open Anyway, then confirm with your password or Touch ID.</li>
          <li>Triptych opens, and from then on it opens like any other app.</li>
        </ol>
        <p>
          If macOS says the app is damaged instead, open Terminal and run
          {' '}<code>xattr -dr com.apple.quarantine /Applications/Triptych.app</code>, then open it again.
          The Mac app does not update itself: download the new .dmg and replace the old app.
        </p>
      </details>
    </section>
  );
}
