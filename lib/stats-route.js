'use strict';

const CONFIG = require('./config');
const analytics = require('./analytics');
const { statsPage } = require('./stats-page');

/*
 * The /stats HTTP surface and the access policy in front of it. Kept out of
 * server.js so the edge file stays about the game's transport, and out of
 * public/ so the dashboard never lands in the PWA's service-worker cache.
 *
 * ANALYTICS_TOKEN gates it; with no token set only a loopback request (an ssh
 * tunnel, a local run) is served, so deploying without one cannot leak the
 * numbers. A rejected request 404s rather than 401s — there is nothing to be
 * gained by confirming the endpoint exists.
 */
function allowed(req) {
  const token = CONFIG.analytics.token;
  if (token) {
    return req.query.key === token || req.get('authorization') === `Bearer ${token}`;
  }
  // Behind a proxy the socket is always "local"; the forwarded header is the
  // tell that this request came in off the internet.
  if (req.get('x-forwarded-for')) return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function summaryFor(req) {
  const { retentionDays, reportDays } = CONFIG.analytics;
  const span = Math.max(1, Math.min(retentionDays, Number(req.query.days) || reportDays));
  return { ...analytics.summary(span), retentionDays };
}

function mountStats(app) {
  app.get('/stats.json', (req, res) => {
    if (!allowed(req)) return res.status(404).end();
    res.json(summaryFor(req));
  });

  app.get('/stats', (req, res) => {
    if (!allowed(req)) return res.status(404).end();
    res.type('html').send(statsPage({ ...summaryFor(req), key: CONFIG.analytics.token }, CONFIG.name));
  });
}

module.exports = { mountStats };
