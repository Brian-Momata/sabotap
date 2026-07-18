/* Lobby screen: player roster, mode/rounds/difficulty settings, start button. */

import { $, state, esc } from './state.js';
import { send } from './net.js';
import { voice } from './voice.js';
import { BOARD_MOTIF } from './board-themes.js';

export function renderLobby() {
  const r = state.room;
  if (!r) return;
  state.mode = r.settings.mode || 'versus';
  $('lobbyCode').textContent = r.code;
  const isHost = state.seat === (r.host || 0);
  const tourn = state.mode === 'tournament';
  const maxP = r.maxPlayers || (tourn ? 8 : 2);
  const minP = r.minPlayers || (tourn ? 3 : 2);

  const wrap = $('lobbyPlayers');
  wrap.innerHTML = '';
  for (const p of r.players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const chip = p.seat === (r.host || 0)
      ? '<span class="row-chip">HOST</span>'
      : (p.ready ? '<span class="row-chip ready">READY</span>' : '<span class="row-chip">NOT READY</span>');
    row.innerHTML = `<span class="dot ${p.connected ? 'online' : ''}"></span><span style="flex:1">${esc(p.name)}${p.seat === state.seat ? ' (you)' : ''}</span>${micBadge(p.id)}${chip}`;
    wrap.append(row);
  }
  if (r.players.length < maxP) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.innerHTML = `<span class="dot"></span><span class="muted">Waiting for players… (${r.players.length}/${tourn ? maxP : 2})</span>`;
    wrap.append(row);
  }

  renderSegs('modeGroup', ['versus', 'tournament'], state.mode, isHost,
    v => send({ t: 'settings', mode: v }), k => (k === 'versus' ? '1 v 1' : 'Tournament'));
  $('modeHint').textContent = tourn
    ? `${minP}–${maxP} players · round-robin, everyone plays everyone · 2 rounds per match · most round wins takes it`
    : '';

  $('roundsLabel').hidden = tourn;
  $('roundsGroup').hidden = tourn;
  if (!tourn) {
    renderSegs('roundsGroup', (state.config?.roundsToWinOptions) || [2, 3, 5], r.settings.roundsToWin, isHost,
      v => send({ t: 'settings', roundsToWin: v }), v => `${v} wins`);
  }
  const diffs = state.config?.difficulties || [];
  renderSegs('diffGroup', diffs.map(d => d.key), r.settings.difficulty, isHost,
    v => send({ t: 'settings', difficulty: v }), k => (diffs.find(d => d.key === k) || { name: k }).name);
  const cur = diffs.find(d => d.key === r.settings.difficulty);
  $('diffHint').textContent = cur ? `${cur.fuseMs / 1000}s fuse. Faster fuse, faster puzzles, trickier digits.` : '';

  renderBoards(r, isHost);

  const btn = $('startBtn');
  btn.classList.remove('btn-ready');
  if (isHost) {
    const others = r.players.filter(p => p.seat !== (r.host || 0));
    const allReady = others.length && others.every(p => p.ready);
    const enough = r.players.length >= minP && (tourn || r.players.length === 2);
    btn.disabled = !(enough && allReady);
    btn.textContent = !enough
      ? `Waiting for players… (${r.players.length}/${minP})`
      : (allReady ? (tourn ? 'Start Tournament' : 'Start Match') : 'Waiting for ready…');
  } else {
    const me = r.players.find(x => x.seat === state.seat);
    btn.disabled = false;
    if (me && me.ready) {
      btn.textContent = 'Ready · host starts the match';
      btn.classList.add('btn-ready');
    } else {
      btn.textContent = "I'm Ready";
    }
  }
}

// Host picks from motif cards; everyone else sees the current pick read-only.
function renderBoards(r, isHost) {
  const boards = state.config?.boards || [];
  const selected = r.settings.board || 'standard';
  const wrap = $('boardGroup');
  wrap.innerHTML = '';
  $('boardLabel').textContent = isHost ? 'Board' : 'Board · set by host';
  if (!boards.length) return;
  if (isHost) {
    wrap.className = 'board-grid';
    for (const b of boards) {
      const card = document.createElement('button');
      card.className = 'board-card' + (b.key === selected ? ' sel' : '');
      card.innerHTML = `<span class="board-motif">${BOARD_MOTIF[b.key] || '■'}</span>`
        + `<span class="board-name">${esc(b.name)}</span><span class="board-tag">${esc(b.tagline)}</span>`;
      card.onclick = () => send({ t: 'settings', board: b.key });
      wrap.append(card);
    }
  } else {
    wrap.className = '';
    const b = boards.find(x => x.key === selected) || boards[0];
    const row = document.createElement('div');
    row.className = 'board-readonly';
    row.innerHTML = `<span class="board-motif">${BOARD_MOTIF[b.key] || '■'}</span>`
      + `<span><span class="board-name">${esc(b.name)}</span><span class="board-tag">${esc(b.tagline)}</span></span>`;
    wrap.append(row);
  }
}

function micBadge(playerId) {
  const m = voice.members.find(x => x.id === playerId);
  if (!m) return '';
  return `<span class="mic-badge${m.muted ? ' muted' : ''}" title="${m.muted ? 'In voice (muted)' : 'In voice'}">`
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>'
    + '<path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line>'
    + '<line class="slash" x1="2" y1="2" x2="22" y2="22"></line></svg></span>';
}

function renderSegs(groupId, options, selected, enabled, onPick, label) {
  const g = $(groupId);
  g.innerHTML = '';
  for (const v of options) {
    const b = document.createElement('button');
    b.className = 'seg' + (v === selected ? ' sel' : '');
    b.textContent = label(v);
    b.disabled = !enabled;
    b.onclick = () => onPick(v);
    g.append(b);
  }
}
