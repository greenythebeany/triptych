import { useCallback, useEffect, useRef, useState } from 'react';
import Shot from './Shot.jsx';
import { LOOKS } from '../content.js';
import { motionOff } from '../site.js';

const BOOT_KEY = 'triptych-booted';
const BOOT_MS = 2700; // ~1.2 s of level meter, then the settled logo holds for ~1.5 s
const SLIDE_MS = 5200;

// The boot, the same way as on greenybeany.dev/me: the inline script in
// index.html decides before the first paint (once per tab, never with
// animations switched off, ?boot forces it) and puts `booting` on <html>; the CSS then shows the
// meter. Here the page is kept out of reach until it lifts, any click or key
// skips it, and onDone starts the slideshow.
function useBoot(onDone) {
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains('booting')) { onDone(); return undefined; }
    const page = [...document.body.children].filter((el) => el.tagName !== 'SCRIPT');
    page.forEach((el) => { el.inert = true; });
    let timer;
    const release = () => {
      clearTimeout(timer);
      removeEventListener('pointerdown', finish);
      removeEventListener('keydown', finish);
      page.forEach((el) => { el.inert = false; });
    };
    function finish() {
      release();
      try { sessionStorage.setItem(BOOT_KEY, '1'); } catch { /* storage blocked */ }
      root.classList.remove('booting');
      onDone();
    }
    // the meter started with the first paint, not with this script
    timer = setTimeout(finish, Math.max(0, BOOT_MS - performance.now()));
    addEventListener('pointerdown', finish);
    addEventListener('keydown', finish);
    return release;
  }, [onDone]);
}

// The three looks fill the screen and lock into place, with an overshoot,
// under the still title and the moving logo. Tabs (arrow keys), swipe or drag, and an autoplay
// that pauses on hover and stops for good once the visitor takes over.
export default function Hero() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState(false);
  const [still, setStill] = useState(false); // the pause button also stops the visualizer
  const hero = useRef(null);
  const tabs = useRef([]);
  const drag = useRef(null);
  const lens = useRef(null);

  useBoot(useCallback(() => { if (!motionOff()) setPlaying(true); }, []));

  // Scrolling down lowers the bars back to where they start; back near the
  // top they rise again (removing .lowered restarts the CSS animation).
  useEffect(() => {
    const onScroll = () => hero.current.classList.toggle('lowered', scrollY > 60);
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);

  // The navbar switch starts or stops the slideshow with everything else.
  useEffect(() => {
    const onMotion = (e) => { setPlaying(e.detail); setStill(!e.detail); };
    addEventListener('triptych:motion', onMotion);
    return () => removeEventListener('triptych:motion', onMotion);
  }, []);

  useEffect(() => {
    if (!playing || hover) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % LOOKS.length), SLIDE_MS);
    return () => clearInterval(id);
  }, [playing, hover]);

  const go = (i, focus = false) => {
    const next = (i + LOOKS.length) % LOOKS.length;
    setIndex(next);
    setPlaying(false);
    if (focus) tabs.current[next]?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowRight') go(index + 1, true);
    if (e.key === 'ArrowLeft') go(index - 1, true);
  };

  // Swipe / drag: follow the finger, then snap to the nearest slide.
  // --drag sits on the hero so the lens copy of the slides follows too.
  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, dx: 0 };
    hero.current.classList.add('dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e) => {
    if (!drag.current) return;
    drag.current.dx = e.clientX - drag.current.x;
    hero.current.style.setProperty('--drag', `${drag.current.dx}px`);
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    const { dx } = drag.current;
    drag.current = null;
    hero.current.classList.remove('dragging');
    hero.current.style.setProperty('--drag', '0px');
    if (Math.abs(dx) > Math.min(120, innerWidth * 0.15)) go(index + (dx < 0 ? 1 : -1));
  };

  // The lens follows a mouse (not touch) without re-rendering: the position
  // goes on the lens itself (not the whole hero), at most once a frame.
  const lensAt = useRef(null);
  const onLens = (e) => {
    if (e.pointerType !== 'mouse') return;
    const box = hero.current.getBoundingClientRect();
    const first = !lensAt.current;
    lensAt.current = [e.clientX - box.left, e.clientY - box.top];
    if (!first) return;
    requestAnimationFrame(() => {
      const [x, y] = lensAt.current; lensAt.current = null;
      lens.current.style.setProperty('--mx', `${x}px`);
      lens.current.style.setProperty('--my', `${y}px`);
      hero.current.classList.add('lensing');
    });
  };

  return (
    <section
      className="hero"
      id="top"
      aria-roledescription="carousel"
      aria-label="The three looks of Triptych"
      data-look={LOOKS[index].key}
      data-paused={still}
      ref={hero}
      style={{ '--i': index }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => { setHover(false); hero.current.classList.remove('lensing'); }}
      onPointerMove={onLens}
    >
      <div
        className="track"
        onPointerDown={onPointerDown}
        onPointerMove={onDrag}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {LOOKS.map((look, i) => (
          <div
            className="slide"
            key={look.key}
            id={`look-${look.key}`}
            role="tabpanel"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${LOOKS.length}: ${look.label}`}
            inert={i !== index}
          >
            {/* blurred and dimmed ahead of time (*-blur): a live CSS blur is redrawn every frame in Firefox */}
            <Shot className="shot" name={`d-${look.key}-blur`} phone={`p-${look.key}-blur`} width="1600" height="900" alt={look.alt} eager={i === 0} />
          </div>
        ))}
      </div>

      {/* The lens: the same slides, sharp, seen through a circle around the mouse. */}
      <div className="lens" aria-hidden="true" ref={lens}>
        <div className="lens-track">
          {LOOKS.map((look) => (
            <div className="slide" key={look.key}>
              <Shot className="shot" name={`d-${look.key}`} phone={`p-${look.key}`} width="1600" height="900" alt="" />
            </div>
          ))}
        </div>
      </div>

      {/* the logo as three bars that change height (an SVG scaled per bar would squash its rounded corners) */}
      <div className="boot" aria-hidden="true">
        <div className="viz"><span className="bar bar-1" /><span className="bar bar-2" /><span className="bar bar-3" /></div>
      </div>

      <div className="hud">
        <h1 className="title">Triptych<span className="stop" aria-hidden="true" /></h1>
        <div className="intro">
          <p className="lede">A music player for your own Jellyfin server. One library, three looks. Free on Windows, Linux, Android and iPhone.</p>
          <a className="btn" href="#download">Download Triptych</a>
        </div>
        <p className="caption"><strong>{LOOKS[index].label}.</strong> {LOOKS[index].caption}</p>
        <div className="controls">
          <div className="tabs" role="tablist" aria-label="Choose a look">
            {LOOKS.map((look, i) => (
              <button
                key={look.key}
                ref={(el) => { tabs.current[i] = el; }}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-controls={`look-${look.key}`}
                tabIndex={i === index ? 0 : -1}
                onClick={() => go(i)}
                onKeyDown={onKeyDown}
              >
                {look.label}
              </button>
            ))}
          </div>
          <button
            className="play"
            type="button"
            aria-label={playing ? 'Pause the slideshow and the logo' : 'Play the slideshow'}
            data-playing={playing}
            onClick={() => { setStill(playing); setPlaying(!playing); }}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
