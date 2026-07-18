/* Account & devices card: link/recovery codes and the claim ("restore") flow. */

import { $ } from './state.js';
import { send } from './net.js';
import { toast } from './ui.js';

let countdownTimer = null;

export function setupIdentityUi() {
  $('accountToggle').onclick = () => {
    const body = $('accountBody');
    body.hidden = !body.hidden;
    $('accountToggle').classList.toggle('open', !body.hidden);
  };
  $('linkCodeBtn').onclick = () => send({ t: 'linkCodeGet' });
  $('recoveryCodeBtn').onclick = () => send({ t: 'recoveryCodeGet' });
  $('claimBtn').onclick = () => {
    const code = $('claimInput').value.trim();
    if (code) send({ t: 'claim', code });
  };
  $('claimInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('claimBtn').click(); });
}

function codeEl(code) {
  const b = document.createElement('b');
  b.className = 'mono account-code';
  b.textContent = code;
  return b;
}

export function showLinkCode(msg) {
  clearInterval(countdownTimer);
  const out = $('linkCodeOut');
  const until = Date.now() + msg.expiresInMs;
  const render = () => {
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    if (!left) {
      clearInterval(countdownTimer);
      out.textContent = 'Code expired. Get a new one.';
      return;
    }
    out.innerHTML = '';
    out.append(codeEl(msg.code), ` · type it on the other device · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`);
  };
  render();
  countdownTimer = setInterval(render, 1000);
}

export function showRecoveryCode(msg) {
  const out = $('recoveryCodeOut');
  out.innerHTML = '';
  out.append(codeEl(msg.code), ' · save it somewhere safe');
  const btn = $('recoveryCodeBtn');
  btn.textContent = 'Copy';
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(msg.code);
      toast('Recovery code copied.');
    } catch {
      toast(msg.code);
    }
  };
}
