'use strict';

const CONFIG = require('./config');

const rand = n => Math.floor(Math.random() * n);
const pickOne = arr => arr[rand(arr.length)];

// Digits that read as visually similar — used to steepen the puzzle
// difficulty curve as the round progresses (spec fairness requirement).
const CONFUSABLE = {
  0: [8, 6, 9], 1: [7, 4], 2: [7, 3], 3: [8, 9, 5], 4: [1, 9],
  5: [6, 3, 9], 6: [8, 5, 0], 7: [1, 2], 8: [3, 6, 9, 0], 9: [8, 3, 4, 6, 0],
};

const CODE_WORDS = ['FOX', 'OWL', 'CAT', 'BEE', 'ELK', 'KIT', 'JAY', 'RAM', 'BAT', 'ANT', 'HEN', 'PUP', 'DOE', 'CUB', 'KOI', 'YAK', 'EMU', 'ASP', 'ORC', 'IBEX'];

function makeRoomCode() {
  return `${pickOne(CODE_WORDS)}-${10 + rand(90)}`;
}

function makeGrid() {
  const size = CONFIG.grid.cols * CONFIG.grid.rows;
  const set = new Set();
  while (set.size < size) set.add(10 + rand(90));
  return Array.from(set);
}

function sabotageList() {
  return Object.entries(CONFIG.sabotages).map(([kind, s]) =>
    ({ kind, name: s.name, detail: s.detail, cooldownMs: s.cooldownMs }));
}

// Circle-method round-robin: returns stages of [a, b] roster-index pairs.
// With an odd player count a -1 slot marks the bye.
function roundRobin(n) {
  const ids = [...Array(n).keys()];
  if (n % 2) ids.push(-1);
  const m = ids.length;
  const stages = [];
  const ring = ids.slice(1);
  for (let s = 0; s < m - 1; s++) {
    const order = [ids[0], ...ring];
    const pairs = [];
    for (let i = 0; i < m / 2; i++) pairs.push([order[i], order[m - 1 - i]]);
    stages.push(pairs);
    ring.unshift(ring.pop());
  }
  return stages;
}

/*
 * Match: a self-contained 2-player game engine. Seats are match-local (0/1);
 * all communication goes through the provided ports. Ends either at
 * `firstTo` round wins (versus) or after exactly `totalRounds` rounds
 * (tournament — a 1-1 split is a valid result).
 */
class Match {
  constructor({ ports, names, difficulty, firstTo = 0, totalRounds = 0, hooks = {} }) {
    this.ports = ports;               // [{ send(msg) }, { send(msg) }]
    this.names = names;               // [name0, name1]
    this.difficultyKey = difficulty;
    this.firstTo = firstTo;
    this.totalRounds = totalRounds;
    this.hooks = hooks;               // { onRoundEnd(match, winnerSeat), onEnd(match), log(text) }
    this.round = 0;
    this.wins = [0, 0];
    this.history = [];
    this.phase = 'idle';              // pick | live | roundEnd | done
    this.paused = false;
    this.firstCaller = rand(2);
    this.timers = { swaps: [] };
  }

  difficulty() { return CONFIG.difficulties[this.difficultyKey]; }
  fuseMs() { return CONFIG.fuseMsOverride ?? this.difficulty().fuseMs; }
  puzzleMs() { return CONFIG.puzzleMsOverride ?? this.difficulty().puzzleMs; }
  callerSeat() { return (this.firstCaller + this.round - 1) % 2; }
  searcherSeat() { return 1 - this.callerSeat(); }
  roundsLeft() {
    if (this.phase === 'done') return 0;
    if (this.totalRounds) return this.totalRounds - this.history.length;
    return 1; // versus matches have no fixed horizon; count the live round
  }

  send(seat, msg) { this.ports[seat].send(msg); }
  broadcast(msg) { this.send(0, msg); this.send(1, msg); }
  log(text) { if (this.hooks.log) this.hooks.log(text); }

  start() { this.beginRound(); }

  clearRoundTimers() {
    clearInterval(this.timers.fuse);
    clearTimeout(this.timers.pick);
    clearTimeout(this.timers.puzzle);
    clearTimeout(this.timers.interRound);
    this.timers.swaps.forEach(clearTimeout);
    this.timers.swaps = [];
  }

  forceEnd() {
    this.clearRoundTimers();
    this.phase = 'done';
  }

