import { useEffect, useState } from 'react';

export const REPO = 'greenythebeany/triptych';
export const GITHUB = `https://github.com/${REPO}`;
export const RELEASES = `${GITHUB}/releases/latest`;
export const ISSUES = `${GITHUB}/issues`;
export const JELLYFIN = 'https://jellyfin.org/downloads/server';
export const SITE = 'https://greenybeany.dev/triptych/';
export const BASE = import.meta.env.BASE_URL;

// Public files, with the build id appended so a deploy replaces cached copies.
export const media = (file) => `${BASE}media/${file}?v=${__BUILD__}`;

// Latest release from the GitHub API, for the version label and direct
// download links. Falls back to the releases page if it can't be reached.
export function useLatestRelease() {
  const [release, setRelease] = useState(null);
  useEffect(() => {
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setRelease(data))
      .catch(() => {});
  }, []);
  const asset = (test) => release?.assets?.find((a) => test(a.name))?.browser_download_url || RELEASES;
  return {
    version: release?.tag_name || null,
    windows: asset((n) => /setup.*\.exe$/i.test(n)),
    android: asset((n) => /\.apk$/i.test(n)),
    appimage: asset((n) => /\.appimage$/i.test(n)),
    snap: asset((n) => /\.snap$/i.test(n)),
    macArm: asset((n) => /arm64\.dmg$/i.test(n)),
    macIntel: asset((n) => /x64\.dmg$/i.test(n)),
    ipa: asset((n) => /\.ipa$/i.test(n))
  };
}

// Animations on or off: the navbar switch, remembered in this browser.
// <html class="still"> is set before the first paint by index.html.
export const MOTION_KEY = 'triptych-motion';
export const motionOff = () => typeof document !== 'undefined' && document.documentElement.classList.contains('still');
export function setMotion(on) {
  document.documentElement.classList.toggle('still', !on);
  try { localStorage.setItem(MOTION_KEY, on ? 'on' : 'off'); } catch { /* storage blocked: this visit only */ }
  dispatchEvent(new CustomEvent('triptych:motion', { detail: on }));
}

// Smooth scroll for the page's own #links, eased by hand: CSS smooth
// scrolling is skipped by browsers when the OS asks for less motion, and the
// site decides that with its own switch instead.
export function smoothAnchors() {
  const onClick = (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const target = a.hash === '#top' ? document.body : document.querySelector(a.hash);
    if (!target) return;
    e.preventDefault();
    history.pushState(null, '', a.hash);
    const offset = target === document.body ? 0 : parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    const to = Math.max(0, target.getBoundingClientRect().top + scrollY - offset);
    if (motionOff()) { scrollTo(0, to); return; }
    const from = scrollY;
    const ms = Math.min(1100, 450 + Math.abs(to - from) * 0.12);
    const start = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      scrollTo(0, from + (to - from) * ease(t));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  addEventListener('click', onClick);
  return () => removeEventListener('click', onClick);
}
