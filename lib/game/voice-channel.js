'use strict';

/*
 * VoiceChannel: WebRTC signaling roster for a room (audio flows peer-to-peer).
 * Depends on a narrow room interface, injected at construction:
 *   players()          -> [{ id, name }]  (seat order)
 *   sendTo(seat, msg)
 *   groupOf(playerId)  -> string channel key (who can hear whom)
 */
class VoiceChannel {
  constructor({ players, sendTo, groupOf }) {
    this.playersOf = players;
    this.sendTo = sendTo;
    this.groupOf = groupOf;
    this.members = new Map(); // playerId -> { muted }
  }

  broadcastState() {
    const players = this.playersOf();
    const members = [...this.members.entries()].map(([id, v]) => {
      const p = players.find(x => x.id === id);
      return { id, name: p ? p.name : '?', muted: !!v.muted };
    });
    players.forEach((p, seat) => {
      const mine = this.groupOf(p.id);
      const peers = members
        .filter(m => m.id !== p.id && this.groupOf(m.id) === mine)
        .map(m => m.id);
      this.sendTo(seat, { t: 'voiceState', members, peers });
    });
  }

  // Re-announce peer groups after any topology change (match start/end, forfeit).
  refresh() {
    if (this.members.size) this.broadcastState();
  }

  join(player) {
    if (!player) return;
    this.members.set(player.id, { muted: false });
    this.broadcastState();
  }

  leave(player) {
    if (!player || !this.members.delete(player.id)) return;
    this.broadcastState();
  }

  mute(player, muted) {
    const v = player && this.members.get(player.id);
    if (!v) return;
    v.muted = !!muted;
    this.broadcastState();
  }

  drop(playerId) {
    if (this.members.delete(playerId)) this.broadcastState();
  }

  relay(fromId, to, data, seatOf) {
    if (!this.members.has(fromId) || !this.members.has(to)) return;
    if (this.groupOf(fromId) !== this.groupOf(to)) return;
    const seat = seatOf(to);
    if (seat !== -1) this.sendTo(seat, { t: 'rtc', from: fromId, data });
  }
}

module.exports = { VoiceChannel };
