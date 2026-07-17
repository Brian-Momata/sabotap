/* Game screen: grid, fuse, caller panel, and sabotage effects. */

import { $, state, esc } from './state.js';
import { send } from './net.js';
import { sfx, buzz } from './audio.js';
import { show } from './ui.js';

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
  $('fuseName').textContent = v >= 0.8 ? 'FUSE — CRITICAL' : 'FUSE';
}

function buildGrid(values, tappable) {
  state.grid = [...values];
  const grid = $('grid');
  grid.style.gridTemplateColumns = `repeat(${state.gridCols}, 1fr)`;
  grid.innerHTML = '';
  values.forEach((v, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = v;
    if (tappable) {
      cell.onclick = () => {
        sfx.tap();
        send({ t: state.phase === 'pick' ? 'pick' : 'tap', index: i });
      };
    }
    grid.append(cell);
  });
}

export function cells() {
  return $('grid').children;
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
    buildGrid(msg.grid, true);
    showGamePanels({ grid: true, wait: false, caller: false });
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

/* ---------- sabotage effects (searcher) ---------- */

const SAB_ICON = { blur: '🌫', decoys: '✨', swap: '⚡', zoom: '🔍', invert: '🌗' };
let effectTimers = [];

export function resetEffects() {
  effectTimers.forEach(clearTimeout);
  effectTimers = [];
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
