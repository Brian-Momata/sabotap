'use strict';

const CONFIG = require('../config');
const { rand, pickOne } = require('./rng');
const { sabotageList, applySabotage } = require('./sabotages');
const { resolveBoard, boardGrid, boardPuzzle, clientBoard } = require('./boards');

/*
 * Match: a self-contained 2-player game engine. Seats are match-local (0/1);
 * all communication goes through the provided ports. Ends either at
 * `firstTo` round wins (versus) or after exactly `totalRounds` rounds
 * (tournament — a 1-1 split is a valid result).
 * State fields persisted across server restarts are mirrored in serialize.js —
 * extend it when adding match state a rejoining player needs.
 */
class Match {
  constructor({ ports, names, difficulty, board = CONFIG.defaultBoard, firstTo = 0, totalRounds = 0, hooks = {} }) {
    this.ports = ports;               // [{ send(msg) }, { send(msg) }]
    this.names = names;               // [name0, name1]
    this.difficultyKey = difficulty;
    this.boardSetting = board;        // may be 'rotation'; resolved per round
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
    this.boardKey = resolveBoard(this.boardSetting, this.round);
    this.gridValues = boardGrid(this.boardKey);
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
      board: clientBoard(this.boardKey),
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
      this.log(`${this.names[this.callerSeat()]} stalled. Target chosen at random.`);
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
    this.puzzleSeq += 1;
    this.puzzle = { id: this.puzzleSeq, ...boardPuzzle(this.boardKey, this.fuse, this.difficulty().confusableFrom) };
    this.send(this.callerSeat(), { t: 'puzzle', id: this.puzzle.id, tiles: this.puzzle.tiles, timeMs: this.puzzleMs() });
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
    applySabotage(this, kind, spec, msg);
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
    this.armInterRound();
  }

  // Re-armable (matchOver is derived from score, not captured) so a match
  // paused — or revived from disk — during the inter-round gap still advances.
  armInterRound() {
    const matchOver = this.totalRounds
      ? this.history.length >= this.totalRounds
      : Math.max(...this.wins) >= this.firstTo;
    clearTimeout(this.timers.interRound);
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
    clearTimeout(this.timers.interRound); // a new round must not start while paused
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
    if (this.phase === 'roundEnd') this.armInterRound();
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
      board: clientBoard(this.boardKey || resolveBoard(this.boardSetting, 1)),
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

module.exports = { Match };
