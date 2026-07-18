'use strict';

// End-to-end test: spawns the server with shortened timings and drives two
// scripted WebSocket clients through a full match, friends flow, and reconnect.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 3111;
const ENV = {
  ...process.env,
  PORT: String(PORT),
  FUSE_MS: '3000',
  PICK_TIMEOUT_MS: '1500',
  PUZZLE_TIME_MS: '1200',
  INTER_ROUND_MS: '300',
  RECONNECT_GRACE_MS: '3000',
  PAIRING_DELAY_MS: '300',
  FUSE_TICK_MS: '100',
  LINK_CODE_TTL_MS: '1500',
  CLAIM_MAX_ATTEMPTS: '2',
  STORE_FILE: path.join(os.tmpdir(), `sabotap-test-store-${Date.now()}.json`),
  ROOMS_FILE: path.join(os.tmpdir(), `sabotap-test-rooms-${Date.now()}.json`),
  ROOM_AUTOSAVE_MS: '300',
  ROOM_SAVE_DEBOUNCE_MS: '50',
};

let passed = 0;
function assert(cond, label) {
  if (!cond) throw new Error('ASSERT FAILED: ' + label);
  passed += 1;
  console.log('  ok:', label);
}

class Client {
  constructor(label) {
    this.label = label;
    this.inbox = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', raw => {
        const msg = JSON.parse(raw);
        for (let i = 0; i < this.waiters.length; i++) {
          const w = this.waiters[i];
          if (w.match(msg)) {
            this.waiters.splice(i, 1);
            return w.resolve(msg);
          }
        }
        this.inbox.push(msg);
      });
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  // Resolve with the first message (past or future) matching type + predicate.
  waitFor(type, pred = () => true, timeoutMs = 8000) {
    const match = m => m.t === type && pred(m);
    const idx = this.inbox.findIndex(match);
    if (idx !== -1) return Promise.resolve(this.inbox.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.label}: timeout waiting for '${type}'. inbox: ${this.inbox.map(m => m.t).join(',')}`));
      }, timeoutMs);
      this.waiters.push({ match, resolve: m => { clearTimeout(timer); resolve(m); } });
    });
  }

  drain(type) {
    this.inbox = this.inbox.filter(m => m.t !== type);
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const oddIndex = tiles => tiles.findIndex(d => tiles.filter(x => x === d).length === 1);

async function playRoundAsSearcherWin(clients, seats, roundMsgAll) {
  // roundMsgAll: map seat -> roundStart msg. Caller picks index 3; searcher taps wrong then right.
  const callerSeat = roundMsgAll[0].callerSeat;
  const searcherSeat = 1 - callerSeat;
  const caller = clients[seats.indexOf(callerSeat)];
  const searcher = clients[seats.indexOf(searcherSeat)];
  assert(Array.isArray(roundMsgAll[callerSeat].grid), 'caller receives grid in pick phase');
  assert(roundMsgAll[searcherSeat].grid === undefined, 'searcher gets no grid during pick');
  caller.send({ t: 'pick', index: 3 });
  const liveS = await searcher.waitFor('live');
  const liveC = await caller.waitFor('live');
  assert(liveS.target === roundMsgAll[callerSeat].grid[3], 'target matches picked cell');
  assert(liveC.target === liveS.target, 'caller knows the target');
  assert(Array.isArray(liveS.grid) && liveS.grid.length === 56, 'searcher live grid has 56 cells');
  const ti = liveS.grid.indexOf(liveS.target);
  const wrongIdx = (ti + 1) % 56;
  searcher.send({ t: 'tap', index: wrongIdx });
  const wrong = await searcher.waitFor('wrong');
  assert(wrong.index === wrongIdx, 'wrong tap echoed with index');
  searcher.send({ t: 'tap', index: ti });
  const end = await searcher.waitFor('roundEnd');
  await caller.waitFor('roundEnd');
  assert(end.winnerSeat === searcherSeat && end.reason === 'found', 'searcher wins round on correct tap');
  return end;
}

async function startServer(cwd) {
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: ENV,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
    proc.on('exit', () => reject(new Error('server exited early')));
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });
  return proc;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sabotap-test-'));
  let server = await startServer(dataDir);

  // Graceful restart against the same store/rooms files, as a redeploy would.
  async function restartServer() {
    const exited = new Promise(r => server.once('exit', r));
    server.kill('SIGTERM');
    await exited;
    server = await startServer(dataDir);
  }

  const A = new Client('A');
  const B = new Client('B');

  try {
    // --- hello / identity ---
    await A.connect();
    await B.connect();
    A.send({ t: 'hello', playerId: 'test_a_' + Date.now(), name: 'Ann' });
    B.send({ t: 'hello', playerId: 'test_b_' + Date.now(), name: 'Bob' });
    const helloA = await A.waitFor('hello');
    const helloB = await B.waitFor('hello');
    assert(/^ANN#\d{4}$/.test(helloA.you.tag), 'Ann gets a friend tag');
    assert(Array.isArray(helloA.config.boards) && helloA.config.boards.some(b => b.key === 'glyphs'),
      'hello config lists board themes');
    const aId = helloA.you.id, bId = helloB.you.id;

    // --- room create/join + settings ---
    A.send({ t: 'create' });
    const roomA = await A.waitFor('room');
    assert(/^[A-Z]{3,4}-\d{2}$/.test(roomA.code), 'room code format');
    B.send({ t: 'join', code: roomA.code });
    await B.waitFor('room', m => m.players.length === 2);
    await A.waitFor('room', m => m.players.length === 2);
    A.send({ t: 'settings', roundsToWin: 2 });
    const upd = await B.waitFor('room', m => m.settings.roundsToWin === 2);
    assert(upd.settings.roundsToWin === 2, 'host settings propagate');
    A.send({ t: 'settings', difficulty: 'frantic' });
    const updD = await B.waitFor('room', m => m.settings.difficulty === 'frantic');
    assert(updD.settings.difficulty === 'frantic', 'difficulty setting propagates');
    B.send({ t: 'settings', roundsToWin: 5 });
    const err = await B.waitFor('error');
    assert(/host/i.test(err.msg), 'non-host cannot change settings');

    // --- ready gate: only the host starts, and only once the guest is ready ---
    B.send({ t: 'start' });
    const errGuest = await B.waitFor('error');
    assert(/host/i.test(errGuest.msg), 'guest cannot start the match');
    A.send({ t: 'start' });
    const errNotReady = await A.waitFor('error');
    assert(/ready/i.test(errNotReady.msg), 'host blocked until guest is ready');
    B.send({ t: 'ready', ready: true });
    const readyUpd = await A.waitFor('room', m => m.players.some(p => p.seat === 1 && p.ready));
    assert(readyUpd.players.find(p => p.seat === 1).ready === true, 'guest ready state propagates');

    // --- round 1: searcher finds target ---
    A.send({ t: 'start' });
    const r1A = await A.waitFor('roundStart');
    const r1B = await B.waitFor('roundStart');
    assert(r1A.round === 1 && r1B.round === 1, 'round 1 starts for both');
    const bySeat1 = {};
    bySeat1[roomA.you] = r1A; // A's seat is 0 (creator)
    bySeat1[1 - roomA.you] = r1B;
    const clients = [A, B];
    const seats = [0, 1];
    const end1 = await playRoundAsSearcherWin(clients, seats, bySeat1);
    const r1Caller = r1A.callerSeat;

    // --- round 2: roles swap; pick timeout; puzzle -> charges -> all sabotages; fuse expiry ---
    const r2A = await A.waitFor('roundStart', m => m.round === 2);
    const r2B = await B.waitFor('roundStart', m => m.round === 2);
    assert(r2A.callerSeat === 1 - r1Caller, 'roles swap between rounds');
    const caller2 = r2A.callerSeat === 0 ? A : B;
    const searcher2 = r2A.callerSeat === 0 ? B : A;
    // let the pick time out
    const live2S = await searcher2.waitFor('live', () => true, 4000);
    assert(typeof live2S.target === 'number', 'pick timeout auto-selects a target');
    await caller2.waitFor('live');

    // solve puzzles to bank charges
    caller2.drain('puzzle');
    for (let want = 1; want <= 3; want++) {
      const pz = await caller2.waitFor('puzzle');
      caller2.send({ t: 'puzzle', id: pz.id, index: oddIndex(pz.tiles) });
      const ch = await caller2.waitFor('charges', m => m.n === want, 4000);
      assert(ch.n === want, `charge ${want} banked`);
    }

    // fire blur, then blur again (cooldown), then decoys, swap
    caller2.send({ t: 'sabotage', kind: 'blur' });
    const sabBlur = await searcher2.waitFor('sabotage', m => m.kind === 'blur');
    assert(sabBlur.durationMs > 0, 'blur sabotage lands on searcher');
    caller2.send({ t: 'sabotage', kind: 'blur' });
    const cooldownErr = await caller2.waitFor('error');
    assert(/recharging/i.test(cooldownErr.msg), 'repeat blur blocked by cooldown');
    caller2.send({ t: 'sabotage', kind: 'decoys' });
    const sabDec = await searcher2.waitFor('sabotage', m => m.kind === 'decoys');
    assert(sabDec.indices.length === 2 && sabDec.indices.every(i => live2S.grid[i] !== live2S.target), 'decoys never on target');
    const targetIdx2 = live2S.grid.indexOf(live2S.target);
    caller2.send({ t: 'sabotage', kind: 'swap' });
    const sabSwap = await searcher2.waitFor('sabotage', m => m.kind === 'swap');
    assert(sabSwap.a !== sabSwap.b, 'swap has two distinct indices');
    assert(sabSwap.a !== targetIdx2 && sabSwap.b !== targetIdx2, 'swap never moves the target');
    caller2.send({ t: 'sabotage', kind: 'zoom' });
    const noCharge = await caller2.waitFor('error');
    assert(/no charges/i.test(noCharge.msg), 'sabotage blocked without charges');

    // swap adjudication: track shown layout client-side, tap the target's current cell
    const shown = [...live2S.grid];
    [shown[sabSwap.a], shown[sabSwap.b]] = [shown[sabSwap.b], shown[sabSwap.a]];
    // fuse (3s) should expire before we tap — wait for it instead of racing:
    const end2 = await searcher2.waitFor('roundEnd', () => true, 8000);
    assert(end2.reason === 'fuse' && end2.winnerSeat === r2A.callerSeat, 'fuse expiry gives caller the round');
    await caller2.waitFor('roundEnd');

    // Round 1's searcher IS round 2's caller, so that seat now has 2 wins → match over.
    assert(end2.matchOver === true, 'second win ends the match at first-to-2');
    const matchA = await A.waitFor('matchEnd');
    await B.waitFor('matchEnd');
    assert(matchA.winnerSeat === end2.winnerSeat, 'match winner is the seat with 2 wins');
    assert(matchA.score.reduce((s, x) => s + x) === 2 && matchA.history.length === 2, 'match score and history complete');
    assert(matchA.log.length > 0, 'activity log delivered at match end');

    // --- rematch ---
    A.send({ t: 'rematch' });
    await B.waitFor('rematchStatus', m => m.votes.filter(Boolean).length === 1);
    B.send({ t: 'rematch' });
    const rrA = await A.waitFor('roundStart', m => m.round === 1);
    assert(rrA.round === 1 && rrA.score[0] === 0 && rrA.score[1] === 0, 'rematch resets to round 1, 0–0');

    // --- reconnect mid-round ---
    const rrB = await B.waitFor('roundStart', m => m.round === 1);
    const callerR = rrA.callerSeat === (roomA.you) ? A : B; // seat->client: A is seat roomA.you
    const rrCallerMsg = rrA.callerSeat === roomA.you ? rrA : rrB;
    const searcherR = callerR === A ? B : A;
    callerR.send({ t: 'pick', index: 0 });
    await searcherR.waitFor('live');
    await callerR.waitFor('live');
    // searcher drops and comes back
    const searcherId = searcherR === A ? aId : bId;
    searcherR.close();
    await callerR.waitFor('opponentStatus', m => m.connected === false);
    const S2 = new Client('S2');
    await S2.connect();
    S2.send({ t: 'hello', playerId: searcherId, name: 'Rejoined' });
    await S2.waitFor('hello');
    const snap = await S2.waitFor('resume');
    assert(snap.match && snap.match.phase === 'live' && Array.isArray(snap.match.grid) && typeof snap.match.target === 'number',
      'reconnect resumes live round with grid + target');
    assert(snap.match.board && snap.match.board.key === 'standard', 'snapshot carries the round board');
    await callerR.waitFor('opponentStatus', m => m.connected === true);
    const ti = snap.match.grid.indexOf(snap.match.target);
    S2.send({ t: 'tap', index: ti });
    await S2.waitFor('roundEnd', m => m.reason === 'found');
    assert(true, 'resumed client can finish the round');

    // --- friends: add by tag, accept, presence, invite ---
    const C = new Client('C');
    const D = new Client('D');
    await C.connect();
    await D.connect();
    C.send({ t: 'hello', playerId: 'test_c_' + Date.now(), name: 'Cy' });
    D.send({ t: 'hello', playerId: 'test_d_' + Date.now(), name: 'Dee' });
    const helloC = await C.waitFor('hello');
    const helloD = await D.waitFor('hello');
    C.send({ t: 'friendAdd', tag: helloD.you.tag });
    const req = await D.waitFor('friendRequest');
    assert(req.from.tag === helloC.you.tag, 'friend request delivered with tag');
    D.send({ t: 'friendAccept', id: helloC.you.id });
    const flC = await C.waitFor('friends', m => m.list.some(f => f.status === 'accepted'));
    assert(flC.list.find(f => f.id === helloD.you.id).online === true, 'friend shows online presence');
    C.send({ t: 'create' });
    const roomC = await C.waitFor('room');
    await D.waitFor('friends', m => m.list.some(f => f.id === helloC.you.id && f.presence === 'lobby'));
    assert(true, 'friend presence shows in-lobby after room create');
    C.send({ t: 'friendInvite', id: helloD.you.id });
    const invite = await D.waitFor('invite');
    assert(invite.code === roomC.code && invite.from.name === 'Cy', 'friend invite carries room code');
    assert(invite.ttlMs > 0, 'invite carries an expiry ttl');
    D.send({ t: 'inviteDecline', id: helloC.you.id });
    const declined = await C.waitFor('inviteDeclined');
    assert(declined.from.name === 'Dee', 'invite decline is relayed to the inviter');
    C.send({ t: 'friendInvite', id: helloD.you.id });
    const invite2 = await D.waitFor('invite');
    D.send({ t: 'join', code: invite2.code });
    await D.waitFor('room', m => m.players.length === 2);
    assert(true, 'invitee joined via invite');

    // A third friend observes in-match presence once C's room starts playing.
    const E = new Client('E');
    await E.connect();
    E.send({ t: 'hello', playerId: 'test_e_' + Date.now(), name: 'Eve' });
    const helloE = await E.waitFor('hello');
    C.send({ t: 'friendAdd', tag: helloE.you.tag });
    await E.waitFor('friendRequest');
    E.send({ t: 'friendAccept', id: helloC.you.id });
    await C.waitFor('friends', m => m.list.some(f => f.id === helloE.you.id && f.status === 'accepted'));
    D.send({ t: 'ready', ready: true });
    await C.waitFor('room', m => m.players.some(p => p.seat === 1 && p.ready));
    C.send({ t: 'start' });
    await E.waitFor('friends', m => m.list.some(f => f.id === helloC.you.id && f.presence === 'match'));
    assert(true, 'friend presence shows in-match after the room starts');
    E.close();

    C.close(); D.close(); S2.close();

    // --- identity: link + recovery codes, claim, lockout, expiry ---
    const X = new Client('X');
    await X.connect();
    X.send({ t: 'hello', playerId: 'test_x_' + Date.now(), name: 'Xan' });
    const helloX = await X.waitFor('hello');
    X.send({ t: 'linkCodeGet' });
    const lc = await X.waitFor('linkCode');
    assert(typeof lc.code === 'string' && lc.code.length === 6 && lc.expiresInMs > 0, 'link code issued with a ttl');
    X.send({ t: 'recoveryCodeGet' });
    const rc1 = await X.waitFor('recoveryCode');
    X.send({ t: 'recoveryCodeGet' });
    const rc2 = await X.waitFor('recoveryCode');
    assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rc1.code) && rc1.code === rc2.code, 'recovery code is stable across requests');

    const Y = new Client('Y');
    await Y.connect();
    Y.send({ t: 'hello', playerId: 'test_y_' + Date.now(), name: 'Yara' });
    await Y.waitFor('hello');
    Y.send({ t: 'claim', code: lc.code });
    const claimed = await Y.waitFor('claimed');
    assert(claimed.you.id === helloX.you.id && claimed.you.tag === helloX.you.tag, 'link-code claim adopts the profile');
    Y.send({ t: 'claim', code: lc.code });
    const reuse = await Y.waitFor('error');
    assert(/invalid|expired/i.test(reuse.msg), 'link code is single-use');

    const Z = new Client('Z');
    await Z.connect();
    Z.send({ t: 'hello', playerId: 'test_z_' + Date.now(), name: 'Zed' });
    await Z.waitFor('hello');
    Z.send({ t: 'claim', code: rc1.code.toLowerCase() });
    const claimed2 = await Z.waitFor('claimed');
    assert(claimed2.you.id === helloX.you.id, 'recovery-code claim restores the profile (case-insensitive)');

    const W = new Client('W');
    await W.connect();
    W.send({ t: 'hello', playerId: 'test_w_' + Date.now(), name: 'Wyn' });
    await W.waitFor('hello');
    W.send({ t: 'claim', code: 'NOPE99' });
    await W.waitFor('error', m => /invalid/i.test(m.msg));
    W.send({ t: 'claim', code: 'NOPE98' });
    await W.waitFor('error', m => /invalid/i.test(m.msg));
    W.send({ t: 'claim', code: rc1.code });
    await W.waitFor('error', m => /too many/i.test(m.msg));
    assert(true, 'claim attempts are limited per connection');

    Z.send({ t: 'linkCodeGet' });
    const lcExp = await Z.waitFor('linkCode');
    await sleep(Number(ENV.LINK_CODE_TTL_MS) + 300);
    const Q = new Client('Q');
    await Q.connect();
    Q.send({ t: 'hello', playerId: 'test_q_' + Date.now(), name: 'Quo' });
    await Q.waitFor('hello');
    Q.send({ t: 'claim', code: lcExp.code });
    const expired = await Q.waitFor('error');
    assert(/invalid|expired/i.test(expired.msg), 'expired link code is rejected');
    X.close(); Y.close(); Z.close(); W.close(); Q.close();

    // --- identity: claiming mid-match resumes the seat on the new device ---
    const M1 = new Client('M1');
    const M2 = new Client('M2');
    await M1.connect();
    await M2.connect();
    M1.send({ t: 'hello', playerId: 'test_m1_' + Date.now(), name: 'Mia' });
    M2.send({ t: 'hello', playerId: 'test_m2_' + Date.now(), name: 'Moe' });
    await M1.waitFor('hello');
    const hm2 = await M2.waitFor('hello');
    M1.send({ t: 'create' });
    const mroom = await M1.waitFor('room');
    M2.send({ t: 'join', code: mroom.code });
    await M1.waitFor('room', m => m.players.length === 2);
    M2.send({ t: 'ready', ready: true });
    await M1.waitFor('room', m => m.players.some(p => p.seat === 1 && p.ready));
    M1.send({ t: 'start' });
    const mrs1 = await M1.waitFor('roundStart');
    await M2.waitFor('roundStart');
    (mrs1.callerSeat === 0 ? M1 : M2).send({ t: 'pick', index: 2 });
    await M1.waitFor('live');
    await M2.waitFor('live');
    M2.send({ t: 'linkCodeGet' });
    const mlc = await M2.waitFor('linkCode');
    const M3 = new Client('M3');
    await M3.connect();
    M3.send({ t: 'hello', playerId: 'test_m3_' + Date.now(), name: 'New Phone' });
    await M3.waitFor('hello');
    M3.send({ t: 'claim', code: mlc.code });
    await M3.waitFor('claimed', m => m.you.id === hm2.you.id);
    const mresume = await M3.waitFor('resume');
    assert(mresume.match && mresume.match.phase === 'live', 'claiming mid-match resumes the seat on the new device');
    M1.close(); M2.close(); M3.close();

    // --- tournament: 3 players, round-robin with byes ---
    const T = [new Client('T1'), new Client('T2'), new Client('T3')];
    await Promise.all(T.map(c => c.connect()));
    const names = ['Tia', 'Uma', 'Vic'];
    T.forEach((c, i) => c.send({ t: 'hello', playerId: `test_t${i}_` + Date.now(), name: names[i] }));
    await Promise.all(T.map(c => c.waitFor('hello')));
    T[0].send({ t: 'create' });
    const troom = await T[0].waitFor('room');
    T[0].send({ t: 'settings', mode: 'tournament' });
    await T[0].waitFor('room', m => m.settings.mode === 'tournament');
    T[1].send({ t: 'join', code: troom.code });
    T[2].send({ t: 'join', code: troom.code });
    await T[0].waitFor('room', m => m.players.length === 3);
    assert(true, 'three players join a tournament room');
    T[0].send({ t: 'start' });
    const errT = await T[0].waitFor('error');
    assert(/ready/i.test(errT.msg), 'tournament blocked until everyone is ready');
    T[1].send({ t: 'ready', ready: true });
    T[2].send({ t: 'ready', ready: true });
    await T[0].waitFor('room', m => m.players.filter(p => p.ready).length === 3);
    T[0].send({ t: 'start' });

    // circle method for 3: byes are seat 0, then 1, then 2
    const byeOrder = [0, 1, 2];
    const seenPairs = new Set();

    async function playTournMatch(c1, c2) {
      for (let r = 1; r <= 2; r++) {
        const rs1 = await c1.waitFor('roundStart', m => m.round === r, 10000);
        await c2.waitFor('roundStart', m => m.round === r, 10000);
        const caller = rs1.role === 'caller' ? c1 : c2;
        const searcher = caller === c1 ? c2 : c1;
        caller.send({ t: 'pick', index: 0 });
        const live = await searcher.waitFor('live');
        await caller.waitFor('live');
        searcher.send({ t: 'tap', index: live.grid.indexOf(live.target) });
        await c1.waitFor('roundEnd', m => m.history.length === r);
        await c2.waitFor('roundEnd', m => m.history.length === r);
      }
    }

    for (let stage = 1; stage <= 3; stage++) {
      const byeSeat = byeOrder[stage - 1];
      const byeMsg = await T[byeSeat].waitFor('tWaiting', m => m.reason === 'bye' && m.stage === stage, 15000);
      assert(byeMsg.stages === 3 && Array.isArray(byeMsg.standings), `stage ${stage}: bye player gets waiting screen with standings`);
      const playing = [0, 1, 2].filter(s => s !== byeSeat);
      const p1 = await T[playing[0]].waitFor('tPairing', m => m.stage === stage, 15000);
      const p2 = await T[playing[1]].waitFor('tPairing', m => m.stage === stage, 15000);
      assert(p1.opponent.name === names[playing[1]] && p2.opponent.name === names[playing[0]],
        `stage ${stage}: pairings name the right opponents`);
      assert(typeof p1.you.rank === 'number' && typeof p1.opponent.points === 'number',
        `stage ${stage}: pairing carries rank and points`);
      seenPairs.add(playing.slice().sort().join('-'));
      await playTournMatch(T[playing[0]], T[playing[1]]);
      if (stage < 3) {
        await T[playing[0]].waitFor('tWaiting', m => m.reason === 'finished' && m.stage === stage, 10000);
        await T[playing[1]].waitFor('tWaiting', m => m.reason === 'finished' && m.stage === stage, 10000);
      }
    }
    assert(seenPairs.size === 3 && seenPairs.has('0-1') && seenPairs.has('0-2') && seenPairs.has('1-2'),
      'everyone played everyone exactly once');

    const tEnds = await Promise.all(T.map(c => c.waitFor('tEnd', () => true, 15000)));
    const lb = tEnds[0].leaderboard;
    assert(lb.length === 3, 'leaderboard lists all three players');
    assert(lb.reduce((s, r) => s + r.points, 0) === 6, 'leaderboard points sum to total rounds played');
    assert(lb.every(r => r.played === 2), 'everyone played two matches');
    assert(lb.every(r => r.points === 2 && r.rank === 1), 'all-searchers-win yields a three-way tie at rank 1');

    T.forEach(c => c.close());

    // --- voice chat signaling ---
    const V1 = new Client('V1');
    const V2 = new Client('V2');
    await V1.connect();
    await V2.connect();
    V1.send({ t: 'hello', playerId: 'test_v1_' + Date.now(), name: 'Pia' });
    V2.send({ t: 'hello', playerId: 'test_v2_' + Date.now(), name: 'Quin' });
    const hv1 = await V1.waitFor('hello');
    const hv2 = await V2.waitFor('hello');
    assert(Array.isArray(hv1.config.iceServers) && hv1.config.iceServers.length > 0, 'hello ships ICE servers');
    V1.send({ t: 'create' });
    const vroom = await V1.waitFor('room');
    V2.send({ t: 'join', code: vroom.code });
    await V1.waitFor('room', m => m.players.length === 2);
    V1.send({ t: 'voiceJoin' });
    const vs1 = await V2.waitFor('voiceState', m => m.members.length === 1);
    assert(vs1.members[0].name === 'Pia' && vs1.members[0].muted === false, 'voice join broadcast to the room');
    V2.send({ t: 'voiceJoin' });
    const vsBoth = await V1.waitFor('voiceState', m => m.members.length === 2);
    assert(Array.isArray(vsBoth.peers) && vsBoth.peers.length === 1 && vsBoth.peers[0] === hv2.you.id,
      'voiceState names the peers you may connect to');
    V1.send({ t: 'rtc', to: hv2.you.id, data: { sdp: { type: 'offer', sdp: 'x' } } });
    const relay = await V2.waitFor('rtc');
    assert(relay.from === hv1.you.id && relay.data.sdp.type === 'offer', 'rtc signaling relayed between voice members');
    V1.send({ t: 'voiceMute', muted: true });
    const vsMute = await V2.waitFor('voiceState', m => m.members.some(x => x.muted));
    assert(vsMute.members.find(x => x.id === hv1.you.id).muted === true, 'mute state broadcast');
    V2.send({ t: 'voiceLeave' });
    const vsLeave = await V1.waitFor('voiceState', m => m.members.length === 1);
    assert(vsLeave.members[0].id === hv1.you.id, 'voice leave removes member');
    V1.close(); V2.close();

    // --- voice scoping: whole room in the lobby, match pairs during play ---
    const U = [new Client('U1'), new Client('U2'), new Client('U3')];
    await Promise.all(U.map(c => c.connect()));
    U.forEach((c, i) => c.send({ t: 'hello', playerId: `test_u${i}_` + Date.now(), name: 'U' + (i + 1) }));
    const hu = await Promise.all(U.map(c => c.waitFor('hello')));
    const uid = hu.map(h => h.you.id);
    U[0].send({ t: 'create' });
    const uroom = await U[0].waitFor('room');
    U[0].send({ t: 'settings', mode: 'tournament' });
    await U[0].waitFor('room', m => m.settings.mode === 'tournament');
    U[1].send({ t: 'join', code: uroom.code });
    await U[1].waitFor('room');
    U[2].send({ t: 'join', code: uroom.code });
    await U[0].waitFor('room', m => m.players.length === 3);
    U.forEach(c => c.send({ t: 'voiceJoin' }));
    const vsAll = await U[0].waitFor('voiceState', m => m.members.length === 3);
    assert(vsAll.peers.length === 2 && !vsAll.peers.includes(uid[0]), 'lobby voice channel spans the whole room');
    U[1].send({ t: 'ready', ready: true });
    U[2].send({ t: 'ready', ready: true });
    await U[0].waitFor('room', m => m.players.filter(p => p.ready).length === 3);
    U.forEach(c => c.drain('voiceState'));
    U[0].send({ t: 'start' });
    // stage 1 of the 3-player round-robin: seat 0 sits out, seats 1 & 2 play
    const vsPair = await U[1].waitFor('voiceState', m => m.peers.length === 1, 10000);
    assert(vsPair.peers[0] === uid[2], 'in-game voice narrows to your match opponent');
    const vsBye = await U[0].waitFor('voiceState', m => m.peers.length === 0, 10000);
    assert(vsBye.members.length === 3, 'sitting player still sees who is in voice but talks to no one');
    // relay enforcement: cross-group rtc is dropped, in-pair rtc flows
    U[0].send({ t: 'rtc', to: uid[1], data: { sdp: { type: 'offer', sdp: 'blocked' } } });
    await sleep(150);
    U[2].send({ t: 'rtc', to: uid[1], data: { sdp: { type: 'offer', sdp: 'paired' } } });
    const relayed = await U[1].waitFor('rtc');
    assert(relayed.from === uid[2] && relayed.data.sdp.sdp === 'paired', 'rtc relay only flows inside your voice group');
    U.forEach(c => c.close());

    // --- board themes: glyphs round end-to-end ---
    const G = new Client('G');
    const H = new Client('H');
    await G.connect();
    await H.connect();
    G.send({ t: 'hello', playerId: 'test_g_' + Date.now(), name: 'Gia' });
    H.send({ t: 'hello', playerId: 'test_h_' + Date.now(), name: 'Hal' });
    await G.waitFor('hello');
    await H.waitFor('hello');
    G.send({ t: 'create' });
    const groom = await G.waitFor('room');
    H.send({ t: 'join', code: groom.code });
    await G.waitFor('room', m => m.players.length === 2);
    G.send({ t: 'settings', board: 'glyphs' });
    const gset = await H.waitFor('room', m => m.settings.board === 'glyphs');
    assert(gset.settings.board === 'glyphs', 'board setting propagates to the room');
    H.drain('room');
    G.send({ t: 'settings', board: 'colossus' });
    const gbad = await H.waitFor('room');
    assert(gbad.settings.board === 'glyphs', 'unknown board key is ignored');
    H.send({ t: 'ready', ready: true });
    await G.waitFor('room', m => m.players.some(p => p.seat === 1 && p.ready));
    G.send({ t: 'start' });
    const grsG = await G.waitFor('roundStart');
    const grsH = await H.waitFor('roundStart');
    assert(grsG.board && grsG.board.key === 'glyphs' && grsG.board.name === 'Glyphs',
      'roundStart announces the glyphs board');
    const gCaller = grsG.callerSeat === 0 ? G : H; // G created the room, so G is seat 0
    const gSearcher = gCaller === G ? H : G;
    const pickGrid = (gCaller === G ? grsG : grsH).grid;
    assert(pickGrid.length === 56 && new Set(pickGrid).size === 56 && pickGrid.every(v => typeof v === 'string' && isNaN(Number(v))),
      'glyphs grid is 56 unique symbols');
    gCaller.send({ t: 'pick', index: 7 });
    const gliveS = await gSearcher.waitFor('live');
    await gCaller.waitFor('live');
    assert(typeof gliveS.target === 'string' && gliveS.grid.includes(gliveS.target), 'glyph target is a symbol on the grid');
    gCaller.drain('puzzle');
    const gpz = await gCaller.waitFor('puzzle');
    assert(gpz.tiles.length === 5 && gpz.tiles.every(v => typeof v === 'string'), 'caller puzzle is glyph odd-one-out');
    gCaller.send({ t: 'puzzle', id: gpz.id, index: oddIndex(gpz.tiles) });
    await gCaller.waitFor('charges', m => m.n === 1, 4000);
    assert(true, 'glyph puzzle solve banks a charge');
    gSearcher.send({ t: 'tap', index: gliveS.grid.indexOf(gliveS.target) });
    const gend = await gSearcher.waitFor('roundEnd');
    assert(gend.reason === 'found' && gend.target === gliveS.target, 'glyph round resolves on the tapped symbol');
    G.close(); H.close();

    // --- board themes: rotation cycles boards round by round ---
    const R1 = new Client('R1');
    const R2 = new Client('R2');
    await R1.connect();
    await R2.connect();
    R1.send({ t: 'hello', playerId: 'test_r1_' + Date.now(), name: 'Rex' });
    R2.send({ t: 'hello', playerId: 'test_r2_' + Date.now(), name: 'Sky' });
    await R1.waitFor('hello');
    await R2.waitFor('hello');
    R1.send({ t: 'create' });
    const rroom = await R1.waitFor('room');
    R2.send({ t: 'join', code: rroom.code });
    await R1.waitFor('room', m => m.players.length === 2);
    R1.send({ t: 'settings', board: 'rotation', roundsToWin: 2 });
    await R2.waitFor('room', m => m.settings.board === 'rotation');
    R2.send({ t: 'ready', ready: true });
    await R1.waitFor('room', m => m.players.some(p => p.seat === 1 && p.ready));
    R1.send({ t: 'start' });
    const rot1 = await R1.waitFor('roundStart', m => m.round === 1);
    await R2.waitFor('roundStart', m => m.round === 1);
    assert(rot1.board.key === 'standard', 'rotation round 1 plays the standard board');
    const rCaller1 = rot1.callerSeat === 0 ? R1 : R2;
    const rSearcher1 = rCaller1 === R1 ? R2 : R1;
    rCaller1.send({ t: 'pick', index: 0 });
    const rlive1 = await rSearcher1.waitFor('live');
    await rCaller1.waitFor('live');
    rSearcher1.send({ t: 'tap', index: rlive1.grid.indexOf(rlive1.target) });
    await R1.waitFor('roundEnd');
    await R2.waitFor('roundEnd');
    const rot2a = await R1.waitFor('roundStart', m => m.round === 2, 5000);
    const rot2b = await R2.waitFor('roundStart', m => m.round === 2, 5000);
    assert(rot2a.board.key === 'mirrors', 'rotation round 2 advances to hall of mirrors');
    const mirrorsGrid2 = (rot2a.role === 'caller' ? rot2a : rot2b).grid;
    assert(mirrorsGrid2.length === 56 && new Set(mirrorsGrid2).size === 56 && mirrorsGrid2.every(v => typeof v === 'number'),
      'mirrors grid stays 56 unique numbers');
    R1.close(); R2.close();

    // --- room persistence: mid-round server restart, full restore ---
    const P1 = new Client('P1');
    const P2 = new Client('P2');
    await P1.connect();
    await P2.connect();
    const p1Id = 'test_p1_' + Date.now();
    const p2Id = 'test_p2_' + Date.now();
    P1.send({ t: 'hello', playerId: p1Id, name: 'Poe' });
    P2.send({ t: 'hello', playerId: p2Id, name: 'Quill' });
    await P1.waitFor('hello');
    await P2.waitFor('hello');
    P1.send({ t: 'create' });
    const proom = await P1.waitFor('room');
    P2.send({ t: 'join', code: proom.code });
    await P1.waitFor('room', m => m.players.length === 2);
    P2.send({ t: 'ready', ready: true });
    await P1.waitFor('room', m => m.players.some(p => p.seat === 1 && p.ready));
    P1.send({ t: 'start' });
    const prs = await P1.waitFor('roundStart');
    const prs2 = await P2.waitFor('roundStart');
    await playRoundAsSearcherWin([P1, P2], [0, 1], { [prs.you]: prs, [prs2.you]: prs2 });
    const r1Winner = 1 - prs.callerSeat; // searcher won round 1
    const pr2a = await P1.waitFor('roundStart', m => m.round === 2);
    await P2.waitFor('roundStart', m => m.round === 2);
    const pCaller = pr2a.callerSeat === 0 ? P1 : P2;
    const pSearcher = pCaller === P1 ? P2 : P1;
    pCaller.send({ t: 'pick', index: 5 });
    const plive = await pSearcher.waitFor('live');
    await pCaller.waitFor('live');
    await restartServer();
    const P1b = new Client('P1b');
    await P1b.connect();
    P1b.send({ t: 'hello', playerId: p1Id, name: 'Poe' });
    await P1b.waitFor('hello');
    const res1 = await P1b.waitFor('resume');
    assert(res1.code === proom.code && res1.match && res1.match.phase === 'live',
      'restart: room and live round revived from disk');
    assert(res1.match.round === 2 && res1.match.score[r1Winner] === 1,
      'restart: score and round number survive');
    const ppause = await P1b.waitFor('opponentStatus');
    assert(ppause.connected === false, 'restart: first returner stays paused until the opponent is back');
    await sleep(400);
    assert(!P1b.inbox.some(m => m.t === 'fuse'), 'restart: fuse stays frozen while the opponent is away');
    const P2b = new Client('P2b');
    await P2b.connect();
    P2b.send({ t: 'hello', playerId: p2Id, name: 'Quill' });
    await P2b.waitFor('hello');
    const res2 = await P2b.waitFor('resume');
    const searcherSeat2 = 1 - pr2a.callerSeat;
    const sRes = searcherSeat2 === 0 ? res1 : res2;
    const sClient = searcherSeat2 === 0 ? P1b : P2b;
    assert(sRes.match.target === plive.target && Array.isArray(sRes.match.grid),
      'restart: searcher snapshot keeps the target and grid');
    await P1b.waitFor('opponentStatus', m => m.connected === true);
    sClient.send({ t: 'tap', index: sRes.match.grid.indexOf(sRes.match.target) });
    const pend = await sClient.waitFor('roundEnd', m => m.reason === 'found');
    assert(pend.history.length === 2, 'restart: revived round completes and history advances');
    P1b.close(); P2b.close(); P1.close(); P2.close();

    // --- room persistence: lobby room survives; unreturned player expires ---
    const L1 = new Client('L1');
    const L2 = new Client('L2');
    await L1.connect();
    await L2.connect();
    const l1Id = 'test_l1_' + Date.now();
    L1.send({ t: 'hello', playerId: l1Id, name: 'Lil' });
    L2.send({ t: 'hello', playerId: 'test_l2_' + Date.now(), name: 'Mo' });
    await L1.waitFor('hello');
    await L2.waitFor('hello');
    L1.send({ t: 'create' });
    const lroom = await L1.waitFor('room');
    L1.send({ t: 'settings', difficulty: 'frantic', board: 'blackout' });
    await L1.waitFor('room', m => m.settings.board === 'blackout');
    L2.send({ t: 'join', code: lroom.code });
    await L1.waitFor('room', m => m.players.length === 2);
    await restartServer();
    const L1b = new Client('L1b');
    await L1b.connect();
    L1b.send({ t: 'hello', playerId: l1Id, name: 'Lil' });
    await L1b.waitFor('hello');
    const lres = await L1b.waitFor('resume');
    assert(lres.code === lroom.code && lres.phase === 'lobby' && lres.players.length === 2
      && lres.settings.difficulty === 'frantic' && lres.settings.board === 'blackout',
      'restart: lobby room revives with settings and roster');
    const lAfter = await L1b.waitFor('room', m => m.players.length === 1, 8000);
    assert(lAfter.players[0].name === 'Lil', 'restart: a player who never returns expires after grace');
    L1b.close(); L1.close(); L2.close();

    // --- room persistence: tournament mid-stage restart ---
    const K = [new Client('K1'), new Client('K2'), new Client('K3')];
    await Promise.all(K.map(c => c.connect()));
    const kIds = K.map((_, i) => `test_k${i}_` + Date.now());
    K.forEach((c, i) => c.send({ t: 'hello', playerId: kIds[i], name: 'K' + (i + 1) }));
    await Promise.all(K.map(c => c.waitFor('hello')));
    K[0].send({ t: 'create' });
    const kroom = await K[0].waitFor('room');
    K[0].send({ t: 'settings', mode: 'tournament' });
    await K[0].waitFor('room', m => m.settings.mode === 'tournament');
    K[1].send({ t: 'join', code: kroom.code });
    K[2].send({ t: 'join', code: kroom.code });
    await K[0].waitFor('room', m => m.players.length === 3);
    K[1].send({ t: 'ready', ready: true });
    K[2].send({ t: 'ready', ready: true });
    await K[0].waitFor('room', m => m.players.filter(p => p.ready).length === 3);
    K[0].send({ t: 'start' });
    // stage 1: seat 0 sits out; seats 1 & 2 reach a live round, then the server dies
    const krs1 = await K[1].waitFor('roundStart', () => true, 10000);
    await K[2].waitFor('roundStart', () => true, 10000);
    const kCallerIdx = krs1.role === 'caller' ? 1 : 2;
    const kSearcherIdx = kCallerIdx === 1 ? 2 : 1;
    K[kCallerIdx].send({ t: 'pick', index: 1 });
    const klive = await K[kSearcherIdx].waitFor('live');
    await K[kCallerIdx].waitFor('live');
    await restartServer();
    const KB = [new Client('K1b'), new Client('K2b'), new Client('K3b')];
    await Promise.all(KB.map(c => c.connect()));
    KB.forEach((c, i) => c.send({ t: 'hello', playerId: kIds[i], name: 'K' + (i + 1) }));
    await Promise.all(KB.map(c => c.waitFor('hello')));
    const kres = await Promise.all(KB.map(c => c.waitFor('resume')));
    assert(kres.every(r => r.settings.mode === 'tournament' && r.code === kroom.code),
      'restart: tournament room revives for all seats');
    assert(kres[kSearcherIdx].match && kres[kSearcherIdx].match.phase === 'live'
      && kres[kSearcherIdx].match.target === klive.target,
      'restart: tournament stage match revives mid-round');
    KB[kSearcherIdx].send({ t: 'tap', index: kres[kSearcherIdx].match.grid.indexOf(kres[kSearcherIdx].match.target) });
    await KB[kSearcherIdx].waitFor('roundEnd', m => m.reason === 'found', 8000);
    // round 2: roles swap inside the revived match; finish it to close the stage
    await KB[kSearcherIdx].waitFor('roundStart', m => m.round === 2, 8000);
    KB[kSearcherIdx].send({ t: 'pick', index: 0 });
    const klive2 = await KB[kCallerIdx].waitFor('live', () => true, 8000);
    KB[kCallerIdx].send({ t: 'tap', index: klive2.grid.indexOf(klive2.target) });
    await KB[kCallerIdx].waitFor('roundEnd', () => true, 8000);
    const kpair2 = await KB[0].waitFor('tPairing', m => m.stage === 2, 10000);
    assert(kpair2.stage === 2, 'restart: the schedule advances to the next stage after revival');
    KB.forEach(c => c.close());
    K.forEach(c => c.close());

    console.log(`\nALL PASSED (${passed} assertions)`);
  } finally {
    A.close(); B.close();
    server.kill();
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error('\nTEST FAILED:', e.message);
  process.exit(1);
});
