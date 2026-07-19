'use strict';

const crypto = require('crypto');

// Profiles, friend tags, friendships, presence. No accounts: identity is a
// device-persistent playerId paired with a device secret; the human-friendly
// handle is a tag like BRI#4821. The playerId is public (friends and roommates
// see it in payloads) — only the secret authenticates.
class Social {
  // statusOf lets the transport layer report where a player is ('lobby'|'match')
  // without Social knowing about rooms; null means plain 'online'.
  constructor(store, statusOf = () => null) {
    this.store = store;
    this.statusOf = statusOf;
    this.online = new Map(); // playerId -> ws
  }

  // Trust-on-first-use: the first device to present a secret binds it; after
  // that, a mismatched secret is an impersonation attempt and returns null.
  // Legacy profiles (no secret yet) bind whatever the next hello brings.
  register(id, name, secret = '') {
    const players = this.store.data.players;
    let p = players[id];
    if (p && p.secret && p.secret !== secret) return null;
    const cleanName = String(name || '').trim().slice(0, 20) || 'Player';
    if (!p) {
      p = players[id] = { id, name: cleanName, tag: this.makeTag(cleanName), createdAt: Date.now() };
    } else if (cleanName !== 'Player' || !p.name) {
      p.name = cleanName;
    }
    if (secret && !p.secret) p.secret = secret;
    p.lastSeen = Date.now();
    this.store.save();
    return p;
  }

  // Adopt a profile whose ownership was just proven by a link/recovery code —
  // no secret check here; the caller hands the stored secret to the device.
  adopt(id) {
    const p = this.get(id);
    if (!p) return null;
    p.lastSeen = Date.now();
    this.store.save();
    return p;
  }

  ensureSecret(id) {
    const p = this.get(id);
    if (!p) return null;
    if (!p.secret) {
      p.secret = crypto.randomBytes(24).toString('base64url');
      this.store.save();
    }
    return p.secret;
  }

  get(id) {
    return this.store.data.players[id] || null;
  }

  byTag(tag) {
    const want = String(tag || '').trim().toUpperCase();
    return Object.values(this.store.data.players).find(p => p.tag === want) || null;
  }

  // Renames update the tag prefix too, but only while nobody knows the old
  // tag (no friendships) — after that the tag is a stable identifier.
  rename(id, name) {
    const p = this.get(id);
    if (!p) return null;
    const cleanName = String(name || '').trim().slice(0, 20);
    if (!cleanName) return p;
    p.name = cleanName;
    const hasTies = this.store.data.friendships.some(f => f.from === id || f.to === id);
    if (!hasTies) p.tag = this.makeTag(cleanName);
    this.store.save();
    return p;
  }

  makeTag(name) {
    const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
    const base = (letters + 'XXX').slice(0, 3);
    for (;;) {
      const tag = `${base}#${1000 + Math.floor(Math.random() * 9000)}`;
      if (!this.byTag(tag)) return tag;
    }
  }

  findFriendship(a, b) {
    return this.store.data.friendships.find(
      f => (f.from === a && f.to === b) || (f.from === b && f.to === a)
    ) || null;
  }

  // Returns { ok, error?, friend?, autoAccepted? }
  addByTag(byId, tag) {
    const target = this.byTag(tag);
    if (!target) return { ok: false, error: 'No player with that tag.' };
    if (target.id === byId) return { ok: false, error: "That's your own tag." };
    const existing = this.findFriendship(byId, target.id);
    if (existing) {
      if (existing.status === 'accepted') return { ok: false, error: 'Already friends.' };
      if (existing.from === byId) return { ok: false, error: 'Request already sent.' };
      existing.status = 'accepted'; // they had already asked us — mutual intent
      this.store.save();
      return { ok: true, friend: target, autoAccepted: true };
    }
    this.store.data.friendships.push({ from: byId, to: target.id, status: 'pending', createdAt: Date.now() });
    this.store.save();
    return { ok: true, friend: target };
  }

  accept(byId, otherId) {
    const f = this.findFriendship(byId, otherId);
    if (!f || f.status !== 'pending' || f.to !== byId) return { ok: false, error: 'No pending request from that player.' };
    f.status = 'accepted';
    this.store.save();
    return { ok: true };
  }

  friendsOf(id) {
    const out = [];
    for (const f of this.store.data.friendships) {
      if (f.from !== id && f.to !== id) continue;
      const otherId = f.from === id ? f.to : f.from;
      const other = this.get(otherId);
      if (!other) continue;
      const status = f.status === 'accepted' ? 'accepted' : (f.from === id ? 'pending_out' : 'pending_in');
      const online = this.online.has(otherId);
      const presence = !online ? 'offline' : (this.statusOf(otherId) || 'online');
      out.push({ id: other.id, name: other.name, tag: other.tag, status, online, presence });
    }
    out.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    return out;
  }

  friendIdsOf(id) {
    return this.friendsOf(id).map(f => f.id);
  }

  // Bound store growth: anyone can mint profiles just by connecting, so idle
  // ones with nothing worth keeping (no friendships, no recovery code) are
  // dropped at startup. A pruned player who returns just re-registers.
  pruneStale(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const players = this.store.data.players;
    let removed = 0;
    for (const [id, p] of Object.entries(players)) {
      if ((p.lastSeen || p.createdAt || 0) > cutoff) continue;
      if (p.recoveryCode) continue;
      if (this.store.data.friendships.some(f => f.from === id || f.to === id)) continue;
      delete players[id];
      removed += 1;
    }
    if (removed) this.store.save();
    return removed;
  }

  // Drop a profile that never made a friend — used when a fresh device's
  // throwaway identity is replaced by a claimed one.
  discardIfUnused(id) {
    const hasTies = this.store.data.friendships.some(f => f.from === id || f.to === id);
    if (!hasTies) {
      delete this.store.data.players[id];
      this.store.save();
    }
  }
}

module.exports = Social;
