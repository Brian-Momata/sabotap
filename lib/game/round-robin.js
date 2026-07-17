'use strict';

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

module.exports = { roundRobin };
