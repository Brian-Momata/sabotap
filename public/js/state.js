/* Identity, preferences, and the single mutable client state bag. */

export const LS = window.localStorage;
if (!LS.playerId) LS.playerId = 'p_' + crypto.randomUUID();

export const prefs = {
  get sound() { return LS.sound !== 'off'; },
  set sound(v) { LS.sound = v ? 'on' : 'off'; },
  get haptics() { return LS.haptics !== 'off'; },
  set haptics(v) { LS.haptics = v ? 'on' : 'off'; },
};

export const $ = id => document.getElementById(id);

export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export const state = {
  you: null,
  friends: [],
  room: null,        // last room message
  seat: null,
  matchSeat: 0,
  mode: 'versus',
  role: null,
  phase: 'home',
  round: 0,
  score: [0, 0],
  callerSeat: 0,
  grid: [],
  gridCols: 6,
  target: null,
  charges: 0,
  maxCharges: 3,
  sabotages: [],
  puzzleId: null,
  cooldowns: {},
  pendingInviteFriend: null,
  pendingJoinCode: null,
  rematchVotes: [null, null],
  opponent: null,
};
