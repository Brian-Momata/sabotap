/* Home screen: profile chip and friends list. */

import { $, state } from './state.js';
import { send } from './net.js';

export function setAvatarFromName(name) {
  const ch = (name || '').trim().charAt(0);
  $('youAvatar').textContent = ch ? ch.toUpperCase() : '?';
}

export function renderYou() {
  if (!state.you) return;
  $('youTag').textContent = state.you.tag;
  if (!$('nameInput').value) $('nameInput').value = state.you.name;
  setAvatarFromName($('nameInput').value);
}

export function renderFriends() {
  const list = $('friendList');
  list.innerHTML = '';
  if (!state.friends.length) {
    list.innerHTML = '<div class="friend-row"><span class="friend-name" style="color: var(--text-3);">No friends yet. Add one by tag, or after a match.</span></div>';
    return;
  }
  for (const f of state.friends) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    const dot = document.createElement('span');
    dot.className = 'dot' + (f.online ? ' online' : '')
      + (f.presence === 'lobby' || f.presence === 'match' ? ` ${f.presence}` : '');
    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = f.name;
    const tag = document.createElement('span');
    tag.className = 'friend-tag mono';
    tag.textContent = f.tag;
    row.append(dot, name, tag);
    if (f.presence === 'lobby' || f.presence === 'match') {
      const st = document.createElement('span');
      st.className = 'friend-presence ' + f.presence;
      st.textContent = f.presence === 'match' ? 'in game' : 'in lobby';
      row.append(st);
    }
    if (f.status === 'pending_in') {
      const btn = document.createElement('button');
      btn.className = 'chip-btn';
      btn.textContent = 'Accept';
      btn.onclick = () => send({ t: 'friendAccept', id: f.id });
      row.append(btn);
    } else if (f.status === 'pending_out') {
      const s = document.createElement('span');
      s.className = 'friend-tag';
      s.textContent = 'invited';
      row.append(s);
    } else {
      const btn = document.createElement('button');
      btn.className = 'chip-btn';
      btn.textContent = 'Invite';
      btn.disabled = !f.online || f.presence === 'match';
      btn.onclick = () => inviteFriend(f);
      row.append(btn);
    }
    list.append(row);
  }
}

export function inviteFriend(f) {
  if (state.room && (state.phase === 'lobby')) {
    send({ t: 'friendInvite', id: f.id });
  } else {
    state.pendingInviteFriend = f.id;
    send({ t: 'create' });
  }
}
