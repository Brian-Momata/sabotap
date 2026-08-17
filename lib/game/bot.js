'use strict';

const CONFIG = require('../config');
const { rand, pickOne } = require('./rng');
const { twinsOf } = require('./puzzle');
const { sabotageList } = require('./sabotages');

/*
 * The Caller bot for solo runs. It is a Match port with a lifecycle: `send`
 * receives the caller's view of the round exactly as a socket would, and
 * clear/pause/resume let Match drive its timers alongside its own, so the bot
 * never acts into a paused or finished round.
 *
 * Only the Caller is simulated, and deliberately so — the Caller's job is a
 * handful of discrete decisions (pick a target, answer a puzzle, spend a
 * charge), all of which a bot can make honestly. A Searcher bot would have to
 * fake visual search, since four of the five sabotages are pure perception
 * effects it cannot perceive; solo therefore pins the human to Searcher.
 *
 * Skill comes from lib/config.js `solo.ladder`, selected by the human's current
 * streak: how reliably the bot banks charges, and how fast it reacts.
 */

const jitter = ms => Math.max(60, Math.round(ms * (1 + (Math.random() * 2 - 1) * CONFIG.solo.reactionJitter)));

// The index of the tile that appears exactly once — the puzzle's answer.
const oddIndexOf = tiles => tiles.findIndex(d => tiles.filter(x => x === d).length === 1);

/*
 * How well a value hides on this board: tiles that look like it are the real
 * defence, so a Caller who picks a number with live twins buys seconds. Glyph
 * boards carry no digits and score on position alone — eyes start in the
 * middle, which makes the rim the better hiding place either way.
 */
function hidingScore(values, index, cols, rows) {
  const v = values[index];
  let twins = 0;
  if (typeof v === 'number') {
    const look = new Set(twinsOf(v));
    for (let i = 0; i < values.length; i++) if (i !== index && look.has(values[i])) twins += 1;
  }
  const col = index % cols;
  const row = Math.floor(index / cols);
  const edge = Math.abs(col - (cols - 1) / 2) / ((cols - 1) / 2)
    + Math.abs(row - (rows - 1) / 2) / ((rows - 1) / 2);
  return twins * 2 + edge;
}

/*
 * One handler per inbound message kind, same strategy-table shape as
 * sabotages.js. Called with the Bot as `this`; kinds with no entry are ignored.
 */
const inbound = {
  roundStart(msg) {
    this.reset();
    if (msg.role !== 'caller') return;
    this.grid = msg.grid;
    this.cols = msg.gridCols;
    this.schedulePick();
  },

  live(msg) {
    this.kinds = (msg.sabotages || []).map(s => s.kind);
  },

  fuse(msg) {
    this.fuse = msg.v;
  },

  puzzle(msg) {
    clearTimeout(this.timers.puzzle);
    const { accuracy, reactionMs } = this.rung();
    this.timers.puzzle = setTimeout(() => {
      const odd = oddIndexOf(msg.tiles);
      // A miss is a real miss: answering a tile that is not the odd one costs
      // the bot the charge exactly as it costs a human.
      const answer = Math.random() < accuracy
        ? odd
        : (odd + 1 + rand(msg.tiles.length - 1)) % msg.tiles.length;
      this.match.onPuzzleAnswer(this.seat, msg.id, answer);
    }, jitter(reactionMs));
  },

  charges(msg) {
    if (msg.n > 0) this.scheduleSabotage();
  },

  sabotageFired(msg) {
    this.cooldowns[msg.kind] = Date.now() + (msg.cooldownMs || 0);
  },

  // A refused sabotage (cooldown the bot mis-tracked, charge spent elsewhere)
  // leaves nothing else scheduled — try again rather than stalling the round.
  error() {
    this.scheduleSabotage();
  },
};

class Bot {
  constructor({ seat, name = CONFIG.solo.botName }) {
    this.seat = seat;
    this.name = name;
    this.match = null;
    this.timers = { pick: null, puzzle: null, sabotage: null };
    this.reset();
  }

  attach(match) { this.match = match; }

