/* Versus results screen. */

import { $, state } from './state.js';
import { sfx, buzz } from './audio.js';
import { show } from './ui.js';

export function renderResults(msg) {
  state.phase = 'matchEnd';
  const won = msg.winnerSeat === state.seat;
  const v = $('verdict');
  v.textContent = won ? 'YOU WIN' : 'YOU LOSE';
  v.className = 'verdict ' + (won ? 'win' : 'lose');
  const mine = msg.score[state.seat];
  const theirs = msg.score[1 - state.seat];
  $('finalScore').textContent = `${mine}–${theirs}`;
  const dots = $('historyDots');
  dots.innerHTML = '';
  msg.history.forEach(w => {
    const d = document.createElement('div');
    d.className = 'hdot ' + (w === state.seat ? 'w' : 'l');
    dots.append(d);
  });
  const logEl = $('roundLog');
  logEl.innerHTML = '';
  (msg.log || []).forEach(l => {
    const d = document.createElement('div');
    d.textContent = `R${l.round} · ${l.text}`;
    logEl.append(d);
  });
  const opp = (msg.players || []).find(p => p.seat !== state.seat);
  state.opponent = opp || null;
  const isFriend = opp && state.friends.some(f => f.id === opp.id);
  $('addFriendResultBtn').hidden = !opp || isFriend;
  $('rematchBtn').textContent = 'Rematch';
  (won ? sfx.win : sfx.lose)();
  buzz(won ? [40, 30, 40, 30, 120] : [200]);
  show('s-results');
}
