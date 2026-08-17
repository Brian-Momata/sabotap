/* Your side of room voice: membership, the microphone, and the dock controls.
   The mesh lives in voice-peers.js, the shared record in voice-state.js. */

import { $, state } from './state.js';
import { send } from './net.js';
import { toast } from './ui.js';
import { renderLobby } from './lobby.js';
import { attachMeter, detachMeter, stopMeters } from './voice-meter.js';
import { voice, voiceAllowed, log, onVoiceChange } from './voice-state.js';
import { closeAllPeers, sendMicToPeers } from './voice-peers.js';

// The roster's mic badge is server state, so every local change is announced.
function setMuted(muted) {
  voice.muted = muted;
  send({ t: 'voiceMute', muted });
  renderVoiceDock();
}

/* ---------- microphone ----------
   voice.wantMic is intent and survives everything; voice.stream is a capture
   session and survives nothing. Keeping them apart is what makes a reconnect
   resume talking instead of silently muting whoever was mid-sentence.
   All mic work funnels through one promise chain, so a double tap (or a tap
   during the permission prompt) can never leave two capture sessions alive. */

let micWork = Promise.resolve();

function setMic(on) {
  voice.wantMic = on;
  micWork = micWork.then(applyMic, applyMic);
  return micWork;
}

async function applyMic() {
  const want = voice.wantMic && voice.joined;
  if (want === !!voice.stream) return; // already where we want to be
  if (!want) {
    releaseMic();
    setMuted(true);
    return;
  }
  // The mic is held only while talking: releasing it when muted lets the phone
  // give the mic (and the call audio route) back to other apps. Hearing peers
  // never depends on holding it.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (err) {
    log('mic-denied', err && err.name);
    voice.wantMic = false;
    setMuted(true);
    toast('Microphone blocked. Allow mic access to talk.');
    return;
  }
  // The permission prompt can outlive the reason we asked — a Leave or a socket
  // drop while it was open must not leave a hot mic nobody is listening to.
  if (!voice.wantMic || !voice.joined) {
    stream.getTracks().forEach(tr => tr.stop());
    log('mic-discarded');
    return;
  }
  voice.stream = stream;
  const track = stream.getAudioTracks()[0];
  // An incoming call or another app can take the capture away from us. The
  // track just ends, and without this we would sit there looking unmuted.
  track.onended = () => {
    log('mic-ended');
    voice.wantMic = false;
    releaseMic();
    setMuted(true);
    toast('Microphone stopped. Tap the mic to talk again.');
  };
  if (state.you) attachMeter(state.you.id, stream);
  sendMicToPeers(track);
  setMuted(false);
  log('mic-live');
}

function releaseMic() {
  if (!voice.stream) return;
  if (state.you) detachMeter(state.you.id);
  voice.stream.getTracks().forEach(tr => { tr.onended = null; tr.stop(); });
  voice.stream = null;
  sendMicToPeers(null);
  log('mic-released');
}

/* ---------- membership ---------- */

// Being in the room means hearing the room: joining is listen-only (no mic
// permission, no uplink), so whoever opens their mic is audible immediately.
// Talking is gated solely by the mic button (toggleVoiceMute).
export function joinVoice() {
  if (voice.joined) return;
  voice.joined = true;
  voice.muted = true;
  voice.optedOut = false;
  send({ t: 'voiceJoin', muted: true });
  renderVoiceDock();
  // Replay talk intent: after a reconnect the permission is already granted, so
  // this re-opens the mic with no prompt and no gesture.
  if (voice.wantMic) setMic(true);
  log('join');
}

// Runs on every room snapshot (create, join, resume) so voice comes back after
// a reconnect without a gesture; audio that starts before the next tap is
// caught by the pointerdown autoplay retry in voice-peers.js.
export function ensureVoice() {
  if (state.room && !voice.optedOut) joinVoice();
}

export function leaveVoice(notify = true) {
  if (!voice.joined) return;
  if (notify) {
    // An explicit Leave is an opt-out: stay out of voice until the user taps
    // the join button again, even across room snapshots — and drop talk intent,
    // so rejoining starts listen-only like any other join.
    voice.optedOut = true;
    voice.wantMic = false;
    send({ t: 'voiceLeave' });
  }
  voice.joined = false;
  voice.muted = true;
  stopMeters();
  closeAllPeers();
  releaseMic();
  voice.members = [];
  voice.allowed = null;
  renderVoiceDock();
  if (state.phase === 'lobby' && state.room) renderLobby();
  log(notify ? 'leave' : 'disconnected');
}

// Toggles intent, not the capture: tapping again while the permission prompt is
// open cancels the request instead of queueing a second one.
export function toggleVoiceMute() {
  if (!voice.joined) return;
  return setMic(!voice.wantMic);
}

/* ---------- dock ---------- */

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
  dock.classList.toggle('degraded', voice.joined && voice.unreachable.size > 0);
  $('voiceJoinBtn').hidden = voice.joined;
  $('voiceLive').hidden = !voice.joined;
  if (voice.joined) {
    // Count only the people you can actually hear (your channel), yourself included.
    const n = voice.members.filter(m => (state.you && m.id === state.you.id) || voiceAllowed(m.id)).length;
    $('voiceCount').textContent = String(n || 1);
    $('voiceMuteBtn').classList.toggle('muted', voice.muted);
  }
}

// The mesh reports link give-ups on its own timer, not on a server message.
// Naming the peer once matters: "voice is broken" is unactionable, "can't reach
// Sam" points at the one pair whose networks need a TURN relay.
const announced = new Set();
onVoiceChange(() => {
  for (const id of voice.unreachable) {
    if (announced.has(id)) continue;
    announced.add(id);
    const m = voice.members.find(x => x.id === id);
    toast(`Can't reach ${m ? m.name.split(' ')[0] : 'a player'} for voice.`);
  }
  for (const id of [...announced]) {
    if (!voice.unreachable.has(id)) announced.delete(id);
  }
  renderVoiceDock();
});
