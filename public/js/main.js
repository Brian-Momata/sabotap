/* Entry point: static UI wiring, boot sequence, socket connection. */

import { $, LS, state, prefs } from './state.js';
import { connect, send } from './net.js';
import { show, toast } from './ui.js';
import { renderLobby } from './lobby.js';
import { setAvatarFromName } from './home.js';
import { handlers, declineInvite } from './handlers.js';
import { joinVoice, leaveVoice, toggleVoiceMute } from './voice.js';
import { setupInstall } from './install.js';
import { setupIdentityUi } from './identity-ui.js';

/* ---------- home ---------- */

$('nameInput').addEventListener('change', () => {
  const name = $('nameInput').value.trim();
  if (name) {
    LS.name = name;
    send({ t: 'setName', name });
  }
});

$('nameInput').addEventListener('input', () => setAvatarFromName($('nameInput').value));
$('nameEditBtn').onclick = () => { const i = $('nameInput'); i.focus(); i.select(); };

$('createBtn').onclick = () => send({ t: 'create' });

$('joinBtn').onclick = () => {
  const code = $('codeInput').value.trim().toUpperCase();
  if (code) send({ t: 'join', code });
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

$('friendAddBtn').onclick = () => {
  const tag = $('friendTagInput').value.trim().toUpperCase();
  if (tag) {
    send({ t: 'friendAdd', tag });
    $('friendTagInput').value = '';
  }
};

/* ---------- lobby ---------- */

$('shareBtn').onclick = async () => {
  if (!state.room) return;
  const url = `${location.origin}/#${state.room.code}`;
  const text = `Play Sabotap with me, room ${state.room.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Sabotap', text, url }); } catch {}
  } else {
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied.');
    } catch {
      toast(url);
    }
  }
};

$('startBtn').onclick = () => {
  if (state.room && state.seat === (state.room.host || 0)) {
    send({ t: 'start' });
  } else {
    const me = state.room && state.room.players.find(x => x.seat === state.seat);
    send({ t: 'ready', ready: !(me && me.ready) });
  }
};
$('leaveBtn').onclick = () => send({ t: 'leave' });

/* ---------- results ---------- */

$('rematchBtn').onclick = () => {
  send({ t: 'rematch' });
  $('rematchBtn').textContent = 'Waiting for opponent…';
};
$('backHomeBtn').onclick = () => {
  // Return to the shared room lobby (keeps the same code for another match);
  // home only if the room dissolved while we sat on the results screen.
  if (state.room) {
    renderLobby();
    show('s-lobby');
    state.phase = 'lobby';
  } else {
    show('s-home');
    state.phase = 'home';
  }
};
$('addFriendResultBtn').onclick = () => {
  const opp = state.opponent;
  if (!opp) return;
  // We only know the opponent's id here; the server matches friends by tag,
  // so ask it via the tag of the profile — fetch through a targeted add.
  send({ t: 'friendAdd', tag: opp.tag || '' });
};
$('inviteDeclineBtn').onclick = declineInvite;
$('tendLobbyBtn').onclick = () => {
  renderLobby();
  show('s-lobby');
  state.phase = 'lobby';
};

/* ---------- prefs ---------- */

function renderPrefButtons() {
  $('soundToggle').classList.toggle('on', prefs.sound);
  $('hapticsToggle').classList.toggle('on', prefs.haptics);
}
$('soundToggle').onclick = () => { prefs.sound = !prefs.sound; renderPrefButtons(); };
$('hapticsToggle').onclick = () => { prefs.haptics = !prefs.haptics; renderPrefButtons(); };
renderPrefButtons();

/* ---------- voice ---------- */

$('voiceJoinBtn').onclick = joinVoice;
$('voiceLeaveBtn').onclick = () => leaveVoice(true);
$('voiceMuteBtn').onclick = toggleVoiceMute;

/* ---------- boot ---------- */

setupInstall();
setupIdentityUi();

const hashCode = location.hash.replace('#', '').trim().toUpperCase();
if (/^[A-Z]{3,4}-\d{2}$/.test(hashCode)) {
  state.pendingJoinCode = hashCode;
  history.replaceState(null, '', location.pathname);
}

show('s-home');
connect({
  onMessage: msg => { const h = handlers[msg.t]; if (h) h(msg); },
  onClose: () => leaveVoice(false), // server already dropped us from voice on disconnect
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