  // Per-round state. Sabotage cooldowns are round-scoped on the server
  // (Match.beginRound clears lastSabAt), so the bot's mirror resets with them.
  reset() {
    this.grid = null;
    this.cols = CONFIG.grid.cols;
    this.kinds = [];
    this.cooldowns = {};
    this.fuse = 0;
  }

  // The rung the human's current streak has earned. Env overrides win so tests
  // can pin the bot's behaviour.
  rung() {
    const streak = this.match ? this.match.wins[1 - this.seat] : 0;
    const s = CONFIG.solo;
    const base = s.ladder.reduce((best, r) => (streak >= r.streak && r.streak >= best.streak ? r : best), s.ladder[0]);
    return {
      accuracy: s.accuracyOverride ?? base.accuracy,
      reactionMs: s.reactionMsOverride ?? base.reactionMs,
      sabotageDelayMs: s.sabotageDelayMsOverride ?? base.sabotageDelayMs,
    };
  }

  /* ---------- port lifecycle (driven by Match) ---------- */

  clear() {
    clearTimeout(this.timers.pick);
    clearTimeout(this.timers.puzzle);
    clearTimeout(this.timers.sabotage);
    this.timers.pick = this.timers.puzzle = this.timers.sabotage = null;
  }

  pause() { this.clear(); }

  // Match re-arms its own phase timers before calling this, and a resumed live
  // round regenerates its puzzle (which re-enters `send`). Only the unprompted
  // intents — picking, and spending charges already banked — need re-scheduling.
  resume() {
    const m = this.match;
    if (!m) return;
    this.seedFrom(m);
    if (m.phase === 'pick' && m.callerSeat() === this.seat) this.schedulePick();
    if (m.phase === 'live' && m.charges > 0) this.scheduleSabotage();
  }

  // A run revived from disk resumes mid-round having never received the
  // roundStart/live messages that normally furnish the caller's view, so take
  // it from the match. Cooldowns are rebuilt from the fire times Match
  // persisted, or the bot would keep picking kinds that are still recharging.
  seedFrom(m) {
    if (!this.grid && Array.isArray(m.shown)) this.grid = m.shown;
    if (!this.kinds.length) this.kinds = sabotageList().map(s => s.kind);
    for (const [kind, at] of Object.entries(m.lastSabAt || {})) {
      const spec = CONFIG.sabotages[kind];
      if (spec && !this.cooldowns[kind]) this.cooldowns[kind] = at + spec.cooldownMs;
    }
    this.fuse = m.fuse || 0;
  }

  /* ---------- port: the caller's view of the round ---------- */

  send(msg) {
    const fn = Object.hasOwn(inbound, msg.t) ? inbound[msg.t] : null;
    if (fn) fn.call(this, msg);
  }

  /* ---------- intents ---------- */

  schedulePick() {
    clearTimeout(this.timers.pick);
    this.timers.pick = setTimeout(() => {
      this.timers.pick = null;
      const values = this.grid || [];
      if (!values.length) return;
      const rows = Math.ceil(values.length / this.cols);
      // Rank by how well each tile hides, then choose among the best few so
      // the same board never produces the same target twice.
      const ranked = values
        .map((_, i) => ({ i, score: hidingScore(values, i, this.cols, rows) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      this.match.onPick(this.seat, pickOne(ranked).i);
    }, jitter(CONFIG.solo.pickDelayMs));
  }

  // Charges arrive faster than the bot spends them, so an already-pending
  // spend is left alone — restarting its delay on every bank would let a
  // high-accuracy bot postpone firing indefinitely.
  scheduleSabotage() {
    if (this.timers.sabotage) return;
    this.timers.sabotage = setTimeout(() => {
      this.timers.sabotage = null;
      const m = this.match;
      if (!m || m.phase !== 'live' || m.paused || m.charges < 1) return;
      // Spending before the Searcher has started scanning wastes the charge.
      if (this.fuse < CONFIG.solo.minFuseToSabotage) return this.scheduleSabotage();
      const now = Date.now();
      const ready = this.kinds.filter(k => (this.cooldowns[k] || 0) <= now);
      if (!ready.length) return this.scheduleSabotage();
      m.onSabotage(this.seat, pickOne(ready));
    }, jitter(this.rung().sabotageDelayMs));
  }
}

module.exports = { Bot };
