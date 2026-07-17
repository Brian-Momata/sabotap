'use strict';

// Public surface of the game package. `require('./lib/game')` resolves here,
// keeping the pre-split import path working.
const { Room } = require('./room');
const { Match } = require('./match');
const { makeRoomCode } = require('./room-code');
const { makeGrid } = require('./grid');
const { roundRobin } = require('./round-robin');

module.exports = { Room, Match, makeRoomCode, makeGrid, roundRobin };
