'use strict';

const CONFIG = require('../config');
const { roundRobin } = require('./round-robin');
const { Match } = require('./match');

/*
 * Tournament: a round-robin of concurrent 2-round matches inside a room.
 * Owns the schedule, stage progression, standings, walkovers, and forfeits;
 * roster membership, phase, and transport stay with the owning Room (passed
 * in as a facade). Roster seats stay stable for the whole tournament —
 * dropouts are marked inactive rather than removed so the schedule and any
 * running matches keep their seat references.
 */
class Tournament {
  constructor(room) {
    this.room = room;
    this.stage = 0;
    this.schedule = [];
    this.stageMatches = []; // [{ match, pair: [ri, rj], seatIn(rosterSeat) }]
    this.pairingTimer = null;
    this.pendingStagePairs = 0;
  }

  get players() { return this.room.players; }

  destroy() {
    this.stageMatches.forEach(s => s.match.forceEnd());
    clearTimeout(this.pairingTimer);
  }

  activeSeats() {
    return this.players.map((p, i) => i).filter(i => this.players[i].active !== false);
  }

  start() {
    this.schedule = roundRobin(this.players.length);
    this.stage = 0;
    this.stageMatches = [];
    this.room.pushLog(`Tournament started — ${this.players.length} players, ${this.schedule.length} stages.`);
    this.nextStage();
  }

  worstRoundMs() {
    const fuse = CONFIG.fuseMsOverride ?? CONFIG.difficulties[this.room.settings.difficulty].fuseMs;
    return CONFIG.pickTimeoutMs + fuse + CONFIG.interRoundMs;
  }

  stageEstimateMs() {
    let worst = 0;
    for (const { match } of this.stageMatches) {
      worst = Math.max(worst, match.roundsLeft() * this.worstRoundMs());
    }
    // Matches announced but not yet started (pairing splash still showing).
    if (!worst && this.pendingStagePairs) {
      worst = CONFIG.tournament.pairingDelayMs + CONFIG.tournament.matchRounds * this.worstRoundMs();
    }
    return worst;
  }

  standings() {
    const rows = this.players
      .map((p, seat) => ({ seat, id: p.id, name: p.name, tag: p.tag, points: p.points, played: p.played, active: p.active !== false }))
      .sort((a, b) => (b.points - a.points) || a.name.localeCompare(b.name));
    let rank = 0;
    let prevPts = null;
    rows.forEach((r, i) => {
      if (r.points !== prevPts) { rank = i + 1; prevPts = r.points; }
      r.rank = rank;
    });
    return rows;
  }

  rowFor(seat) {
    return this.standings().find(r => r.seat === seat);
  }

  sendWaiting(seat, reason) {
    this.room.sendTo(seat, {
      t: 'tWaiting',
      reason, // 'finished' | 'bye' | 'walkover'
      stage: this.stage,
      stages: this.schedule.length,
      standings: this.standings(),
      estimateMs: this.stageEstimateMs(),
    });
  }

  context() {
    return { mode: 'tournament', stage: this.stage, stages: this.schedule.length };
  }

  pushWaitingUpdate() {
    if (this.room.phase !== 'playing') return;
    const inMatch = new Set();
    this.stageMatches.forEach(({ match, pair }) => {
      if (match.phase !== 'done') pair.forEach(i => inMatch.add(i));
    });
    this.players.forEach((p, seat) => {
      if (p.active !== false && p.connected && !inMatch.has(seat)) {
        this.room.sendTo(seat, {
          t: 'tStandings',
          standings: this.standings(),
          estimateMs: this.stageEstimateMs(),
          stage: this.stage,
          stages: this.schedule.length,
        });
      }
    });
  }

  awardWalkover(seat) {
    this.players[seat].points += CONFIG.tournament.matchRounds;
    this.players[seat].played += 1;
  }

