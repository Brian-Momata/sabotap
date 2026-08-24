'use strict';

/*
 * Server-rendered HTML for /stats. Reads an analytics summary and prints it —
 * no client JS, no assets, and deliberately outside public/ so the dashboard
 * never lands in the PWA's service-worker cache.
 *
 * Everything below the KPI strip renders whatever the summary contains rather
 * than a hand-listed set of charts, so adding an event to lib/game/telemetry.js
 * shows up here without touching this file.
 */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
const num = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// Event names are grouped by their prefix so related counters render together.
const GROUP_TITLES = {
  session: 'Sessions & reach',
  room: 'Getting into a game',
  match: 'Matches',
  round: 'Round outcomes',
  solo: 'Solo runs',
  tournament: 'Tournaments',
  sabotage: 'Sabotage usage',
  voice: 'Voice chat',
  friend: 'Friends',
  invite: 'Invites',
  player: 'Reliability',
  client: 'Client-reported',
};

function kpi(label, value, sub = '') {
  return `<div class="kpi"><b>${esc(value)}</b><span>${esc(label)}</span>${sub ? `<i>${esc(sub)}</i>` : ''}</div>`;
}

// Daily activity, drawn as bars scaled to the busiest day in the range.
function chart(series) {
  if (!series.length) return '<p class="empty">No activity recorded yet.</p>';
  const peak = Math.max(1, ...series.map(d => Math.max(d.active, d.matches)));
  const bars = series.map(d => `
    <div class="col" title="${esc(d.date)}: ${d.active} players, ${d.matches} matches, ${d.rounds} rounds">
      <div class="stack">
        <div class="bar players" style="height:${(d.active / peak) * 100}%"></div>
        <div class="bar matches" style="height:${(d.matches / peak) * 100}%"></div>
      </div>
      <span>${esc(d.date.slice(5))}</span>
    </div>`).join('');
  return `<div class="chart">${bars}</div>
    <p class="legend"><i class="swatch players"></i>active players <i class="swatch matches"></i>matches started</p>`;
}

// One dimension: every value it took, ordered by frequency, as share-of-total bars.
function dimTable(key, values) {
  const rows = Object.entries(values).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  return `<div class="dim"><h4>${esc(key)}</h4>${rows.map(([value, n]) => `
    <div class="row">
      <span class="label">${esc(value)}</span>
      <span class="track"><span class="fill" style="width:${pct(n, total)}%"></span></span>
      <span class="n">${n} <em>${pct(n, total)}%</em></span>
    </div>`).join('')}</div>`;
}

function statRows(prefix, stats) {
  const rows = Object.entries(stats).filter(([name]) => name.startsWith(prefix + '.'));
  if (!rows.length) return '';
  return `<table class="stats"><tr><th>measure</th><th>avg</th><th>min</th><th>max</th><th>n</th></tr>${
    rows.map(([name, s]) => `<tr>
      <td>${esc(name.slice(prefix.length + 1))}</td>
      <td><b>${esc(num(s.sum / s.n))}</b></td>
      <td>${esc(num(s.min))}</td>
      <td>${esc(num(s.max))}</td>
      <td>${s.n}</td>
    </tr>`).join('')}</table>`;
}

function eventBlock(name, count, totals) {
  const dims = totals.dims[name] || {};
  return `<section class="event">
    <h3>${esc(name)} <b>${count}</b></h3>
    ${statRows(name, totals.stats)}
    <div class="dims">${Object.entries(dims).map(([key, values]) => dimTable(key, values)).join('')}</div>
  </section>`;
}

function groups(totals) {
  const byGroup = new Map();
  for (const [name, count] of Object.entries(totals.events).sort((a, b) => b[1] - a[1])) {
    const group = name.split('.')[0];
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push([name, count]);
  }
  return [...byGroup.entries()].map(([group, events]) => `
    <div class="group">
      <h2>${esc(GROUP_TITLES[group] || group)}</h2>
      ${events.map(([name, count]) => eventBlock(name, count, totals)).join('')}
    </div>`).join('');
}

