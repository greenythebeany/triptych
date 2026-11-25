// Settings -> OLED care: keeps the same pixels from showing the same bright
// UI for hours (burn-in on OLED laptops, monitors and phones).
// - Pixel shift: the whole window moves by up to 2px every few minutes.
// - Idle dim: after a minute without mouse, touch or keys, the fixed chrome
//   (title bar, sidebar, player bar, bottom nav) fades down until the next input.
import { getSettings, onSettingsChange } from './settings.js';

const SHIFT_MS = 3 * 60 * 1000;
const IDLE_MS = 60 * 1000;
const STEP_PX = 1;
// A slow walk around a 5x5 square, so no offset sits still for long.
const OFFSETS = [[0, 0], [1, 0], [2, 1], [1, 2], [0, 1], [-1, 2], [-2, 1], [-1, 0], [-2, -1], [-1, -2], [0, -1], [1, -2], [2, -1]];

const root = document.documentElement;
let shiftIndex = 0;
let shiftTimer = 0;
let idleTimer = 0;
let started = false;

function enabled() {
  return getSettings().oledCare === true;
}

function setShift([x, y]) {
  root.style.setProperty('--oled-x', `${x * STEP_PX}px`);
  root.style.setProperty('--oled-y', `${y * STEP_PX}px`);
}

function onActivity() {
  if (!enabled()) return;
  root.removeAttribute('data-oled-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => root.setAttribute('data-oled-idle', ''), IDLE_MS);
}

// Call after the setting changes (applySettings already set data-oled-care).
export function syncOledCare() {
  clearInterval(shiftTimer);
  clearTimeout(idleTimer);
  root.removeAttribute('data-oled-idle');
  if (!enabled()) {
    root.style.removeProperty('--oled-x');
    root.style.removeProperty('--oled-y');
    return;
  }
  setShift(OFFSETS[shiftIndex]);
  shiftTimer = setInterval(() => {
    shiftIndex = (shiftIndex + 1) % OFFSETS.length;
    setShift(OFFSETS[shiftIndex]);
  }, SHIFT_MS);
  onActivity();
}

export function initOledCare() {
  if (started) return;
  started = true;
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, onActivity, { capture: true, passive: true });
  }
  let was = enabled();
  onSettingsChange(() => {
    if (enabled() !== was) { was = enabled(); syncOledCare(); }
  });
  syncOledCare();
}
