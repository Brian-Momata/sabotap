/* WebSocket transport: connect with auto-reconnect backoff, plus send(). */

import { LS, state } from './state.js';

let ws = null;
let reconnectDelay = 500;
let lastMsgAt = Date.now();

export function connect({ onMessage, onClose }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    reconnectDelay = 500;
    lastMsgAt = Date.now();
    send({ t: 'hello', playerId: LS.playerId, secret: LS.secret, name: LS.name || '' });
  };
  ws.onmessage = ev => {
    lastMsgAt = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  };
  ws.onclose = () => {
    onClose();
    setTimeout(() => connect({ onMessage, onClose }), reconnectDelay);
    reconnectDelay = Math.min(8000, reconnectDelay * 2);
  };
}

export function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Half-open sockets (phone sleep, Wi-Fi to cellular, proxy drop) fire no close
// event — the screen just freezes and send() no-ops. Ping once the connection
// goes quiet; once nothing at all has arrived for staleMs, force-close so the
// reconnect + resume path takes over. The visibility hook makes a thawed phone
// recover immediately instead of on the next tick.
function checkLiveness() {
  if (!ws || ws.readyState !== 1) return;
  const cfg = state.config || {};
  const quiet = Date.now() - lastMsgAt;
  if (quiet > (cfg.staleMs || 25000)) {
    try { ws.close(); } catch {}
  } else if (quiet > (cfg.pingMs || 10000)) {
    send({ t: 'ping' });
  }
}
setInterval(checkLiveness, 3000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkLiveness();
});
