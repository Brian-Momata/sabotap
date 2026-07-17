'use strict';

const CONFIG = require('../config');
const { rand } = require('./rng');

function sabotageList() {
  return Object.entries(CONFIG.sabotages).map(([kind, s]) =>
    ({ kind, name: s.name, detail: s.detail, cooldownMs: s.cooldownMs }));
}

// Sabotages never touch the target tile — moving or highlighting it
// would point the Searcher straight at it.
const nonTargetIndices = (match, targetIndex) =>
  match.shown.map((v, i) => i).filter(i => i !== targetIndex);

/*
 * One effect per sabotage kind. Each receives the live match, the config
 * spec, and the outbound message to decorate for the Searcher. Kinds with
 * no entry (blur, invert) are pure client-side effects — the base message
 * is enough. Adding a new sabotage means adding a config entry and, if it
 * needs server state, one function here; Match stays untouched.
 */
const effects = {
  decoys(match, spec, msg, targetIndex) {
    const candidates = nonTargetIndices(match, targetIndex);
    const indices = [];
    while (indices.length < spec.count && candidates.length) {
      indices.push(candidates.splice(rand(candidates.length), 1)[0]);
    }
    msg.indices = indices;
  },

  swap(match, spec, msg, targetIndex) {
    const candidates = nonTargetIndices(match, targetIndex);
    const a = candidates.splice(rand(candidates.length), 1)[0];
    const b = candidates.splice(rand(candidates.length), 1)[0];
    [match.shown[a], match.shown[b]] = [match.shown[b], match.shown[a]];
    match.pendingSwaps.push({ a, b });
    msg.a = a;
    msg.b = b;
    const revert = setTimeout(() => {
      if (match.phase !== 'live') return;
      [match.shown[a], match.shown[b]] = [match.shown[b], match.shown[a]];
      match.pendingSwaps = match.pendingSwaps.filter(s => !(s.a === a && s.b === b));
      match.send(match.searcherSeat(), { t: 'gridRevert', a, b });
    }, spec.durationMs);
    match.timers.swaps.push(revert);
  },

  zoom(match, spec, msg, targetIndex) {
    // Zoom into the quadrant farthest from the target so the forced pan
    // starts the Searcher looking in the wrong place.
    const col = targetIndex % CONFIG.grid.cols;
    const row = Math.floor(targetIndex / CONFIG.grid.cols);
    msg.scale = spec.scale;
    msg.focus = {
      x: col < CONFIG.grid.cols / 2 ? 1 : 0,
      y: row < CONFIG.grid.rows / 2 ? 1 : 0,
    };
  },
};

function applySabotage(match, kind, spec, msg) {
  const targetIndex = match.shown.indexOf(match.target);
  if (effects[kind]) effects[kind](match, spec, msg, targetIndex);
}

module.exports = { sabotageList, applySabotage };
