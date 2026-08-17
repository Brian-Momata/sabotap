'use strict';

const { rand, pickOne } = require('./rng');

// Digits that read as visually similar — used to steepen the puzzle
// difficulty curve as the round progresses (spec fairness requirement).
const CONFUSABLE = {
  0: [8, 6, 9], 1: [7, 4], 2: [7, 3], 3: [8, 9, 5], 4: [1, 9],
  5: [6, 3, 9], 6: [8, 5, 0], 7: [1, 2], 8: [3, 6, 9, 0], 9: [8, 3, 4, 6, 0],
};

// The two-digit numbers that read as near-twins of `n`: reversed digits
// (37/73) or one digit swapped for a lookalike (68/63). Used both to build the
// Hall of Mirrors grid and to judge how well a number hides on a given board.
function twinsOf(n) {
  const tens = Math.floor(n / 10);
  const units = n % 10;
  const out = [];
  const rev = units * 10 + tens;
  if (rev >= 10 && rev !== n) out.push(rev);
  for (const d of CONFUSABLE[units]) out.push(tens * 10 + d);
  for (const d of CONFUSABLE[tens]) { if (d !== 0) out.push(d * 10 + units); }
  return out.filter(t => t >= 10 && t <= 99 && t !== n);
}

// Five tiles sharing one digit with a single odd one out. Past the
// difficulty's confusableFrom fuse fraction, the odd digit is a lookalike.
function makePuzzle(fuse, confusableFrom) {
  const shared = rand(10);
  let odd;
  if (fuse >= confusableFrom && CONFUSABLE[shared].length) {
    odd = pickOne(CONFUSABLE[shared]);
  } else {
    do { odd = rand(10); } while (odd === shared);
  }
  const oddIndex = rand(5);
  const tiles = Array.from({ length: 5 }, (_, i) => (i === oddIndex ? odd : shared));
  return { tiles, oddIndex };
}

module.exports = { makePuzzle, twinsOf, CONFUSABLE };
