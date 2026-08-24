/* PWA install prompt (Chrome/Android beforeinstallprompt + iOS manual steps). */

import { $, LS, isStandalone } from './state.js';
import { toast } from './ui.js';
import { send } from './net.js';

let deferredInstall = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstall() {
  const card = $('installCard');
  if (isStandalone || LS.installDismissed === '1') return void (card.hidden = true);
  if (deferredInstall) {
    // Chrome/Android: we can trigger the real install prompt.
    $('installSub').textContent = 'Fullscreen, home-screen icon, faster loads.';
    $('installBtn').hidden = false;
    card.hidden = false;
  } else if (isIOS) {
    // iOS Safari never fires beforeinstallprompt — show the manual steps.
    $('installSub').textContent = 'Tap Share ⎋ then “Add to Home Screen” to install.';
    $('installBtn').hidden = true;
    card.hidden = false;
  } else {
    card.hidden = true;
  }
}

export function setupInstall() {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    renderInstall();
  });

  window.addEventListener('appinstalled', () => {
    send({ t: 'stat', k: 'install.accepted' });
    deferredInstall = null;
    $('installCard').hidden = true;
    toast('Sabotap installed. Find it on your home screen.');
  });

  $('installBtn').onclick = async () => {
    if (!deferredInstall) return;
    send({ t: 'stat', k: 'install.prompted' });
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    renderInstall();
  };

  $('installDismiss').onclick = () => {
    send({ t: 'stat', k: 'install.dismissed' });
    LS.installDismissed = '1';
    $('installCard').hidden = true;
  };

  renderInstall();
}