  beginRound() {
    this.clearRoundTimers();
    this.round += 1;
    this.phase = 'pick';
    this.gridValues = makeGrid();
    this.shown = [...this.gridValues];
    this.pendingSwaps = [];
    this.target = null;
    this.fuse = 0;
    this.charges = 0;
    this.puzzle = null;
    this.puzzleSeq = 0;
    this.lastSabAt = {};

    const caller = this.callerSeat();
    const searcher = this.searcherSeat();
    const base = {
      t: 'roundStart',
      round: this.round,
      callerSeat: caller,
      score: this.wins,
      pickTimeoutMs: CONFIG.pickTimeoutMs,
      gridCols: CONFIG.grid.cols,
      totalRounds: this.totalRounds,
    };
    this.send(caller, { ...base, you: caller, opponent: this.names[searcher], role: 'caller', grid: this.shown });
    this.send(searcher, { ...base, you: searcher, opponent: this.names[caller], role: 'searcher' });
    this.log(`${this.names[caller]} calls against ${this.names[searcher]}.`);
    this.armPickTimeout();
  }

  armPickTimeout() {
    clearTimeout(this.timers.pick);
    this.timers.pick = setTimeout(() => {
      if (this.phase !== 'pick') return;
      this.log(`${this.names[this.callerSeat()]} stalled — target chosen at random.`);
      this.goLive(pickOne(this.gridValues), true);
    }, CONFIG.pickTimeoutMs);
  }

  onPick(seat, index) {
    if (this.phase !== 'pick' || seat !== this.callerSeat()) return;
    if (!(index >= 0 && index < this.gridValues.length)) return;
    this.goLive(this.gridValues[index], false);
  }

  goLive(target, wasRandom) {
    clearTimeout(this.timers.pick);
    this.target = target;
    this.phase = 'live';
    if (!wasRandom) this.log('Target chosen. Fuse armed.');
    const base = {
      t: 'live',
      target,
      fuseMs: this.fuseMs(),
      puzzleTimeMs: this.puzzleMs(),
      maxCharges: CONFIG.maxCharges,
      sabotages: sabotageList(),
    };
    this.send(this.searcherSeat(), { ...base, grid: this.shown, gridCols: CONFIG.grid.cols });
    this.send(this.callerSeat(), base);
    this.startFuse();
    this.newPuzzle();
  }

  startFuse() {
    clearInterval(this.timers.fuse);
    this.timers.fuse = setInterval(() => {
      if (this.phase !== 'live') return;
      this.fuse = Math.min(1, this.fuse + CONFIG.fuseTickMs / this.fuseMs());
      this.broadcast({ t: 'fuse', v: this.fuse });
      if (this.fuse >= 1) {
        this.log('Fuse ran out.');
        this.endRound(this.callerSeat(), 'fuse');
      }
    }, CONFIG.fuseTickMs);
  }

  onTap(seat, index) {
    if (this.phase !== 'live' || seat !== this.searcherSeat()) return;
    if (!(index >= 0 && index < this.shown.length)) return;
    if (this.shown[index] === this.target) {
      this.log(`${this.names[seat]} found ${this.target}.`);
      this.endRound(seat, 'found', index);
    } else {
      this.log(`${this.names[seat]} mistapped ${this.shown[index]}.`);
      this.send(seat, { t: 'wrong', index });
      this.send(this.callerSeat(), { t: 'callerFeed', text: `Mistap on ${this.shown[index]}` });
    }
  }

  newPuzzle() {
    if (this.phase !== 'live') return;
    clearTimeout(this.timers.puzzle);
    const shared = rand(10);
    let odd;
    if (this.fuse >= this.difficulty().confusableFrom && CONFUSABLE[shared].length) {
      odd = pickOne(CONFUSABLE[shared]);
    } else {
      do { odd = rand(10); } while (odd === shared);
    }
    const oddIndex = rand(5);
    const tiles = Array.from({ length: 5 }, (_, i) => (i === oddIndex ? odd : shared));
    this.puzzleSeq += 1;
    this.puzzle = { id: this.puzzleSeq, tiles, oddIndex };
    this.send(this.callerSeat(), { t: 'puzzle', id: this.puzzle.id, tiles, timeMs: this.puzzleMs() });
    this.timers.puzzle = setTimeout(() => {
      if (this.phase !== 'live') return;
      this.send(this.callerSeat(), { t: 'puzzleResult', ok: false, reason: 'timeout' });
      this.newPuzzle();
    }, this.puzzleMs());
  }

