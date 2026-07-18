/* Game screen: grid, fuse, and the caller panel. Sabotage visuals live in
   sabotage-fx.js; board theming in board-themes.js. */

import { $, state, esc } from './state.js';
import { send } from './net.js';
import { sfx } from './audio.js';
import { show } from './ui.js';
import { boardRoundStart, armBoardFx, driftRowStyle } from './board-themes.js';
import { resetEffects } from './sabotage-fx.js';

/* ---------- layout & head ---------- */

function setAccent(role) {
  const game = $('s-game');
  game.style.setProperty('--accent', role === 'caller' ? 'var(--accent-caller)' : 'var(--accent-searcher)');
}

function renderHead() {
  const role = state.role === 'caller' ? 'CALLER' : 'SEARCHER';
  $('roleLabel').textContent = state.opponentName ? `${role} · VS ${state.opponentName.toUpperCase()}` : role;
  const [a, b] = state.score;
  const mine = state.matchSeat === 0 ? `${a}–${b}` : `${b}–${a}`;
  $('scoreLabel').textContent = `R${state.round} · ${mine}`;
}

export function renderFuse(v) {
  const pct = Math.min(100, Math.round(v * 100));
  $('fuseFill').style.width = pct + '%';
  $('fusePct').textContent = pct + '%';
  const wrap = $('fuseWrap');
  wrap.classList.toggle('critical', v >= 0.8);
  $('fuseName').textContent = v >= 0.8 ? 'FUSE · CRITICAL' : 'FUSE';
}

// Drift builds row containers (so each row can move as one unit) while every
// other board keeps the flat CSS grid; state.cellEls preserves index order
// either way, so taps and sabotage effects are layout-agnostic.
function buildGrid(values, tappable, drift = false) {
  state.grid = [...values];
  const grid = $('grid');
  grid.innerHTML = '';
  grid.classList.toggle('drifting', drift);
  grid.style.gridTemplateColumns = drift ? '' : `repeat(${state.gridCols}, 1fr)`;
  state.cellEls = [];
  let rowEl = null;
  values.forEach((v, i) => {
    if (drift && i % state.gridCols === 0) {
      rowEl = document.createElement('div');
      driftRowStyle(rowEl, Math.floor(i / state.gridCols), state.board || {});
      grid.append(rowEl);
    }
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = v;
    if (tappable) {
      cell.onclick = () => {
        sfx.tap();
        send({ t: state.phase === 'pick' ? 'pick' : 'tap', index: i });
      };
    }
    (drift ? rowEl : grid).append(cell);
    state.cellEls.push(cell);
  });
}

export function cells() {
  return state.cellEls || [];
}

function showGamePanels({ grid, wait, caller }) {
  $('gridOuter').hidden = !grid;
  $('waitBox').hidden = !wait;
  $('callerPanel').hidden = !caller;
  $('callerPanel').style.display = caller ? 'flex' : 'none';
}

/* ---------- phases ---------- */

export function enterPickPhase(msg) {
  state.phase = 'pick';
  state.round = msg.round;
  state.score = msg.score;
  state.callerSeat = msg.callerSeat;
  state.matchSeat = msg.you ?? state.seat;
  state.opponentName = msg.opponent || null;
  state.role = msg.role;
  $('pairOverlay').classList.remove('on');
  setAccent(msg.role);
  renderHead();
  renderFuse(0);
  $('roundOverlay').classList.remove('on');
  show('s-game');
  resetEffects();
  state.cooldowns = {};
  state.board = msg.board || state.board || null;
  boardRoundStart(state.board, msg.round);
  if (msg.role === 'caller') {
    state.gridCols = msg.gridCols;
    $('findLbl').textContent = 'PICK THE TARGET';
    $('findNum').textContent = '· ·';
    buildGrid(msg.grid, true);
    showGamePanels({ grid: true, wait: false, caller: false });
  } else {
    $('findLbl').textContent = 'FIND';
    $('findNum').textContent = '· ·';
    $('waitText').textContent = 'Caller is choosing a target…';
    showGamePanels({ grid: false, wait: true, caller: false });
  }
}

