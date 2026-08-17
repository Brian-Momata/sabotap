/* Shared voice record: the one piece of state the mic, the mesh, and the dock
   all read. Its own module so none of them has to import another. */

export const voice = {
  joined: false,
  muted: true,      // transmit state: true whenever no mic track is attached
  wantMic: false,   // talk intent — sticky, so a reconnect can replay it
  optedOut: false,  // explicit Leave: stay out until the join button is tapped
  stream: null,
  peers: new Map(), // playerId -> peer entry (see voice-peers.js)
  members: [],
  allowed: null,    // ids you may connect to; null = unrestricted (older server)
  unreachable: new Set(), // peers whose links gave up after exhausting retries
};
window.voice = voice; // exposed for automated tests

// The server scopes who may talk to whom (everyone in the lobby, your match
// opponent during a game). null means no restriction (older server).
export function voiceAllowed(id) {
  return voice.allowed ? voice.allowed.has(id) : true;
}

// Mesh recovery runs on a timer, not in response to a server message, so the
// dock needs a way to hear about it without voice-peers.js importing the UI.
let listener = null;
export function onVoiceChange(fn) { listener = fn; }
export function voiceChanged() { if (listener) listener(); }

// Voice failures are silent by nature: a broken link looks exactly like a quiet
// room, which is why they survive playtests unreported. Keep a short ring of
// transitions so a "voice didn't work" report can be diagnosed after the fact.
const LOG_MAX = 120;
export const vlog = [];
export function log(what, detail) {
  vlog.push(`${new Date().toISOString().slice(11, 23)} ${what}${detail ? ' ' + detail : ''}`);
  if (vlog.length > LOG_MAX) vlog.shift();
}

// window.voiceDiag() in the phone's console is the whole diagnostic story.
window.voiceDiag = () => ({
  joined: voice.joined,
  muted: voice.muted,
  wantMic: voice.wantMic,
  unreachable: [...voice.unreachable],
  mic: voice.stream ? voice.stream.getAudioTracks().map(t => `${t.readyState}/${t.muted ? 'silent' : 'live'}`) : null,
  allowed: voice.allowed ? [...voice.allowed] : null,
  peers: [...voice.peers.entries()].map(([id, p]) => ({
    id,
    conn: p.pc.connectionState,
    ice: p.pc.iceConnectionState,
    sig: p.pc.signalingState,
    polite: p.polite,
    tries: p.tries,
    resends: p.resends,
    sending: !!p.sender.track,
  })),
  log: vlog,
});
