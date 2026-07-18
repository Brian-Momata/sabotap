/* PWA install prompt (Chrome/Android beforeinstallprompt + iOS manual steps). */

import { $, LS } from './state.js';
import { toast } from './ui.js';

let deferredInstall = null;
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
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
    deferredInstall = null;
    $('installCard').hidden = true;
    toast('Sabotap installed. Find it on your home screen.');
  });

  $('installBtn').onclick = async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    renderInstall();
  };

  $('installDismiss').onclick = () => {
    LS.installDismissed = '1';
    $('installCard').hidden = true;
  };

  renderInstall();
}
