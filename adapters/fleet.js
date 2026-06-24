'use strict';

// Conductor adapter: trading-bot fleet.
//
// The first new use case beyond Claude Code — proof that the engine is genuinely
// source-agnostic. Convention-over-config, mirroring Conductor's "read a trail that already
// exists" ethos: each bot writes an append-only event log at
//   ~/.fleet/bots/<bot>/events.jsonl
// one JSON record per line: { ts, type, ... } where type ∈
//   signal | order | fill | pnl | heartbeat | error
// An optional ~/.fleet/bots/<bot>/meta.json gives { strategy, mandate, venue, symbol }.
//
// Observation is read-only. Control is opt-in: commands are appended to
//   ~/.fleet/bots/<bot>/control.jsonl
// which the bot itself polls. Capabilities: pause | resume | flatten | set-param.
// broadcast('flatten') is the desk-wide panic flatten (the cockpit gates it behind a confirm token).
//
// The append-only-trail plumbing (discover / tail / stream / control-write) is shared with the
// MEV-searcher adapter via ./_filetrail; only the domain parsing below is bot-specific.

const path = require('path');
const ft = require('./_filetrail');
const { clip, prettify } = require('../util');

const KIND = 'bots';
const LIVE_MINUTES = 2;       // a bot is "live" if it emitted anything within this window
const WEDGE_MINUTES = 5;      // an order/signal with no fill older than this = wedged
const DRAWDOWN_PCT = 0.1;     // equity off its peak by this fraction = drawdown signal
const RING = 12;              // recent non-heartbeat events surfaced per bot

function tsOf(r) { return ft.tsOf(r); }

function sideSign(side) {
  const s = String(side || '').toLowerCase();
  if (s === 'buy' || s === 'long' || s === 'b' || s === 'bid') return 1;
  if (s === 'sell' || s === 'short' || s === 's' || s === 'ask') return -1;
  return 0;
}

function fmtSigned(n) {
  if (n == null || isNaN(n)) return '0';
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return (r >= 0 ? '+' : '') + r;
}

function describe(ev) {
  const px = ev.price != null ? ' @ ' + ev.price : '';
  switch (ev.type) {
    case 'signal': return clip(`signal ${ev.side || ''} ${ev.reason || ''}`.trim(), 80);
    case 'order': return clip(`order ${ev.side || ''} ${ev.qty != null ? ev.qty : ''}${px}`.trim(), 80);
    case 'fill': return clip(`filled ${ev.side || ''} ${ev.qty != null ? ev.qty : ''}${px}`.trim(), 80);
    case 'pnl': return `pnl ${fmtSigned(ev.pnl != null ? ev.pnl : (ev.realized || 0) + (ev.unrealized || 0))}`;
    case 'error': return clip('error: ' + (ev.message || 'unknown'), 80);
    case 'heartbeat': return 'heartbeat';
    default: return clip(ev.type || 'event', 80);
  }
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

function listBots() { return ft.listUnits(KIND); }
function discover() { return ft.discover(KIND); }

function liveness(handles, opts = {}) {
  return ft.liveness(handles, (opts.liveMinutes || LIVE_MINUTES) * 60000);
}

async function parse(handle, opts = {}) {
  const dir = path.dirname(handle);
  const bot = ft.unitName(handle);
  if (!ft.safeName(bot)) return null;
  const meta = ft.readMeta(dir);

  const s = {
    lastTs: 0, lastFillTs: 0, lastOrderSignalTs: 0,
    position: 0, sessionPnl: null, equity: null, peakEquity: null,
    recent: [], lastMeaningful: null, lastOrderSignal: null,
  };

  await ft.streamEvents(handle, (ev, t) => {
    if (!isNaN(t) && t > s.lastTs) s.lastTs = t;
    switch (ev.type) {
      case 'fill': {
        s.position += sideSign(ev.side) * (Number(ev.qty) || 0);
        if (!isNaN(t)) s.lastFillTs = Math.max(s.lastFillTs, t);
        break;
      }
      case 'order':
      case 'signal':
        if (!isNaN(t) && t >= s.lastOrderSignalTs) { s.lastOrderSignalTs = t; s.lastOrderSignal = ev; }
        break;
      case 'pnl': {
        s.sessionPnl = ev.pnl != null ? ev.pnl : (ev.realized || 0) + (ev.unrealized || 0);
        if (ev.equity != null) {
          s.equity = ev.equity;
          s.peakEquity = s.peakEquity == null ? ev.equity : Math.max(s.peakEquity, ev.equity);
        }
        break;
      }
      case 'heartbeat': break;
      case 'error': break;
      default: break;
    }
    if (ev.type !== 'heartbeat') {
      s.lastMeaningful = ev;
      s.recent.push({ actor: 'bot', kind: ev.type, summary: describe(ev), ts: isNaN(t) ? 0 : t });
      if (s.recent.length > RING) s.recent.shift();
    }
  });

  if (!s.lastTs && !s.recent.length) return null; // empty trail

  const now = Date.now();
  const wedgeMs = (opts.wedgeMinutes || WEDGE_MINUTES) * 60000;
  const ddThresh = opts.drawdownPct || DRAWDOWN_PCT;
  // wedged: an order/signal with no fill after it, older than the threshold.
  const wedged = s.lastOrderSignalTs > 0 && s.lastOrderSignalTs > s.lastFillTs
    && (now - s.lastOrderSignalTs) > wedgeMs;
  const drawdownPct = (s.peakEquity && s.peakEquity > 0 && s.equity != null)
    ? Math.max(0, (s.peakEquity - s.equity) / s.peakEquity) : 0;
  const drawdown = drawdownPct >= ddThresh;

  const venue = meta.venue || null;
  const posStr = s.position === 0 ? 'flat' : `pos ${fmtSigned(s.position)}${meta.symbol ? ' ' + meta.symbol : ''}`;
  const context = [
    venue,
    posStr,
    s.sessionPnl != null ? `PnL ${fmtSigned(s.sessionPnl)}` : null,
    drawdown ? `DD ${(drawdownPct * 100).toFixed(0)}%` : null,
  ].filter(Boolean);

  const lastAction = wedged && s.lastOrderSignal
    ? `⚠ ${describe(s.lastOrderSignal)} — awaiting fill`
    : (s.lastMeaningful ? describe(s.lastMeaningful) : 'idle');

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
    statusInputs: { lastActivityTs: s.lastTs, wedged, drawdown, drawdownPct, sessionPnl: s.sessionPnl, position: s.position },
    // --- fleet passthrough (surfaces + risk_snapshot) ---
    bot, venue, position: s.position, sessionPnl: s.sessionPnl,
    equity: s.equity, drawdownPct, wedged, drawdown,
  };
}

