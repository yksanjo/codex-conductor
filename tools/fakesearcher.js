#!/usr/bin/env node
'use strict';

// fakesearcher — emit a realistic ~/.fleet/searchers/<name>/events.jsonl so the MEV-searcher
// adapter (and its tests) have something to read without a live chain. Writes a full scenario
// one-shot, then exits. Zero dependencies. Mirrors tools/fakebot.js.
//
//   node tools/fakesearcher.js <name> [--scenario racing|wedged|bleeding|feed-dead|idle]
//                                     [--dir <fleet-root>] [--chain Solana]
//                                     [--now <ms-epoch>]   # deterministic timestamps (tests)
//
// Event stream (one JSON record per line, { ts, type, ... }):
//   opportunity   a profitable arb/liq seen in the orderflow
//   bundle        a bundle built (carries a tip)
//   submit        the bundle submitted to the block engine
//   land          the bundle landed → { pnl (net of tip+gas), tip, gas, protocol }
//   revert        the bundle reverted / lost the race → { cost (gas burned) }
//   pnl           authoritative running session pnl snapshot → { net, tips, gas }
//   gas           a gas-spend tick (informational)
//   heartbeat     liveness ping (feed alive)
//   error         something went wrong
//
// Scenarios:
//   racing     lands bundles, positive net flow                        → RACING
//   wedged     submits a flurry of bundles, ~nothing lands             → WEDGED
//   bleeding   lands some, but tips+gas outrun profit → net negative   → BLEEDING
//   feed-dead  last heartbeat/opportunity 8m ago (disconnected)        → FEED-DEAD
//   idle       connected + heartbeating, but no opportunities seen     → IDLE

const fs = require('fs');
const path = require('path');
const os = require('os');

function parseArgs(argv) {
  const a = { name: null, scenario: 'racing', dir: process.env.FLEET_DIR || path.join(os.homedir(), '.fleet'), chain: 'Solana', now: Date.now() };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--scenario') a.scenario = argv[++i];
    else if (v === '--dir') a.dir = argv[++i];
    else if (v === '--chain') a.chain = argv[++i];
    else if (v === '--now') a.now = parseInt(argv[++i], 10);
    else if (!a.name && !v.startsWith('--')) a.name = v;
  }
  return a;
}

const MIN = 60000;
const SEC = 1000;

