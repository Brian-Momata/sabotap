'use strict';

const CONFIG = require('./config');
const { boardList } = require('./game');

// The static config block shipped to clients in hello/claimed payloads.
// ICE is STUN-only by default; set TURN_URL/TURN_USERNAME/TURN_CREDENTIAL to
// add a relay for strict-NAT pairs whose voice would otherwise fail silently.
function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return servers;
}

function clientConfig() {
  return {
    name: CONFIG.name,
    roundsToWinOptions: CONFIG.roundsToWinOptions,
    difficulties: Object.entries(CONFIG.difficulties).map(([key, d]) => ({ key, name: d.name, fuseMs: d.fuseMs })),
    boards: boardList(),
    iceServers: iceServers(),
    voiceMaxBps: CONFIG.voice.maxBps,
    pingMs: CONFIG.net.clientPingMs,
    staleMs: CONFIG.net.clientStaleMs,
  };
}

module.exports = { clientConfig };
