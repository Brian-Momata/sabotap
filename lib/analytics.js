'use strict';

const crypto = require('crypto');
const path = require('path');
const CONFIG = require('./config');
const Store = require('./store');

/*
 * Analytics sink: counts events into daily buckets and answers summary().
 *
 * Aggregate-only by design — there is no per-event log and no raw playerId on
 * disk (ids are salted-hashed, so the file cannot be walked back to a profile),
 * which keeps a friends-and-family game's telemetry from becoming a surveillance
 * record. Every map is capped so a buggy or hostile caller cannot grow the file
 * without bound, and buckets older than the retention window are dropped.
 *
 * The transport edge tracks its own events directly; game code goes through
 * lib/game/telemetry.js, which owns the gameplay taxonomy.
 *
 * This module owns its file path rather than taking it from server.js (the way
 * the other stores do): the domain reaches the sink as a singleton, so there is
 * no construction seam to inject through.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const OVERFLOW = 'other';

const epochDay = (at = Date.now()) => Math.floor(at / DAY_MS);
const dateOf = day => new Date(day * DAY_MS).toISOString().slice(0, 10);

// Counter increment with a cardinality cap: once a map is full, unseen keys
// collapse into a single 'other' bucket instead of growing the file forever.
function bump(map, key, n, cap) {
  if (map[key] === undefined && Object.keys(map).length >= cap) key = OVERFLOW;
  map[key] = (map[key] || 0) + n;
}

function emptyDay() {
  return { events: {}, dims: {}, stats: {}, uniq: {}, fresh: 0 };
}

class Analytics {
  constructor(file, opts) {
    this.opts = opts;
    this.enabled = opts.enabled;
    this.store = new Store(file, { salt: '', startedAt: Date.now(), days: {}, known: {} }, opts.saveDebounceMs);
    if (!this.store.data.salt) {
      // Per-install salt: hashes are stable here but meaningless anywhere else.
      this.store.data.salt = crypto.randomBytes(16).toString('hex');
      this.store.save();
    }
    this.prune();
  }

  hash(id) {
    return crypto.createHash('sha256')
      .update(this.store.data.salt + ':' + id)
      .digest('base64url')
      .slice(0, 12);
  }

  day(at) {
    const key = String(epochDay(at));
    const days = this.store.data.days;
    if (!days[key]) {
      days[key] = emptyDay();
      this.prune();
    }
    return days[key];
  }

  // Drop day buckets past the retention window, and evict the least recently
  // active known players once that map hits its cap.
  prune() {
    const days = this.store.data.days;
    const oldest = epochDay() - this.opts.retentionDays;
    for (const key of Object.keys(days)) if (Number(key) < oldest) delete days[key];

    const known = this.store.data.known;
    const ids = Object.keys(known);
    if (ids.length > this.opts.maxKnownPlayers) {
      ids.sort((a, b) => known[a][1] - known[b][1]);
      for (const id of ids.slice(0, ids.length - this.opts.maxKnownPlayers)) delete known[id];
    }
  }

  /*
   * One event. Props become dimensions (string/boolean: counted per value) or
   * running stats (finite numbers: n/sum/min/max), so a caller never has to
   * know which storage shape it is feeding. `n` counts a batch as one call.
   */
  track(name, props = {}, n = 1) {
    if (!this.enabled || n <= 0) return;
    const day = this.day();
    bump(day.events, name, n, this.opts.maxEventNames);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) continue;
        const stat = (day.stats[`${name}.${key}`] ||= { n: 0, sum: 0, min: value, max: value });
        stat.n += 1;
        stat.sum += value;
        stat.min = Math.min(stat.min, value);
        stat.max = Math.max(stat.max, value);
      } else {
        const dim = (day.dims[name] ||= {});
        const values = (dim[key] ||= {});
        bump(values, String(value).slice(0, 32), n, this.opts.maxDimValues);
      }
    }
    this.store.save();
  }

  /*
   * Record a player as active today. Returns whether this is the first time
   * this profile has ever been seen, which the caller tags its session with —
   * that single flag is what separates growth from repeat play.
   */
  seen(playerId) {
    if (!this.enabled || !playerId) return { isNew: false };
    const id = this.hash(playerId);
    const day = this.day();
    const today = epochDay();
    const known = this.store.data.known;
    const first = known[id] === undefined;
    if (first) {
      known[id] = [today, today];
      day.fresh += 1;
    } else {
      known[id][1] = today;
    }
    if (day.uniq[id] === undefined && Object.keys(day.uniq).length < this.opts.maxUniquesPerDay) {
      day.uniq[id] = 1;
    }
    this.store.save();
    return { isNew: first };
  }

  // Shutdown hook: the debounced write must not lose the last minutes of a
  // session when a redeploy stops the process.
  flush() { this.store.flush(); }

  // ---------- reporting ----------

  // Merge a set of day buckets into one aggregate (events, dims, stats).
  static merge(buckets) {
    const out = { events: {}, dims: {}, stats: {} };
    for (const day of buckets) {
      for (const [name, count] of Object.entries(day.events)) {
        out.events[name] = (out.events[name] || 0) + count;
      }
      for (const [name, dims] of Object.entries(day.dims)) {
        const target = (out.dims[name] ||= {});
        for (const [key, values] of Object.entries(dims)) {
          const bucket = (target[key] ||= {});
          for (const [value, count] of Object.entries(values)) bucket[value] = (bucket[value] || 0) + count;
        }
      }
      for (const [name, stat] of Object.entries(day.stats)) {
        const target = out.stats[name];
        if (!target) { out.stats[name] = { ...stat }; continue; }
        target.n += stat.n;
        target.sum += stat.sum;
        target.min = Math.min(target.min, stat.min);
        target.max = Math.max(target.max, stat.max);
      }
    }
    return out;
  }

  daysInRange(span) {
    const days = this.store.data.days;
    const from = epochDay() - span + 1;
    return Object.keys(days)
      .map(Number)
      .filter(day => day >= from)
      .sort((a, b) => a - b)
      .map(day => ({ day, bucket: days[day] }));
  }

  activeOver(span) {
    const ids = new Set();
    for (const { bucket } of this.daysInRange(span)) for (const id of Object.keys(bucket.uniq)) ids.add(id);
    return ids.size;
  }

  /*
   * The whole report in one object: a daily series for the shape of usage, a
   * merged aggregate for the composition of it, and player counts for reach.
   */
  summary(span = this.opts.reportDays) {
    const range = this.daysInRange(span);
    const known = this.store.data.known;
    const allTime = Object.keys(known);
    // "Returned" is deliberately the loosest useful definition — seen on any
    // later day than the first. With a handful of players a stricter D1/D7
    // cohort is mostly noise.
    const returned = allTime.filter(id => known[id][1] > known[id][0]).length;

    return {
      generatedAt: Date.now(),
      since: this.store.data.startedAt,
      spanDays: span,
      enabled: this.enabled,
      series: range.map(({ day, bucket }) => ({
        date: dateOf(day),
        active: Object.keys(bucket.uniq).length,
        fresh: bucket.fresh,
        sessions: bucket.events.session || 0,
        matches: bucket.events['match.start'] || 0,
        rounds: bucket.events['round.end'] || 0,
      })),
      players: {
        allTime: allTime.length,
        returned,
        returnRate: allTime.length ? returned / allTime.length : 0,
        activeToday: this.activeOver(1),
        active7d: this.activeOver(7),
        active30d: this.activeOver(30),
      },
      totals: Analytics.merge(range.map(r => r.bucket)),
    };
  }
}

const file = process.env.ANALYTICS_FILE || path.join(__dirname, '..', 'data', 'analytics.json');

module.exports = new Analytics(file, CONFIG.analytics);
module.exports.Analytics = Analytics;