function status(rec, ctx) {
  const si = rec.statusInputs || {};
  if (si.wedged) return 'wedged';
  if (si.drawdown) return 'drawdown';
  if (ctx && ctx.live) return 'active';
  return 'idle';
}

const statuses = [
  { key: 'wedged', title: 'WEDGED', word: 'wedged', color: 'red' },
  { key: 'drawdown', title: 'DRAWDOWN', word: 'drawdown', color: 'amber' },
  { key: 'active', title: 'TRADING', word: 'live', color: 'green' },
  { key: 'idle', title: 'IDLE', word: 'idle', color: 'dim' },
];

// ---------------------------------------------------------------------------
// Control — append commands the bot polls (via the shared file-trail writer). Bot names are
// validated (no traversal); commands are written as structured JSON, never interpolated into a
// shell. `flatten` is money-moving → destructive: it requires a confirm token (command.confirm ===
// 'flatten') AT THE ADAPTER LAYER, independent of the cockpit's own guard, so flatten is gated even
// when driven directly (MCP / script / test) — matching mev/validator's defense in depth. Unlike
// those adapters, fleet DOES let flatten be broadcast (the desk-wide panic-flatten is the marquee
// feature), but the broadcast must carry the same confirm token, which the cockpit double-confirms.
// ---------------------------------------------------------------------------
const CAPS = ['pause', 'resume', 'flatten', 'set-param'];
const DESTRUCTIVE = new Set(['flatten']);

function writeControl(bot, command = {}) {
  const r = ft.writeControl(KIND, bot, command, { caps: CAPS, destructive: DESTRUCTIVE });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, bot: r.unit, command: r.command };
}

const control = {
  capabilities: CAPS,
  destructive: Array.from(DESTRUCTIVE),
  // Cockpit hint for the desk-wide band: which broadcast this fleet offers + whether it's dangerous.
  broadcastUi: { cmd: 'flatten', label: '🛑 Flatten all bots', danger: true },
  send(target, command) { return writeControl(target, command); },
  // The desk-wide panic-flatten is allowed, but a destructive broadcast must carry the confirm
  // token just like a single send — enforced inside ft.broadcast (one shared copy of the policy).
  broadcast(command = {}) {
    return ft.broadcast(KIND, command, { caps: CAPS, destructive: DESTRUCTIVE });
  },
};

module.exports = { discover, liveness, parse, status, statuses, control, listBots, fleetRoot: ft.fleetRoot };
