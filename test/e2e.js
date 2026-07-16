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
  FUSE_TICK_MS: '100',
  STORE_FILE: path.join(os.tmpdir(), `sabotap-test-store-${Date.now()}.json`),
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
  assert(Array.isArray(liveS.grid) && liveS.grid.length === 36, 'searcher live grid has 36 cells');
  const ti = liveS.grid.indexOf(liveS.target);
  const wrongIdx = (ti + 1) % 36;
  searcher.send({ t: 'tap', index: wrongIdx });
  const wrong = await searcher.waitFor('wrong');
  assert(wrong.index === wrongIdx, 'wrong tap echoed with index');
  searcher.send({ t: 'tap', index: ti });
  const end = await searcher.waitFor('roundEnd');
  await caller.waitFor('roundEnd');
  assert(end.winnerSeat === searcherSeat && end.reason === 'found', 'searcher wins round on correct tap');
  return end;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sabotap-test-'));
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: ENV,
    cwd: dataDir, // keep test store out of the repo? store path is absolute to repo — see note below
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write('[server] ' + d));
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('listening')) resolve(); });
    server.on('exit', () => reject(new Error('server exited early')));
    setTimeout(() => reject(new Error('server did not start')), 5000);
  });

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

    // fire blur, decoys, swap
    caller2.send({ t: 'sabotage', kind: 'blur' });
    const sabBlur = await searcher2.waitFor('sabotage', m => m.kind === 'blur');
    assert(sabBlur.durationMs > 0, 'blur sabotage lands on searcher');
    caller2.send({ t: 'sabotage', kind: 'decoys' });
    const sabDec = await searcher2.waitFor('sabotage', m => m.kind === 'decoys');
    assert(sabDec.indices.length === 2 && sabDec.indices.every(i => live2S.grid[i] !== live2S.target), 'decoys never on target');
    caller2.send({ t: 'sabotage', kind: 'swap' });
    const sabSwap = await searcher2.waitFor('sabotage', m => m.kind === 'swap');
    assert(sabSwap.a !== sabSwap.b, 'swap has two distinct indices');
    caller2.send({ t: 'sabotage', kind: 'zoom' });
    const noCharge = await caller2.waitFor('error');
    assert(/charge/i.test(noCharge.msg), 'sabotage blocked without charges');

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
    assert(snap.phase === 'live' && Array.isArray(snap.grid) && typeof snap.target === 'number', 'reconnect resumes live round with grid + target');
    await callerR.waitFor('opponentStatus', m => m.connected === true);
    const ti = snap.grid.indexOf(snap.target);
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
    C.send({ t: 'friendInvite', id: helloD.you.id });
    const invite = await D.waitFor('invite');
    assert(invite.code === roomC.code && invite.from.name === 'Cy', 'friend invite carries room code');
    D.send({ t: 'join', code: invite.code });
    await D.waitFor('room', m => m.players.length === 2);
    assert(true, 'invitee joined via invite');

    C.close(); D.close(); S2.close();
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
