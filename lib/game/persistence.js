'use strict';

const CONFIG = require('../config');
const { serializeRoom, reviveRoom } = require('./serialize');

/*
 * When and where rooms hit disk: event-driven touches after handled messages,
 * an interval autosave for timer-driven mutation (fuse ticks, round ends,
 * stage advances), and flushAll() on shutdown so graceful restarts persist the
 * exact state. On boot, restore() revives every saved room in a paused,
 * disconnected state; players re-attach through the normal hello → reconnect
 * path. Grace deadlines are absolute timestamps, so a server that was down
 * longer than the grace window expires seats instead of resurrecting them.
 */
class RoomPersistence {
  constructor(store, { rooms, roomOf, makeRoom }) {
    this.store = store; // a Store whose data holds { rooms: {} }
    this.rooms = rooms;
    this.roomOf = roomOf;
    this.makeRoom = makeRoom;
    this.autosave = setInterval(() => this.touchAll(), CONFIG.roomPersist.autosaveMs);
    if (this.autosave.unref) this.autosave.unref();
  }

  touch(room) {
    if (!this.rooms.has(room.code)) return; // destroyed mid-handler
    this.store.data.rooms[room.code] = serializeRoom(room);
    this.store.save();
  }

  touchAll() {
    if (!this.rooms.size) return;
    for (const room of this.rooms.values()) this.store.data.rooms[room.code] = serializeRoom(room);
    this.store.save();
  }

  remove(code) {
    if (!this.store.data.rooms[code]) return;
    delete this.store.data.rooms[code];
    this.store.save();
  }

  flushAll() {
    for (const room of this.rooms.values()) this.store.data.rooms[room.code] = serializeRoom(room);
    this.store.flush();
  }

  restore() {
    const saved = this.store.data.rooms;
    const now = Date.now();
    for (const code of Object.keys(saved)) {
      // Players connected at save time get a fresh grace window from boot —
      // the restart wasn't their fault; recorded deadlines stand.
      const deadlineFor = p => p.graceUntil || (now + CONFIG.reconnectGraceMs);
      if (!saved[code].players.some(p => deadlineFor(p) > now)) {
        delete saved[code]; // everyone's grace ran out while the server was down
        continue;
      }
      const room = reviveRoom(saved[code], this.makeRoom);
      for (const p of room.players) {
        this.roomOf.set(p.id, room.code);
        // Timer of 0 fires next tick, keeping expiry out of this loop.
        room.armGrace(p.id, Math.max(0, deadlineFor(p) - now));
      }
    }
    this.store.save();
  }
}

module.exports = { RoomPersistence };
