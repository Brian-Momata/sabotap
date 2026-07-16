'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const CONFIG = require('./lib/config');
const Store = require('./lib/store');
const Social = require('./lib/social');
const { Room, makeRoomCode } = require('./lib/game');

const store = new Store(process.env.STORE_FILE || path.join(__dirname, 'data', 'store.json'));
const social = new Social(store);

const rooms = new Map(); // code -> Room
const roomOf = new Map(); // playerId -> code

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, online: social.online.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function destroyRoom(code) {
  const room = rooms.get(code);
  if (room) room.players.forEach(p => roomOf.delete(p.id));
  rooms.delete(code);
}

function createRoom() {
  let code;
  do { code = makeRoomCode(); } while (rooms.has(code));
  const room = new Room(code, destroyRoom);
  rooms.set(code, room);
  return room;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function pushFriends(playerId) {
  const ws = social.online.get(playerId);
  if (ws) send(ws, { t: 'friends', list: social.friendsOf(playerId) });
}

function notifyPresence(playerId) {
  // Refresh the friends list of everyone connected to this player.
  for (const id of social.friendIdsOf(playerId)) pushFriends(id);
}

function roomFor(playerId) {
  const code = roomOf.get(playerId);
  if (!code) return null;
  const room = rooms.get(code);
  if (!room || room.seatOf(playerId) === -1) {
    roomOf.delete(playerId);
    return null;
  }
  return room;
}

function leaveRoom(playerId) {
  const code = roomOf.get(playerId);
  if (!code) return;
  roomOf.delete(playerId);
  const room = rooms.get(code);
  if (room) room.removePlayer(playerId);
}

wss.on('connection', ws => {
  let me = null; // profile after hello

  const handlers = {
    hello(msg) {
      const id = String(msg.playerId || '').slice(0, 64);
      if (!id) return send(ws, { t: 'error', msg: 'hello requires playerId' });
      // A second connection for the same player replaces the first.
      const prev = social.online.get(id);
      if (prev && prev !== ws) { try { prev.close(); } catch {} }
      me = social.register(id, msg.name);
      social.online.set(id, ws);
      send(ws, {
        t: 'hello',
        you: { id: me.id, name: me.name, tag: me.tag },
        friends: social.friendsOf(id),
        config: {
          name: CONFIG.name,
          roundsToWinOptions: CONFIG.roundsToWinOptions,
          difficulties: Object.entries(CONFIG.difficulties).map(([key, d]) => ({ key, name: d.name, fuseMs: d.fuseMs })),
        },
      });
      notifyPresence(id);
      // Re-attach to a live seat if this device was mid-game.
      const room = roomFor(id);
      if (room) room.reconnect(id, ws);
    },

    setName(msg) {
      me = social.rename(me.id, msg.name) || me;
      send(ws, { t: 'hello', you: { id: me.id, name: me.name, tag: me.tag }, friends: social.friendsOf(me.id) });
      notifyPresence(me.id);
    },

    create() {
      leaveRoom(me.id);
      const room = createRoom();
      room.addPlayer({ id: me.id, name: me.name, tag: me.tag, ws });
      roomOf.set(me.id, room.code);
    },

    join(msg) {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: `Room ${code || '?'} not found.` });
      if (roomOf.get(me.id) === code && room.seatOf(me.id) !== -1) return room.reconnect(me.id, ws);
      leaveRoom(me.id);
      const res = room.addPlayer({ id: me.id, name: me.name, tag: me.tag, ws });
      if (!res.ok) return send(ws, { t: 'error', msg: res.error });
      roomOf.set(me.id, code);
    },

    leave() {
      leaveRoom(me.id);
      send(ws, { t: 'left' });
    },

    settings(msg) {
      const room = roomFor(me.id);
      if (room) room.setSettings(room.seatOf(me.id), msg);
    },

    start() {
      const room = roomFor(me.id);
      if (room) room.start(room.seatOf(me.id));
    },

    pick(msg) {
      const room = roomFor(me.id);
      if (room) room.onPick(room.seatOf(me.id), msg.index | 0);
    },

    tap(msg) {
      const room = roomFor(me.id);
      if (room) room.onTap(room.seatOf(me.id), msg.index | 0);
    },

    puzzle(msg) {
      const room = roomFor(me.id);
      if (room) room.onPuzzleAnswer(room.seatOf(me.id), msg.id | 0, msg.index | 0);
    },

    sabotage(msg) {
      const room = roomFor(me.id);
      if (room) room.onSabotage(room.seatOf(me.id), String(msg.kind || ''));
    },

    rematch() {
      const room = roomFor(me.id);
      if (room) room.rematch(room.seatOf(me.id));
    },

    friendAdd(msg) {
      const res = social.addByTag(me.id, msg.tag);
      if (!res.ok) return send(ws, { t: 'error', msg: res.error });
      pushFriends(me.id);
      pushFriends(res.friend.id);
      const theirWs = social.online.get(res.friend.id);
      if (theirWs && !res.autoAccepted) {
        send(theirWs, { t: 'friendRequest', from: { id: me.id, name: me.name, tag: me.tag } });
      }
      send(ws, { t: 'toast', msg: res.autoAccepted ? `You and ${res.friend.name} are now friends.` : `Request sent to ${res.friend.name}.` });
    },

    friendAccept(msg) {
      const res = social.accept(me.id, String(msg.id || ''));
      if (!res.ok) return send(ws, { t: 'error', msg: res.error });
      pushFriends(me.id);
      pushFriends(String(msg.id));
    },

    friendInvite(msg) {
      const room = roomFor(me.id);
      if (!room) return send(ws, { t: 'error', msg: 'Create a room first.' });
      const code = room.code;
      const friend = social.friendsOf(me.id).find(f => f.id === msg.id && f.status === 'accepted');
      if (!friend) return send(ws, { t: 'error', msg: 'Not in your friends list.' });
      const theirWs = social.online.get(friend.id);
      if (!theirWs) return send(ws, { t: 'error', msg: `${friend.name} is offline.` });
      send(theirWs, { t: 'invite', from: { id: me.id, name: me.name, tag: me.tag }, code });
      send(ws, { t: 'toast', msg: `Invite sent to ${friend.name}.` });
    },
  };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg !== 'object' || msg === null) return;
    if (msg.t !== 'hello' && !me) return send(ws, { t: 'error', msg: 'Say hello first.' });
    const handler = handlers[msg.t];
    if (!handler) return send(ws, { t: 'error', msg: `Unknown message: ${msg.t}` });
    try {
      handler(msg);
    } catch (e) {
      console.error('handler error:', msg.t, e);
      send(ws, { t: 'error', msg: 'Server error.' });
    }
  });

  ws.on('close', () => {
    if (!me) return;
    if (social.online.get(me.id) === ws) {
      social.online.delete(me.id);
      notifyPresence(me.id);
      const room = roomFor(me.id);
      if (room) room.handleDisconnect(me.id);
    }
  });
});

server.listen(CONFIG.port, () => {
  console.log(`${CONFIG.name} listening on http://localhost:${CONFIG.port}`);
});

process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });
