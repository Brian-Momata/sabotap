/* Searcher-side sabotage effects: the unmissable feedback flash and the
   per-kind grid disruptions. Split from game-view to keep both under the
   size cap; cells() stays the shared index-ordered handle to the grid. */

import { $, state } from './state.js';
import { sfx, buzz } from './audio.js';
import { cells } from './game-view.js';
import { resetBoardFx } from './board-themes.js';


const SAB_ICON = { blur: '🌫', decoys: '✨', swap: '⚡', zoom: '🔍', invert: '🌗' };
let effectTimers = [];

export function resetEffects() {
  effectTimers.forEach(clearTimeout);
  effectTimers = [];
  resetBoardFx();
  $('gridOuter').classList.remove('blurred', 'inverted', 'zoomed');
  $('edgeGlow').classList.remove('on');
  $('sabBanner').classList.remove('on');
}

function flashFeedback(kind, name, detail) {
  // Unmissable: banner + edge glow the instant it lands (design variant C).
  const pink = kind === 'swap';
  const glow = $('edgeGlow');
  glow.style.setProperty('--glow', pink ? 'var(--accent-searcher)' : 'var(--accent-caller)');
  glow.classList.remove('on');
  void glow.offsetWidth;
  glow.classList.add('on');
  const banner = $('sabBanner');
  banner.style.setProperty('--banner-bg', pink ? 'var(--accent-searcher)' : 'var(--accent-caller)');
  banner.style.setProperty('--banner-fg', pink ? 'var(--on-searcher)' : 'var(--on-caller)');
  banner.textContent = `${SAB_ICON[kind] || '⚡'} ${name.toUpperCase()} — ${detail}`;
  banner.classList.add('on');
  effectTimers.push(setTimeout(() => banner.classList.remove('on'), 1600));
  sfx.sabotage();
  buzz([60, 40, 60]);
}

export function applySwap(a, b) {
  const cs = cells();
  const ca = cs[a], cb = cs[b];
  if (!ca || !cb) return;
  const ra = ca.getBoundingClientRect();
  const rb = cb.getBoundingClientRect();
  ca.style.transform = `translate(${rb.left - ra.left}px, ${rb.top - ra.top}px)`;
  cb.style.transform = `translate(${ra.left - rb.left}px, ${ra.top - rb.top}px)`;
  ca.style.zIndex = cb.style.zIndex = 2;
  effectTimers.push(setTimeout(() => {
    ca.style.transition = cb.style.transition = 'none';
    ca.style.transform = cb.style.transform = '';
    ca.style.zIndex = cb.style.zIndex = '';
    const tmp = state.grid[a];
    state.grid[a] = state.grid[b];
    state.grid[b] = tmp;
    ca.textContent = state.grid[a];
    cb.textContent = state.grid[b];
    void ca.offsetWidth;
    ca.style.transition = cb.style.transition = '';
  }, 380));
}

export function handleSabotage(msg) {
  const spec = state.sabotages.find(s => s.kind === msg.kind) || { name: msg.name, detail: '' };
  flashFeedback(msg.kind, msg.name, spec.detail || '');
  const outer = $('gridOuter');
  if (msg.kind === 'blur') {
    outer.classList.add('blurred');
    effectTimers.push(setTimeout(() => outer.classList.remove('blurred'), msg.durationMs));
  } else if (msg.kind === 'invert') {
    outer.classList.add('inverted');
    effectTimers.push(setTimeout(() => outer.classList.remove('inverted'), msg.durationMs));
  } else if (msg.kind === 'zoom') {
    outer.classList.add('zoomed');
    // Pan to the quadrant the server chose (the far side from the target).
    const pan = () => {
      if (msg.focus) {
        outer.scrollLeft = msg.focus.x ? outer.scrollWidth - outer.clientWidth : 0;
        outer.scrollTop = msg.focus.y ? outer.scrollHeight - outer.clientHeight : 0;
      }
    };
    effectTimers.push(setTimeout(pan, 60));
    effectTimers.push(setTimeout(pan, 380));
    effectTimers.push(setTimeout(() => {
      outer.classList.remove('zoomed');
      outer.scrollLeft = 0;
      outer.scrollTop = 0;
    }, msg.durationMs));
  } else if (msg.kind === 'decoys') {
    const cs = cells();
    msg.indices.forEach(i => cs[i] && cs[i].classList.add('decoy'));
    effectTimers.push(setTimeout(() => {
      msg.indices.forEach(i => cs[i] && cs[i].classList.remove('decoy'));
    }, msg.durationMs));
  } else if (msg.kind === 'swap') {
    applySwap(msg.a, msg.b);
  }
}
