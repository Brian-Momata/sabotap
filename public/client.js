'use strict';

/* ---------- identity & prefs ---------- */

const LS = window.localStorage;
if (!LS.playerId) LS.playerId = 'p_' + crypto.randomUUID();
const prefs = {
  get sound() { return LS.sound !== 'off'; },
  set sound(v) { LS.sound = v ? 'on' : 'off'; },
  get haptics() { return LS.haptics !== 'off'; },
  set haptics(v) { LS.haptics = v ? 'on' : 'off'; },
};

const $ = id => document.getElementById(id);

const state = {
  you: null,
  friends: [],
  room: null,        // last room message
  seat: null,
  matchSeat: 0,
  mode: 'versus',
  role: null,
  phase: 'home',
  round: 0,
  score: [0, 0],
  callerSeat: 0,
  grid: [],
  gridCols: 6,
  target: null,
  charges: 0,
  maxCharges: 3,
  sabotages: [],
  puzzleId: null,
  cooldowns: {},
  pendingInviteFriend: null,
  pendingJoinCode: null,
  rematchVotes: [null, null],
  opponent: null,
};

/* ---------- websocket ---------- */

let ws = null;
let reconnectDelay = 500;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    reconnectDelay = 500;
    send({ t: 'hello', playerId: LS.playerId, name: LS.name || '' });
  };
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const h = handlers[msg.t];
    if (h) h(msg);
  };
  ws.onclose = () => {
    leaveVoice(false); // server already dropped us from voice on disconnect
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/* ---------- audio & haptics ---------- */

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
const sfx = {
  tap: () => blip(320, 0.04),
  wrong: () => blip(140, 0.15, 'square', 0.04),
  correct: () => { blip(520, 0.09); setTimeout(() => blip(780, 0.12), 90); },
  charge: () => blip(660, 0.08, 'triangle'),
  sabotage: () => { blip(220, 0.2, 'sawtooth', 0.05); },
  win: () => { blip(520, 0.1); setTimeout(() => blip(660, 0.1), 110); setTimeout(() => blip(880, 0.16), 220); },
  lose: () => { blip(300, 0.12, 'square', 0.04); setTimeout(() => blip(200, 0.2, 'square', 0.04), 130); },
};
function buzz(pattern) {
  if (prefs.haptics && navigator.vibrate) navigator.vibrate(pattern);
}

/* ---------- screens & toast ---------- */

function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('on'));
  $(screen).classList.add('on');
  if (typeof renderVoiceDock === 'function') renderVoiceDock();
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}

/* ---------- home ---------- */

function renderYou() {
  if (!state.you) return;
  $('youTag').textContent = state.you.tag;
  if (!$('nameInput').value) $('nameInput').value = state.you.name;
}

function renderFriends() {
  const list = $('friendList');
  list.innerHTML = '';
  if (!state.friends.length) {
    list.innerHTML = '<div class="friend-row"><span class="friend-name" style="color: var(--text-3);">No friends yet — add one by tag, or after a match.</span></div>';
    return;
  }
  for (const f of state.friends) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const dot = document.createElement('span');
    dot.className = 'dot' + (f.online ? ' online' : '');
    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = f.name;
    const tag = document.createElement('span');
    tag.className = 'friend-tag mono';
    tag.textContent = f.tag;
    row.append(dot, name, tag);
    if (f.status === 'pending_in') {
      const btn = document.createElement('button');
      btn.className = 'chip-btn';
      btn.textContent = 'Accept';
      btn.onclick = () => send({ t: 'friendAccept', id: f.id });
      row.append(btn);
    } else if (f.status === 'pending_out') {
      const s = document.createElement('span');
      s.className = 'friend-tag';
      s.textContent = 'invited';
      row.append(s);
    } else {
      const btn = document.createElement('button');
      btn.className = 'chip-btn';
      btn.textContent = 'Invite';
      btn.disabled = !f.online;
      btn.onclick = () => inviteFriend(f);
      row.append(btn);
    }
    list.append(row);
  }
}

function inviteFriend(f) {
  if (state.room && (state.phase === 'lobby')) {
    send({ t: 'friendInvite', id: f.id });
  } else {
    state.pendingInviteFriend = f.id;
    send({ t: 'create' });
  }
}

/* ---------- lobby ---------- */

