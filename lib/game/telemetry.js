'use strict';

const analytics = require('../analytics');

/*
 * The gameplay event taxonomy: the one place that decides what a played match
 * reports and under which names. Modes call these from the hooks they already
 * own, so adding a measurement never means threading an analytics call through
 * the engine.
 *
 * Everything here is best-effort observation — a throw would abort a round, so
 * nothing in this file may assume more than the object it is handed.
 */

// Numbers are stored as running stats (avg/min/max), which hides the shape of a
// distribution. Where the shape is the point — how far solo runs actually get —
// a band rides along as a dimension so the histogram survives aggregation.
function band(value, edges) {
  for (const edge of edges) if (value <= edge) return `${edge}`;
  return `${edges[edges.length - 1] + 1}+`;
}

const minutesSince = at => (at ? Math.round(((Date.now() - at) / 60000) * 10) / 10 : 0);

function matchStarted(room) {
  const s = room.settings;
  analytics.track('match.start', {
    mode: s.mode,
    difficulty: s.difficulty,
    board: s.board,
    roundsToWin: String(s.roundsToWin),
    size: String(room.players.length),
  });
}

// Called by the engine itself: round outcome is the balance signal that has to
// be right for every mode, so it must not depend on a mode remembering to hook.
function roundEnded(match, winnerSeat, reason) {
  analytics.track('round.end', {
    reason,                         // 'found' (searcher tapped it) | 'fuse' (ran out)
    difficulty: match.difficultyKey,
    board: match.boardKey,
    // Per-dimension counts can't be crossed after the fact, so the two crosses
    // worth having — is a difficulty or a board eating searchers? — are recorded
    // as their own low-cardinality dimensions.
    difficultyOutcome: `${match.difficultyKey}/${reason}`,
    boardOutcome: `${match.boardKey}/${reason}`,
    seconds: match.liveAt ? Math.round((Date.now() - match.liveAt) / 100) / 10 : null,
  });
}

// The play tallies a finished match accumulated (see Match#stats), reported
// once so per-round noise never inflates the event count.
function reportPlay(match, mode) {
  const stats = match.stats || {};
  for (const [kind, n] of Object.entries(stats.sabotages || {})) {
    analytics.track('sabotage.fire', { kind, mode }, n);
  }
  analytics.track('match.play', {
    mode,
    mistaps: stats.mistaps || 0,
    puzzlesSolved: stats.puzzlesSolved || 0,
    puzzlesWrong: stats.puzzlesWrong || 0,
    puzzlesTimedOut: stats.puzzlesTimedOut || 0,
  });
}

function matchEnded(match, room) {
  const rounds = match.history.length;
  analytics.track('match.end', {
    mode: room.settings.mode,
    difficulty: match.difficultyKey,
    board: room.settings.board,
    rounds,
    // A shutout says the pairing was lopsided — worth separating from a close one.
    sweep: Math.min(...match.wins) === 0,
    minutes: minutesSince(match.startedAt),
  });
  reportPlay(match, room.settings.mode);
}

function soloEnded(match, room, streak) {
  analytics.track('solo.end', {
    difficulty: match.difficultyKey,
    board: room.settings.board,
    streak,
    streakBand: band(streak, [0, 2, 5, 9, 14]),
    minutes: minutesSince(match.startedAt),
  });
  reportPlay(match, 'solo');
}

function tournamentMatchEnded(match) {
  reportPlay(match, 'tournament');
}

// Voice adoption: a room having voice available says nothing; a player
// actually joining the channel does.
function voiceJoined(muted) {
  analytics.track('voice.join', { muted });
}

function tournamentEnded(tournament) {
  analytics.track('tournament.end', {
    size: String(tournament.players.length),
    stages: tournament.schedule.length,
    finishers: tournament.players.filter(p => p.active !== false).length,
    minutes: minutesSince(tournament.startedAt),
  });
}

module.exports = {
  matchStarted, roundEnded, matchEnded, soloEnded,
  tournamentMatchEnded, tournamentEnded, voiceJoined,
};
