/* WebSocket transport: connect with auto-reconnect backoff, plus send(). */

import { LS } from './state.js';

let ws = null;
let reconnectDelay = 500;

export function connect({ onMessage, onClose }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    reconnectDelay = 500;
    send({ t: 'hello', playerId: LS.playerId, name: LS.name || '' });
  };
  ws.onmessage = ev => {
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
