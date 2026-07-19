'use strict';

const CONFIG = require('../config');

/*
 * Disconnect grace, seat re-attachment, and resume snapshots for a Room —
 * plain functions over the room, split out of Room for size. Revival after a
 * server restart re-arms grace through the same armGrace path, with deadlines
 * carried as absolute timestamps (players[seat].graceUntil).
 */

function armGrace(room, playerId, ms) {
  const seat = room.seatOf(playerId);
  if (seat !== -1) room.players[seat].graceUntil = Date.now() + ms;
  clearTimeout(room.graceTimers.get(playerId));
  room.graceTimers.set(playerId, setTimeout(() => {
    room.graceTimers.delete(playerId);
    const s = room.seatOf(playerId);
    if (s !== -1) room.players[s].graceUntil = null;
    if (room.phase === 'playing' && room.isTournament()) room.tournament.forfeit(s);
    else room.removePlayer(playerId);
  }, ms));
}

function handleDisconnect(room, playerId) {
  const seat = room.seatOf(playerId);
  if (seat === -1) return;
  const p = room.players[seat];
  p.connected = false;
  room.voice.drop(playerId);
  // Only lobby drops forfeit the seat immediately (roster accuracy matters
  // there). Results screens (matchEnd/tEnd) get the same grace as a mid-match
  // drop — a phone backgrounded between matches must not lose its seat.
  if (room.phase === 'lobby') {
    room.removePlayer(playerId);
    return;
  }
  const located = room.matchOf(seat);
  if (located) {
    located.match.pause();
    room.sendToMatchOpponent(located, seat, { t: 'opponentStatus', connected: false, graceMs: CONFIG.reconnectGraceMs });
  }
  room.broadcastRoom();
  armGrace(room, playerId, CONFIG.reconnectGraceMs);
}

function reconnect(room, playerId, ws) {
  const seat = room.seatOf(playerId);
  if (seat === -1) return false;
  const p = room.players[seat];
  if (room.isTournament() && p.active === false) return false; // forfeited — nothing to resume
  p.ws = ws;
  p.connected = true;
  p.graceUntil = null;
  const timer = room.graceTimers.get(playerId);
  if (timer) { clearTimeout(timer); room.graceTimers.delete(playerId); }
  sendResume(room, seat);
  const located = room.matchOf(seat);
  if (located) {
    room.sendToMatchOpponent(located, seat, { t: 'opponentStatus', connected: true });
    // Resume only once the whole pair is back; the fuse must not run against
    // an absent opponent (double-disconnect, server restart).
    if (located.pair.every(s => room.players[s].connected)) located.match.resume();
    else room.sendTo(seat, { t: 'opponentStatus', connected: false, graceMs: CONFIG.reconnectGraceMs });
  }
  if (room.needsKick) {
    // First returner to a revived tournament nudges the stalled schedule.
    room.needsKick = false;
    if (room.tournament) room.tournament.kick();
  }
  room.broadcastRoom();
  room.voice.refresh();
  return true;
}

function sendResume(room, seat) {
  const msg = { ...room.roomState(), t: 'resume', you: seat };
  if (room.isTournament() && room.tournament) Object.assign(msg, room.tournament.context());
  const located = room.matchOf(seat);
  if (room.phase === 'playing' && located) {
    room.sendTo(seat, { ...msg, match: located.match.snapshot(located.seatIn(seat)) });
  } else if (room.phase === 'playing' && room.isTournament()) {
    room.sendTo(seat, msg);
    room.tournament.sendWaiting(seat, 'finished');
  } else if (room.phase === 'matchEnd' && room.lastMatchEnd) {
    room.sendTo(seat, msg);
    room.sendTo(seat, room.lastMatchEnd);
  } else if (room.phase === 'tEnd' && room.tournament) {
    room.sendTo(seat, msg);
    room.sendTo(seat, room.tournament.endMessage());
  } else {
    room.sendTo(seat, msg);
  }
}

module.exports = { armGrace, handleDisconnect, reconnect, sendResume };
