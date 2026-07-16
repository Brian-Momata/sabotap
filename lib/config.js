'use strict';

// Every playtesting variable lives here. Numeric values can be overridden via
// environment variables (used by the e2e test to shorten timings).
const num = (env, fallback) => (process.env[env] ? Number(process.env[env]) : fallback);

module.exports = {
  name: 'Sabotap',
  port: num('PORT', 3000),

  grid: { cols: 6, rows: 6 }, // 36 unique two-digit numbers

  // Match settings (host-adjustable in the lobby within these options)
  roundsToWin: 3,
  roundsToWinOptions: [2, 3, 5],
  fuseMs: num('FUSE_MS', 45000),
  fuseMsOptions: [30000, 45000, 60000],

  fuseTickMs: num('FUSE_TICK_MS', 200),
  pickTimeoutMs: num('PICK_TIMEOUT_MS', 12000),
  puzzleTimeMs: num('PUZZLE_TIME_MS', 4000),
  maxCharges: 3,
  interRoundMs: num('INTER_ROUND_MS', 3500),
  reconnectGraceMs: num('RECONNECT_GRACE_MS', 30000),

  sabotages: {
    blur:   { name: 'Blur',   detail: '1.5s fog',         durationMs: 1500 },
    decoys: { name: 'Decoys', detail: '2 fake finds',     durationMs: 1500, count: 2 },
    swap:   { name: 'Swap',   detail: 'swap 2 tiles, 3s', durationMs: 3000, targetChance: 0.25 },
    zoom:   { name: 'Zoom',   detail: 'force scroll, 2s', durationMs: 2000, scale: 1.8 },
    invert: { name: 'Invert', detail: 'flip colors, 1s',  durationMs: 1000 },
  },
};
