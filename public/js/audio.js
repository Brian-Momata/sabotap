/* Synthesized sound effects and haptics, gated by user prefs. */

import { prefs } from './state.js';

let audioCtx = null;
function blip(freq, dur = 0.07, type = 'sine', gain = 0.05) {
  if (!prefs.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch {}
}

export const sfx = {
  tap: () => blip(320, 0.04),
  wrong: () => blip(140, 0.15, 'square', 0.04),
  correct: () => { blip(520, 0.09); setTimeout(() => blip(780, 0.12), 90); },
  charge: () => blip(660, 0.08, 'triangle'),
  sabotage: () => { blip(220, 0.2, 'sawtooth', 0.05); },
  win: () => { blip(520, 0.1); setTimeout(() => blip(660, 0.1), 110); setTimeout(() => blip(880, 0.16), 220); },
  lose: () => { blip(300, 0.12, 'square', 0.04); setTimeout(() => blip(200, 0.2, 'square', 0.04), 130); },
};

export function buzz(pattern) {
  if (prefs.haptics && navigator.vibrate) navigator.vibrate(pattern);
}
