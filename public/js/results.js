/* Versus results screen, and the solo run's streak summary. */

import { $, state, LS } from './state.js';
import { sfx, buzz } from './audio.js';
import { show } from './ui.js';

// Solo is scored as survival, so the verdict is the streak itself and the only
// thing to beat is your own record. The best is a local display stat — the
// server owns every number that decides a round.
function renderSolo(msg) {
  const streak = msg.streak || 0;
  const best = Math.max(streak, Number(LS.bestStreak) || 0);
  const isRecord = streak > (Number(LS.bestStreak) || 0) && streak > 0;
  LS.bestStreak = String(best);

  const v = $('verdict');
  v.textContent = isRecord ? 'NEW BEST' : 'RUN OVER';
  v.className = 'verdict ' + (isRecord ? 'win' : 'lose');
  $('finalScore').textContent = `${streak} round${streak === 1 ? '' : 's'}`;
  const bestEl = $('soloBest');
  bestEl.hidden = false;
  bestEl.textContent = isRecord ? 'Your longest run yet.' : `Best: ${best}`;
  $('rematchBtn').textContent = 'New Run';
  $('addFriendResultBtn').hidden = true;
  (isRecord ? sfx.win : sfx.lose)();
  buzz(isRecord ? [40, 30, 40, 30, 120] : [200]);
}

export function renderResults(msg) {
  state.phase = 'matchEnd';
  const solo = !!msg.solo;
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

  if (solo) {
    state.opponent = null;
    renderSolo(msg);
    return show('s-results');
  }

  const won = msg.winnerSeat === state.seat;
  const v = $('verdict');
  v.textContent = won ? 'YOU WIN' : 'YOU LOSE';
  v.className = 'verdict ' + (won ? 'win' : 'lose');
  $('finalScore').textContent = `${msg.score[state.seat]}–${msg.score[1 - state.seat]}`;
  $('soloBest').hidden = true;
  const opp = (msg.players || []).find(p => p.seat !== state.seat);
  state.opponent = opp || null;
  const isFriend = opp && state.friends.some(f => f.id === opp.id);
  $('addFriendResultBtn').hidden = !opp || isFriend;
  $('rematchBtn').textContent = 'Rematch';
  (won ? sfx.win : sfx.lose)();
  buzz(won ? [40, 30, 40, 30, 120] : [200]);
  show('s-results');
}
