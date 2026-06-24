'use strict';

// Conductor adapter: MEV / liquidation searcher fleet.
//
// A searcher is a unit racing with intent — win profitable bundles (arb / liquidation) net of
// tips and gas. The operator supervises by exception, watching for the one that's wedged (losing
// every race), bleeding (net-negative after costs), or feed-dead (disconnected from the
// mempool / Geyser / orderflow). Sibling of the trading-bot fleet adapter: same "read a trail that
// already exists" pattern, sharing ./_filetrail for the append-only events.jsonl + control.jsonl
// plumbing.
//
// Each searcher appends to ~/.fleet/searchers/<bot>/events.jsonl, one JSON record per line —
//   { ts, type, ... } where type ∈
//     opportunity | bundle | submit | land | revert | pnl | gas | heartbeat | error
// An optional ~/.fleet/searchers/<bot>/meta.json gives { strategy, mandate, chain, venue }.
//
// Observation is read-only. Control appends pause | resume | set-param | kill | unwind to the
// bot's control.jsonl, which it polls. `unwind` flattens seized collateral — destructive, so it
// carries an adapter-layer confirm-token gate (independent of the cockpit guard). broadcast('pause')
// is the desk-wide stop (gas spike / reorg / bad oracle); a destructive op can never be broadcast.

const path = require('path');
const ft = require('./_filetrail');
const { clip, prettify } = require('../util');

const KIND = 'searchers';
const FEED_MINUTES = 3;        // no heartbeat/opportunity within this window → feed-dead (disconnected)
const WINDOW_MINUTES = 5;      // the recent window over which wedged/bleeding are judged
const WEDGE_MIN_SUBMITS = 3;   // need at least this many submits in-window before "losing every race" applies
const WEDGE_LAND_RATE = 0.2;   // land/submit ratio at or below this over the window = wedged
const RING = 12;               // recent non-heartbeat events surfaced per searcher

function num(x) { return typeof x === 'number' && !isNaN(x) ? x : 0; }

function fmtSigned(n) {
  if (n == null || isNaN(n)) return '0';
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 1000) / 1000;
  return (r >= 0 ? '+' : '') + r;
}

