/* Speaking detection: WebAudio meters over the local mic and each remote peer
   stream, driving .speaking highlights in the lobby roster and the voice dock.
   Detection is purely local — every audible peer's stream already arrives via
   the mesh, so no signaling is needed. */

import { $, state } from './state.js';
import { voice } from './voice.js';

const ON_RMS = 0.045;  // level that flips a member to "speaking"
const OFF_RMS = 0.025; // must stay below this…
const OFF_TICKS = 3;   // …for this many ticks before unflagging, so words don't flicker
const TICK_MS = 120;

let ctx = null;
let loop = null;
const meters = new Map(); // id -> { source, analyser, data, quiet }
export const speaking = new Set();
window.voiceMeter = { speaking }; // exposed for automated tests

function ensureContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') {
    // Same story as blocked <audio>.play(): remote tracks can arrive outside a
    // user gesture — resume now if allowed, else on the next tap.
    ctx.resume().catch(() => {});
    document.addEventListener('pointerdown', () => ctx.resume().catch(() => {}), { once: true });
  }
  return ctx;
}

export function attachMeter(id, stream) {
  detachMeter(id);
  let source, analyser;
  try {
    const ac = ensureContext();
    source = ac.createMediaStreamSource(stream);
    analyser = ac.createAnalyser();
  } catch {
    return; // no WebAudio — voice still works, just without the highlight
  }
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.4;
  source.connect(analyser); // analysis only — playback stays on the <audio> elements
  meters.set(id, { source, analyser, data: new Uint8Array(analyser.fftSize), quiet: 0 });
  if (!loop) loop = setInterval(tick, TICK_MS);
}

export function detachMeter(id) {
  const m = meters.get(id);
  if (!m) return;
  try { m.source.disconnect(); } catch {}
  meters.delete(id);
  if (speaking.delete(id)) applySpeakingClasses();
  if (!meters.size && loop) {
    clearInterval(loop);
    loop = null;
  }
}

export function stopMeters() {
  for (const id of [...meters.keys()]) detachMeter(id);
}

function rms(m) {
  m.analyser.getByteTimeDomainData(m.data);
  let sum = 0;
  for (let i = 0; i < m.data.length; i++) {
    const v = (m.data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / m.data.length);
}

function tick() {
  let changed = false;
  for (const [id, m] of meters) {
    const level = rms(m);
    if (speaking.has(id)) {
      if (level < OFF_RMS) {
        m.quiet += 1;
        if (m.quiet >= OFF_TICKS) {
          speaking.delete(id);
          changed = true;
        }
      } else {
        m.quiet = 0;
      }
    } else if (level > ON_RMS) {
      m.quiet = 0;
      speaking.add(id);
      changed = true;
    }
  }
  if (changed) applySpeakingClasses();
}

// Idempotent, so renders that rebuild the roster via innerHTML re-apply it.
export function applySpeakingClasses() {
  document.querySelectorAll('.mic-badge[data-id]').forEach(el => {
    el.classList.toggle('speaking', speaking.has(el.dataset.id));
  });
  const dock = $('voiceDock');
  if (dock) dock.classList.toggle('speaking', speaking.size > 0);
  const out = $('voiceSpeaker');
  if (!out) return;
  const names = [...speaking].map(id => {
    if (state.you && id === state.you.id) return 'You';
    const m = voice.members.find(x => x.id === id);
    return m ? m.name.split(' ')[0] : null;
  }).filter(Boolean);
  out.textContent = names.join(', ');
  out.hidden = !names.length;
}
