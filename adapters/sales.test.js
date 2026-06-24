#!/usr/bin/env node
'use strict';

// No-mock tests for the sales-agent fleet adapter. Writes real agent trails into an isolated
// FLEET_DIR, runs them through the real engine, and asserts the status mapping (feed-dead vs
// halted vs blocked vs gated vs working vs idle), the control gate (kill needs a confirm token),
// and that the destructive `kill` can never be broadcast (the desk-wide button only pauses).
// Zero dependencies.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-sales-'));
process.env.FLEET_DIR = root;                 // isolate the fleet root before requiring the adapter

const engine = require('../engine');
const sales = require('./sales');

const NOW = Date.now();
const ago = (min) => NOW - min * 60000;

// Write a real trail: meta.json + events.jsonl from a list of records.
function makeAgent(name, role, events) {
  const dir = path.join(root, 'sales', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ name: `${name} ${role}`, role, mandate: `${role} mandate` }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

(async () => {
  console.log('conductor sales adapter tests:');

  // WORKING — heartbeat + a send + work this window
  makeAgent('A2', 'Outreach', [
    { ts: ago(1), type: 'work', summary: 'online' },
    { ts: ago(1), type: 'spend', usd: 0.0014, summary: '$0.0014 llm:mid' },
    { ts: ago(1), type: 'send', to: 'ops@x.example', domain: 'x.example', summary: '→ ops@x.example (incident-pitch)' },
    { ts: ago(1), type: 'heartbeat' },
  ]);

  // BLOCKED — a send refused by suppression this window (supervise by exception)
  makeAgent('A2b', 'Outreach', [
    { ts: ago(1), type: 'send', to: 'a@x.example', domain: 'x.example', summary: '→ a@x.example' },
    { ts: ago(1), type: 'exception', code: 'SUPPRESSED', blocked: true, summary: 'SUPPRESSED: trust@x is on the suppression list' },
    { ts: ago(1), type: 'heartbeat' },
  ]);

  // GATED — a quote parked for a human, nothing blocked
  makeAgent('A4', 'Proposal', [
    { ts: ago(1), type: 'gate', kind: 'QUOTE_GATED', approvalId: 'AP-1', summary: 'ECマート ¥2,160,000' },
    { ts: ago(1), type: 'heartbeat' },
  ]);

  // HALTED — paused by the operator (latest heartbeat carries paused:true)
  makeAgent('A1', 'Prospector', [
    { ts: ago(2), type: 'work', summary: 'scored 9' },
    { ts: ago(1), type: 'exception', code: 'PAUSED', halted: true, summary: 'paused by operator' },
    { ts: ago(1), type: 'heartbeat', paused: true },
  ]);

  // HALTED via office cap — it tripped, then keeps emitting paused heartbeats
  // (so it stays live-but-halted, not feed-dead).
  makeAgent('A5', 'Pipeline', [
    { ts: ago(2), type: 'exception', code: 'OFFICE_CAP', halted: true, summary: 'office at $1700.00 / $1700 — halting' },
    { ts: ago(1), type: 'heartbeat', paused: true },
  ]);

  // FEED-DEAD — only stale traffic, well outside the liveness window
  makeAgent('A6', 'Intelligence', [
    { ts: ago(30), type: 'work', summary: 'intel digest' },
    { ts: ago(30), type: 'heartbeat' },
  ]);

  // IDLE — alive (recent heartbeat) but no sends/work/gates/blocks this window
  makeAgent('A3', 'Qualifier', [
    { ts: ago(20), type: 'work', summary: 'booked 2' },
    { ts: ago(1), type: 'heartbeat' },
  ]);

  // a malformed trail must not crash the scan
  const a2trail = path.join(root, 'sales', 'A2', 'events.jsonl');
  fs.writeFileSync(a2trail, fs.readFileSync(a2trail, 'utf8') + 'not json\n{broken\n');

  const rows = await engine.collect(sales, {});
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  ok('discovers all seven agents', rows.length === 7);
  ok('A2 sending this window is WORKING', by['A2'].status === 'working');
  ok('A2b with a refused send is BLOCKED', by['A2b'].status === 'blocked');
  ok('A4 with a parked quote is GATED', by['A4'].status === 'gated');
  ok('A1 paused by operator is HALTED', by['A1'].status === 'halted');
  ok('A5 over the office cap is HALTED', by['A5'].status === 'halted');
  ok('A6 with only stale traffic is FEED-DEAD', by['A6'].status === 'feed-dead');
  ok('A3 alive but quiet is IDLE', by['A3'].status === 'idle');

  // the exception lanes are genuinely distinct, not collapsed
  ok('halted ≠ blocked ≠ gated are separated',
    new Set([by['A1'].status, by['A2b'].status, by['A4'].status]).size === 3);

  // sorting puts problems first: feed-dead/halted at the top, idle at the bottom
  ok('rows sorted by status priority (problems first)',
    ['feed-dead', 'halted'].includes(rows[0].status) && rows[rows.length - 1].status === 'idle');

  // passthrough surfaces the governance counters
  ok('passthrough exposes send/block/gate counts', by['A2b'].blocked >= 1 && by['A4'].gates >= 1);
  ok('intent carries the agent mandate', by['A2'].intent === 'Outreach mandate');

  // --- control gate ---
  const caps = sales.control.capabilities;
  ok('capabilities are pause/resume/set-param/kill', caps.join(',') === 'pause,resume,set-param,kill');

  const noTok = sales.control.send('A1', { cmd: 'kill' });
  ok('kill without a confirm token is refused (destructive gate)', noTok.ok === false);

  const wrongName = sales.control.send('../../etc', { cmd: 'pause' });
  ok('path-traversal agent name is refused', wrongName.ok === false);

  const paused = sales.control.send('A1', { cmd: 'pause' });
  ok('pause (non-destructive) is accepted', paused.ok === true);

  const killed = sales.control.send('A1', { cmd: 'kill', confirm: 'kill' });
  ok('kill WITH a confirm token is accepted', killed.ok === true);
  const ctrl = fs.readFileSync(path.join(root, 'sales', 'A1', 'control.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('confirm token is never persisted to the control log', ctrl.every((c) => c.confirm === undefined));
  ok('the kill command itself is on the control log', ctrl.some((c) => c.cmd === 'kill'));

  // --- broadcast: the desk-wide button can pause everyone but never kill ---
  const bcKill = sales.control.broadcast({ cmd: 'kill', confirm: 'kill' });
  ok('broadcast(kill) is refused outright (no desk-wide kill)', bcKill.ok === false);
  const bcPause = sales.control.broadcast({ cmd: 'pause' });
  ok('broadcast(pause) — the panic stop — pauses the whole office', bcPause.ok === true && bcPause.sent === 7);

  console.log(`\n  ${pass} assertions passed.`);
  fs.rmSync(root, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
