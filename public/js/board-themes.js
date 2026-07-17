/* Board themes: round-start announce splash, per-board classes on the game
   screen, and the live effects (Blackout torch, Drift row motion) that need
   JS. Atmosphere never degrades digit legibility — only sabotages may. */

import { $, state } from './state.js';

export const BOARD_MOTIF = {
  standard: '■', mirrors: '≋', blackout: '◐', drift: '⇄', glyphs: '✦', rotation: '↻',
};

const BOARD_CLASSES = ['board-standard', 'board-mirrors', 'board-blackout', 'board-drift', 'board-glyphs'];

let lastAnnounced = null;
let announceTimer = null;
let torchDetach = null;

/* Theme the game screen for the round and splash the board name — once per
   board, so a fixed board announces at round 1 and Rotation every round. */
export function boardRoundStart(board, round) {
  const game = $('s-game');
  BOARD_CLASSES.forEach(c => game.classList.remove(c));
  if (!board) return;
  game.classList.add('board-' + board.key);
  if (round === 1) lastAnnounced = null;
  if (board.key === 'standard' || board.key === lastAnnounced) { lastAnnounced = board.key; return; }
  lastAnnounced = board.key;
  $('boardOvEyebrow').textContent = `ROUND ${round}`;
  $('boardOvTitle').textContent = board.name;
  $('boardOvSub').textContent = board.tagline;
  const ov = $('boardOverlay');
  ov.classList.add('on');
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => ov.classList.remove('on'), 1500);
}

/* Live-phase effects on the Searcher's grid. */
export function armBoardFx(board) {
  resetBoardFx();
  if (board && board.key === 'blackout') torchDetach = attachTorch(board);
}

// Also drops Blackout's darkness so the round-end target reveal is visible.
export function resetBoardFx() {
  if (torchDetach) { torchDetach(); torchDetach = null; }
  $('boardOverlay').classList.remove('on');
}

/* Blackout: the grid is dark; a warm torch follows the finger revealing a
   ~2-tile radius fully and a dim ember ring beyond it. */
function attachTorch(board) {
  const outer = $('gridOuter');
  outer.classList.add('torch-out');
  const torch = document.createElement('div');
  torch.className = 'torch';
  outer.append(torch);
  let px = 0, py = 0, raf = 0;

  const update = () => {
    raf = 0;
    const or = outer.getBoundingClientRect();
    torch.style.left = (px - or.left + outer.scrollLeft) + 'px';
    torch.style.top = (py - or.top + outer.scrollTop) + 'px';
    torch.classList.add('on');
    const els = state.cellEls || [];
    if (!els.length) return;
    const r0 = els[0].getBoundingClientRect();
    const radius = (board.torchTiles || 2.2) * Math.max(r0.width, r0.height);
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - px, r.top + r.height / 2 - py);
      el.classList.toggle('lit', d < radius);
      el.classList.toggle('ember', d >= radius && d < radius * 1.8);
    }
  };
  const move = e => {
    px = e.clientX;
    py = e.clientY;
    if (!raf) raf = requestAnimationFrame(update);
  };
  outer.addEventListener('pointerdown', move);
  outer.addEventListener('pointermove', move);

  return () => {
    outer.removeEventListener('pointerdown', move);
    outer.removeEventListener('pointermove', move);
    if (raf) cancelAnimationFrame(raf);
    torch.remove();
    outer.classList.remove('torch-out');
    (state.cellEls || []).forEach(el => el.classList.remove('lit', 'ember'));
  };
}

/* Drift: rows oscillate in alternating directions. Purely visual — cells keep
   their indices, they just move, so the server needs no drift logic. */
export function driftRowStyle(rowEl, rowIndex, board) {
  const period = (board.periodMs || 5200) + rowIndex * 260;
  const amp = board.amplitudePct || 4.5;
  rowEl.className = 'drift-row';
  rowEl.style.setProperty('--amp', (rowIndex % 2 ? -amp : amp) + '%');
  rowEl.style.animation = `driftOsc ${period}ms ease-in-out infinite`;
}
