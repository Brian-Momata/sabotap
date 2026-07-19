/* Room voice chat: WebRTC mesh, signaled over the game socket. */

import { $, state } from './state.js';
import { send } from './net.js';
import { toast } from './ui.js';
import { renderLobby } from './lobby.js';
import { attachMeter, detachMeter, stopMeters } from './voice-meter.js';

export const voice = { joined: false, muted: false, optedOut: false, stream: null, peers: new Map(), members: [], allowed: null };
window.voice = voice; // exposed for automated tests

// The server scopes who may talk to whom (everyone in the lobby, your match
// opponent during a game). null means no restriction (older server).
export function voiceAllowed(id) {
  return voice.allowed ? voice.allowed.has(id) : true;
}

function rtcConfig() {
  return { iceServers: (state.config && state.config.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }] };
}

// Mesh audio means each phone uploads its mic once per peer: in a full 8-player
// waiting channel that is 7 parallel encodes, enough to squeeze the game
// traffic on weak uplinks. Capping the per-link bitrate keeps the whole mesh
// inside what one voice call would cost. Only works post-negotiation, hence
// the connectionstatechange hook.
function capSenderBitrate(sender) {
  const maxBitrate = state.config && state.config.voiceMaxBps;
  if (!maxBitrate) return; // older server: leave the browser default
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    sender.setParameters(params).catch(() => {});
  } catch {}
}

// The mic is held only while unmuted: releasing the capture session when muted
// lets the phone give the mic (and call audio route) back to other apps, e.g.
// an ongoing WhatsApp call. Hearing peers never depends on having the mic.
async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  voice.stream = stream;
  if (state.you) attachMeter(state.you.id, stream);
  const track = stream.getAudioTracks()[0];
  voice.peers.forEach(entry => { entry.sender.replaceTrack(track).catch(() => {}); });
}

function stopMic() {
  if (!voice.stream) return;
  if (state.you) detachMeter(state.you.id);
  voice.stream.getTracks().forEach(tr => tr.stop());
  voice.stream = null;
  voice.peers.forEach(entry => { entry.sender.replaceTrack(null).catch(() => {}); });
}

// Being in the room means hearing the room: joining is listen-only (no mic
// permission, no uplink), so whoever opens their mic is audible to everyone
// immediately. Talking is gated solely by the mic button (toggleVoiceMute).
export function joinVoice() {
  if (voice.joined) return;
  voice.joined = true;
  voice.muted = true;
  voice.optedOut = false;
  send({ t: 'voiceJoin', muted: true });
  renderVoiceDock();
}

// Runs on every room snapshot (create, join, resume) so voice comes back
// after a reconnect without a gesture; audio that starts before the next tap
// is caught by the pointerdown autoplay retry in voicePeer.
export function ensureVoice() {
  if (state.room && !voice.optedOut) joinVoice();
}

export function leaveVoice(notify = true) {
  if (!voice.joined) return;
  if (notify) {
    // An explicit Leave is an opt-out: stay out of voice until the user taps
    // the join button again, even across room snapshots.
    voice.optedOut = true;
    send({ t: 'voiceLeave' });
  }
  stopMeters();
  voice.peers.forEach(entry => {
    try { entry.pc.close(); } catch {}
    entry.audio.remove();
  });
  voice.peers.clear();
  if (voice.stream) voice.stream.getTracks().forEach(tr => tr.stop());
  voice.stream = null;
  voice.joined = false;
  voice.muted = false;
  voice.members = [];
  voice.allowed = null;
  renderVoiceDock();
  if (state.phase === 'lobby' && state.room) renderLobby();
}

export async function toggleVoiceMute() {
  if (!voice.joined) return;
  if (voice.muted) {
    try {
      await startMic();
    } catch {
      toast('Microphone blocked. Allow mic access to talk.');
      return;
    }
    voice.muted = false;
  } else {
    stopMic();
    voice.muted = true;
  }
  send({ t: 'voiceMute', muted: voice.muted });
  renderVoiceDock();
}

export function voicePeer(id, initiator) {
  let entry = voice.peers.get(id);
  if (entry) return entry;
  const pc = new RTCPeerConnection(rtcConfig());
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  document.body.append(audio);
  // One sendrecv transceiver per pair, created before any SDP exchange: the
  // answering side's transceiver is reused for the incoming m-line (JSEP), and
  // replaceTrack on its sender swaps the mic in/out without renegotiation.
  // This is what lets a mic-less (muted/blocked) member still hear peers.
  const sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
  entry = { pc, audio, sender, pendingIce: [] };
  voice.peers.set(id, entry);
  if (voice.stream) sender.replaceTrack(voice.stream.getAudioTracks()[0]).catch(() => {});
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected') capSenderBitrate(sender); };
  pc.ontrack = e => {
    // addTransceiver + replaceTrack sends no stream association (no a=msid in
    // the SDP), so e.streams is empty — wrap the bare track or nothing plays.
    const stream = e.streams[0] || new MediaStream([e.track]);
    audio.srcObject = stream;
    attachMeter(id, stream);
    // Autoplay can be blocked when the track arrives outside a user gesture
    // (e.g. someone joins voice long after we did) — retry on the next tap.
    audio.play().catch(() => {
      document.addEventListener('pointerdown', () => audio.play().catch(() => {}), { once: true });
    });
  };
  pc.onicecandidate = e => { if (e.candidate) send({ t: 'rtc', to: id, data: { ice: e.candidate } }); };
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        send({ t: 'rtc', to: id, data: { sdp: pc.localDescription } });
      } catch {}
    };
  }
  return entry;
}

function dropVoicePeer(id) {
  const entry = voice.peers.get(id);
  if (!entry) return;
  detachMeter(id);
  try { entry.pc.close(); } catch {}
  entry.audio.remove();
  voice.peers.delete(id);
}

export function syncVoicePeers() {
  if (!voice.joined || !state.you) return;
  const ids = new Set(voice.members.map(m => m.id));
  for (const id of [...voice.peers.keys()]) {
    if (!ids.has(id) || !voiceAllowed(id)) dropVoicePeer(id);
  }
  for (const m of voice.members) {
    if (m.id === state.you.id || !voiceAllowed(m.id) || voice.peers.has(m.id)) continue;
    // Exactly one side initiates per pair: the lexically larger id.
    if (state.you.id > m.id) voicePeer(m.id, true);
  }
}

export function renderVoiceDock() {
  const dock = $('voiceDock');
  const inRoom = !!state.room && !$('s-home').classList.contains('on');
  dock.hidden = !inRoom;
  if (!inRoom) return;
  // during a match the dock lives in the game header so it never covers the grid
  const inGame = $('s-game').classList.contains('on');
  const wantParent = inGame ? $('voiceSlot') : document.body;
  if (dock.parentElement !== wantParent) wantParent.appendChild(dock);
  dock.classList.toggle('inhead', inGame);
  dock.classList.toggle('live', voice.joined);
  $('voiceJoinBtn').hidden = voice.joined;
  $('voiceLive').hidden = !voice.joined;
  if (voice.joined) {
    // Count only the people you can actually hear (your channel), yourself included.
    const n = voice.members.filter(m => (state.you && m.id === state.you.id) || voiceAllowed(m.id)).length;
    $('voiceCount').textContent = String(n || 1);
    $('voiceMuteBtn').classList.toggle('muted', voice.muted);
  }
}
