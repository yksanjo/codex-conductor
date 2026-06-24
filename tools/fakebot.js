#!/usr/bin/env node
'use strict';

// fakebot — emit a realistic ~/.fleet/bots/<name>/events.jsonl so the fleet adapter (and its
// tests) have something to read without a live venue. Writes a full scenario one-shot, then
// exits. Zero dependencies.
//
//   node tools/fakebot.js <name> [--scenario healthy|wedged|drawdown|stale]
//                                [--dir <fleet-root>] [--venue Hyperliquid]
//                                [--now <ms-epoch>]   # deterministic timestamps (tests)
//
// Scenarios:
//   healthy   live heartbeats, a filled long, positive PnL          → TRADING
//   wedged    live heartbeats but an order placed 10m ago, no fill   → WEDGED
//   drawdown  live heartbeats, equity down 15% off its peak          → DRAWDOWN
//   stale     last activity 30m ago                                  → IDLE

const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const a = { name: null, scenario: 'healthy', dir: process.env.FLEET_DIR || path.join(os.homedir(), '.fleet'), venue: 'Hyperliquid', now: Date.now() };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--scenario') a.scenario = argv[++i];
    else if (v === '--dir') a.dir = argv[++i];
    else if (v === '--venue') a.venue = argv[++i];
    else if (v === '--now') a.now = parseInt(argv[++i], 10);
    else if (!a.name && !v.startsWith('--')) a.name = v;
  }
  return a;
}

const MIN = 60000;

function scenario(name, kind, now) {
  const ev = [];
  const at = (msAgo) => now - msAgo;
  const meta = {
    name: name,
    strategy: { healthy: 'momentum', wedged: 'mean-reversion', drawdown: 'breakout', stale: 'scalper' }[kind] || 'momentum',
    mandate: 'paper desk — prove edge before real capital',
    venue: null, // filled by caller
    symbol: 'SOL',
  };

  if (kind === 'stale') {
    ev.push({ ts: at(35 * MIN), type: 'heartbeat' });
    ev.push({ ts: at(34 * MIN), type: 'signal', side: 'buy', reason: 'momentum' });
    ev.push({ ts: at(33 * MIN), type: 'order', side: 'buy', qty: 0.5, price: 142.1 });
    ev.push({ ts: at(33 * MIN), type: 'fill', side: 'buy', qty: 0.5, price: 142.2 });
    ev.push({ ts: at(32 * MIN), type: 'pnl', realized: 0, unrealized: 1.2, equity: 1001.2 });
    ev.push({ ts: at(30 * MIN), type: 'heartbeat' });
    return { meta, ev };
  }

  // a few minutes of warmup heartbeats common to the live scenarios
  for (let m = 6; m >= 3; m--) ev.push({ ts: at(m * MIN), type: 'heartbeat' });

  if (kind === 'healthy') {
    ev.push({ ts: at(150000), type: 'signal', side: 'buy', reason: 'momentum cross' });
    ev.push({ ts: at(140000), type: 'order', side: 'buy', qty: 0.5, price: 142.1 });
    ev.push({ ts: at(138000), type: 'fill', side: 'buy', qty: 0.5, price: 142.2 });
    ev.push({ ts: at(120000), type: 'pnl', realized: 0, unrealized: 2.3, equity: 1002.3 });
    ev.push({ ts: at(60000), type: 'pnl', realized: 0, unrealized: 3.1, equity: 1003.1 });
    ev.push({ ts: at(5000), type: 'heartbeat' });
  } else if (kind === 'wedged') {
    // an order placed 10 minutes ago that never filled — but the bot is still heartbeating.
    ev.push({ ts: at(11 * MIN), type: 'signal', side: 'buy', reason: 'reversion' });
    ev.push({ ts: at(10 * MIN), type: 'order', side: 'buy', qty: 1.0, price: 139.0 });
    ev.push({ ts: at(120000), type: 'heartbeat' });
    ev.push({ ts: at(60000), type: 'heartbeat' });
    ev.push({ ts: at(4000), type: 'heartbeat' });
  } else if (kind === 'drawdown') {
    ev.push({ ts: at(8 * MIN), type: 'signal', side: 'buy', reason: 'breakout' });
    ev.push({ ts: at(7 * MIN), type: 'order', side: 'buy', qty: 2.0, price: 150.0 });
    ev.push({ ts: at(7 * MIN - 1000), type: 'fill', side: 'buy', qty: 2.0, price: 150.0 });
    ev.push({ ts: at(6 * MIN), type: 'pnl', realized: 0, unrealized: 0, equity: 1000 });   // peak
    ev.push({ ts: at(3 * MIN), type: 'pnl', realized: -120, unrealized: -30, equity: 850 }); // -15%
    ev.push({ ts: at(5000), type: 'heartbeat' });
  }
  return { meta, ev };
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.name) { console.error('usage: fakebot <name> [--scenario healthy|wedged|drawdown|stale] [--dir <root>]'); process.exit(1); }
  if (!Number.isFinite(a.now)) { console.error('fakebot: --now must be an ms epoch'); process.exit(1); }
  const { meta, ev } = scenario(a.name, a.scenario, a.now);
  meta.venue = a.venue;
  const dir = path.join(a.dir, 'bots', a.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), ev.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`fakebot "${a.name}" (${a.scenario}) → ${dir}/events.jsonl  (${ev.length} events)`);
}

main();
