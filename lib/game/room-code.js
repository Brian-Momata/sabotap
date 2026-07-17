'use strict';

const { rand, pickOne } = require('./rng');

const CODE_WORDS = ['FOX', 'OWL', 'CAT', 'BEE', 'ELK', 'KIT', 'JAY', 'RAM', 'BAT', 'ANT', 'HEN', 'PUP', 'DOE', 'CUB', 'KOI', 'YAK', 'EMU', 'ASP', 'ORC', 'IBEX'];

function makeRoomCode() {
  return `${pickOne(CODE_WORDS)}-${10 + rand(90)}`;
}

module.exports = { makeRoomCode };
