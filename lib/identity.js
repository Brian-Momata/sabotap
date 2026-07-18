'use strict';

const crypto = require('crypto');
const CONFIG = require('./config');

// Device transfer/recovery for the no-accounts identity model. The playerId in
// localStorage is the credential; these codes are two ways to hand it to a new
// device: a short-lived link code (minted from a signed-in device) and a
// long-lived recovery code the player saves somewhere. The alphabet omits
// lookalike characters (0/O, 1/I/L) because humans retype these.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

class Identity {
  constructor(social) {
    this.social = social;
    this.linkCodes = new Map(); // code -> { playerId, expiresAt }
  }

  issueLinkCode(playerId) {
    // One live code per player: re-requesting invalidates the previous one.
    for (const [code, v] of this.linkCodes) {
      if (v.playerId === playerId || v.expiresAt <= Date.now()) this.linkCodes.delete(code);
    }
    let code;
    do { code = randomCode(6); } while (this.linkCodes.has(code));
    this.linkCodes.set(code, { playerId, expiresAt: Date.now() + CONFIG.identity.linkCodeTtlMs });
    return { code, expiresInMs: CONFIG.identity.linkCodeTtlMs };
  }

  recoveryCodeOf(playerId) {
    const p = this.social.get(playerId);
    if (!p) return null;
    if (!p.recoveryCode) {
      p.recoveryCode = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
      this.social.store.save();
    }
    return p.recoveryCode;
  }

  // Accepts either code kind, tolerant of case/dashes/spaces. Link codes are
  // single-use even on a miss (an expired one is gone, not guessable again).
  resolve(rawCode) {
    const norm = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!norm) return null;
    const link = this.linkCodes.get(norm);
    if (link) {
      this.linkCodes.delete(norm);
      return link.expiresAt > Date.now() ? link.playerId : null;
    }
    const byRecovery = Object.values(this.social.store.data.players)
      .find(p => p.recoveryCode && p.recoveryCode.replace(/-/g, '') === norm);
    return byRecovery ? byRecovery.id : null;
  }
}

module.exports = Identity;
