'use strict';

// Every playtesting variable lives here. Numeric values can be overridden via
// environment variables (used by the e2e test to shorten timings).
const num = (env, fallback) => (process.env[env] ? Number(process.env[env]) : fallback);

module.exports = {
  name: 'Sabotap',
  port: num('PORT', 3000),

  grid: { cols: 7, rows: 8 }, // 56 unique two-digit numbers

  // Match settings (host-adjustable in the lobby within these options)
  roundsToWin: 3,
  roundsToWinOptions: [2, 3, 5],

  // Difficulty bundles the jeopardy dials: fuse speed, puzzle speed, and how
  // early the puzzle's odd digit becomes a visual lookalike (0 = always).
  difficulties: {
    casual:  { name: 'Casual',  fuseMs: 24000, puzzleMs: 2600, confusableFrom: 0.5 },
    tense:   { name: 'Tense',   fuseMs: 16000, puzzleMs: 2000, confusableFrom: 0.25 },
    frantic: { name: 'Frantic', fuseMs: 10000, puzzleMs: 1500, confusableFrom: 0 },
  },
  defaultDifficulty: 'tense',
  // Env overrides (used by tests) trump the difficulty's values when set.
  fuseMsOverride: num('FUSE_MS', null),
  puzzleMsOverride: num('PUZZLE_TIME_MS', null),

  // Board themes ("maps"). Host-selectable in the lobby; 'rotation' cycles
  // through the playable boards round by round. Visual tunables ride along to
  // the client via the roundStart board payload. Atmosphere must never degrade
  // digit legibility — only earned sabotages may do that.
  boards: {
    standard: { name: 'Standard',        tagline: 'Pure speed' },
    mirrors:  { name: 'Hall of Mirrors', tagline: 'Twin numbers everywhere' },
    blackout: { name: 'Blackout',        tagline: 'Find in darkness', torchTiles: 2.2 },
    drift:    { name: 'Drift',           tagline: 'Rows on the move', periodMs: 5200, amplitudePct: 4.5 },
    glyphs:   { name: 'Glyphs',          tagline: 'Symbols, not numbers' },
    rotation: { name: 'Rotation',        tagline: 'New board every round' },
  },
  defaultBoard: 'standard',

  tournament: {
    minPlayers: 3,
    maxPlayers: 8,
    matchRounds: 2, // fixed per pairing so both players search once and durations stay predictable
    pairingDelayMs: num('PAIRING_DELAY_MS', 6000),
  },

  // Per-peer Opus cap for voice. Mesh topology uploads the mic once per peer,
  // so an 8-player waiting channel costs 7x this per phone — keep it modest.
  voice: {
    maxBps: num('VOICE_MAX_BPS', 24000),
  },

  fuseTickMs: num('FUSE_TICK_MS', 200),
  pickTimeoutMs: num('PICK_TIMEOUT_MS', 12000),
  maxCharges: 3,
  interRoundMs: num('INTER_ROUND_MS', 3500),
  reconnectGraceMs: num('RECONNECT_GRACE_MS', 30000),
  inviteTtlMs: num('INVITE_TTL_MS', 45000),

  // Device link/recovery codes (see lib/identity.js). staleProfileMs bounds
  // store growth: profiles with no friendships and no recovery code are
  // dropped at startup once idle this long.
  identity: {
    linkCodeTtlMs: num('LINK_CODE_TTL_MS', 600000),
    claimMaxAttempts: num('CLAIM_MAX_ATTEMPTS', 5),
    staleProfileMs: num('STALE_PROFILE_MS', 30 * 24 * 60 * 60 * 1000),
  },

  // Transport-edge abuse limits (see lib/limits.js). Bursts are generous —
  // they exist to stop floods and brute force, not to pace normal play.
  net: {
    maxPayloadBytes: num('WS_MAX_PAYLOAD_BYTES', 32 * 1024),
    // Burst must absorb a voice-mesh rebuild: rejoining a full 8-player
    // channel fires ~6 SDP offers plus trickle ICE (10-20 candidates per peer)
    // inside a second, and dropped signaling kills voice silently.
    msgBurst: num('WS_MSG_BURST', 300),          // per connection
    msgRefillPerSec: num('WS_MSG_PER_SEC', 40),
    connBurst: num('WS_CONN_BURST', 60),         // per IP
    connRefillPerSec: num('WS_CONN_PER_SEC', 0.5),
    failBurst: num('WS_FAIL_BURST', 20),         // per IP: claim + join misses
    failRefillPerSec: num('WS_FAIL_PER_SEC', 0.1),
    // Liveness. Half-open sockets (phone sleep, network switch) never fire
    // 'close' on their own — the server pings and terminates silent peers so
    // grace/forfeit can run, and clients ping/force-close so a frozen screen
    // recovers through the normal reconnect path instead of hanging forever.
    heartbeatMs: num('WS_HEARTBEAT_MS', 25000),      // server ping cadence; 2 misses = terminate
    clientPingMs: num('CLIENT_PING_MS', 10000),      // client pings when this quiet
    clientStaleMs: num('CLIENT_STALE_MS', 25000),    // client force-closes when this quiet
    trustProxy: process.env.TRUST_PROXY === '1',
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  },

  // Room persistence across server restarts (see lib/game/persistence.js).
  roomPersist: {
    debounceMs: num('ROOM_SAVE_DEBOUNCE_MS', 1000),
    autosaveMs: num('ROOM_AUTOSAVE_MS', 2000),
  },

  // No sabotage ever touches or highlights the target tile — that would
  // point the Searcher straight at it and defeat the purpose.
  sabotages: {
    blur:   { name: 'Blur',   detail: '1.5s fog',         durationMs: 1500, cooldownMs: 6000 },
    decoys: { name: 'Decoys', detail: '2 fake finds',     durationMs: 1500, count: 2, cooldownMs: 5000 },
    swap:   { name: 'Swap',   detail: 'swap 2 tiles, 3s', durationMs: 3000, cooldownMs: 6000 },
    zoom:   { name: 'Zoom',   detail: 'force scroll, 2s', durationMs: 2000, scale: 1.8, cooldownMs: 8000 },
    invert: { name: 'Invert', detail: 'flip colors, 1s',  durationMs: 1000, cooldownMs: 4000 },
  },
};
