'use strict';

const CONFIG = require('../config');
const { Match } = require('./match');
const { Tournament } = require('./tournament');
const { VoiceChannel } = require('./voice-channel');

/*
 * Room: roster, lobby settings, transport, and mode dispatch. A room runs
 * either one versus match or a Tournament (which owns its own schedule and
 * concurrent matches); voice signaling is delegated to VoiceChannel.
 */
class Room {
  constructor(code, onDestroy) {
    this.code = code;
    this.onDestroy = onDestroy;
    this.players = []; // { id, name, tag, ws, connected, ready, wantsRematch, points, played, active }
    this.settings = { mode: 'versus', roundsToWin: CONFIG.roundsToWin, difficulty: CONFIG.defaultDifficulty };
    this.phase = 'lobby'; // lobby | playing | matchEnd | tEnd
    this.log = [];
    this.match = null;      // versus
    this.tournament = null;
    this.graceTimers = new Map(); // playerId -> timer
    this.voice = new VoiceChannel({
      players: () => this.players,
      sendTo: (seat, msg) => this.sendTo(seat, msg),
      groupOf: id => this.voiceGroupOf(id),
    });
  }

  // ---------- basics ----------

  isTournament() { return this.settings.mode === 'tournament'; }
  maxPlayers() { return this.isTournament() ? CONFIG.tournament.maxPlayers : 2; }

  destroy() {
    if (this.match) this.match.forceEnd();
    if (this.tournament) this.tournament.destroy();
    this.graceTimers.forEach(clearTimeout);
    this.onDestroy(this.code);
  }

