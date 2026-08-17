/* The voice mesh: one RTCPeerConnection per audible peer, signaled over the
   game socket. Three invariants keep the rest of the app simple:
     - every pair holds one sendrecv transceiver for its whole life, so a
       mic-less member still hears everyone and muting is replaceTrack, never
       renegotiation;
     - negotiation is symmetric (perfect negotiation), so either side may
       (re)offer and a collision resolves deterministically — that is what lets
       whichever side noticed a dead link rebuild it;
     - a link that never reaches 'connected' is on a deadline. Silence is not
       evidence of success, so no link is allowed to wait forever. */

import { state } from './state.js';
import { send } from './net.js';
import { voice, voiceAllowed, log, voiceChanged } from './voice-state.js';
import { attachMeter, detachMeter } from './voice-meter.js';

// Long enough to cover a slow ICE gather on mobile data, short enough that a
// player notices a rebuild rather than a dead channel. Pairs that cannot
// traverse their NATs at all fail this every time — that is what TURN fixes.
const CONNECT_TIMEOUT_MS = 12000;
const MAX_TRIES = 3;
const MAX_RESENDS = 2;
const SWEEP_MS = 4000;

let sweeper = null;

function rtcConfig() {
  return { iceServers: (state.config && state.config.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }] };
}

// Mesh audio means each phone uploads its mic once per peer: in a full 8-player
// waiting channel that is 7 parallel encodes, enough to squeeze the game
// traffic on weak uplinks. Capping the per-link bitrate keeps the whole mesh
// inside what one voice call would cost. Only works post-negotiation, hence the
// connectionstatechange hook.
function capSenderBitrate(sender) {
  const maxBitrate = state.config && state.config.voiceMaxBps;
  if (!maxBitrate) return; // older server: leave the browser default
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    sender.setParameters(params).catch(err => log('bitrate-cap-failed', err && err.name));
  } catch (err) {
    log('bitrate-cap-failed', err && err.name);
  }
}

function createPeer(id, { offer = false, tries = 0 } = {}) {
  const pc = new RTCPeerConnection(rtcConfig());
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  document.body.append(audio);
  // Created before any SDP exchange so the answering side's transceiver is
  // reused for the incoming m-line (JSEP) instead of adding a second one.
  const sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
  const entry = {
    pc, audio, sender, tries,
    pendingIce: [],
    // Perfect negotiation roles: the lexically smaller id is polite and yields
    // when two offers cross. Fixed per pair, so both sides agree without asking.
    polite: !!(state.you && state.you.id < id),
    makingOffer: false,
    ignoreOffer: false,
    resends: 0,
    since: Date.now(),
  };
  voice.peers.set(id, entry);

  const track = voice.stream && voice.stream.getAudioTracks()[0];
  if (track) sender.replaceTrack(track).catch(err => log('replace-failed', `${id} ${err && err.name}`));

  // Only a side asked to offer wires this up: in the steady state exactly one
  // side of each pair offers, and a rebuild re-creates the peer with offer set.
  if (offer) {
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        send({ t: 'rtc', to: id, data: { sdp: pc.localDescription } });
      } catch (err) {
        log('offer-failed', `${id} ${err && err.name}`);
      } finally {
        entry.makingOffer = false;
      }
    };
  }

  pc.onicecandidate = e => { if (e.candidate) send({ t: 'rtc', to: id, data: { ice: e.candidate } }); };

  pc.ontrack = e => {
    // addTransceiver + replaceTrack sends no stream association (no a=msid in
    // the SDP), so e.streams is empty — wrap the bare track or nothing plays.
    const stream = e.streams[0] || new MediaStream([e.track]);
    audio.srcObject = stream;
    attachMeter(id, stream);
    // Autoplay can be blocked when the track arrives outside a user gesture
    // (e.g. someone joins voice long after we did) — retry on the next tap.
    audio.play().catch(() => {
      log('autoplay-blocked', id);
      document.addEventListener('pointerdown', () => audio.play().catch(() => {}), { once: true });
    });
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    log('conn', `${id} ${st}`);
    // Every transition restarts the deadline, so a drop out of 'connected' gets
    // its own grace window instead of being rebuilt instantly.
    entry.since = Date.now();
    if (st === 'connected') {
      entry.tries = 0;
      entry.resends = 0;
      capSenderBitrate(sender);
    } else if (st === 'failed') {
      rebuild(id, 'failed');
    }
  };

  log('peer-new', `${id} ${offer ? 'offering' : 'listening'} try ${tries}`);
  startSweeper();
  return entry;
}

function closePeer(id) {
  const entry = voice.peers.get(id);
  if (!entry) return;
  detachMeter(id);
  entry.pc.onconnectionstatechange = null; // close() fires it again otherwise
  entry.pc.onicecandidate = null;
  entry.pc.ontrack = null;
  entry.pc.onnegotiationneeded = null;
  try { entry.pc.close(); } catch {}
  entry.audio.srcObject = null;
  entry.audio.remove();
  voice.peers.delete(id);
  if (!voice.peers.size) stopSweeper();
}