const CSS = `
:root{color-scheme:dark;--bg:#0d1016;--card:#161b24;--line:#242c39;--fg:#e8ecf4;--dim:#8d99ad;--a:#5eead4;--b:#f472b6}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--dim);margin:0 0 24px;font-size:13px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:28px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.kpi b{display:block;font-size:26px;line-height:1.1}
.kpi span{display:block;color:var(--dim);font-size:12px;margin-top:4px}
.kpi i{display:block;color:var(--a);font-size:11px;font-style:normal;margin-top:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:28px}
.chart{display:flex;gap:3px;align-items:flex-end;height:150px;overflow-x:auto}
.col{flex:1 0 22px;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%}
.stack{flex:1;display:flex;align-items:flex-end;gap:2px;width:100%;justify-content:center}
.bar{width:45%;min-height:2px;border-radius:3px 3px 0 0}
.bar.players{background:var(--a)}.bar.matches{background:var(--b)}
.col span{font-size:9px;color:var(--dim);white-space:nowrap}
.legend{color:var(--dim);font-size:12px;margin:12px 0 0;display:flex;gap:8px;align-items:center}
.swatch{width:10px;height:10px;border-radius:3px;display:inline-block}
.swatch.players{background:var(--a)}.swatch.matches{background:var(--b);margin-left:8px}
.group{margin-bottom:8px}
.group>h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:28px 0 10px}
.event{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.event h3{font-size:14px;margin:0 0 10px;font-weight:600;color:var(--dim)}
.event h3 b{color:var(--fg);font-size:18px;margin-left:6px}
.dims{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px 24px}
.dim h4{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin:8px 0 6px;font-weight:500}
.row{display:grid;grid-template-columns:minmax(80px,1fr) 2fr auto;gap:8px;align-items:center;padding:1px 0;font-size:13px}
.label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.track{background:#0d1016;border-radius:4px;height:8px;overflow:hidden}
.fill{display:block;height:100%;background:var(--a);border-radius:4px}
.n{font-variant-numeric:tabular-nums;font-size:12px;color:var(--dim)}
.n em{font-style:normal;color:var(--fg)}
table.stats{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px}
table.stats th{text-align:left;font-weight:500;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px 4px 0}
table.stats td{padding:2px 8px 2px 0;font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.empty{color:var(--dim)}
footer{color:var(--dim);font-size:12px;margin-top:32px}
a{color:var(--a)}
`;

function statsPage(summary, appName) {
  const { players, totals, series } = summary;
  const sessions = totals.events.session || 0;
  const standalone = ((totals.dims.session || {}).standalone || {});
  const installed = standalone.true || 0;
  const matches = totals.events['match.start'] || 0;
  // One 'match.start' is recorded per versus match, solo run, or whole
  // tournament, so a completion of any of those three closes the loop.
  const finished = (totals.events['match.end'] || 0)
    + (totals.events['solo.end'] || 0)
    + (totals.events['tournament.end'] || 0);
  const outcomes = ((totals.dims['round.end'] || {}).reason || {});
  const rounds = (outcomes.found || 0) + (outcomes.fuse || 0);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(appName)} usage</title><style>${CSS}</style></head>
<body><main>
  <h1>${esc(appName)} usage</h1>
  <p class="sub">Last ${summary.spanDays} days · generated ${esc(new Date(summary.generatedAt).toISOString().replace('T', ' ').slice(0, 16))} UTC
    · <a href="stats.json${summary.key ? '?key=' + encodeURIComponent(summary.key) : ''}">raw JSON</a>
    ${summary.enabled ? '' : '· <b>collection is disabled</b>'}</p>

  <div class="kpis">
    ${kpi('players today', players.activeToday)}
    ${kpi('players this week', players.active7d)}
    ${kpi('players this month', players.active30d)}
    ${kpi('players ever', players.allTime, `${Math.round(players.returnRate * 100)}% came back another day`)}
    ${kpi('sessions', sessions, sessions ? `${pct(installed, sessions)}% from the installed app` : '')}
    ${kpi('matches started', matches, matches ? `${pct(finished, matches)}% played to a result` : '')}
    ${kpi('rounds played', rounds, rounds ? `${pct(outcomes.found || 0, rounds)}% found before the fuse` : '')}
  </div>

  <div class="card">${chart(series)}</div>
  ${groups(totals)}

  <footer>Aggregate counters only — no per-event log, and player ids are salted-hashed before they are counted.
    Retention ${esc(summary.retentionDays || '')} days.</footer>
</main></body></html>`;
}

module.exports = { statsPage };
