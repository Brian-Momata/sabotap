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

class Room {
  constructor(code, onDestroy) {
    this.code = code;
    this.onDestroy = onDestroy;
    this.players = []; // seat-indexed: { id, name, ws, connected, wantsRematch }
    this.settings = { roundsToWin: CONFIG.roundsToWin, difficulty: CONFIG.defaultDifficulty };
    this.phase = 'lobby'; // lobby | pick | live | roundEnd | matchEnd
    this.timers = { swaps: [] };
    this.resetMatch();
  }

  // ---------- lifecycle ----------

  resetMatch() {
    this.round = 0;
    this.wins = [0, 0];
    this.history = []; // winner seat per round
    this.log = [];
    this.firstCaller = rand(2);
    this.paused = false;
    this.players.forEach((p, seat) => { p.wantsRematch = false; p.ready = seat === 0; });
    this.clearRoundTimers();
  }

  clearRoundTimers() {
    clearInterval(this.timers.fuse);
    clearTimeout(this.timers.pick);
    clearTimeout(this.timers.puzzle);
    clearTimeout(this.timers.interRound);
    this.timers.swaps.forEach(clearTimeout);
    this.timers.swaps = [];
  }

  destroy() {
    this.clearRoundTimers();
    clearTimeout(this.timers.grace);
    this.onDestroy(this.code);
  }

  // ---------- messaging ----------

  send(seat, msg) {
    const p = this.players[seat];
    if (p && p.connected && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    this.players.forEach((_, seat) => this.send(seat, msg));
  }

  pushLog(text) {
    this.log.push({ at: Date.now(), round: this.round, text });
  }

  publicPlayers() {
    return this.players.map((p, seat) => ({ seat, id: p.id, name: p.name, tag: p.tag, connected: p.connected, ready: !!p.ready }));
  }

  roomState() {
    return {
      t: 'room',
      code: this.code,
      phase: this.phase,
      players: this.publicPlayers(),
      settings: this.settings,
      host: 0,
    };
  }

  broadcastRoom() {
    this.players.forEach((p, seat) => this.send(seat, { ...this.roomState(), you: seat }));
  }

  // ---------- players ----------

  difficulty() {
    return CONFIG.difficulties[this.settings.difficulty];
  }

  fuseMs() {
    return CONFIG.fuseMsOverride ?? this.difficulty().fuseMs;
  }

  puzzleMs() {
    return CONFIG.puzzleMsOverride ?? this.difficulty().puzzleMs;
  }

  callerSeat() {
    return (this.firstCaller + this.round - 1) % 2;
  }

  searcherSeat() {
    return 1 - this.callerSeat();
  }

  seatOf(playerId) {
    return this.players.findIndex(p => p.id === playerId);
  }

  addPlayer(player) {
    if (this.players.length >= 2) return { ok: false, error: 'Room is full.' };
    if (this.seatOf(player.id) !== -1) return { ok: false, error: 'Already in this room.' };
    const seat = this.players.length;
    this.players.push({ ...player, connected: true, wantsRematch: false, ready: seat === 0 });
    this.broadcastRoom();
    return { ok: true, seat };
  }

  removePlayer(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    this.players.splice(seat, 1);
    if (this.players.length === 0) return this.destroy();
    // A mid-match departure dissolves the match back to the lobby.
    this.clearRoundTimers();
    clearTimeout(this.timers.grace);
    this.phase = 'lobby';
    this.resetMatch();
    this.broadcastRoom();
    this.broadcast({ t: 'toast', msg: 'Opponent left the room.' });
  }

  handleDisconnect(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    const p = this.players[seat];
    p.connected = false;
    if (this.phase === 'lobby' || this.phase === 'matchEnd') {
      // No game in flight to protect — just drop them.
      this.removePlayer(playerId);
      return;
    }
    this.pause();
    this.send(1 - seat, { t: 'opponentStatus', connected: false, graceMs: CONFIG.reconnectGraceMs });
    this.timers.grace = setTimeout(() => this.removePlayer(playerId), CONFIG.reconnectGraceMs);
  }

  reconnect(playerId, ws) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return false;
    const p = this.players[seat];
    p.ws = ws;
    p.connected = true;
    clearTimeout(this.timers.grace);
    this.send(1 - seat, { t: 'opponentStatus', connected: true });
    this.send(seat, this.snapshot(seat));
    this.resume();
    return true;
  }