function renderLobby() {
  const r = state.room;
  if (!r) return;
  state.mode = r.settings.mode || 'versus';
  $('lobbyCode').textContent = r.code;
  const isHost = state.seat === (r.host || 0);
  const tourn = state.mode === 'tournament';
  const maxP = r.maxPlayers || (tourn ? 8 : 2);
  const minP = r.minPlayers || (tourn ? 3 : 2);

  const wrap = $('lobbyPlayers');
  wrap.innerHTML = '';
  for (const p of r.players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const chip = p.seat === (r.host || 0)
      ? '<span class="row-chip">HOST</span>'
      : (p.ready ? '<span class="row-chip ready">READY</span>' : '<span class="row-chip">NOT READY</span>');
    row.innerHTML = `<span class="dot ${p.connected ? 'online' : ''}"></span><span style="flex:1">${esc(p.name)}${p.seat === state.seat ? ' (you)' : ''}</span>${chip}`;
    wrap.append(row);
  }
  if (r.players.length < maxP) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<span class="dot"></span><span class="muted">Waiting for players… (${r.players.length}/${tourn ? maxP : 2})</span>`;
    wrap.append(row);
  }

  renderSegs('modeGroup', ['versus', 'tournament'], state.mode, isHost,
    v => send({ t: 'settings', mode: v }), k => (k === 'versus' ? '1 v 1' : 'Tournament'));
  $('modeHint').textContent = tourn
    ? `${minP}–${maxP} players · round-robin, everyone plays everyone · 2 rounds per match · most round wins takes it`
    : '';

  $('roundsLabel').hidden = tourn;
  $('roundsGroup').hidden = tourn;
  if (!tourn) {
    renderSegs('roundsGroup', (state.config?.roundsToWinOptions) || [2, 3, 5], r.settings.roundsToWin, isHost,
      v => send({ t: 'settings', roundsToWin: v }), v => `${v} wins`);
  }
  const diffs = state.config?.difficulties || [];
  renderSegs('diffGroup', diffs.map(d => d.key), r.settings.difficulty, isHost,
    v => send({ t: 'settings', difficulty: v }), k => (diffs.find(d => d.key === k) || { name: k }).name);
  const cur = diffs.find(d => d.key === r.settings.difficulty);
  $('diffHint').textContent = cur ? `${cur.fuseMs / 1000}s fuse — faster fuse, faster puzzles, trickier digits.` : '';

  const btn = $('startBtn');
  btn.classList.remove('btn-ready');
  if (isHost) {
    const others = r.players.filter(p => p.seat !== (r.host || 0));
    const allReady = others.length && others.every(p => p.ready);
    const enough = r.players.length >= minP && (tourn || r.players.length === 2);
    btn.disabled = !(enough && allReady);
    btn.textContent = !enough
      ? `Waiting for players… (${r.players.length}/${minP})`
      : (allReady ? (tourn ? 'Start Tournament' : 'Start Match') : 'Waiting for ready…');
  } else {
    const me = r.players.find(x => x.seat === state.seat);
    btn.disabled = false;
    if (me && me.ready) {
      btn.textContent = 'Ready — host starts the match';
      btn.classList.add('btn-ready');
    } else {
      btn.textContent = "I'm Ready";
    }
  }
}

function renderSegs(groupId, options, selected, enabled, onPick, label) {
  const g = $(groupId);
  g.innerHTML = '';
  for (const v of options) {
    const b = document.createElement('button');
    b.className = 'seg' + (v === selected ? ' sel' : '');
    b.textContent = label(v);
    b.disabled = !enabled;
    b.onclick = () => onPick(v);
    g.append(b);
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------- game rendering ---------- */

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

function renderFuse(v) {
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

function cells() {
  return $('grid').children;
}

function showGamePanels({ grid, wait, caller }) {
  $('gridOuter').hidden = !grid;
  $('waitBox').hidden = !wait;
  $('callerPanel').hidden = !caller;
  $('callerPanel').style.display = caller ? 'flex' : 'none';
}

function enterPickPhase(msg) {
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

function enterLivePhase(msg) {
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

/* ---------- caller panel ---------- */

function renderPuzzle(msg) {
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

function renderCharges() {
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

function updateSabButtons() {
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

function resetEffects() {
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

function applySwap(a, b) {
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

function handleSabotage(msg) {
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

/* ---------- tournament ---------- */

function startCountdown(el, ms, { prefix = '~', doneText = 'any moment…', seconds = false } = {}) {
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

function renderStandings(el, rows) {
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

const TWAIT_STATUS = {
  finished: 'Match done — waiting for the other matches to finish',
  bye: 'You sit out this stage — back in the next pairing',
  walkover: 'Walkover — your opponent left. Waiting for the other matches',
};

/* ---------- results ---------- */

function renderResults(msg) {
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

/* ---------- message handlers ---------- */

const handlers = {
  hello(msg) {
    state.you = msg.you;
    state.friends = msg.friends || [];
    if (msg.config) state.config = msg.config;
    LS.name = msg.you.name;
    renderYou();
    renderFriends();
    if (state.pendingJoinCode) {
      send({ t: 'join', code: state.pendingJoinCode });
      state.pendingJoinCode = null;
    }
  },

  friends(msg) {
    state.friends = msg.list;
    renderFriends();
    if (!$('addFriendResultBtn').hidden && state.opponent) {
      $('addFriendResultBtn').hidden = state.friends.some(f => f.id === state.opponent.id);
    }
  },

  friendRequest(msg) {
    toast(`${msg.from.name} (${msg.from.tag}) wants to be friends — check your Friends list.`);
  },

  invite(msg) {
    $('inviteTitle').textContent = `${msg.from.name} invited you`;
    $('inviteSub').textContent = `Join room ${msg.code} and play a match right now.`;
    $('inviteAcceptBtn').onclick = () => {
      $('inviteOverlay').classList.remove('on');
      send({ t: 'join', code: msg.code });
    };
    $('inviteOverlay').classList.add('on');
    sfx.charge();
    buzz([50, 50, 50]);
  },

  room(msg) {
    state.room = msg;
    state.seat = msg.you;
    if (msg.phase === 'lobby') {
      state.phase = 'lobby';
      $('pauseOverlay').classList.remove('on');
      $('roundOverlay').classList.remove('on');
      renderLobby();
      show('s-lobby');
      if (state.pendingInviteFriend) {
        send({ t: 'friendInvite', id: state.pendingInviteFriend });
        state.pendingInviteFriend = null;
      }
    } else {
      renderLobby();
    }
  },

  left() {
    leaveVoice(false);
    state.room = null;
    state.phase = 'home';
    show('s-home');
    renderVoiceDock();
  },

  roundStart(msg) {
    enterPickPhase(msg);
  },

  live(msg) {
    enterLivePhase(msg);
  },

  fuse(msg) {
    renderFuse(msg.v);
  },

  puzzle(msg) {
    renderPuzzle(msg);
  },

  puzzleResult(msg) {
    if (msg.ok) { sfx.charge(); buzz(30); }
  },

  charges(msg) {
    if (msg.n > state.charges) sfx.charge();
    state.charges = msg.n;
    renderCharges();
  },

  wrong(msg) {
    const c = cells()[msg.index];
    if (c) {
      c.classList.add('wrong');
      setTimeout(() => c.classList.remove('wrong'), 350);
    }
    sfx.wrong();
    buzz(80);
  },

  callerFeed(msg) {
    $('callerFeed').textContent = msg.text;
  },

  sabotage(msg) {
    handleSabotage(msg);
  },

  sabotageFired(msg) {
    state.cooldowns[msg.kind] = Date.now() + (msg.cooldownMs || 0);
    updateSabButtons();
    $('callerFeed').textContent = `${msg.name} fired ⚡`;
    sfx.sabotage();
  },

  gridRevert(msg) {
    applySwap(msg.a, msg.b);
  },

  roundEnd(msg) {
    state.phase = 'roundEnd';
    state.score = msg.score;
    resetEffects();
    // Reveal the target on the searcher's grid.
    if (state.role === 'searcher') {
      const cs = cells();
      if (msg.foundIndex >= 0 && cs[msg.foundIndex]) cs[msg.foundIndex].classList.add('correct');
      else if (cs[msg.targetIndex]) cs[msg.targetIndex].classList.add('reveal');
    }
    const won = msg.winnerSeat === state.matchSeat;
    $('roundOverlayEyebrow').textContent = msg.matchOver ? 'Match point' : `Round ${state.round}`;
    $('roundOverlayTitle').textContent = won ? 'Round yours' : 'Round lost';
    $('roundOverlayTitle').style.color = won ? 'var(--win)' : 'var(--danger)';
    $('roundOverlaySub').textContent = msg.reason === 'found'
      ? `The target ${msg.target} was found.`
      : `The fuse ran out — ${msg.target} stayed hidden.`;
    setTimeout(() => $('roundOverlay').classList.add('on'), msg.reason === 'found' ? 450 : 0);
    (won ? sfx.correct : sfx.wrong)();
    buzz(won ? [40, 40, 80] : [150]);
  },

  tPairing(msg) {
    $('roundOverlay').classList.remove('on');
    $('pairStage').textContent = `Stage ${msg.stage} of ${msg.stages}`;
    $('pairVs').textContent = `You vs ${msg.opponent.name}`;
    $('pairInfo').textContent = `You: #${msg.you.rank} · ${msg.you.points} pts   —   ${msg.opponent.name}: #${msg.opponent.rank} · ${msg.opponent.points} pts`;
    startCountdown($('pairCount'), msg.startsInMs, { prefix: 'Starting in ', doneText: 'Starting…', seconds: true });
    $('pairOverlay').classList.add('on');
    sfx.charge();
    buzz([40, 40, 40]);
  },

  tWaiting(msg) {
    $('roundOverlay').classList.remove('on');
    $('pairOverlay').classList.remove('on');
    resetEffects();
    $('twaitStage').textContent = `Stage ${msg.stage} / ${msg.stages}`;
    $('twaitStatus').textContent = TWAIT_STATUS[msg.reason] || 'Waiting to pair…';
    if (msg.estimateMs > 0) startCountdown($('twaitCount'), msg.estimateMs);
    else $('twaitCount').textContent = 'any moment…';
    renderStandings($('twaitStandings'), msg.standings);
    show('s-twait');
  },

  tStandings(msg) {
    if (!$('s-twait').classList.contains('on')) return;
    $('twaitStage').textContent = `Stage ${msg.stage} / ${msg.stages}`;
    if (msg.estimateMs > 0) startCountdown($('twaitCount'), msg.estimateMs);
    else $('twaitCount').textContent = 'any moment…';
    renderStandings($('twaitStandings'), msg.standings);
  },

  tEnd(msg) {
    $('roundOverlay').classList.remove('on');
    $('pairOverlay').classList.remove('on');
    resetEffects();
    const mine = msg.leaderboard.find(r => state.you && r.id === state.you.id);
    const v = $('tendVerdict');
    if (mine && mine.rank === 1) {
      v.textContent = 'YOU WIN THE TOURNAMENT';
      v.className = 'verdict win';
      sfx.win();
      buzz([40, 30, 40, 30, 160]);
    } else {
      v.textContent = mine ? `#${mine.rank} PLACE` : 'TOURNAMENT OVER';
      v.className = 'verdict';
      sfx.lose();
    }
    $('tendPoints').textContent = mine ? `${mine.points} pts` : '';
    renderStandings($('tendBoard'), msg.leaderboard);
    show('s-tend');
  },

  matchEnd(msg) {
    $('roundOverlay').classList.remove('on');
    resetEffects();
    renderResults(msg);
  },

  rematchStatus(msg) {
    const votes = msg.votes.filter(Boolean).length;
    $('rematchBtn').textContent = votes === 1 ? 'Rematch (1/2 ready)' : 'Rematch';
  },

  opponentStatus(msg) {
    $('pauseOverlay').classList.toggle('on', !msg.connected);
  },

  resume(msg) {
    state.room = msg;
    state.seat = msg.you;
    state.mode = msg.settings ? (msg.settings.mode || 'versus') : 'versus';
    $('pauseOverlay').classList.remove('on');
    $('pairOverlay').classList.remove('on');
    $('roundOverlay').classList.remove('on');
    if (msg.match) {
      const s = msg.match;
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
    } else if (msg.phase === 'lobby' || msg.phase === 'matchEnd' || msg.phase === 'tEnd') {
      // matchEnd / tEnd screens arrive as separate follow-up messages
      state.phase = 'lobby';
      renderLobby();
      show('s-lobby');
    }
    // phase 'playing' without a match: a tWaiting follow-up is on its way
  },

  voiceState(msg) {
    voice.members = msg.members || [];
    syncVoicePeers();
    renderVoiceDock();
  },

  async rtc(msg) {
    if (!voice.joined) return;
    const entry = voice.peers.get(msg.from) || voicePeer(msg.from, false);
    const pc = entry.pc;
    try {
      if (msg.data.sdp) {
        await pc.setRemoteDescription(msg.data.sdp);
        if (msg.data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          send({ t: 'rtc', to: msg.from, data: { sdp: pc.localDescription } });
        }
        while (entry.pendingIce.length) pc.addIceCandidate(entry.pendingIce.shift()).catch(() => {});
      } else if (msg.data.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.data.ice);
        else entry.pendingIce.push(msg.data.ice);
      }
    } catch {}
  },

  toast(msg) {
    toast(msg.msg);
  },

  error(msg) {
    toast(msg.msg);
  },
};

