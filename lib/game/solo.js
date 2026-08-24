'use strict';

const CONFIG = require('../config');
const { Match } = require('./match');
const { Bot } = require('./bot');
const telemetry = require('./telemetry');

/*
 * Solo run: one human against the caller bot, scored as survival rather than
 * as a match. Roles are pinned — the human searches every round, the bot calls
 * every round — and the run ends the first time the fuse beats the human. The
 * streak is simply the human's round wins, so nothing extra has to be tracked
 * or persisted: a revived run resumes with its streak (and therefore the bot's
 * skill rung) intact.
 *
 * The room owns the seats; solo only ever uses these two.
 */
const HUMAN_SEAT = 0;
const BOT_SEAT = 1;

// The single place solo ports/hooks are built — revival after a server restart
// recreates the match through here too (see serialize.js).
function makeSoloMatch(room) {
  const bot = new Bot({ seat: BOT_SEAT });
  const match = new Match({
    ports: [{ send: m => room.sendTo(HUMAN_SEAT, m) }, bot],
    names: [room.players[HUMAN_SEAT].name, bot.name],
    difficulty: room.settings.difficulty,
    board: room.settings.board,
    boardOffset: room.boardCycle,
    firstCaller: BOT_SEAT,
    rotateRoles: false,
    // Survival: every round the human takes extends the run, the first one
    // they lose ends it.
    overWhen: m => m.wins[BOT_SEAT] >= 1,
    hooks: {
      log: text => room.pushLog(text),
      onEnd: match => {
        room.boardCycle += match.history.length;
        room.phase = 'matchEnd';
        room.onPhaseChange();
        const streak = match.wins[HUMAN_SEAT];
        telemetry.soloEnded(match, room, streak);
        room.pushLog(`Run over — ${streak} round${streak === 1 ? '' : 's'} survived.`);
        // `solo` and `streak` are additive: an older client still reads a
        // well-formed matchEnd and shows the round the run ended on.
        room.lastMatchEnd = {
          t: 'matchEnd',
          solo: true,
          streak,
          winnerSeat: BOT_SEAT,
          score: match.wins,
          history: match.history,
          log: room.log,
          players: room.publicPlayers(),
        };
        room.broadcast(room.lastMatchEnd);
        room.match = null;
      },
    },
  });
  bot.attach(match);
  return match;
}

// A solo room is private by construction: one seat, so the room code can never
// be joined by anyone else.
const soloSettings = () => ({
  mode: 'solo',
  roundsToWin: CONFIG.roundsToWin,
  difficulty: CONFIG.defaultDifficulty,
  board: CONFIG.defaultBoard,
});

module.exports = { makeSoloMatch, soloSettings, HUMAN_SEAT, BOT_SEAT };
