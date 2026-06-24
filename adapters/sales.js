'use strict';

// Conductor adapter: a fleet of sales agents.
//
// A sales agent is a unit working a pipeline with intent — prospect, reach out,
// qualify, quote, forecast — under hard guardrails (spend caps, send governance,
// approval gates, a kill switch, an append-only audit). The operator supervises
// by exception, watching for the one that's HALTED (cap tripped / killed /
// paused), BLOCKED (a send refused by suppression or an unapproved template),
// or has work GATED (a quote or claim parked for a human). Sibling of the MEV
// searcher and trading-bot adapters: same "read a trail that already exists"
// pattern over ./_filetrail (append-only events.jsonl + control.jsonl).
//
// Each agent appends to ~/.fleet/sales/<agent>/events.jsonl, one JSON record
// per line — { ts, type, ... } where type ∈
//   work | spend | send | gate | exception | heartbeat
// exception carries { code, blocked?, halted? }; gate carries { kind, approvalId }.
// An optional meta.json gives { name, role, mandate }.
//
// Observation is read-only. Control appends pause | resume | set-param | kill to
// the agent's control.jsonl, which it polls. `kill` ends the process and is
// destructive → it carries an adapter-layer confirm token and can NEVER be
// broadcast. broadcast('pause') is the desk-wide stop (the supervisor's panic
// button) — non-destructive, so the whole office can be paused but never killed
// in one click.

const path = require('path');
const ft = require('./_filetrail');
const { clip, prettify } = require('../util');

const KIND = 'sales';
const FEED_MINUTES = 3;     // no heartbeat/work within this window → feed-dead (process gone)
const WINDOW_MINUTES = 10;  // recent window over which blocked/gating/working are judged
const RING = 12;            // recent non-heartbeat events surfaced per agent

// Governance codes that mean the agent has stopped doing useful work.
const HALT_CODES = new Set(['PAUSED', 'KILLED', 'OFFICE_CAP', 'AGENT_CAP', 'GLOBAL_CAP', 'AGENT_HALTED', 'ERROR', 'TICK_ERROR']);

function num(x) { return typeof x === 'number' && !isNaN(x) ? x : 0; }

function describe(ev) {
  switch (ev.type) {
    case 'send': return clip(`✉ ${ev.summary || ev.to || 'sent'}`, 80);
    case 'spend': return clip(`$${num(ev.usd).toFixed(4)} ${ev.summary || ''}`.trim(), 80);
    case 'gate': return clip(`⏸ ${ev.kind || 'GATE'} → human: ${ev.summary || ''}`.trim(), 80);
    case 'exception': return clip(`${ev.halted ? '■' : '⊘'} ${ev.code || 'GUARD'}: ${ev.summary || ''}`.trim(), 80);
    case 'work': return clip(ev.summary || ev.kind || 'work', 80);
    default: return clip(ev.type || 'event', 80);
  }
}

function listAgents() { return ft.listUnits(KIND); }
function discover() { return ft.discover(KIND); }

// Liveness is process-liveness: an agent is "live" only if it has heartbeat or
// work traffic within the window. Nothing → the CLI is gone → feed-dead.
function liveness(handles, opts = {}) {
  return ft.liveness(handles, (opts.feedMinutes || FEED_MINUTES) * 60000, { types: ['heartbeat', 'work', 'send'] });
}