  nextStage() {
    if (this.room.phase !== 'playing') return;
    if (this.stage >= this.schedule.length || this.activeSeats().length < 2) return this.end();
    const pairs = this.schedule[this.stage];
    this.stage += 1;
    this.stageMatches = [];
    const toStart = [];
    const sitters = []; // [seat, reason]

    for (const [a, b] of pairs) {
      const pa = a >= 0 ? this.players[a] : null;
      const pb = b >= 0 ? this.players[b] : null;
      const aLive = pa && pa.active !== false;
      const bLive = pb && pb.active !== false;
      if (aLive && bLive) {
        toStart.push([a, b]);
      } else if (aLive || bLive) {
        const seat = aLive ? a : b;
        const other = aLive ? pb : pa;
        if (other) {
          // Scheduled opponent forfeited earlier — walkover.
          this.awardWalkover(seat);
          this.room.pushLog(`${this.players[seat].name} gets a walkover (${other.name} left).`);
          sitters.push([seat, 'walkover']);
        } else {
          sitters.push([seat, 'bye']);
        }
      }
    }

    // Sitters learn their fate after the pending matches are known so their
    // wait estimate covers the whole stage.
    this.pendingStagePairs = toStart.length;
    for (const [seat, reason] of sitters) this.sendWaiting(seat, reason);

    if (!toStart.length) {
      this.pairingTimer = setTimeout(() => this.nextStage(), 1500);
      return;
    }

    // Announce pairings, then start the matches after the splash delay.
    for (const [a, b] of toStart) {
      this.room.sendTo(a, {
        t: 'tPairing', stage: this.stage, stages: this.schedule.length,
        startsInMs: CONFIG.tournament.pairingDelayMs, you: this.rowFor(a), opponent: this.rowFor(b),
      });
      this.room.sendTo(b, {
        t: 'tPairing', stage: this.stage, stages: this.schedule.length,
        startsInMs: CONFIG.tournament.pairingDelayMs, you: this.rowFor(b), opponent: this.rowFor(a),
      });
    }

    this.pairingTimer = setTimeout(() => {
      this.pendingStagePairs = 0;
      for (const [a, b] of toStart) {
        // A pairing can die during the splash (forfeit) — walkover instead.
        const aLive = this.players[a].active !== false;
        const bLive = this.players[b].active !== false;
        if (!aLive || !bLive) {
          if (aLive || bLive) {
            const seat = aLive ? a : b;
            this.awardWalkover(seat);
            this.sendWaiting(seat, 'walkover');
          }
          continue;
        }
        this.stageMatches.push({
          match: this.createMatch(a, b),
          pair: [a, b],
          seatIn: s => (s === a ? 0 : 1),
        });
      }
      this.stageMatches.forEach(({ match }) => match.start());
      this.room.voice.refresh();
      if (!this.stageMatches.length) this.checkStageDone();
    }, CONFIG.tournament.pairingDelayMs);
  }

  createMatch(a, b) {
    return new Match({
      ports: [{ send: m => this.room.sendTo(a, m) }, { send: m => this.room.sendTo(b, m) }],
      names: [this.players[a].name, this.players[b].name],
      difficulty: this.room.settings.difficulty,
      board: this.room.settings.board,
      totalRounds: CONFIG.tournament.matchRounds,
      hooks: {
        log: text => this.room.pushLog(text),
        onRoundEnd: (m, winnerSeat) => {
          this.players[winnerSeat === 0 ? a : b].points += 1;
          this.pushWaitingUpdate();
        },
        onEnd: () => {
          this.players[a].played += 1;
          this.players[b].played += 1;
          if (this.players[a].active !== false) this.sendWaiting(a, 'finished');
          if (this.players[b].active !== false) this.sendWaiting(b, 'finished');
          this.pushWaitingUpdate();
          this.room.voice.refresh();
          this.checkStageDone();
        },
      },
    });
  }

  checkStageDone() {
    if (this.room.phase !== 'playing') return;
    if (this.stageMatches.every(({ match }) => match.phase === 'done')) {
      clearTimeout(this.pairingTimer);
      this.pairingTimer = setTimeout(() => this.nextStage(), 1200);
    }
  }

  forfeit(seat) {
    const p = this.players[seat];
    if (!p || p.active === false || this.room.phase !== 'playing') return;
    p.active = false;
    p.ready = false;
    this.room.pushLog(`${p.name} left the tournament.`);
    const located = this.matchOf(seat);
    if (located) {
      const { match, pair } = located;
      const oppSeat = pair[0] === seat ? pair[1] : pair[0];
      const remaining = match.roundsLeft();
      match.forceEnd();
      if (this.players[oppSeat].active !== false) {
        this.players[oppSeat].points += remaining;
        this.players[oppSeat].played += 1;
        this.room.pushLog(`${this.players[oppSeat].name} wins by forfeit.`);
        this.room.sendTo(oppSeat, { t: 'toast', msg: `${p.name} left — you take the remaining rounds.` });
        this.sendWaiting(oppSeat, 'walkover');
      }
    }
    this.room.broadcastRoom();
    this.pushWaitingUpdate();
    this.room.voice.refresh();
    if (this.activeSeats().length < 2) return this.end();
    if (located) this.checkStageDone();
  }

  matchOf(seat) {
    return this.stageMatches.find(({ match, pair }) => match.phase !== 'done' && pair.includes(seat)) || null;
  }

  endMessage() {
    return {
      t: 'tEnd',
      leaderboard: this.standings(),
      stages: this.schedule.length,
      log: this.room.log,
    };
  }

  end() {
    if (this.room.phase !== 'playing') return;
    this.pendingStagePairs = 0;
    clearTimeout(this.pairingTimer);
    this.stageMatches.forEach(({ match }) => match.forceEnd());
    const top = this.standings()[0];
    this.room.pushLog(`Tournament over — ${top ? top.name : '?'} takes it with ${top ? top.points : 0} points.`);
    this.room.onTournamentEnd(this.endMessage());
  }
}

module.exports = { Tournament };