  sendTo(seat, msg) {
    const p = this.players[seat];
    if (p && p.connected && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    this.players.forEach((_, seat) => this.sendTo(seat, msg));
  }

  pushLog(text) {
    const round = this.isTournament()
      ? (this.tournament ? this.tournament.stage : 0)
      : (this.match ? this.match.round : 0);
    this.log.push({ at: Date.now(), round, text });
  }

  hostSeat() {
    const i = this.players.findIndex(p => p.active !== false && p.connected);
    return i === -1 ? 0 : i;
  }

  publicPlayers() {
    return this.players.map((p, seat) => ({
      seat, id: p.id, name: p.name, tag: p.tag,
      connected: p.connected, ready: !!p.ready, active: p.active !== false,
    }));
  }

  roomState() {
    return {
      t: 'room',
      code: this.code,
      phase: this.phase,
      players: this.publicPlayers(),
      settings: this.settings,
      host: this.hostSeat(),
      minPlayers: this.isTournament() ? CONFIG.tournament.minPlayers : 2,
      maxPlayers: this.maxPlayers(),
    };
  }

  broadcastRoom() {
    this.players.forEach((p, seat) => this.sendTo(seat, { ...this.roomState(), you: seat }));
  }

  seatOf(playerId) {
    return this.players.findIndex(p => p.id === playerId);
  }

  // ---------- voice (WebRTC signaling; audio flows peer-to-peer) ----------

  // Everyone shares one channel in the lobby / between matches; during play
  // each active match becomes its own private channel and the sitters share one.
  voiceGroupOf(playerId) {
    if (this.phase !== 'playing') return 'lobby';
    const located = this.matchOf(this.seatOf(playerId));
    return located ? `match:${Math.min(...located.pair)}` : 'waiting';
  }

  voiceJoin(seat) { this.voice.join(this.players[seat]); }
  voiceLeave(seat) { this.voice.leave(this.players[seat]); }
  voiceMute(seat, muted) { this.voice.mute(this.players[seat], muted); }

  relayRtc(fromId, to, data) {
    this.voice.relay(fromId, to, data, id => this.seatOf(id));
  }

  // ---------- membership ----------

  addPlayer(player) {
    if (this.phase === 'playing') return { ok: false, error: 'A game is in progress in this room.' };
    if (this.players.length >= this.maxPlayers()) return { ok: false, error: 'Room is full.' };
    if (this.seatOf(player.id) !== -1) return { ok: false, error: 'Already in this room.' };
    const seat = this.players.length;
    this.players.push({ ...player, connected: true, ready: seat === 0, wantsRematch: false, points: 0, played: 0, active: true });
    this.broadcastRoom();
    this.voice.refresh();
    return { ok: true, seat };
  }

  removePlayer(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    this.voice.drop(playerId);
    const timer = this.graceTimers.get(playerId);
    if (timer) { clearTimeout(timer); this.graceTimers.delete(playerId); }

    if (this.isTournament() && this.phase === 'playing') {
      // Keep the roster slot so the schedule and match seats stay valid.
      this.players[seat].connected = false;
      this.tournament.forfeit(seat);
      return;
    }

    this.players.splice(seat, 1);
    if (this.players.length === 0) return this.destroy();
    if (!this.isTournament() && this.phase === 'playing') {
      // A mid-match departure dissolves the versus match back to the lobby.
      if (this.match) this.match.forceEnd();
      this.match = null;
      this.phase = 'lobby';
      this.resetScores();
      this.players.forEach((p, i) => { p.ready = i === 0; });
      this.broadcast({ t: 'toast', msg: 'Opponent left the room.' });
    }
    this.broadcastRoom();
  }

  handleDisconnect(playerId) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return;
    const p = this.players[seat];
    p.connected = false;
    this.voice.drop(playerId);
    if (this.phase !== 'playing') {
      this.removePlayer(playerId);
      return;
    }
    const located = this.matchOf(seat);
    if (located) {
      located.match.pause();
      this.sendToMatchOpponent(located, seat, { t: 'opponentStatus', connected: false, graceMs: CONFIG.reconnectGraceMs });
    }
    this.broadcastRoom();
    this.graceTimers.set(playerId, setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (this.isTournament()) this.tournament.forfeit(seat);
      else this.removePlayer(playerId);
    }, CONFIG.reconnectGraceMs));
  }

  reconnect(playerId, ws) {
    const seat = this.seatOf(playerId);
    if (seat === -1) return false;
    const p = this.players[seat];
    if (this.isTournament() && p.active === false) return false; // forfeited — nothing to resume
    p.ws = ws;
    p.connected = true;
    const timer = this.graceTimers.get(playerId);
    if (timer) { clearTimeout(timer); this.graceTimers.delete(playerId); }
    this.sendResume(seat);
    const located = this.matchOf(seat);
    if (located) {
      this.sendToMatchOpponent(located, seat, { t: 'opponentStatus', connected: true });
      located.match.resume();
    }
    this.broadcastRoom();
    this.voice.refresh();
    return true;
  }

  sendResume(seat) {
    const room = { ...this.roomState(), t: 'resume', you: seat };
    if (this.isTournament() && this.tournament) Object.assign(room, this.tournament.context());
    const located = this.matchOf(seat);
    if (this.phase === 'playing' && located) {
      this.sendTo(seat, { ...room, match: located.match.snapshot(located.seatIn(seat)) });
    } else if (this.phase === 'playing' && this.isTournament()) {
      this.sendTo(seat, room);
      this.tournament.sendWaiting(seat, 'finished');
    } else if (this.phase === 'matchEnd' && this.lastMatchEnd) {
      this.sendTo(seat, room);
      this.sendTo(seat, this.lastMatchEnd);
    } else if (this.phase === 'tEnd' && this.tournament) {
      this.sendTo(seat, room);
      this.sendTo(seat, this.tournament.endMessage());
    } else {
      this.sendTo(seat, room);
    }
  }

  // ---------- settings / ready / start ----------

  setSettings(seat, patch) {
    if (seat !== this.hostSeat()) return this.sendTo(seat, { t: 'error', msg: 'Only the host can change settings.' });
    if (this.phase === 'playing') return;
    if (CONFIG.roundsToWinOptions.includes(patch.roundsToWin)) this.settings.roundsToWin = patch.roundsToWin;
    if (CONFIG.difficulties[patch.difficulty]) this.settings.difficulty = patch.difficulty;
    if (patch.mode === 'versus' || patch.mode === 'tournament') {
      if (patch.mode === 'versus' && this.players.length > 2) {
        return this.sendTo(seat, { t: 'error', msg: 'Too many players for 1v1 — someone has to leave first.' });
      }
      this.settings.mode = patch.mode;
    }
    this.broadcastRoom();
  }

  setReady(seat, ready) {
    if (this.phase === 'playing' || seat < 0 || seat === this.hostSeat()) return;
    this.players[seat].ready = !!ready;
    this.broadcastRoom();
  }

  start(seat) {
    if (this.phase === 'playing') return;
    if (seat !== this.hostSeat()) return this.sendTo(seat, { t: 'error', msg: 'Only the host starts the match.' });
    const min = this.isTournament() ? CONFIG.tournament.minPlayers : 2;
    if (this.players.length < min) {
      return this.sendTo(seat, { t: 'error', msg: this.isTournament() ? `Tournaments need at least ${min} players.` : 'Waiting for an opponent.' });
    }
    const notReady = this.players.find((p, i) => i !== this.hostSeat() && !p.ready);
    if (notReady) return this.sendTo(seat, { t: 'error', msg: `${notReady.name} isn't ready yet.` });
    this.resetScores();
    this.phase = 'playing';
    this.lastMatchEnd = null;
    this.broadcastRoom();
    if (this.isTournament()) {
      this.tournament = new Tournament(this);
      this.tournament.start();
    } else {
      this.startVersus();
    }
    this.voice.refresh();
  }

  resetScores() {
    this.players.forEach(p => { p.points = 0; p.played = 0; p.active = true; p.wantsRematch = false; });
    this.log = [];
  }

  // ---------- versus ----------

  startVersus() {
    this.match = new Match({
      ports: [{ send: m => this.sendTo(0, m) }, { send: m => this.sendTo(1, m) }],
      names: [this.players[0].name, this.players[1].name],
      difficulty: this.settings.difficulty,
      firstTo: this.settings.roundsToWin,
      hooks: {
        log: text => this.pushLog(text),
        onEnd: match => {
          this.phase = 'matchEnd';
          const winnerSeat = match.wins[0] > match.wins[1] ? 0 : 1;
          this.pushLog(`${this.players[winnerSeat].name} wins the match ${match.wins[winnerSeat]}–${match.wins[1 - winnerSeat]}.`);
          this.lastMatchEnd = {
            t: 'matchEnd',
            winnerSeat,
            score: match.wins,
            history: match.history,
            log: this.log,
            players: this.publicPlayers(),
          };
          this.broadcast(this.lastMatchEnd);
          this.match = null;
          this.voice.refresh();
        },
      },
    });
    this.match.start();
  }

  rematch(seat) {
    if (this.phase !== 'matchEnd') return;
    this.players[seat].wantsRematch = true;
    this.broadcast({ t: 'rematchStatus', votes: this.players.map(p => p.wantsRematch) });
    if (this.players.length === 2 && this.players.every(p => p.wantsRematch)) {
      this.resetScores();
      this.phase = 'playing';
      this.startVersus();
      this.voice.refresh();
    }
  }

  // ---------- tournament ----------

  // Called by the Tournament once its schedule is exhausted or too few
  // players remain: publish the result and reset the room to a clean lobby.
  onTournamentEnd(endMessage) {
    this.phase = 'tEnd';
    this.broadcast(endMessage);
    // Forfeited/vanished players lose their roster slots now the schedule is done.
    this.players.forEach(p => { if (p.active === false || !p.connected) this.voice.members.delete(p.id); });
    this.players = this.players.filter(p => p.active !== false && p.connected);
    if (this.players.length === 0) return this.destroy();
    this.players.forEach((p, i) => { p.ready = i === this.hostSeat(); });
    this.broadcastRoom();
    this.voice.refresh();
  }

  // ---------- in-game routing ----------

  matchOf(seat) {
    if (!this.isTournament()) {
      if (this.match && this.match.phase !== 'done' && (seat === 0 || seat === 1)) {
        return { match: this.match, pair: [0, 1], seatIn: s => s };
      }
      return null;
    }
    return this.tournament ? this.tournament.matchOf(seat) : null;
  }

  sendToMatchOpponent(located, seat, msg) {
    const oppSeat = located.pair[0] === seat ? located.pair[1] : located.pair[0];
    this.sendTo(oppSeat, msg);
  }

  onPick(seat, index) {
    const located = this.matchOf(seat);
    if (located) located.match.onPick(located.seatIn(seat), index);
  }

  onTap(seat, index) {
    const located = this.matchOf(seat);
    if (located) located.match.onTap(located.seatIn(seat), index);
  }

  onPuzzleAnswer(seat, puzzleId, index) {
    const located = this.matchOf(seat);
    if (located) located.match.onPuzzleAnswer(located.seatIn(seat), puzzleId, index);
  }

  onSabotage(seat, kind) {
    const located = this.matchOf(seat);
    if (located) located.match.onSabotage(located.seatIn(seat), kind);
  }
}

module.exports = { Room };
