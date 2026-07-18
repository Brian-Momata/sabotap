/* Tournament screens: countdowns, standings tables, waiting statuses. */

import { state, esc } from './state.js';

export function startCountdown(el, ms, { prefix = '~', doneText = 'any moment…', seconds = false } = {}) {
  clearInterval(el._cd);
  const end = Date.now() + ms;
  const tick = () => {
    const left = end - Date.now();
    if (left <= 0) {
      el.textContent = doneText;
      clearInterval(el._cd);
      return;
    }
    const s = Math.ceil(left / 1000);
    el.textContent = seconds
      ? `${prefix}${s}…`
      : `${prefix}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  el._cd = setInterval(tick, 500);
}

export function renderStandings(el, rows) {
  el.innerHTML = '';
  rows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'standing-row'
      + (state.you && r.id === state.you.id ? ' you' : '')
      + (r.active === false ? ' gone' : '')
      + (r.rank === 1 ? ' first' : '');
    row.innerHTML = `<span class="rank">#${r.rank}</span>`
      + `<span class="sname">${esc(r.name)}${state.you && r.id === state.you.id ? ' (you)' : ''}${r.active === false ? ' · left' : ''}</span>`
      + `<span class="played">${r.played}m</span>`
      + `<span class="pts">${r.points} pt${r.points === 1 ? '' : 's'}</span>`;
    el.append(row);
  });
}

export const TWAIT_STATUS = {
  finished: 'Match done. Waiting for the other matches to finish',
  bye: 'You sit out this stage, back in the next pairing',
  walkover: 'Walkover. Your opponent left. Waiting for the other matches',
};