  onPuzzleAnswer(seat, puzzleId, index) {
    if (this.phase !== 'live' || seat !== this.callerSeat()) return;
    if (!this.puzzle || this.puzzle.id !== puzzleId) return;
    const ok = index === this.puzzle.oddIndex;
    if (ok) {
      this.charges = Math.min(CONFIG.maxCharges, this.charges + 1);
      this.send(seat, { t: 'charges', n: this.charges });
    }
    this.send(seat, { t: 'puzzleResult', ok, reason: ok ? 'solved' : 'wrong' });
    this.newPuzzle();
  }

  onSabotage(seat, kind) {
    if (this.phase !== 'live' || seat !== this.callerSeat()) return;
    const spec = CONFIG.sabotages[kind];
    if (!spec) return;
    if (this.charges < 1) return this.send(seat, { t: 'error', msg: 'No charges banked.' });
    const sinceLast = Date.now() - (this.lastSabAt[kind] || 0);
    if (sinceLast < spec.cooldownMs) {
      const waitS = Math.ceil((spec.cooldownMs - sinceLast) / 1000);
      return this.send(seat, { t: 'error', msg: `${spec.name} is recharging (${waitS}s).` });
    }
    this.lastSabAt[kind] = Date.now();
    this.charges -= 1;
    this.send(seat, { t: 'charges', n: this.charges });
    this.log(`${this.names[seat]} fired ${spec.name}.`);

    const msg = { t: 'sabotage', kind, name: spec.name, durationMs: spec.durationMs };
    // Sabotages never touch the target tile — moving or highlighting it
    // would point the Searcher straight at it.
    const targetIndex = this.shown.indexOf(this.target);

    if (kind === 'decoys') {
      const candidates = this.shown.map((v, i) => i).filter(i => i !== targetIndex);
      const indices = [];
      while (indices.length < spec.count && candidates.length) {
        indices.push(candidates.splice(rand(candidates.length), 1)[0]);
      }
      msg.indices = indices;
    } else if (kind === 'swap') {
      const candidates = this.shown.map((v, i) => i).filter(i => i !== targetIndex);
      const a = candidates.splice(rand(candidates.length), 1)[0];
      const b = candidates.splice(rand(candidates.length), 1)[0];
      [this.shown[a], this.shown[b]] = [this.shown[b], this.shown[a]];
      this.pendingSwaps.push({ a, b });
      msg.a = a;
      msg.b = b;
      const revert = setTimeout(() => {
        if (this.phase !== 'live') return;
        [this.shown[a], this.shown[b]] = [this.shown[b], this.shown[a]];
        this.pendingSwaps = this.pendingSwaps.filter(s => !(s.a === a && s.b === b));
        this.send(this.searcherSeat(), { t: 'gridRevert', a, b });
      }, spec.durationMs);
      this.timers.swaps.push(revert);
    } else if (kind === 'zoom') {
      // Zoom into the quadrant farthest from the target so the forced pan
      // starts the Searcher looking in the wrong place.
      const col = targetIndex % CONFIG.grid.cols;
      const row = Math.floor(targetIndex / CONFIG.grid.cols);
      msg.scale = spec.scale;
      msg.focus = {
        x: col < CONFIG.grid.cols / 2 ? 1 : 0,
        y: row < CONFIG.grid.rows / 2 ? 1 : 0,
      };
    }

    this.send(this.searcherSeat(), msg);
    this.send(seat, { t: 'sabotageFired', kind, name: spec.name, cooldownMs: spec.cooldownMs });
  }

  endRound(winnerSeat, reason, foundIndex = -1) {
    this.clearRoundTimers();
    this.phase = 'roundEnd';
    this.wins[winnerSeat] += 1;
    this.history.push(winnerSeat);
    const matchOver = this.totalRounds
      ? this.history.length >= this.totalRounds
      : this.wins[winnerSeat] >= this.firstTo;
    this.broadcast({
      t: 'roundEnd',
      winnerSeat,
      reason,
      score: this.wins,
      history: this.history,
      target: this.target,
      targetIndex: this.shown.indexOf(this.target),
      foundIndex,
      matchOver,
      nextInMs: CONFIG.interRoundMs,
    });
    if (this.hooks.onRoundEnd) this.hooks.onRoundEnd(this, winnerSeat);
    this.timers.interRound = setTimeout(() => {
      if (matchOver) {
        this.phase = 'done';
        if (this.hooks.onEnd) this.hooks.onEnd(this);
      } else {
        this.beginRound();
      }
    }, CONFIG.interRoundMs);
  }

