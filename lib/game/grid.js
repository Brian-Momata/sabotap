'use strict';

const CONFIG = require('../config');
const { rand } = require('./rng');

function makeGrid() {
  const size = CONFIG.grid.cols * CONFIG.grid.rows;
  const set = new Set();
  while (set.size < size) set.add(10 + rand(90));
  return Array.from(set);
}

module.exports = { makeGrid };
