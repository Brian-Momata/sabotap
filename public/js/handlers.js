/* Server-message dispatch table: one handler per message type. */

import { $, state, LS } from './state.js';
import { send } from './net.js';
import { sfx, buzz } from './audio.js';
import { show, toast } from './ui.js';
import { renderYou, renderFriends } from './home.js';
import { renderLobby } from './lobby.js';
import {
  enterPickPhase, enterLivePhase, resumeMatch, renderFuse, renderPuzzle,
  renderCharges, updateSabButtons, cells, handleSabotage, applySwap, resetEffects,
} from './game-view.js';
import { startCountdown, renderStandings, TWAIT_STATUS } from './tournament-view.js';
import { renderResults } from './results.js';
import { voice, voiceAllowed, voicePeer, syncVoicePeers, leaveVoice, renderVoiceDock } from './voice.js';

export const handlers = {
  hello(msg) {
    state.you = msg.you;
    state.friends = msg.friends || [];
    if (msg.config) state.config = msg.config;
    LS.name = msg.you.name;
    renderYou();
    renderFriends();
    if (state.pendingJoinCode) {
      send({ t: 'join', code: state.pendingJoinCode });
      state.pendingJoinCode = null;
    }
  },

  friends(msg) {
    state.friends = msg.list;
    renderFriends();
    if (!$('addFriendResultBtn').hidden && state.opponent) {
      $('addFriendResultBtn').hidden = state.friends.some(f => f.id === state.opponent.id);
    }
  },

  friendRequest(msg) {
    toast(`${msg.from.name} (${msg.from.tag}) wants to be friends — check your Friends list.`);
  },

  invite(msg) {
    $('inviteTitle').textContent = `${msg.from.name} invited you`;
    $('inviteSub').textContent = `Join room ${msg.code} and play a match right now.`;
    $('inviteAcceptBtn').onclick = () => {
      $('inviteOverlay').classList.remove('on');
      send({ t: 'join', code: msg.code });
    };
    $('inviteOverlay').classList.add('on');
    sfx.charge();
    buzz([50, 50, 50]);
  },

  room(msg) {
    state.room = msg;
    state.seat = msg.you;
    if (msg.phase === 'lobby') {
      state.phase = 'lobby';
      $('pauseOverlay').classList.remove('on');
      $('roundOverlay').classList.remove('on');
      renderLobby();
      show('s-lobby');
      if (state.pendingInviteFriend) {
        send({ t: 'friendInvite', id: state.pendingInviteFriend });
        state.pendingInviteFriend = null;
      }
    } else {
      renderLobby();
    }
  },

  left() {
    leaveVoice(false);
    state.room = null;
    state.phase = 'home';
    show('s-home');
    renderVoiceDock();
  },

  roundStart(msg) {
    enterPickPhase(msg);
  },

  live(msg) {
    enterLivePhase(msg);
  },

  fuse(msg) {
    renderFuse(msg.v);
  },

  puzzle(msg) {
    renderPuzzle(msg);
  },

  puzzleResult(msg) {
    if (msg.ok) { sfx.charge(); buzz(30); }
  },

  charges(msg) {
    if (msg.n > state.charges) sfx.charge();
    state.charges = msg.n;
    renderCharges();
  },

  wrong(msg) {
    const c = cells()[msg.index];
    if (c) {
      c.classList.add('wrong');
      setTimeout(() => c.classList.remove('wrong'), 350);
    }
    sfx.wrong();
    buzz(80);
  },

  callerFeed(msg) {
    $('callerFeed').textContent = msg.text;
  },

  sabotage(msg) {
    handleSabotage(msg);
  },

  sabotageFired(msg) {
    state.cooldowns[msg.kind] = Date.now() + (msg.cooldownMs || 0);
    updateSabButtons();
    $('callerFeed').textContent = `${msg.name} fired ⚡`;
    sfx.sabotage();
  },

  gridRevert(msg) {
    applySwap(msg.a, msg.b);
  },

  roundEnd(msg) {
    state.phase = 'roundEnd';
    state.score = msg.score;
    resetEffects();
    // Reveal the target on the searcher's grid.
    if (state.role === 'searcher') {
      const cs = cells();
      if (msg.foundIndex >= 0 && cs[msg.foundIndex]) cs[msg.foundIndex].classList.add('correct');
      else if (cs[msg.targetIndex]) cs[msg.targetIndex].classList.add('reveal');
    }
    const won = msg.winnerSeat === state.matchSeat;
    $('roundOverlayEyebrow').textContent = msg.matchOver ? 'Match point' : `Round ${state.round}`;
    $('roundOverlayTitle').textContent = won ? 'Round yours' : 'Round lost';
    $('roundOverlayTitle').style.color = won ? 'var(--win)' : 'var(--danger)';
    $('roundOverlaySub').textContent = msg.reason === 'found'
      ? `The target ${msg.target} was found.`
      : `The fuse ran out — ${msg.target} stayed hidden.`;
    setTimeout(() => $('roundOverlay').classList.add('on'), msg.reason === 'found' ? 450 : 0);
    (won ? sfx.correct : sfx.wrong)();
    buzz(won ? [40, 40, 80] : [150]);
  },

  tPairing(msg) {
    $('roundOverlay').classList.remove('on');
    $('pairStage').textContent = `Stage ${msg.stage} of ${msg.stages}`;
    $('pairVs').textContent = `You vs ${msg.opponent.name}`;
    $('pairInfo').textContent = `You: #${msg.you.rank} · ${msg.you.points} pts   —   ${msg.opponent.name}: #${msg.opponent.rank} · ${msg.opponent.points} pts`;
    startCountdown($('pairCount'), msg.startsInMs, { prefix: 'Starting in ', doneText: 'Starting…', seconds: true });
    $('pairOverlay').classList.add('on');
    sfx.charge();
    buzz([40, 40, 40]);
  },

  tWaiting(msg) {
    $('roundOverlay').classList.remove('on');
    $('pairOverlay').classList.remove('on');
    resetEffects();
    $('twaitStage').textContent = `Stage ${msg.stage} / ${msg.stages}`;
    $('twaitStatus').textContent = TWAIT_STATUS[msg.reason] || 'Waiting to pair…';
    if (msg.estimateMs > 0) startCountdown($('twaitCount'), msg.estimateMs);
    else $('twaitCount').textContent = 'any moment…';
    renderStandings($('twaitStandings'), msg.standings);
    show('s-twait');
  },

  tStandings(msg) {
    if (!$('s-twait').classList.contains('on')) return;
    $('twaitStage').textContent = `Stage ${msg.stage} / ${msg.stages}`;
    if (msg.estimateMs > 0) startCountdown($('twaitCount'), msg.estimateMs);
    else $('twaitCount').textContent = 'any moment…';
    renderStandings($('twaitStandings'), msg.standings);
  },

  tEnd(msg) {
    $('roundOverlay').classList.remove('on');
    $('pairOverlay').classList.remove('on');
    resetEffects();
    const mine = msg.leaderboard.find(r => state.you && r.id === state.you.id);
    const v = $('tendVerdict');
    if (mine && mine.rank === 1) {
      v.textContent = 'YOU WIN THE TOURNAMENT';
      v.className = 'verdict win';
      sfx.win();
      buzz([40, 30, 40, 30, 160]);
    } else {
      v.textContent = mine ? `#${mine.rank} PLACE` : 'TOURNAMENT OVER';
      v.className = 'verdict';
      sfx.lose();
    }
    $('tendPoints').textContent = mine ? `${mine.points} pts` : '';
    renderStandings($('tendBoard'), msg.leaderboard);
    show('s-tend');
  },

  matchEnd(msg) {
    $('roundOverlay').classList.remove('on');
    resetEffects();
    renderResults(msg);
  },

  rematchStatus(msg) {
    const votes = msg.votes.filter(Boolean).length;
    $('rematchBtn').textContent = votes === 1 ? 'Rematch (1/2 ready)' : 'Rematch';
  },

  opponentStatus(msg) {
    $('pauseOverlay').classList.toggle('on', !msg.connected);
  },

  resume(msg) {
    state.room = msg;
    state.seat = msg.you;
    state.mode = msg.settings ? (msg.settings.mode || 'versus') : 'versus';
    $('pauseOverlay').classList.remove('on');
    $('pairOverlay').classList.remove('on');
    $('roundOverlay').classList.remove('on');
    if (msg.match) {
      resumeMatch(msg.match);
    } else if (msg.phase === 'lobby' || msg.phase === 'matchEnd' || msg.phase === 'tEnd') {
      // matchEnd / tEnd screens arrive as separate follow-up messages
      state.phase = 'lobby';
      renderLobby();
      show('s-lobby');
    }
    // phase 'playing' without a match: a tWaiting follow-up is on its way
  },

  voiceState(msg) {
    voice.members = msg.members || [];
    voice.allowed = Array.isArray(msg.peers) ? new Set(msg.peers) : null;
    syncVoicePeers();
    renderVoiceDock();
    if (state.phase === 'lobby' && state.room) renderLobby();
  },

  async rtc(msg) {
    if (!voice.joined || !voiceAllowed(msg.from)) return;
    const entry = voice.peers.get(msg.from) || voicePeer(msg.from, false);
    const pc = entry.pc;
    try {
      if (msg.data.sdp) {
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
    } catch {}
  },

  toast(msg) {
    toast(msg.msg);
  },

  error(msg) {
    toast(msg.msg);
  },
};