  pause() {
    if (this.paused || this.phase === 'done') return;
    this.paused = true;
    clearInterval(this.timers.fuse);
    clearTimeout(this.timers.pick);
    clearTimeout(this.timers.puzzle);
    // Revert any in-flight swaps immediately so state is simple on resume.
    this.timers.swaps.forEach(clearTimeout);
    this.timers.swaps = [];
    if (this.pendingSwaps) {
      for (const { a, b } of this.pendingSwaps.reverse()) {
        [this.shown[a], this.shown[b]] = [this.shown[b], this.shown[a]];
      }
      this.pendingSwaps = [];
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    if (this.phase === 'pick') this.armPickTimeout();
    if (this.phase === 'live') {
      this.startFuse();
      this.newPuzzle();
    }
  }

  snapshot(seat) {
    const caller = this.round > 0 ? this.callerSeat() : 0;
    const snap = {
      phase: this.phase,
      round: this.round,
      score: this.wins,
      history: this.history,
      callerSeat: caller,
      you: seat,
      opponent: this.names[1 - seat],
      role: seat === caller ? 'caller' : 'searcher',
      fuse: this.fuse,
      fuseMs: this.fuseMs(),
      gridCols: CONFIG.grid.cols,
      puzzleTimeMs: this.puzzleMs(),
      maxCharges: CONFIG.maxCharges,
      sabotages: sabotageList(),
      pickTimeoutMs: CONFIG.pickTimeoutMs,
      totalRounds: this.totalRounds,
    };
    if (this.phase === 'pick' && seat === caller) snap.grid = this.shown;
    if (this.phase === 'live') {
      snap.target = this.target;
      if (seat !== caller) snap.grid = this.shown;
      if (seat === caller) snap.charges = this.charges;
    }
    return snap;
  }
}

/*
 * Room: lobby + one versus match, or a round-robin tournament of concurrent
 * matches. Tournament roster seats stay stable for the whole tournament —
 * dropouts are marked inactive rather than removed so the schedule and any
 * running matches keep their seat references.
 */
class Room {
  constructor(code, onDestroy) {
    this.code = code;
    this.onDestroy = onDestroy;
    this.players = []; // { id, name, tag, ws, connected, ready, wantsRematch, points, played, active }
    this.settings = { mode: 'versus', roundsToWin: CONFIG.roundsToWin, difficulty: CONFIG.defaultDifficulty };
    this.phase = 'lobby'; // lobby | playing | matchEnd | tEnd
    this.log = [];
    this.match = null;         // versus
    this.stage = 0;            // tournament
    this.schedule = [];
    this.stageMatches = [];    // [{ match, pair: [ri, rj], seatIn(rosterSeat) }]
    this.graceTimers = new Map(); // playerId -> timer
    this.pairingTimer = null;
    this.voice = new Map(); // playerId -> { muted }
  }

  // ---------- basics ----------

  isTournament() { return this.settings.mode === 'tournament'; }
  maxPlayers() { return this.isTournament() ? CONFIG.tournament.maxPlayers : 2; }

  destroy() {
    if (this.match) this.match.forceEnd();
    this.stageMatches.forEach(s => s.match.forceEnd());
    clearTimeout(this.pairingTimer);
    this.graceTimers.forEach(clearTimeout);
    this.onDestroy(this.code);
  }

