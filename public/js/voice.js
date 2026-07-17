/* Room voice chat: WebRTC mesh, signaled over the game socket. */

import { $, state } from './state.js';
import { send } from './net.js';
import { toast } from './ui.js';
import { renderLobby } from './lobby.js';

export const voice = { joined: false, muted: false, stream: null, peers: new Map(), members: [], allowed: null };
window.voice = voice; // exposed for automated tests

// The server scopes who may talk to whom (everyone in the lobby, your match
// opponent during a game). null means no restriction (older server).
export function voiceAllowed(id) {
  return voice.allowed ? voice.allowed.has(id) : true;
}

function rtcConfig() {
  return { iceServers: (state.config && state.config.iceServers) || [{ urls: 'stun:stun.l.google.com:19302' }] };
}

export async function joinVoice() {
  if (voice.joined) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    toast('Microphone blocked — allow mic access to use voice chat.');
    return;
  }
  voice.stream = stream;
  voice.joined = true;
  voice.muted = false;
  send({ t: 'voiceJoin' });
  renderVoiceDock();
}

export function leaveVoice(notify = true) {
  if (!voice.joined) return;
  if (notify) send({ t: 'voiceLeave' });
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

export function toggleVoiceMute() {
  if (!voice.joined) return;
  voice.muted = !voice.muted;
  voice.stream.getAudioTracks().forEach(tr => { tr.enabled = !voice.muted; });
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
  entry = { pc, audio, pendingIce: [] };
  voice.peers.set(id, entry);
  voice.stream.getTracks().forEach(tr => pc.addTrack(tr, voice.stream));
  pc.ontrack = e => {
    audio.srcObject = e.streams[0];
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
