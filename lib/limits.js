'use strict';

// Transport-edge abuse limits: token buckets keyed per IP plus a per-connection
// message bucket, and the WebSocket Origin check. Pure counting — no game or
// social knowledge lives here.

class BucketMap {
  constructor(burst, refillPerSec) {
    this.burst = burst;
    this.refillPerSec = refillPerSec;
    this.map = new Map(); // key -> { tokens, at }
  }

  take(key) {
    const now = Date.now();
    let b = this.map.get(key);
    if (!b) {
      b = { tokens: this.burst, at: now };
      this.map.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // Drop fully-refilled entries so the map stays bounded by *active* keys.
  sweep() {
    const now = Date.now();
    for (const [key, b] of this.map) {
      const tokens = b.tokens + ((now - b.at) / 1000) * this.refillPerSec;
      if (tokens >= this.burst) this.map.delete(key);
    }
  }
}

function tokenBucket(burst, refillPerSec) {
  let tokens = burst;
  let at = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - at) / 1000) * refillPerSec);
    at = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

class EdgeGuards {
  constructor(cfg) {
    this.cfg = cfg;
    this.conn = new BucketMap(cfg.connBurst, cfg.connRefillPerSec);
    // One failure budget per IP shared by claim misses and room-code misses,
    // so reconnecting can't reset brute-force counters.
    this.fail = new BucketMap(cfg.failBurst, cfg.failRefillPerSec);
    this.sweepTimer = setInterval(() => { this.conn.sweep(); this.fail.sweep(); }, 60000);
    this.sweepTimer.unref();
  }

  // Only trust X-Forwarded-For when the platform proxy sets it (TRUST_PROXY=1),
  // otherwise a client could spoof its way past per-IP buckets.
  ipOf(req) {
    if (this.cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  // Non-browser clients (tests, monitors) send no Origin and pass; browsers
  // must come from our own host unless ALLOWED_ORIGINS says otherwise.
  originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (this.cfg.allowedOrigins.length) return this.cfg.allowedOrigins.includes(origin);
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  takeConnection(ip) { return this.conn.take(ip); }
  spendFail(ip) { return this.fail.take(ip); }
  messageBucket() { return tokenBucket(this.cfg.msgBurst, this.cfg.msgRefillPerSec); }
  destroy() { clearInterval(this.sweepTimer); }
}

module.exports = { EdgeGuards };
