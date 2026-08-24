'use strict';

const CONFIG = require('../config');
const { rand, pickOne } = require('./rng');
const { sabotageList, applySabotage } = require('./sabotages');
const { resolveBoard, boardGrid, boardPuzzle, clientBoard } = require('./boards');
const telemetry = require('./telemetry');

/*
 * Match: a self-contained 2-player game engine. Seats are match-local (0/1);
 * all communication goes through the provided ports. Ends either at
 * `firstTo` round wins (versus), after exactly `totalRounds` rounds
 * (tournament — a 1-1 split is a valid result), or when an injected
 * `overWhen` predicate says so (solo survival).
 * A port may be an active participant rather than a socket shim (see bot.js):
 * one exposing clear/pause/resume is driven through the same lifecycle as the
 * match's own timers, so an agent never fires into a paused or finished round.
 * State fields persisted across server restarts are mirrored in serialize.js —
 * extend it when adding match state a rejoining player needs.
 */
class Match {
  constructor({ ports, names, difficulty, board = CONFIG.defaultBoard, boardOffset = 0, firstTo = 0, totalRounds = 0,
                firstCaller = null, rotateRoles = true, overWhen = null, hooks = {} }) {
    this.ports = ports;               // [{ send(msg) }, { send(msg) }]
    this.names = names;               // [name0, name1]
    this.difficultyKey = difficulty;
    this.boardSetting = board;        // may be 'rotation'; resolved per round
    this.boardOffset = boardOffset;   // rotation start point, owned by the room
    this.firstTo = firstTo;
    this.totalRounds = totalRounds;
    this.rotateRoles = rotateRoles;   // false pins each seat to one role for the whole match
    this.overWhen = overWhen;         // optional (match) => boolean, replaces the score check
    this.hooks = hooks;               // { onRoundEnd(match, winnerSeat), onEnd(match), log(text) }
    this.round = 0;
    this.wins = [0, 0];
    this.history = [];
    this.phase = 'idle';              // pick | live | roundEnd | done
    this.paused = false;
    this.firstCaller = firstCaller ?? rand(2);
    this.timers = { swaps: [] };
    this.startedAt = Date.now();
    // Play tallies for telemetry, reported once at match end. Deliberately not
    // serialized: a match revived after a restart counts only what it has seen
    // since, which skews aggregates far less than bloating every room snapshot.
    this.stats = { mistaps: 0, puzzlesSolved: 0, puzzlesWrong: 0, puzzlesTimedOut: 0, sabotages: {} };
  }

  difficulty() { return CONFIG.difficulties[this.difficultyKey]; }
  fuseMs() { return CONFIG.fuseMsOverride ?? this.difficulty().fuseMs; }
  puzzleMs() { return CONFIG.puzzleMsOverride ?? this.difficulty().puzzleMs; }
  callerSeat() { return this.rotateRoles ? (this.firstCaller + this.round - 1) % 2 : this.firstCaller; }
  searcherSeat() { return 1 - this.callerSeat(); }
  roundsLeft() {
    if (this.phase === 'done') return 0;
    if (this.totalRounds) return this.totalRounds - this.history.length;
    return 1; // versus matches have no fixed horizon; count the live round
  }
  matchOver() {
    if (this.overWhen) return this.overWhen(this);
    return this.totalRounds
      ? this.history.length >= this.totalRounds
      : Math.max(...this.wins) >= this.firstTo;
  }
  // Result already settled, only the inter-round splash pending — the state
  // where a departure must publish the result instead of erasing it.
  decided() { return this.phase === 'roundEnd' && this.matchOver(); }

  send(seat, msg) { this.ports[seat].send(msg); }
  broadcast(msg) { this.send(0, msg); this.send(1, msg); }
  log(text) { if (this.hooks.log) this.hooks.log(text); }

  // Drive the optional lifecycle of active ports (agents). Plain send-only
  // ports have none of these and are skipped.
  portsDo(fn) { for (const p of this.ports) if (typeof p[fn] === 'function') p[fn](); }

  start() { this.beginRound(); }

