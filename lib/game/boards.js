'use strict';

const CONFIG = require('../config');
const { rand, pickOne } = require('./rng');
const { makeGrid } = require('./grid');
const { makePuzzle, CONFUSABLE } = require('./puzzle');

/*
 * Board themes, extend-by-strategy (same pattern as sabotages.js): each board
 * may override grid generation and puzzle generation; everything else in
 * Match is board-agnostic. Blackout and Drift are purely visual — the client
 * theme does the work, so they have no entry here.
 */

// Boards a round can actually be played on; 'rotation' resolves into these,
// in this order, one per round.
const PLAYABLE = ['standard', 'mirrors', 'blackout', 'drift', 'glyphs'];

// 28 visually near-twin pairs (filled/outline or one-stroke-off) = exactly the
// 56 tiles of a 7×8 grid. Geometric-shape codepoints only — they render as
// text (not emoji) consistently across platforms.
const GLYPH_PAIRS = [
  ['◆', '◇'], ['●', '○'], ['■', '□'], ['▲', '△'], ['▼', '▽'], ['◀', '◁'],
  ['▶', '▷'], ['★', '☆'], ['⬢', '⬡'], ['⬟', '⬠'], ['◐', '◑'], ['◒', '◓'],
  ['◧', '◨'], ['◩', '◪'], ['⬒', '⬓'], ['⬖', '⬗'], ['✦', '✧'], ['✶', '✷'],
  ['✕', '✚'], ['⊕', '⊗'], ['⊞', '⊠'], ['⊙', '⊚'], ['◍', '◎'], ['▤', '▥'],
  ['▦', '▧'], ['▨', '▩'], ['◰', '◱'], ['◲', '◳'],
];
const GLYPHS = GLYPH_PAIRS.flat();

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Every number arrives with a near-twin when one is free: reversed digits
// (37/73) or a lookalike digit swapped in (68/63). Same rules as standard —
// the maze is in the values, not the mechanics.
function mirrorsGrid() {
  const size = CONFIG.grid.cols * CONFIG.grid.rows;
  const set = new Set();
  const twinsOf = n => {
    const tens = Math.floor(n / 10);
    const units = n % 10;
    const out = [];
    const rev = units * 10 + tens;
    if (rev >= 10 && rev !== n) out.push(rev);
    for (const d of CONFUSABLE[units]) out.push(tens * 10 + d);
    for (const d of CONFUSABLE[tens]) { if (d !== 0) out.push(d * 10 + units); }
    return out.filter(t => t >= 10 && t <= 99 && t !== n);
  };
  while (set.size < size) {
    const n = 10 + rand(90);
    if (set.has(n)) continue;
    set.add(n);
    if (set.size === size) break;
    const free = twinsOf(n).filter(t => !set.has(t));
    if (free.length) set.add(pickOne(free));
  }
  return shuffled(Array.from(set));
}

// Odd-one-out over glyphs: past the difficulty's confusableFrom fraction the
// odd glyph is the shared glyph's near-twin — the same curve digits follow.
function glyphPuzzle(fuse, confusableFrom) {
  const pair = GLYPH_PAIRS[rand(GLYPH_PAIRS.length)];
  const flip = rand(2);
  const shared = pair[flip];
  let odd;
  if (fuse >= confusableFrom) {
    odd = pair[1 - flip];
  } else {
    do { odd = GLYPHS[rand(GLYPHS.length)]; } while (odd === shared);
  }
  const oddIndex = rand(5);
  const tiles = Array.from({ length: 5 }, (_, i) => (i === oddIndex ? odd : shared));
  return { tiles, oddIndex };
}

const grids = {
  mirrors: mirrorsGrid,
  glyphs: () => shuffled(GLYPHS),
};

const puzzles = {
  glyphs: glyphPuzzle,
};

// The concrete board a given round plays on. offset is where in the cycle
// this match starts — rounds are match-local, so without it every match
// replayed the head of the list and 2-round tournament pairings never got
// past 'mirrors'. The room supplies it: versus continues where the last match
// stopped, tournaments derive it from the stage number.
function resolveBoard(settingKey, round, offset = 0) {
  if (settingKey === 'rotation') return PLAYABLE[(offset + round - 1) % PLAYABLE.length];
  return CONFIG.boards[settingKey] ? settingKey : CONFIG.defaultBoard;
}

function boardGrid(key) {
  return grids[key] ? grids[key]() : makeGrid();
}

function boardPuzzle(key, fuse, confusableFrom) {
  return puzzles[key] ? puzzles[key](fuse, confusableFrom) : makePuzzle(fuse, confusableFrom);
}

// What the client needs to theme a round: identity plus visual tunables.
function clientBoard(key) {
  const { name, tagline, ...fx } = CONFIG.boards[key];
  return { key, name, tagline, ...fx };
}

function boardList() {
  return Object.keys(CONFIG.boards).map(clientBoard);
}

module.exports = { resolveBoard, boardGrid, boardPuzzle, clientBoard, boardList };