function describe(ev) {
  switch (ev.type) {
    case 'opportunity': return clip(`opp ${ev.kind || ''} ${ev.route || ev.protocol || ''}`.trim() + (ev.est != null ? ` est ${ev.est}` : ''), 80);
    case 'bundle': return clip(`bundle ${ev.id || ''}${ev.tip != null ? ` tip ${ev.tip}` : ''}`.trim(), 80);
    case 'submit': return clip(`submit ${ev.id || ''}`.trim(), 80);
    case 'land': return clip(`landed ${ev.protocol || ev.id || ''} ${fmtSigned(ev.pnl)}`.trim(), 80);
    case 'revert': return clip(`revert ${ev.id || ''}${ev.cost != null ? ` -${ev.cost}` : ''}`.trim(), 80);
    case 'pnl': return `pnl net ${fmtSigned(ev.net != null ? ev.net : (ev.realized || 0))}`;
    case 'gas': return clip(`gas ${ev.spent != null ? ev.spent : ''}`.trim(), 80);
    case 'error': return clip('error: ' + (ev.message || 'unknown'), 80);
    case 'heartbeat': return 'heartbeat';
    default: return clip(ev.type || 'event', 80);
  }
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

function listSearchers() { return ft.listUnits(KIND); }
function discover() { return ft.discover(KIND); }

// Liveness is feed-liveness: a searcher is "live" only if it has heartbeat/opportunity traffic
// within the window. No heartbeat/opportunity → disconnected from the orderflow → feed-dead.
function liveness(handles, opts = {}) {
  return ft.liveness(handles, (opts.feedMinutes || FEED_MINUTES) * 60000, { types: ['heartbeat', 'opportunity'] });
}

async function parse(handle, opts = {}) {
  const dir = path.dirname(handle);
  const bot = ft.unitName(handle);
  if (!ft.safeName(bot)) return null;
  const meta = ft.readMeta(dir);

  const now = Date.now();
  const windowMs = (opts.windowMinutes || WINDOW_MINUTES) * 60000;
  const windowStart = now - windowMs;

  const s = {
    lastTs: 0,
    submits: 0, lands: 0, reverts: 0, opportunities: 0,   // session counts
    winSubmits: 0, winLands: 0, winNet: 0, winActivity: 0, // window counts (net derived from land/revert)
    latestPnl: null, derivedNet: 0, derivedTips: 0, derivedGas: 0,
    recent: [], lastMeaningful: null, lastLand: null,
  };

  await ft.streamEvents(handle, (ev, t) => {
    if (!isNaN(t) && t > s.lastTs) s.lastTs = t;
    const inWindow = !isNaN(t) && t >= windowStart;
    switch (ev.type) {
      case 'opportunity': s.opportunities++; break;
      case 'submit': { s.submits++; if (inWindow) s.winSubmits++; break; }
      case 'land': {
        s.lands++; s.lastLand = ev;
        s.derivedNet += num(ev.pnl); s.derivedTips += num(ev.tip); s.derivedGas += num(ev.gas);
        if (inWindow) { s.winLands++; s.winNet += num(ev.pnl); s.winActivity++; }
        break;
      }
      case 'revert': {
        s.reverts++;
        s.derivedNet -= num(ev.cost); s.derivedGas += num(ev.cost);
        if (inWindow) { s.winNet -= num(ev.cost); s.winActivity++; }
        break;
      }
      case 'pnl': s.latestPnl = { net: num(ev.net), tips: num(ev.tips), gas: num(ev.gas) }; break;
      case 'gas': s.derivedGas += num(ev.spent); break;
      default: break;
    }
    if (ev.type !== 'heartbeat') {
      s.lastMeaningful = ev;
      s.recent.push({ actor: 'searcher', kind: ev.type, summary: describe(ev), ts: isNaN(t) ? 0 : t });
      if (s.recent.length > RING) s.recent.shift();
    }
  });

  if (!s.lastTs && !s.recent.length) return null; // empty trail

  const sessionNet = s.latestPnl ? s.latestPnl.net : s.derivedNet;
  const tipSpend = s.latestPnl ? s.latestPnl.tips : s.derivedTips;
  const gasSpend = s.latestPnl ? s.latestPnl.gas : s.derivedGas;
  const winRate = s.submits > 0 ? s.lands / s.submits : null;

  // wedged: submitting a flurry of bundles but ~nothing landing — losing every race.
  const wedged = s.winSubmits >= WEDGE_MIN_SUBMITS && (s.winLands / s.winSubmits) <= WEDGE_LAND_RATE;
  // bleeding: net flow over the window is negative (tips + gas outrunning profit).
  const bleeding = s.winActivity > 0 && s.winNet < -1e-9;
  // racing: actively landing bundles this window (and not wedged/bleeding).
  const racing = s.winLands > 0;

  const chain = meta.chain || meta.venue || null;
  const context = [
    chain,
    winRate != null ? `win ${(winRate * 100).toFixed(0)}% (${s.lands}/${s.submits})` : null,
    `net ${fmtSigned(sessionNet)}`,
    (tipSpend || gasSpend) ? `tip+gas ${(tipSpend + gasSpend).toFixed(3)}` : null,
  ].filter(Boolean);

  let lastAction;
  if (wedged) lastAction = `⚠ ${s.winSubmits} submitted, ${s.winLands} landed — losing the race`;
  else if (s.lastLand) lastAction = describe(s.lastLand);
  else if (s.lastMeaningful) lastAction = describe(s.lastMeaningful);
  else lastAction = 'connected — no opportunities';

  return {
    id: bot,
    shortId: bot.length > 12 ? bot.slice(0, 12) : bot,
    label: meta.name || prettify(bot),
    title: meta.strategy || prettify(bot),
    intent: meta.mandate || null,
    context,
    recent: s.recent.slice(-RING),
    lastAction,
    lastActivityTs: s.lastTs,
    statusInputs: { lastActivityTs: s.lastTs, wedged, bleeding, racing, winRate, sessionNet },
    // --- searcher passthrough (surfaces + risk views) ---
    bot, chain, winRate, sessionNet, tipSpend, gasSpend,
    submits: s.submits, lands: s.lands, reverts: s.reverts, wedged, bleeding,
  };
}

function status(rec, ctx) {
  // feed-dead is the absence of liveness: no heartbeat/opportunity in the window → disconnected.
  if (!ctx || !ctx.live) return 'feed-dead';
  const si = rec.statusInputs || {};
  if (si.wedged) return 'wedged';
  if (si.bleeding) return 'bleeding';
  if (si.racing) return 'racing';
  return 'idle';
}

const statuses = [
  { key: 'feed-dead', title: 'FEED-DEAD', word: 'disconnected', color: 'red' },
  { key: 'wedged', title: 'WEDGED', word: 'losing races', color: 'amber' },
  { key: 'bleeding', title: 'BLEEDING', word: 'net negative', color: 'amber' },
  { key: 'racing', title: 'RACING', word: 'landing', color: 'green' },
  { key: 'idle', title: 'IDLE', word: 'quiet', color: 'dim' },
];

// ---------------------------------------------------------------------------
// Control — append commands the searcher polls (via the shared file-trail writer). `unwind`
// flattens seized collateral and is destructive → the adapter requires a confirm token
// (command.confirm === 'unwind') in addition to the cockpit guard. broadcast refuses any
// destructive op, so the desk-wide button can only ever pause/resume the fleet — never unwind-all.
// ---------------------------------------------------------------------------
const CAPS = ['pause', 'resume', 'set-param', 'kill', 'unwind'];
const DESTRUCTIVE = new Set(['unwind']);

function writeControl(bot, command = {}) {
  const r = ft.writeControl(KIND, bot, command, { caps: CAPS, destructive: DESTRUCTIVE });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, bot: r.unit, command: r.command };
}

const control = {
  capabilities: CAPS,
  destructive: Array.from(DESTRUCTIVE),
  // Cockpit hint for the desk-wide band: the gas-spike/reorg panic stop is a non-destructive pause.
  broadcastUi: { cmd: 'pause', label: '⏸ Pause all searchers', danger: false },
  send(target, command) { return writeControl(target, command); },
  // unwind can NEVER be broadcast (per-unit confirm only) — enforced inside ft.broadcast.
  broadcast(command = {}) {
    return ft.broadcast(KIND, command, { caps: CAPS, destructive: DESTRUCTIVE, noDestructiveBroadcast: true });
  },
};

module.exports = { discover, liveness, parse, status, statuses, control, listSearchers, fleetRoot: ft.fleetRoot };