  clearRoundTimers() {
    clearInterval(this.timers.fuse);
    clearTimeout(this.timers.pick);
    clearTimeout(this.timers.puzzle);
    clearTimeout(this.timers.interRound);
    this.timers.swaps.forEach(clearTimeout);
    this.timers.swaps = [];
    this.portsDo('clear');
  }

  forceEnd() {
    this.clearRoundTimers();
    this.phase = 'done';
  }

  // Skip the rest of the inter-round gap and settle now (leaver mid-gap).
  finishNow() {
    this.clearRoundTimers();
    this.phase = 'done';
    if (this.hooks.onEnd) this.hooks.onEnd(this);
  }

  beginRound() {
    this.clearRoundTimers();
    this.round += 1;
    this.phase = 'pick';
    this.boardKey = resolveBoard(this.boardSetting, this.round, this.boardOffset);
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

  // A paused match keeps its phase ('live'), so every intent must also refuse
  // while paused — otherwise a tap landing during an opponent's disconnect
  // settles the round against a frozen fuse.
  onPick(seat, index) {
    if (this.paused || this.phase !== 'pick' || seat !== this.callerSeat()) return;
    if (!(index >= 0 && index < this.gridValues.length)) return;
    this.goLive(this.gridValues[index], false);
  }

  goLive(target, wasRandom) {
    clearTimeout(this.timers.pick);
    this.target = target;
    this.phase = 'live';
    this.liveAt = Date.now(); // fuse start, so round telemetry measures search time only
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
    if (this.paused || this.phase !== 'live' || seat !== this.searcherSeat()) return;
    if (!(index >= 0 && index < this.shown.length)) return;
    if (this.shown[index] === this.target) {
      this.log(`${this.names[seat]} found ${this.target}.`);
      this.endRound(seat, 'found', index);
    } else {
      this.stats.mistaps += 1;
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
      this.stats.puzzlesTimedOut += 1;
      this.send(this.callerSeat(), { t: 'puzzleResult', ok: false, reason: 'timeout' });
      this.newPuzzle();
    }, this.puzzleMs());
  }

  onPuzzleAnswer(seat, puzzleId, index) {
    if (this.paused || this.phase !== 'live' || seat !== this.callerSeat()) return;
    if (!this.puzzle || this.puzzle.id !== puzzleId) return;
    const ok = index === this.puzzle.oddIndex;
    this.stats[ok ? 'puzzlesSolved' : 'puzzlesWrong'] += 1;
    if (ok) {
      this.charges = Math.min(CONFIG.maxCharges, this.charges + 1);
      this.send(seat, { t: 'charges', n: this.charges });
    }
    this.send(seat, { t: 'puzzleResult', ok, reason: ok ? 'solved' : 'wrong' });
    this.newPuzzle();
  }

  onSabotage(seat, kind) {
    if (this.paused || this.phase !== 'live' || seat !== this.callerSeat()) return;
    const spec = CONFIG.sabotages[kind];
    if (!spec) return;
    if (this.charges < 1) return this.send(seat, { t: 'error', msg: 'No charges banked.' });
    const sinceLast = Date.now() - (this.lastSabAt[kind] || 0);
    if (sinceLast < spec.cooldownMs) {
      const waitS = Math.ceil((spec.cooldownMs - sinceLast) / 1000);
      return this.send(seat, { t: 'error', msg: `${spec.name} is recharging (${waitS}s).` });
    }
    this.lastSabAt[kind] = Date.now();
    this.stats.sabotages[kind] = (this.stats.sabotages[kind] || 0) + 1;
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
    const matchOver = this.matchOver();
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
    telemetry.roundEnded(this, winnerSeat, reason);
    if (this.hooks.onRoundEnd) this.hooks.onRoundEnd(this, winnerSeat);
    this.armInterRound();
  }

  // Re-armable (matchOver is derived from score, not captured) so a match
  // paused — or revived from disk — during the inter-round gap still advances.
  armInterRound() {
    clearTimeout(this.timers.interRound);
    this.timers.interRound = setTimeout(() => {
      if (this.matchOver()) {
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
    this.portsDo('pause');
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
    this.portsDo('resume');
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
      board: clientBoard(this.boardKey || resolveBoard(this.boardSetting, 1, this.boardOffset)),
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