export function enterLivePhase(msg) {
  state.phase = 'live';
  state.target = msg.target;
  state.maxCharges = msg.maxCharges;
  state.sabotages = msg.sabotages;
  $('findLbl').textContent = state.role === 'caller' ? 'THEY SEEK' : 'FIND';
  $('findNum').textContent = msg.target;
  if (state.role === 'searcher') {
    state.gridCols = msg.gridCols;
    buildGrid(msg.grid, true, state.board && state.board.key === 'drift');
    showGamePanels({ grid: true, wait: false, caller: false });
    armBoardFx(state.board);
  } else {
    state.charges = msg.charges || 0;
    renderCharges();
    renderSabotages();
    $('callerFeed').textContent = '';
    showGamePanels({ grid: false, wait: false, caller: true });
  }
}

// Rebuild the game screen after a reconnect, from a server match snapshot.
export function resumeMatch(s) {
  state.matchSeat = s.you;
  state.board = s.board || null;
  state.round = s.round;
  state.score = s.score;
  state.callerSeat = s.callerSeat;
  state.role = s.role;
  state.opponentName = s.opponent || null;
  state.gridCols = s.gridCols;
  state.maxCharges = s.maxCharges;
  state.sabotages = s.sabotages;
  if (s.phase === 'pick') {
    enterPickPhase(s);
  } else if (s.phase === 'live') {
    setAccent(s.role);
    renderHead();
    show('s-game');
    resetEffects();
    state.cooldowns = {};
    boardRoundStart(s.board, s.round);
    enterLivePhase(s);
    renderFuse(s.fuse);
  } else {
    // roundEnd: the next roundStart / stage message arrives within seconds
    setAccent(s.role);
    renderHead();
    show('s-game');
    resetEffects();
  }
}

/* ---------- caller panel ---------- */

export function renderPuzzle(msg) {
  state.puzzleId = msg.id;
  const row = $('puzzleRow');
  row.innerHTML = '';
  msg.tiles.forEach((d, i) => {
    const t = document.createElement('div');
    t.className = 'ptile';
    t.textContent = d;
    t.onclick = () => {
      sfx.tap();
      send({ t: 'puzzle', id: state.puzzleId, index: i });
    };
    row.append(t);
  });
  // drain bar: snap to 100% then animate to 0 over timeMs
  const fill = $('ptimerFill');
  fill.classList.remove('drain');
  fill.style.transitionDuration = '0s';
  fill.style.width = '100%';
  void fill.offsetWidth;
  fill.classList.add('drain');
  fill.style.transitionDuration = msg.timeMs + 'ms';
  fill.style.width = '0%';
}

export function renderCharges() {
  const row = $('chargeRow');
  row.innerHTML = '';
  for (let i = 0; i < state.maxCharges; i++) {
    const pip = document.createElement('div');
    pip.className = 'charge-pip' + (i < state.charges ? ' full' : '');
    row.append(pip);
  }
  $('chargeLabel').textContent = `${state.charges} / ${state.maxCharges} CHARGES`;
  updateSabButtons();
}

function renderSabotages() {
  const list = $('sabList');
  list.innerHTML = '';
  for (const s of state.sabotages) {
    const b = document.createElement('button');
    b.className = 'sab-btn';
    b.dataset.kind = s.kind;
    b.innerHTML = `<span>${esc(s.name)}</span><small>${esc(s.detail)}</small>`;
    b.onclick = () => send({ t: 'sabotage', kind: s.kind });
    list.append(b);
  }
  updateSabButtons();
}

export function updateSabButtons() {
  const now = Date.now();
  document.querySelectorAll('.sab-btn').forEach(b => {
    const spec = state.sabotages.find(s => s.kind === b.dataset.kind);
    const until = state.cooldowns[b.dataset.kind] || 0;
    const coolingS = Math.ceil((until - now) / 1000);
    b.disabled = state.charges < 1 || coolingS > 0;
    const small = b.querySelector('small');
    if (small && spec) small.textContent = coolingS > 0 ? `recharging ${coolingS}s` : spec.detail;
  });
}
setInterval(updateSabButtons, 250);