/* ---------- ui wiring ---------- */

$('nameInput').addEventListener('change', () => {
  const name = $('nameInput').value.trim();
  if (name) {
    LS.name = name;
    send({ t: 'setName', name });
  }
});

$('createBtn').onclick = () => send({ t: 'create' });

$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code) send({ t: 'join', code });
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

$('friendAddBtn').onclick = () => {
  const tag = $('friendTagInput').value.trim().toUpperCase();
  if (tag) {
    send({ t: 'friendAdd', tag });
    $('friendTagInput').value = '';
  }
};

$('shareBtn').onclick = async () => {
  if (!state.room) return;
  const url = `${location.origin}/#${state.room.code}`;
  const text = `Play Sabotap with me — room ${state.room.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Sabotap', text, url }); } catch {}
  } else {
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.');
    } catch {
      toast(url);
    }
  }
};

$('startBtn').onclick = () => {
  if (state.room && state.seat === (state.room.host || 0)) {
    send({ t: 'start' });
  } else {
    const me = state.room && state.room.players.find(x => x.seat === state.seat);
    send({ t: 'ready', ready: !(me && me.ready) });
  }
};
$('leaveBtn').onclick = () => send({ t: 'leave' });
$('rematchBtn').onclick = () => {
  send({ t: 'rematch' });
  $('rematchBtn').textContent = 'Waiting for opponent…';
};
$('backHomeBtn').onclick = () => {
  // Return to the shared room lobby (keeps the same code for another match).
  if (state.room) {
    send({ t: 'leave' });
  }
  show('s-home');
  state.phase = 'home';
};
$('addFriendResultBtn').onclick = () => {
  const opp = state.opponent;
  if (!opp) return;
  // We only know the opponent's id here; the server matches friends by tag,
  // so ask it via the tag of the profile — fetch through a targeted add.
  send({ t: 'friendAdd', tag: opp.tag || '' });
};
$('inviteDeclineBtn').onclick = () => $('inviteOverlay').classList.remove('on');
$('tendLobbyBtn').onclick = () => {
  renderLobby();
  show('s-lobby');
  state.phase = 'lobby';
};

function renderPrefButtons() {
  $('soundToggle').textContent = `Sound: ${prefs.sound ? 'on' : 'off'}`;
  $('soundToggle').classList.toggle('on', prefs.sound);
  $('hapticsToggle').textContent = `Haptics: ${prefs.haptics ? 'on' : 'off'}`;
  $('hapticsToggle').classList.toggle('on', prefs.haptics);
}
$('soundToggle').onclick = () => { prefs.sound = !prefs.sound; renderPrefButtons(); };
$('hapticsToggle').onclick = () => { prefs.haptics = !prefs.haptics; renderPrefButtons(); };
renderPrefButtons();

/* ---------- room voice chat (WebRTC mesh, signaled over the game socket) ---------- */

const voice = { joined: false, muted: false, stream: null, peers: new Map(), members: [] };
window.voice = voice; // exposed for automated tests

function rtcConfig() {
  return { iceServers: (state.config && state.config.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }] };
}

async function joinVoice() {
  if (voice.joined) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    toast('Microphone blocked — allow mic access to use voice chat.');
    return;
  }
  voice.stream = stream;
  voice.joined = true;
  voice.muted = false;
  send({ t: 'voiceJoin' });
  renderVoiceDock();
}

function leaveVoice(notify = true) {
  if (!voice.joined) return;
  if (notify) send({ t: 'voiceLeave' });
  voice.peers.forEach(entry => {
    try { entry.pc.close(); } catch {}
    entry.audio.remove();
  });
  voice.peers.clear();
  if (voice.stream) voice.stream.getTracks().forEach(tr => tr.stop());
  voice.stream = null;
  voice.joined = false;
  voice.muted = false;
  voice.members = [];
  renderVoiceDock();
}

function toggleVoiceMute() {
  if (!voice.joined) return;
  voice.muted = !voice.muted;
  voice.stream.getAudioTracks().forEach(tr => { tr.enabled = !voice.muted; });
  send({ t: 'voiceMute', muted: voice.muted });
  renderVoiceDock();
}

function voicePeer(id, initiator) {
  let entry = voice.peers.get(id);
  if (entry) return entry;
  const pc = new RTCPeerConnection(rtcConfig());
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  document.body.append(audio);
  entry = { pc, audio, pendingIce: [] };
  voice.peers.set(id, entry);
  voice.stream.getTracks().forEach(tr => pc.addTrack(tr, voice.stream));
  pc.ontrack = e => { audio.srcObject = e.streams[0]; };
  pc.onicecandidate = e => { if (e.candidate) send({ t: 'rtc', to: id, data: { ice: e.candidate } }); };
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        send({ t: 'rtc', to: id, data: { sdp: pc.localDescription } });
      } catch {}
    };
  }
  return entry;
}

function dropVoicePeer(id) {
  const entry = voice.peers.get(id);
  if (!entry) return;
  try { entry.pc.close(); } catch {}
  entry.audio.remove();
  voice.peers.delete(id);
}

function syncVoicePeers() {
  if (!voice.joined || !state.you) return;
  const ids = new Set(voice.members.map(m => m.id));
  for (const id of [...voice.peers.keys()]) {
    if (!ids.has(id)) dropVoicePeer(id);
  }
  for (const m of voice.members) {
    if (m.id === state.you.id || voice.peers.has(m.id)) continue;
    // Exactly one side initiates per pair: the lexically larger id.
    if (state.you.id > m.id) voicePeer(m.id, true);
  }
}

function renderVoiceDock() {
  const dock = $('voiceDock');
  const inRoom = !!state.room && !$('s-home').classList.contains('on');
  dock.hidden = !inRoom;
  if (!inRoom) return;
  // during a match the dock lives in the game header so it never covers the grid
  const inGame = $('s-game').classList.contains('on');
  const wantParent = inGame ? $('voiceSlot') : document.body;
  if (dock.parentElement !== wantParent) wantParent.appendChild(dock);
  dock.classList.toggle('inhead', inGame);
  dock.classList.toggle('live', voice.joined);
  $('voiceJoinBtn').hidden = voice.joined;
  $('voiceLive').hidden = !voice.joined;
  if (voice.joined) {
    $('voiceCount').textContent = String(voice.members.length || 1);
    $('voiceMuteBtn').classList.toggle('muted', voice.muted);
  }
}

$('voiceJoinBtn').onclick = joinVoice;
$('voiceLeaveBtn').onclick = () => leaveVoice(true);
$('voiceMuteBtn').onclick = toggleVoiceMute;

/* ---------- pwa install prompt ---------- */

let deferredInstall = null;
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstall() {
  const card = $('installCard');
  if (isStandalone || LS.installDismissed === '1') return void (card.hidden = true);
  if (deferredInstall) {
    // Chrome/Android: we can trigger the real install prompt.
    $('installSub').textContent = 'Fullscreen, home-screen icon, faster loads.';
    $('installBtn').hidden = false;
    card.hidden = false;
  } else if (isIOS) {
    // iOS Safari never fires beforeinstallprompt — show the manual steps.
    $('installSub').textContent = 'Tap Share ⎋ then “Add to Home Screen” to install.';
    $('installBtn').hidden = true;
    card.hidden = false;
  } else {
    card.hidden = true;
  }
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  renderInstall();
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  $('installCard').hidden = true;
  toast('Sabotap installed — find it on your home screen.');
});

$('installBtn').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  renderInstall();
};

$('installDismiss').onclick = () => {
  LS.installDismissed = '1';
  $('installCard').hidden = true;
};

renderInstall();

/* ---------- boot ---------- */

const hashCode = location.hash.replace('#', '').trim().toUpperCase();
if (/^[A-Z]{3,4}-\d{2}$/.test(hashCode)) {
  state.pendingJoinCode = hashCode;
  history.replaceState(null, '', location.pathname);
}

show('s-home');
connect();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