  pause() {
    if (this.paused) return;
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

  // ---------- match flow ----------

  setSettings(seat, patch) {
    if (seat !== 0) return this.send(seat, { t: 'error', msg: 'Only the host can change settings.' });
    if (this.phase !== 'lobby' && this.phase !== 'matchEnd') return;
    if (CONFIG.roundsToWinOptions.includes(patch.roundsToWin)) this.settings.roundsToWin = patch.roundsToWin;
    if (CONFIG.difficulties[patch.difficulty]) this.settings.difficulty = patch.difficulty;
    this.broadcastRoom();
  }

  setReady(seat, ready) {
    if (this.phase !== 'lobby' || seat <= 0) return;
    this.players[seat].ready = !!ready;
    this.broadcastRoom();
  }

  start(seat) {
    if (this.phase !== 'lobby') return;
    if (seat !== 0) return this.send(seat, { t: 'error', msg: 'Only the host starts the match.' });
    if (this.players.length < 2) return this.send(seat, { t: 'error', msg: 'Waiting for an opponent.' });
    if (!this.players[1].ready) return this.send(seat, { t: 'error', msg: "Your opponent isn't ready yet." });
    this.resetMatch();
    this.beginRound();
  }

  rematch(seat) {
    if (this.phase !== 'matchEnd') return;
    this.players[seat].wantsRematch = true;
    this.broadcast({ t: 'rematchStatus', votes: this.players.map(p => p.wantsRematch) });
    if (this.players.length === 2 && this.players.every(p => p.wantsRematch)) {
      this.resetMatch();
      this.beginRound();
    }
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
    this.decoysUsedThisRound = 0;

    const caller = this.callerSeat();
    const base = {
      t: 'roundStart',
      round: this.round,
      callerSeat: caller,
      score: this.wins,
      settings: this.settings,
      pickTimeoutMs: CONFIG.pickTimeoutMs,
      gridCols: CONFIG.grid.cols,
    };
    this.send(caller, { ...base, role: 'caller', grid: this.shown });
    this.send(this.searcherSeat(), { ...base, role: 'searcher' });
    this.pushLog(`Round ${this.round} — ${this.players[caller].name} calls.`);
    this.armPickTimeout();
  }

  armPickTimeout() {
    clearTimeout(this.timers.pick);
    this.timers.pick = setTimeout(() => {
      if (this.phase !== 'pick') return;
      this.pushLog('Caller stalled — target chosen at random.');
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
    if (!wasRandom) this.pushLog('Target chosen. Fuse armed.');
    const base = {
      t: 'live',
      target,
      fuseMs: this.fuseMs(),
      puzzleTimeMs: this.puzzleMs(),
      maxCharges: CONFIG.maxCharges,
      sabotages: Object.entries(CONFIG.sabotages).map(([kind, s]) => ({ kind, name: s.name, detail: s.detail })),
    };
    this.send(this.searcherSeat(), { ...base, grid: this.shown, gridCols: CONFIG.grid.cols });
    this.send(this.callerSeat(), base);
    this.startFuse();
    this.newPuzzle();
  }

  // ---------- fuse ----------

  startFuse() {
    clearInterval(this.timers.fuse);
    this.timers.fuse = setInterval(() => {
      if (this.phase !== 'live') return;
      this.fuse = Math.min(1, this.fuse + CONFIG.fuseTickMs / this.fuseMs());
      this.broadcast({ t: 'fuse', v: this.fuse });
      if (this.fuse >= 1) {
        this.pushLog('Fuse ran out.');
        this.endRound(this.callerSeat(), 'fuse');
      }
    }, CONFIG.fuseTickMs);
  }

  // ---------- searcher ----------

  onTap(seat, index) {
    if (this.phase !== 'live' || seat !== this.searcherSeat()) return;
    if (!(index >= 0 && index < this.shown.length)) return;
    if (this.shown[index] === this.target) {
      this.pushLog(`${this.players[seat].name} found ${this.target}.`);
      this.endRound(seat, 'found', index);
    } else {
      this.pushLog(`${this.players[seat].name} mistapped ${this.shown[index]}.`);
      this.send(seat, { t: 'wrong', index });
      this.send(this.callerSeat(), { t: 'callerFeed', text: `Mistap on ${this.shown[index]}` });
    }
  }

  // ---------- caller: puzzle & charges ----------

  newPuzzle() {
    if (this.phase !== 'live') return;
    clearTimeout(this.timers.puzzle);
    const shared = rand(10);
    // Difficulty curve: later in the round the odd digit is a lookalike.
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
    if (!this.puzzle || this.puzzle.id !== puzzleId) return; // stale answer
    const ok = index === this.puzzle.oddIndex;
    if (ok) {
      this.charges = Math.min(CONFIG.maxCharges, this.charges + 1);
      this.send(seat, { t: 'charges', n: this.charges });
    }
    this.send(seat, { t: 'puzzleResult', ok, reason: ok ? 'solved' : 'wrong' });
    this.newPuzzle();
  }

  // ---------- caller: sabotage ----------

  onSabotage(seat, kind) {
    if (this.phase !== 'live' || seat !== this.callerSeat()) return;
    const spec = CONFIG.sabotages[kind];
    if (!spec) return;
    if (this.charges < 1) return this.send(seat, { t: 'error', msg: 'No charges banked.' });
    this.charges -= 1;
    this.send(seat, { t: 'charges', n: this.charges });
    this.pushLog(`${this.players[seat].name} fired ${spec.name}.`);

    const msg = { t: 'sabotage', kind, name: spec.name, durationMs: spec.durationMs };

    if (kind === 'decoys') {
      const candidates = this.shown.map((v, i) => i).filter(i => this.shown[i] !== this.target);
      const indices = [];
      while (indices.length < spec.count && candidates.length) {
        indices.push(candidates.splice(rand(candidates.length), 1)[0]);
      }
      msg.indices = indices;
    } else if (kind === 'swap') {
      const n = this.shown.length;
      const targetIndex = this.shown.indexOf(this.target);
      let a = Math.random() < spec.targetChance ? targetIndex : rand(n);
      let b;
      do { b = rand(n); } while (b === a);
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
      msg.scale = spec.scale;
    }

    this.send(this.searcherSeat(), msg);
    this.send(seat, { t: 'sabotageFired', kind, name: spec.name });
  }

  // ---------- round & match end ----------

  endRound(winnerSeat, reason, foundIndex = -1) {
    this.clearRoundTimers();
    this.phase = 'roundEnd';
    this.wins[winnerSeat] += 1;
    this.history.push(winnerSeat);
    const matchOver = this.wins[winnerSeat] >= this.settings.roundsToWin;
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
    this.timers.interRound = setTimeout(() => {
      if (matchOver) this.endMatch(winnerSeat);
      else this.beginRound();
    }, CONFIG.interRoundMs);
  }

  endMatch(winnerSeat) {
    this.phase = 'matchEnd';
    this.players.forEach(p => { p.wantsRematch = false; });
    this.pushLog(`${this.players[winnerSeat].name} wins the match ${this.wins[winnerSeat]}–${this.wins[1 - winnerSeat]}.`);
    this.broadcast({
      t: 'matchEnd',
      winnerSeat,
      score: this.wins,
      history: this.history,
      log: this.log,
      players: this.publicPlayers(),
    });
  }

  // ---------- resume snapshot ----------

  snapshot(seat) {
    const caller = this.round > 0 ? this.callerSeat() : 0;
    const snap = {
      t: 'resume',
      code: this.code,
      phase: this.phase,
      players: this.publicPlayers(),
      you: seat,
      settings: this.settings,
      host: 0,
      round: this.round,
      score: this.wins,
      history: this.history,
      callerSeat: caller,
      role: seat === caller ? 'caller' : 'searcher',
      fuse: this.fuse,
      fuseMs: this.fuseMs(),
      gridCols: CONFIG.grid.cols,
      puzzleTimeMs: this.puzzleMs(),
      maxCharges: CONFIG.maxCharges,
      sabotages: Object.entries(CONFIG.sabotages).map(([kind, s]) => ({ kind, name: s.name, detail: s.detail })),
      pickTimeoutMs: CONFIG.pickTimeoutMs,
    };
    if (this.phase === 'pick' && seat === caller) snap.grid = this.shown;
    if (this.phase === 'live') {
      snap.target = this.target;
      if (seat !== caller) snap.grid = this.shown;
      if (seat === caller) snap.charges = this.charges;
    }
    if (this.phase === 'matchEnd') snap.log = this.log;
    return snap;
  }
}

module.exports = { Room, makeRoomCode, makeGrid };
