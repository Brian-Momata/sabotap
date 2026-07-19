/* Screen switching and toast — the only DOM chrome shared by every view. */

import { $ } from './state.js';
import { renderVoiceDock } from './voice.js';
import { setWakeLock } from './wake-lock.js';

export function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  $(screen).classList.add('on');
  // Any in-room screen holds the wake lock; home releases it.
  setWakeLock(screen !== 's-home');
  renderVoiceDock();
}

let toastTimer = null;
export function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}