async function parse(handle, opts = {}) {
  const dir = path.dirname(handle);
  const agent = ft.unitName(handle);
  if (!ft.safeName(agent)) return null;
  const meta = ft.readMeta(dir);

  const now = Date.now();
  const windowMs = (opts.windowMinutes || WINDOW_MINUTES) * 60000;
  const windowStart = now - windowMs;

  const s = {
    lastTs: 0,
    sends: 0, blocked: 0, gates: 0, work: 0,   // session counts
    winSends: 0, winBlocked: 0, winGates: 0, winWork: 0,
    spendUsd: 0,
    recent: [], lastMeaningful: null,
    lastHeartbeat: null, lastGovTs: 0, govHalted: false,
  };

  await ft.streamEvents(handle, (ev, t) => {
    if (!isNaN(t) && t > s.lastTs) s.lastTs = t;
    const inWindow = !isNaN(t) && t >= windowStart;
    switch (ev.type) {
      case 'send': s.sends++; if (inWindow) s.winSends++; break;
      case 'spend': s.spendUsd += num(ev.usd); break;
      case 'gate': s.gates++; if (inWindow) s.winGates++; break;
      case 'work': s.work++; if (inWindow) s.winWork++; break;
      case 'exception':
        if (ev.blocked) { s.blocked++; if (inWindow) s.winBlocked++; }
        // Latest governance signal wins: a halt sets halted; any later work/resume clears it.
        if (!isNaN(t) && t >= s.lastGovTs) { s.lastGovTs = t; s.govHalted = !!(ev.halted || HALT_CODES.has(ev.code)); }
        break;
      case 'heartbeat':
        s.lastHeartbeat = ev;
        // A heartbeat without paused:true means the agent is ticking normally → not halted.
        if (!isNaN(t) && t >= s.lastGovTs) { s.lastGovTs = t; s.govHalted = !!ev.paused; }
        break;
      default: break;
    }
    if (ev.type !== 'heartbeat') {
      s.lastMeaningful = ev;
      s.recent.push({ actor: 'agent', kind: ev.type, summary: describe(ev), ts: isNaN(t) ? 0 : t });
      if (s.recent.length > RING) s.recent.shift();
    }
  });

  if (!s.lastTs && !s.recent.length) return null; // empty trail

  const halted = s.govHalted;
  const blocking = !halted && s.winBlocked > 0;     // sends refused this window (suppression / unapproved)
  const gating = !halted && !blocking && s.winGates > 0; // work parked for a human
  const working = !halted && !blocking && !gating && (s.winSends > 0 || s.winWork > 0);

  const context = [
    meta.role || null,
    s.sends ? `sent ${s.sends}` : null,
    s.gates ? `gated ${s.gates}` : null,
    s.blocked ? `blocked ${s.blocked}` : null,
    s.spendUsd ? `$${s.spendUsd.toFixed(2)}` : null,
  ].filter(Boolean);

  let lastAction;
  if (halted) lastAction = `■ ${haltReason(s)}`;
  else if (s.lastMeaningful) lastAction = describe(s.lastMeaningful);
  else lastAction = 'online — quiet';

  return {
    id: agent,
    shortId: agent.length > 12 ? agent.slice(0, 12) : agent,
    label: meta.name || prettify(agent),
    title: meta.role || prettify(agent),
    intent: meta.mandate || null,
    context,
    recent: s.recent.slice(-RING),
    lastAction,
    lastActivityTs: s.lastTs,
    statusInputs: { lastActivityTs: s.lastTs, halted, blocking, gating, working },
    // --- sales passthrough ---
    agent, role: meta.role || null,
    sends: s.sends, blocked: s.blocked, gates: s.gates, spendUsd: s.spendUsd, halted,
  };
}

function haltReason(s) {
  if (s.lastHeartbeat && s.lastHeartbeat.paused) return 'paused';
  const ex = [...s.recent].reverse().find(r => r.kind === 'exception');
  return ex ? ex.summary.replace(/^[■⊘]\s*/, '') : 'halted';
}

function status(rec, ctx) {
  // feed-dead is the absence of liveness: no heartbeat/work in the window → process gone.
  if (!ctx || !ctx.live) return 'feed-dead';
  const si = rec.statusInputs || {};
  if (si.halted) return 'halted';
  if (si.blocking) return 'blocked';
  if (si.gating) return 'gated';
  if (si.working) return 'working';
  return 'idle';
}

const statuses = [
  { key: 'feed-dead', title: 'FEED-DEAD', word: 'process gone', color: 'red' },
  { key: 'halted', title: 'HALTED', word: 'cap/kill/pause', color: 'red' },
  { key: 'blocked', title: 'BLOCKED', word: 'send refused', color: 'amber' },
  { key: 'gated', title: 'GATED', word: 'awaiting human', color: 'amber' },
  { key: 'working', title: 'WORKING', word: 'in pipeline', color: 'green' },
  { key: 'idle', title: 'IDLE', word: 'quiet', color: 'dim' },
];

// ---------------------------------------------------------------------------
// Control — append commands the agent polls. `kill` ends the process and is
// destructive → the adapter requires a confirm token (command.confirm === 'kill')
// on top of the cockpit guard, and ft.broadcast refuses to broadcast it. The
// desk-wide button can therefore only ever pause/resume the office — never kill it.
// ---------------------------------------------------------------------------
const CAPS = ['pause', 'resume', 'set-param', 'kill'];
const DESTRUCTIVE = new Set(['kill']);

function writeControl(agent, command = {}) {
  const r = ft.writeControl(KIND, agent, command, { caps: CAPS, destructive: DESTRUCTIVE });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, agent: r.unit, command: r.command };
}

const control = {
  capabilities: CAPS,
  destructive: Array.from(DESTRUCTIVE),
  broadcastUi: { cmd: 'pause', label: '⏸ Pause all sales agents', danger: false },
  send(target, command) { return writeControl(target, command); },
  // kill can NEVER be broadcast (per-agent confirm only) — enforced inside ft.broadcast.
  broadcast(command = {}) {
    return ft.broadcast(KIND, command, { caps: CAPS, destructive: DESTRUCTIVE, noDestructiveBroadcast: true });
  },
};

module.exports = { discover, liveness, parse, status, statuses, control, listAgents, fleetRoot: ft.fleetRoot };
