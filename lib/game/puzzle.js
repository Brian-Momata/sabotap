'use strict';

const { rand, pickOne } = require('./rng');

// Digits that read as visually similar — used to steepen the puzzle
// difficulty curve as the round progresses (spec fairness requirement).
const CONFUSABLE = {
  0: [8, 6, 9], 1: [7, 4], 2: [7, 3], 3: [8, 9, 5], 4: [1, 9],
  5: [6, 3, 9], 6: [8, 5, 0], 7: [1, 2], 8: [3, 6, 9, 0], 9: [8, 3, 4, 6, 0],
};

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

module.exports = { makePuzzle, CONFUSABLE };