// Tear a link down and try again from scratch. The rebuild always offers,
// whichever side we are: the peer that noticed the failure is the one that can
// still act, and perfect negotiation sorts out both sides rebuilding at once.
function rebuild(id, why) {
  const entry = voice.peers.get(id);
  if (!entry) return;
  const tries = entry.tries + 1;
  closePeer(id);
  if (!voice.joined || !voiceAllowed(id) || !voice.members.some(m => m.id === id)) {
    return log('rebuild-skipped', `${id} ${why}`);
  }
  if (tries > MAX_TRIES) {
    // Out of retries means the two networks cannot reach each other. Record it
    // so the dock can say so: an unexplained silent player is the failure mode
    // this whole file exists to avoid, and the fix (a TURN relay) is not
    // something more retrying can find.
    voice.unreachable.add(id);
    log('gave-up', `${id} ${why}`);
    voiceChanged();
    return;
  }
  log('rebuild', `${id} ${why} try ${tries}`);
  createPeer(id, { offer: true, tries });
  voiceChanged();
}

// Catches links that go quiet without ever reporting 'failed': a lost offer, a
// half-open socket during the handshake, ICE that stalls in 'checking'.
function sweep() {
  for (const [id, entry] of [...voice.peers]) {
    const { pc } = entry;
    if (pc.connectionState === 'connected') continue;
    if (Date.now() - entry.since <= CONNECT_TIMEOUT_MS) continue;
    entry.since = Date.now();
    // An offer still waiting on its first reply was most likely dropped in
    // transit (a mesh rebuild can outrun the edge's message budget). Re-send it:
    // that costs nothing and leaves the negotiation roles alone, whereas
    // rebuilding here would hand the impolite side a collision it is obliged to
    // defend — deadlocking the pair for as long as both keep rebuilding.
    const awaitingReply = pc.signalingState === 'have-local-offer' && !pc.remoteDescription;
    if (awaitingReply && pc.localDescription && entry.resends < MAX_RESENDS) {
      entry.resends += 1;
      log('offer-resent', `${id} try ${entry.resends}`);
      send({ t: 'rtc', to: id, data: { sdp: pc.localDescription } });
      continue;
    }
    rebuild(id, `stuck:${pc.connectionState}/${pc.signalingState}`);
  }
}

function startSweeper() {
  if (sweeper || !voice.peers.size) return;
  sweeper = setInterval(sweep, SWEEP_MS);
}

function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

export async function handleSignal(msg) {
  if (!voice.joined || !voiceAllowed(msg.from)) return;
  // An unexpected offer means a peer is (re)building the link — answer it.
  const entry = voice.peers.get(msg.from) || createPeer(msg.from, { offer: false });
  const { pc } = entry;
  try {
    if (msg.data.sdp) {
      // An offer we have already answered is being re-sent, which means our
      // answer was the message that got lost. Re-send it instead of letting the
      // link sit until the sweeper gives up on it.
      if (msg.data.sdp.type === 'offer' && pc.remoteDescription
          && pc.remoteDescription.sdp === msg.data.sdp.sdp
          && pc.localDescription && pc.localDescription.type === 'answer') {
        send({ t: 'rtc', to: msg.from, data: { sdp: pc.localDescription } });
        return log('answer-resent', msg.from);
      }
      const collision = msg.data.sdp.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
      entry.ignoreOffer = !entry.polite && collision;
      if (entry.ignoreOffer) return log('offer-ignored', msg.from);
      // The polite side's setRemoteDescription rolls its own offer back here.
      await pc.setRemoteDescription(msg.data.sdp);
      if (msg.data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        send({ t: 'rtc', to: msg.from, data: { sdp: pc.localDescription } });
      }
      while (entry.pendingIce.length) pc.addIceCandidate(entry.pendingIce.shift()).catch(() => {});
    } else if (msg.data.ice) {
      if (pc.remoteDescription) await pc.addIceCandidate(msg.data.ice);
      else entry.pendingIce.push(msg.data.ice);
    }
  } catch (err) {
    // Candidates for an offer we just ignored are expected garbage; anything
    // else belongs in the diagnostics ring.
    if (!entry.ignoreOffer) log('signal-error', `${msg.from} ${err && err.name}`);
  }
}

export function syncPeers() {
  if (!voice.joined || !state.you) return;
  const ids = new Set(voice.members.map(m => m.id));
  for (const id of [...voice.peers.keys()]) {
    if (!ids.has(id) || !voiceAllowed(id)) closePeer(id);
  }
  // A topology change (match start/end) is a fresh start for a written-off peer:
  // the pair that failed in the lobby may be the pair the next match needs.
  for (const id of [...voice.unreachable]) {
    if (!ids.has(id) || !voiceAllowed(id)) voice.unreachable.delete(id);
  }
  for (const m of voice.members) {
    if (m.id === state.you.id || !voiceAllowed(m.id)) continue;
    if (voice.peers.has(m.id) || voice.unreachable.has(m.id)) continue;
    // Both sides build the link, but only the impolite (larger id) side offers
    // first — so a dropped offer still leaves the other side with a peer to
    // time out and rebuild, instead of waiting on an offer that never comes.
    createPeer(m.id, { offer: state.you.id > m.id });
  }
}

// Push the mic (or null, on mute) to every link. No renegotiation: the
// transceivers are already sendrecv, which is the point of creating them early.
export function sendMicToPeers(track) {
  voice.peers.forEach((entry, id) => {
    entry.sender.replaceTrack(track).catch(err => log('replace-failed', `${id} ${err && err.name}`));
  });
}

export function closeAllPeers() {
  for (const id of [...voice.peers.keys()]) closePeer(id);
  voice.unreachable.clear();
  stopSweeper();
}