function scenario(name, kind, now) {
  const ev = [];
  const at = (msAgo) => now - msAgo;
  const meta = {
    name,
    strategy: { racing: 'jito-arb', wedged: 'jito-arb', bleeding: 'cex-dex-arb', 'feed-dead': 'liquidations', idle: 'liquidations' }[kind] || 'jito-arb',
    mandate: 'win profitable bundles net of tips + gas',
    chain: null, // filled by caller
    venue: 'Jito block engine',
  };

  if (kind === 'feed-dead') {
    // was racing, then the orderflow feed dropped 8 minutes ago — no heartbeat/opportunity since.
    ev.push({ ts: at(12 * MIN), type: 'heartbeat' });
    ev.push({ ts: at(11 * MIN), type: 'opportunity', kind: 'arb', est: 0.9, route: 'SOL/USDC' });
    ev.push({ ts: at(10 * MIN + 50 * SEC), type: 'bundle', id: 'b1', tip: 0.05 });
    ev.push({ ts: at(10 * MIN + 40 * SEC), type: 'submit', id: 'b1' });
    ev.push({ ts: at(10 * MIN + 30 * SEC), type: 'land', id: 'b1', pnl: 0.6, tip: 0.05, gas: 0.01, protocol: 'Raydium' });
    ev.push({ ts: at(9 * MIN), type: 'pnl', net: 0.6, tips: 0.05, gas: 0.01 });
    ev.push({ ts: at(8 * MIN), type: 'heartbeat' });
    return { meta, ev };
  }

  // a few minutes of warmup heartbeats common to the live scenarios
  for (let m = 6; m >= 4; m--) ev.push({ ts: at(m * MIN), type: 'heartbeat' });

  if (kind === 'idle') {
    // connected + heartbeating, but a quiet market: no opportunities, no bundles.
    ev.push({ ts: at(3 * MIN), type: 'heartbeat' });
    ev.push({ ts: at(2 * MIN), type: 'heartbeat' });
    ev.push({ ts: at(1 * MIN), type: 'heartbeat' });
    ev.push({ ts: at(8 * SEC), type: 'heartbeat' });
    return { meta, ev };
  }

  if (kind === 'racing') {
    let net = 0, tips = 0, gas = 0;
    const lands = [
      [3 * MIN, 'l1', 0.42, 0.04, 0.01, 'Raydium'],
      [2 * MIN, 'l2', 0.31, 0.03, 0.01, 'Orca'],
      [70 * SEC, 'l3', 0.55, 0.05, 0.01, 'Kamino'],
    ];
    for (const [ago, id, pnl, tip, g, proto] of lands) {
      ev.push({ ts: at(ago + 8 * SEC), type: 'opportunity', kind: 'arb', est: pnl + tip, route: proto });
      ev.push({ ts: at(ago + 5 * SEC), type: 'bundle', id, tip });
      ev.push({ ts: at(ago + 3 * SEC), type: 'submit', id });
      ev.push({ ts: at(ago), type: 'land', id, pnl, tip, gas: g, protocol: proto });
      net += pnl; tips += tip; gas += g;
      ev.push({ ts: at(ago - 1 * SEC), type: 'pnl', net: +net.toFixed(4), tips: +tips.toFixed(4), gas: +gas.toFixed(4) });
    }
    // a couple of lost races mixed in (normal) — does not flip the net negative.
    ev.push({ ts: at(40 * SEC), type: 'submit', id: 'l4' });
    ev.push({ ts: at(38 * SEC), type: 'revert', id: 'l4', cost: 0.01 });
    ev.push({ ts: at(6 * SEC), type: 'heartbeat' });
    return { meta, ev };
  }

  if (kind === 'wedged') {
    // a flurry of submitted bundles but almost nothing lands — losing every race.
    ev.push({ ts: at(3 * MIN), type: 'opportunity', kind: 'arb', est: 0.4, route: 'SOL/USDC' });
    const submits = [170, 150, 130, 110, 90, 70, 50, 30];
    let id = 1;
    for (const s of submits) {
      const sid = 'w' + (id++);
      ev.push({ ts: at(s * SEC + 4 * SEC), type: 'bundle', id: sid, tip: 0.03 });
      ev.push({ ts: at(s * SEC + 2 * SEC), type: 'submit', id: sid });
      ev.push({ ts: at(s * SEC), type: 'revert', id: sid, cost: 0.004 });
    }
    ev.push({ ts: at(12 * SEC), type: 'pnl', net: -0.032, tips: 0, gas: 0.032 });
    ev.push({ ts: at(5 * SEC), type: 'heartbeat' });
    return { meta, ev };
  }

  if (kind === 'bleeding') {
    // landing bundles, but tips + gas outrun the gross profit → net negative over the window.
    let net = 0, tips = 0, gas = 0;
    const lands = [
      [3 * MIN, 'd1', -0.08, 0.12, 0.02, 'Drift'],   // overpaid the tip
      [2 * MIN, 'd2', -0.05, 0.10, 0.02, 'MarginFi'],
      [60 * SEC, 'd3', -0.07, 0.11, 0.02, 'Kamino'],
    ];
    for (const [ago, id, pnl, tip, g, proto] of lands) {
      ev.push({ ts: at(ago + 6 * SEC), type: 'opportunity', kind: 'liq', est: 0.2, protocol: proto });
      ev.push({ ts: at(ago + 4 * SEC), type: 'bundle', id, tip });
      ev.push({ ts: at(ago + 2 * SEC), type: 'submit', id });
      ev.push({ ts: at(ago), type: 'land', id, pnl, tip, gas: g, protocol: proto });
      net += pnl; tips += tip; gas += g;
      ev.push({ ts: at(ago - 1 * SEC), type: 'pnl', net: +net.toFixed(4), tips: +tips.toFixed(4), gas: +gas.toFixed(4) });
    }
    ev.push({ ts: at(6 * SEC), type: 'heartbeat' });
    return { meta, ev };
  }

  return { meta, ev };
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.name) { console.error('usage: fakesearcher <name> [--scenario racing|wedged|bleeding|feed-dead|idle] [--dir <root>]'); process.exit(1); }
  if (!Number.isFinite(a.now)) { console.error('fakesearcher: --now must be an ms epoch'); process.exit(1); }
  const { meta, ev } = scenario(a.name, a.scenario, a.now);
  meta.chain = a.chain;
  const dir = path.join(a.dir, 'searchers', a.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), ev.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`fakesearcher "${a.name}" (${a.scenario}) → ${dir}/events.jsonl  (${ev.length} events)`);
}

main();