  sendTo(seat, msg) {
    const p = this.players[seat];
    if (p && p.connected && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    this.players.forEach((_, seat) => this.sendTo(seat, msg));
  }

  pushLog(text) {
    this.log.push({ at: Date.now(), round: this.isTournament() ? this.stage : (this.match ? this.match.round : 0), text });
  }

  hostSeat() {
    const i = this.players.findIndex(p => p.active !== false && p.connected);
    return i === -1 ? 0 : i;
  }

  publicPlayers() {
    return this.players.map((p, seat) => ({
      seat, id: p.id, name: p.name, tag: p.tag,
      connected: p.connected, ready: !!p.ready, active: p.active !== false,
    }));
  }

  roomState() {
    return {
      t: 'room',
      code: this.code,
      phase: this.phase,
      players: this.publicPlayers(),
      settings: this.settings,
      host: this.hostSeat(),
      minPlayers: this.isTournament() ? CONFIG.tournament.minPlayers : 2,
      maxPlayers: this.maxPlayers(),
    };
  }

  broadcastRoom() {
    this.players.forEach((p, seat) => this.sendTo(seat, { ...this.roomState(), you: seat }));
  }

  seatOf(playerId) {
    return this.players.findIndex(p => p.id === playerId);
  }

  // ---------- voice (WebRTC signaling; audio flows peer-to-peer) ----------

  broadcastVoice() {
    const members = [...this.voice.entries()].map(([id, v]) => {
      const p = this.players.find(x => x.id === id);
      return { id, name: p ? p.name : '?', muted: !!v.muted };
    });
    this.broadcast({ t: 'voiceState', members });
  }

  voiceJoin(seat) {
    const p = this.players[seat];
    if (!p) return;
    this.voice.set(p.id, { muted: false });
    this.broadcastVoice();
  }

  voiceLeave(seat) {
    const p = this.players[seat];
    if (!p || !this.voice.delete(p.id)) return;
    this.broadcastVoice();
  }

  voiceMute(seat, muted) {
    const p = this.players[seat];
    const v = p && this.voice.get(p.id);
    if (!v) return;
    v.muted = !!muted;
    this.broadcastVoice();
  }

  dropVoice(playerId) {
    if (this.voice.delete(playerId)) this.broadcastVoice();
  }

  relayRtc(fromId, to, data) {
    if (!this.voice.has(fromId) || !this.voice.has(to)) return;
    const seat = this.seatOf(to);
    if (seat !== -1) this.sendTo(seat, { t: 'rtc', from: fromId, data });
  }

  // ---------- membership ----------

  addPlayer(player) {
    if (this.phase === 'playing') return { ok: false, error: 'A game is in progress in this room.' };
    if (this.players.length >= this.maxPlayers()) return { ok: false, error: 'Room is full.' };
    if (this.seatOf(player.id) !== -1) return { ok: false, error: 'Already in this room.' };
    const seat = this.players.length;
    this.players.push({ ...player, connected: true, ready: seat === 0, wantsRematch: false, points: 0, played: 0, active: true });
    this.broadcastRoom();
    if (this.voice.size) this.broadcastVoice();
    return { ok: true, seat };
  }

  removePlayer(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    this.dropVoice(playerId);
    const timer = this.graceTimers.get(playerId);
    if (timer) { clearTimeout(timer); this.graceTimers.delete(playerId); }

    if (this.isTournament() && this.phase === 'playing') {
      // Keep the roster slot so the schedule and match seats stay valid.
      this.players[seat].connected = false;
      this.forfeit(seat);
      return;
    }

    this.players.splice(seat, 1);
    if (this.players.length === 0) return this.destroy();
    if (!this.isTournament() && this.phase === 'playing') {
      // A mid-match departure dissolves the versus match back to the lobby.
      if (this.match) this.match.forceEnd();
      this.match = null;
      this.phase = 'lobby';
      this.resetScores();
      this.players.forEach((p, i) => { p.ready = i === 0; });
      this.broadcast({ t: 'toast', msg: 'Opponent left the room.' });
    }
    this.broadcastRoom();
  }

  handleDisconnect(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    const p = this.players[seat];
    p.connected = false;
    this.dropVoice(playerId);
    if (this.phase !== 'playing') {
      this.removePlayer(playerId);
      return;
    }
    const located = this.matchOf(seat);
    if (located) {
      located.match.pause();
      this.sendToMatchOpponent(located, seat, { t: 'opponentStatus', connected: false, graceMs: CONFIG.reconnectGraceMs });
    }
    this.broadcastRoom();
    this.graceTimers.set(playerId, setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (this.isTournament()) this.forfeit(seat);
      else this.removePlayer(playerId);
    }, CONFIG.reconnectGraceMs));
  }

