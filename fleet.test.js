#!/usr/bin/env node
'use strict';

// No-mock tests for the trading-bot fleet adapter. Spins up real bot trails with tools/fakebot.js
// into an isolated FLEET_DIR, runs them through the real engine, and asserts parsing, liveness,
// the wedged/drawdown signals, and control writes. Zero dependencies.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-fleet-'));
process.env.FLEET_DIR = root;                 // isolate the fleet root before requiring the adapter

const engine = require('./engine');
const fleet = require('./adapters/fleet');

const NOW = Date.now();
function makeBot(name, sc) {
  execFileSync('node', [path.join(__dirname, 'tools', 'fakebot.js'), name, '--scenario', sc, '--dir', root, '--now', String(NOW)],
    { encoding: 'utf8' });
}

(async () => {
  console.log('conductor fleet adapter tests:');

  makeBot('alpha-momentum', 'healthy');
  makeBot('beta-revert', 'wedged');
  makeBot('gamma-breakout', 'drawdown');
  makeBot('delta-scalp', 'stale');

  // a malformed trail must not crash the scan
  fs.writeFileSync(path.join(root, 'bots', 'beta-revert', 'events.jsonl'),
    fs.readFileSync(path.join(root, 'bots', 'beta-revert', 'events.jsonl'), 'utf8') + 'not json\n{broken\n');

  const rows = await engine.collect(fleet, {});
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  ok('discovers all four bots', rows.length === 4);
  ok('healthy bot is TRADING (active)', by['alpha-momentum'].status === 'active');
  ok('wedged bot is WEDGED', by['beta-revert'].status === 'wedged');
  ok('drawdown bot is DRAWDOWN', by['gamma-breakout'].status === 'drawdown');
  ok('stale bot is IDLE (no recent activity)', by['delta-scalp'].status === 'idle');

  // sorting follows the adapter status order: wedged → drawdown → active → idle
  ok('rows sorted by status priority (problems first)',
    rows[0].status === 'wedged' && rows[rows.length - 1].status === 'idle');

  // parse: meta + aggregates
  const h = by['alpha-momentum'];
  ok('meta strategy → title', h.title === 'momentum');
  ok('meta mandate → intent', /paper desk/.test(h.intent));
  ok('venue from meta', h.venue === 'Hyperliquid');
  ok('position computed from fills (+0.5 long)', h.position === 0.5);
  ok('session PnL surfaced', h.sessionPnl === 3.1);
  ok('context chips include venue + position + PnL', h.context.includes('Hyperliquid') && h.context.some((c) => /PnL/.test(c)));
  ok('lastAction describes the latest meaningful event', typeof h.lastAction === 'string' && h.lastAction.length > 0);
  ok('recent events normalized {actor:bot}', h.recent.length > 0 && h.recent.every((e) => e.actor === 'bot'));

  // wedged signal detail
  const w = by['beta-revert'];
  ok('wedged statusInputs flag set', w.statusInputs.wedged === true);
  ok('wedged lastAction calls out the unfilled order', /awaiting fill/.test(w.lastAction));

  // drawdown signal detail
  const d = by['gamma-breakout'];
  ok('drawdown statusInputs flag set', d.statusInputs.drawdown === true);
  ok('drawdownPct ≈ 15%', Math.abs(d.drawdownPct - 0.15) < 1e-9);
  ok('drawdown context chip present', d.context.some((c) => /DD/.test(c)));

  // liveness is independent of status: the stale bot is not in the live set
  const handles = fleet.discover();
  const live = fleet.liveness(handles, {});
  const staleHandle = path.join(root, 'bots', 'delta-scalp', 'events.jsonl');
  const healthyHandle = path.join(root, 'bots', 'alpha-momentum', 'events.jsonl');
  ok('liveness includes a heartbeating bot', live.has(healthyHandle));
  ok('liveness excludes a stale bot', !live.has(staleHandle));

  // --- control: writes commands the bot would poll ---
  const caps = fleet.control.capabilities;
  ok('control advertises pause/resume/flatten/set-param', ['pause', 'resume', 'flatten', 'set-param'].every((c) => caps.includes(c)));

  const pr = fleet.control.send('alpha-momentum', { cmd: 'pause' });
  ok('control.send(pause) reports ok', pr.ok === true);
  const ctrlFile = path.join(root, 'bots', 'alpha-momentum', 'control.jsonl');
  const ctrlLines = fs.readFileSync(ctrlFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('pause command appended to control.jsonl', ctrlLines.some((c) => c.cmd === 'pause'));

  const sp = fleet.control.send('alpha-momentum', { cmd: 'set-param', key: 'maxPos', value: 1 });
  ok('control.send(set-param) carries key/value', sp.ok && sp.command.key === 'maxPos' && sp.command.value === 1);

  const bad = fleet.control.send('alpha-momentum', { cmd: 'rm -rf' });
  ok('control rejects an unknown command', bad.ok === false);

  const traversal = fleet.control.send('../../etc', { cmd: 'flatten' });
  ok('control rejects a path-traversal bot name', traversal.ok === false);

  // --- destructive gate: flatten is money-moving → confirm token required AT THE ADAPTER LAYER,
  // so it's gated even when driven directly (MCP / script), not just via the cockpit ---
  ok('flatten advertised as destructive', fleet.control.destructive.includes('flatten'));
  const flatNoTok = fleet.control.send('alpha-momentum', { cmd: 'flatten' });
  ok('control.send(flatten) WITHOUT confirm token → rejected', flatNoTok.ok === false);
  const flatTok = fleet.control.send('alpha-momentum', { cmd: 'flatten', confirm: 'flatten' });
  ok('control.send(flatten) WITH confirm token → ok', flatTok.ok === true);
  const ctrlAfter = fs.readFileSync(ctrlFile, 'utf8');
  ok('persisted flatten command never stores the confirm token', !/"confirm"/.test(ctrlAfter));

  // --- broadcast: desk-wide panic flatten reaches every bot, but still needs the token ---
  const bcNoTok = fleet.control.broadcast({ cmd: 'flatten' });
  ok('broadcast(flatten) WITHOUT confirm token → rejected', bcNoTok.ok === false);
  const bc = fleet.control.broadcast({ cmd: 'flatten', confirm: 'flatten' });
  ok('broadcast(flatten) WITH token hits all bots', bc.ok && bc.sent === 4 && bc.total === 4);
  const flattenedEverywhere = ['alpha-momentum', 'beta-revert', 'gamma-breakout', 'delta-scalp'].every((b) => {
    const f = path.join(root, 'bots', b, 'control.jsonl');
    return fs.existsSync(f) && /"cmd":"flatten"/.test(fs.readFileSync(f, 'utf8'));
  });
  ok('every bot received the flatten command', flattenedEverywhere);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} assertions passed.`);
})().catch((e) => { console.error('FAIL:', e.message); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} process.exit(1); });
