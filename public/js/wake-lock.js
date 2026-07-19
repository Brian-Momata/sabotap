/* Screen wake lock: keep the phone awake while in a room (lobby waits, match,
   waiting screens, results) so the OS idle timeout doesn't lock mid-session.
   Released on the home screen — no reason to burn battery in the menu. */

let sentinel = null;
let wanted = false;
let acquiring = false;

async function acquire() {
  if (acquiring || sentinel || document.visibilityState !== 'visible') return;
  acquiring = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    // State can flip mid-await (player left the room, page hidden).
    if (!wanted) { lock.release().catch(() => {}); return; }
    sentinel = lock;
    // The OS takes the lock back on hide or battery saver; the
    // visibilitychange hook below re-acquires when the player returns.
    lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null; });
  } catch {
    // Denied (battery saver) or unsupported: play continues, the screen just
    // follows the normal OS timeout.
  } finally {
    acquiring = false;
  }
}

export function setWakeLock(on) {
  wanted = on;
  if (!('wakeLock' in navigator)) return;
  if (on) {
    acquire();
  } else if (sentinel) {
    sentinel.release().catch(() => {});
    sentinel = null;
  }
}

// A hidden page always loses the lock; take it back on return.
document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') acquire();
});