  reconnect(playerId, ws) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return false;
    const p = this.players[seat];
    if (this.isTournament() && p.active === false) return false; // forfeited — nothing to resume
    p.ws = ws;
    p.connected = true;
    const timer = this.graceTimers.get(playerId);
    if (timer) { clearTimeout(timer); this.graceTimers.delete(playerId); }
    this.sendResume(seat);
    const located = this.matchOf(seat);
    if (located) {
      this.sendToMatchOpponent(located, seat, { t: 'opponentStatus', connected: true });
      located.match.resume();
    }
    this.broadcastRoom();
    if (this.voice.size) this.broadcastVoice();
    return true;
  }

  sendResume(seat) {
    const room = { ...this.roomState(), t: 'resume', you: seat };
    if (this.isTournament()) Object.assign(room, this.tournamentContext());
    const located = this.matchOf(seat);
    if (this.phase === 'playing' && located) {
      this.sendTo(seat, { ...room, match: located.match.snapshot(located.seatIn(seat)) });
    } else if (this.phase === 'playing' && this.isTournament()) {
      this.sendTo(seat, room);
      this.sendWaiting(seat, 'finished');
    } else if (this.phase === 'matchEnd' && this.lastMatchEnd) {
      this.sendTo(seat, room);
      this.sendTo(seat, this.lastMatchEnd);
    } else if (this.phase === 'tEnd') {
      this.sendTo(seat, room);
      this.sendTo(seat, this.tEndMessage());
    } else {
      this.sendTo(seat, room);
    }
  }

  // ---------- settings / ready / start ----------

  setSettings(seat, patch) {
    if (seat !== this.hostSeat()) return this.sendTo(seat, { t: 'error', msg: 'Only the host can change settings.' });
    if (this.phase === 'playing') return;
    if (CONFIG.roundsToWinOptions.includes(patch.roundsToWin)) this.settings.roundsToWin = patch.roundsToWin;
    if (CONFIG.difficulties[patch.difficulty]) this.settings.difficulty = patch.difficulty;
    if (patch.mode === 'versus' || patch.mode === 'tournament') {
      if (patch.mode === 'versus' && this.players.length > 2) {
        return this.sendTo(seat, { t: 'error', msg: 'Too many players for 1v1 — someone has to leave first.' });
      }
      this.settings.mode = patch.mode;
    }
    this.broadcastRoom();
  }

  setReady(seat, ready) {
    if (this.phase === 'playing' || seat < 0 || seat === this.hostSeat()) return;
    this.players[seat].ready = !!ready;
    this.broadcastRoom();
  }

  start(seat) {
    if (this.phase === 'playing') return;
    if (seat !== this.hostSeat()) return this.sendTo(seat, { t: 'error', msg: 'Only the host starts the match.' });
    const min = this.isTournament() ? CONFIG.tournament.minPlayers : 2;
    if (this.players.length < min) {
      return this.sendTo(seat, { t: 'error', msg: this.isTournament() ? `Tournaments need at least ${min} players.` : 'Waiting for an opponent.' });
    }
    const notReady = this.players.find((p, i) => i !== this.hostSeat() && !p.ready);
    if (notReady) return this.sendTo(seat, { t: 'error', msg: `${notReady.name} isn't ready yet.` });
    this.resetScores();
    this.phase = 'playing';
    this.lastMatchEnd = null;
    this.broadcastRoom();
    if (this.isTournament()) this.startTournament();
    else this.startVersus();
  }

  resetScores() {
    this.players.forEach(p => { p.points = 0; p.played = 0; p.active = true; p.wantsRematch = false; });
    this.log = [];
  }

  // ---------- versus ----------

  startVersus() {
    this.match = new Match({
      ports: [{ send: m => this.sendTo(0, m) }, { send: m => this.sendTo(1, m) }],
      names: [this.players[0].name, this.players[1].name],
      difficulty: this.settings.difficulty,
      firstTo: this.settings.roundsToWin,
      hooks: {
        log: text => this.pushLog(text),
        onEnd: match => {
          this.phase = 'matchEnd';
          const winnerSeat = match.wins[0] > match.wins[1] ? 0 : 1;
          this.pushLog(`${this.players[winnerSeat].name} wins the match ${match.wins[winnerSeat]}–${match.wins[1 - winnerSeat]}.`);
          this.lastMatchEnd = {
            t: 'matchEnd',
            winnerSeat,
            score: match.wins,
            history: match.history,
            log: this.log,
            players: this.publicPlayers(),
          };
          this.broadcast(this.lastMatchEnd);
          this.match = null;
        },
      },
    });
    this.match.start();
  }

  rematch(seat) {
    if (this.phase !== 'matchEnd') return;
    this.players[seat].wantsRematch = true;
    this.broadcast({ t: 'rematchStatus', votes: this.players.map(p => p.wantsRematch) });
    if (this.players.length === 2 && this.players.every(p => p.wantsRematch)) {
      this.resetScores();
      this.phase = 'playing';
      this.startVersus();
    }
  }

  // ---------- tournament ----------

  activeSeats() {
    return this.players.map((p, i) => i).filter(i => this.players[i].active !== false);
  }

  startTournament() {
    this.schedule = roundRobin(this.players.length);
    this.stage = 0;
    this.stageMatches = [];
    this.pushLog(`Tournament started — ${this.players.length} players, ${this.schedule.length} stages.`);
    this.nextStage();
  }

  worstRoundMs() {
    const fuse = CONFIG.fuseMsOverride ?? CONFIG.difficulties[this.settings.difficulty].fuseMs;
    return CONFIG.pickTimeoutMs + fuse + CONFIG.interRoundMs;
  }

  stageEstimateMs() {
    let worst = 0;
    for (const { match } of this.stageMatches) {
      worst = Math.max(worst, match.roundsLeft() * this.worstRoundMs());
    }
    // Matches announced but not yet started (pairing splash still showing).
    if (!worst && this.pendingStagePairs) {
      worst = CONFIG.tournament.pairingDelayMs + CONFIG.tournament.matchRounds * this.worstRoundMs();
    }
    return worst;
  }

  standings() {
    const rows = this.players
      .map((p, seat) => ({ seat, id: p.id, name: p.name, tag: p.tag, points: p.points, played: p.played, active: p.active !== false }))
      .sort((a, b) => (b.points - a.points) || a.name.localeCompare(b.name));
    let rank = 0;
    let prevPts = null;
    rows.forEach((r, i) => {
      if (r.points !== prevPts) { rank = i + 1; prevPts = r.points; }
      r.rank = rank;
    });
    return rows;
  }

  rowFor(seat) {
    return this.standings().find(r => r.seat === seat);
  }

  sendWaiting(seat, reason) {
    this.sendTo(seat, {
      t: 'tWaiting',
      reason, // 'finished' | 'bye' | 'walkover'
      stage: this.stage,
      stages: this.schedule.length,
      standings: this.standings(),
      estimateMs: this.stageEstimateMs(),
    });
  }

  tournamentContext() {
    return { mode: 'tournament', stage: this.stage, stages: this.schedule.length };
  }

  pushWaitingUpdate() {
    if (!this.isTournament() || this.phase !== 'playing') return;
    const inMatch = new Set();
    this.stageMatches.forEach(({ match, pair }) => {
      if (match.phase !== 'done') pair.forEach(i => inMatch.add(i));
    });
    this.players.forEach((p, seat) => {
      if (p.active !== false && p.connected && !inMatch.has(seat)) {
        this.sendTo(seat, {
          t: 'tStandings',
          standings: this.standings(),
          estimateMs: this.stageEstimateMs(),
          stage: this.stage,
          stages: this.schedule.length,
        });
      }
    });
  }

  nextStage() {
    if (this.phase !== 'playing') return;
    if (this.stage >= this.schedule.length || this.activeSeats().length < 2) return this.endTournament();
    const pairs = this.schedule[this.stage];
    this.stage += 1;
    this.stageMatches = [];
    const toStart = [];
    const sitters = []; // [seat, reason]

    for (const [a, b] of pairs) {
      const pa = a >= 0 ? this.players[a] : null;
      const pb = b >= 0 ? this.players[b] : null;
      const aLive = pa && pa.active !== false;
      const bLive = pb && pb.active !== false;
      if (aLive && bLive) {
        toStart.push([a, b]);
      } else if (aLive || bLive) {
        const seat = aLive ? a : b;
        const other = aLive ? pb : pa;
        if (other) {
          // Scheduled opponent forfeited earlier — walkover.
          this.players[seat].points += CONFIG.tournament.matchRounds;
          this.players[seat].played += 1;
          this.pushLog(`${this.players[seat].name} gets a walkover (${other.name} left).`);
          sitters.push([seat, 'walkover']);
        } else {
          sitters.push([seat, 'bye']);
        }
      }
    }

    // Sitters learn their fate after the pending matches are known so their
    // wait estimate covers the whole stage.
    this.pendingStagePairs = toStart.length;
    for (const [seat, reason] of sitters) this.sendWaiting(seat, reason);

    if (!toStart.length) {
      this.pairingTimer = setTimeout(() => this.nextStage(), 1500);
      return;
    }

    // Announce pairings, then start the matches after the splash delay.
    for (const [a, b] of toStart) {
      this.sendTo(a, {
        t: 'tPairing', stage: this.stage, stages: this.schedule.length,
        startsInMs: CONFIG.tournament.pairingDelayMs, you: this.rowFor(a), opponent: this.rowFor(b),
      });
      this.sendTo(b, {
        t: 'tPairing', stage: this.stage, stages: this.schedule.length,
        startsInMs: CONFIG.tournament.pairingDelayMs, you: this.rowFor(b), opponent: this.rowFor(a),
      });
    }

    this.pairingTimer = setTimeout(() => {
      this.pendingStagePairs = 0;
      for (const [a, b] of toStart) {
        // A pairing can die during the splash (forfeit) — walkover instead.
        const aLive = this.players[a].active !== false;
        const bLive = this.players[b].active !== false;
        if (!aLive || !bLive) {
          if (aLive || bLive) {
            const seat = aLive ? a : b;
            this.players[seat].points += CONFIG.tournament.matchRounds;
            this.players[seat].played += 1;
            this.sendWaiting(seat, 'walkover');
          }
          continue;
        }
        const match = new Match({
          ports: [{ send: m => this.sendTo(a, m) }, { send: m => this.sendTo(b, m) }],
          names: [this.players[a].name, this.players[b].name],
          difficulty: this.settings.difficulty,
          totalRounds: CONFIG.tournament.matchRounds,
          hooks: {
            log: text => this.pushLog(text),
            onRoundEnd: (m, winnerSeat) => {
              this.players[winnerSeat === 0 ? a : b].points += 1;
              this.pushWaitingUpdate();
            },
            onEnd: () => {
              this.players[a].played += 1;
              this.players[b].played += 1;
              if (this.players[a].active !== false) this.sendWaiting(a, 'finished');
              if (this.players[b].active !== false) this.sendWaiting(b, 'finished');
              this.pushWaitingUpdate();
              this.checkStageDone();
            },
          },
        });
        this.stageMatches.push({ match, pair: [a, b], seatIn: s => (s === a ? 0 : 1) });
        match.start();
      }
      if (!this.stageMatches.length) this.checkStageDone();
    }, CONFIG.tournament.pairingDelayMs);
  }

  checkStageDone() {
    if (this.phase !== 'playing') return;
    if (this.stageMatches.every(({ match }) => match.phase === 'done')) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = setTimeout(() => this.nextStage(), 1200);
    }
  }

  forfeit(seat) {
    const p = this.players[seat];
    if (!p || p.active === false || this.phase !== 'playing' || !this.isTournament()) return;
    p.active = false;
    p.ready = false;
    this.pushLog(`${p.name} left the tournament.`);
    const located = this.matchOf(seat);
    if (located) {
      const { match, pair } = located;
      const oppSeat = pair[0] === seat ? pair[1] : pair[0];
      const remaining = match.roundsLeft();
      match.forceEnd();
      if (this.players[oppSeat].active !== false) {
        this.players[oppSeat].points += remaining;
        this.players[oppSeat].played += 1;
        this.pushLog(`${this.players[oppSeat].name} wins by forfeit.`);
        this.sendTo(oppSeat, { t: 'toast', msg: `${p.name} left — you take the remaining rounds.` });
        this.sendWaiting(oppSeat, 'walkover');
      }
    }
    this.broadcastRoom();
    this.pushWaitingUpdate();
    if (this.activeSeats().length < 2) return this.endTournament();
    if (located) this.checkStageDone();
  }

  matchOf(seat) {
    if (!this.isTournament()) {
      if (this.match && this.match.phase !== 'done' && (seat === 0 || seat === 1)) {
        return { match: this.match, pair: [0, 1], seatIn: s => s };
      }
      return null;
    }
    return this.stageMatches.find(({ match, pair }) => match.phase !== 'done' && pair.includes(seat)) || null;
  }

  sendToMatchOpponent(located, seat, msg) {
    const oppSeat = located.pair[0] === seat ? located.pair[1] : located.pair[0];
    this.sendTo(oppSeat, msg);
  }

  tEndMessage() {
    return {
      t: 'tEnd',
      leaderboard: this.standings(),
      stages: this.schedule.length,
      log: this.log,
    };
  }

  endTournament() {
    if (this.phase !== 'playing' || !this.isTournament()) return;
    this.phase = 'tEnd';
    this.pendingStagePairs = 0;
    clearTimeout(this.pairingTimer);
    this.stageMatches.forEach(({ match }) => match.forceEnd());
    const top = this.standings()[0];
    this.pushLog(`Tournament over — ${top ? top.name : '?'} takes it with ${top ? top.points : 0} points.`);
    this.broadcast(this.tEndMessage());
    // Forfeited/vanished players lose their roster slots now the schedule is done.
    this.players = this.players.filter(p => p.active !== false && p.connected);
    if (this.players.length === 0) return this.destroy();
    this.players.forEach((p, i) => { p.ready = i === this.hostSeat(); });
    this.broadcastRoom();
  }

  // ---------- in-game routing ----------

  onPick(seat, index) {
    const located = this.matchOf(seat);
    if (located) located.match.onPick(located.seatIn(seat), index);
  }

  onTap(seat, index) {
    const located = this.matchOf(seat);
    if (located) located.match.onTap(located.seatIn(seat), index);
  }

  onPuzzleAnswer(seat, puzzleId, index) {
    const located = this.matchOf(seat);
    if (located) located.match.onPuzzleAnswer(located.seatIn(seat), puzzleId, index);
  }

  onSabotage(seat, kind) {
    const located = this.matchOf(seat);
    if (located) located.match.onSabotage(located.seatIn(seat), kind);
  }
}

module.exports = { Room, Match, makeRoomCode, makeGrid, roundRobin };
