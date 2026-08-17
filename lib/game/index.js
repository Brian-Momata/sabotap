'use strict';

// Public surface of the game package. `require('./lib/game')` resolves here,
// keeping the pre-split import path working.
const { Room } = require('./room');
const { Match } = require('./match');
const { Bot } = require('./bot');
const { makeRoomCode } = require('./room-code');
const { makeGrid } = require('./grid');
const { roundRobin } = require('./round-robin');
const { boardList } = require('./boards');
const { RoomPersistence } = require('./persistence');

module.exports = { Room, Match, Bot, makeRoomCode, makeGrid, roundRobin, boardList, RoomPersistence };
