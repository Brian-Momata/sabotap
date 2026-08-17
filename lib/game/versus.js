'use strict';

const { Match } = require('./match');

/*
 * Versus: the 1v1 match a room runs by default — roles swap every round and the
 * first player to `roundsToWin` rounds takes it. Sibling of solo.js; the room
 * owns the roster and dispatches to whichever mode it is in.
 */

// The single place versus ports/hooks are built — revival after a server
// restart recreates the match through here too (see serialize.js).
function makeVersusMatch(room) {
  return new Match({
    ports: [{ send: m => room.sendTo(0, m) }, { send: m => room.sendTo(1, m) }],
    names: [room.players[0].name, room.players[1].name],
    difficulty: room.settings.difficulty,
    board: room.settings.board,
    boardOffset: room.boardCycle,
    firstTo: room.settings.roundsToWin,
    hooks: {
      log: text => room.pushLog(text),
      onEnd: match => {
        // A rematch picks up the rotation where this match stopped.
        room.boardCycle += match.history.length;
        room.phase = 'matchEnd';
        room.onPhaseChange();
        const winnerSeat = match.wins[0] > match.wins[1] ? 0 : 1;
        room.pushLog(`${room.players[winnerSeat].name} wins the match ${match.wins[winnerSeat]}–${match.wins[1 - winnerSeat]}.`);
        room.lastMatchEnd = {
          t: 'matchEnd',
          winnerSeat,
          score: match.wins,
          history: match.history,
          log: room.log,
          players: room.publicPlayers(),
        };
        room.broadcast(room.lastMatchEnd);
        room.match = null;
        room.voice.refresh();
      },
    },
  });
}

module.exports = { makeVersusMatch };
