#!/usr/bin/env node
'use strict';

// No-mock tests for the MEV-searcher fleet adapter. Spins up real searcher trails with
// tools/fakesearcher.js into an isolated FLEET_DIR, runs them through the real engine, and asserts
// the status mapping (feed-dead vs wedged vs bleeding vs racing vs idle), control writes, the
// destructive `unwind` confirm gate, and that a destructive op can't be broadcast. Zero deps.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-mev-'));
process.env.FLEET_DIR = root;                 // isolate the fleet root before requiring the adapter

const engine = require('../engine');
const mev = require('./mev-searcher');

const NOW = Date.now();
function makeSearcher(name, sc) {
  execFileSync('node', [path.join(__dirname, '..', 'tools', 'fakesearcher.js'), name, '--scenario', sc, '--dir', root, '--now', String(NOW)],
    { encoding: 'utf8' });
}

(async () => {
  console.log('conductor mev-searcher adapter tests:');

  makeSearcher('arb-racer', 'racing');
  makeSearcher('arb-wedged', 'wedged');
  makeSearcher('liq-bleeder', 'bleeding');
  makeSearcher('arb-deadfeed', 'feed-dead');
  makeSearcher('liq-quiet', 'idle');

  // a malformed trail must not crash the scan
  const wedgedTrail = path.join(root, 'searchers', 'arb-wedged', 'events.jsonl');
  fs.writeFileSync(wedgedTrail, fs.readFileSync(wedgedTrail, 'utf8') + 'not json\n{broken\n');

  const rows = await engine.collect(mev, {});
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  ok('discovers all five searchers', rows.length === 5);
  ok('racing searcher is RACING', by['arb-racer'].status === 'racing');
  ok('wedged searcher is WEDGED (submits, ~nothing lands)', by['arb-wedged'].status === 'wedged');
  ok('bleeding searcher is BLEEDING (net negative)', by['liq-bleeder'].status === 'bleeding');
  ok('feed-dead searcher is FEED-DEAD (no recent heartbeat/opp)', by['arb-deadfeed'].status === 'feed-dead');
  ok('quiet searcher is IDLE (connected, no opportunities)', by['liq-quiet'].status === 'idle');

  // the three failure modes are genuinely distinct, not collapsed into one bucket
  ok('feed-dead ≠ wedged ≠ bleeding are separated',
    new Set([by['arb-deadfeed'].status, by['arb-wedged'].status, by['liq-bleeder'].status]).size === 3);

  // sorting follows the adapter status order: feed-dead → wedged → bleeding → racing → idle
  ok('rows sorted by status priority (problems first)',
    rows[0].status === 'feed-dead' && rows[rows.length - 1].status === 'idle');

  // parse: meta + aggregates
  const r = by['arb-racer'];
  ok('meta strategy → title', r.title === 'jito-arb');
  ok('meta mandate → intent', /net of tips/.test(r.intent));
  ok('chain from meta', r.chain === 'Solana');
  ok('lands counted from the trail', r.lands === 3);
  ok('session net is positive for the racer', r.sessionNet > 0);
  ok('win-rate context chip present', r.context.some((c) => /win /.test(c)));
  ok('recent events normalized {actor:searcher}', r.recent.length > 0 && r.recent.every((e) => e.actor === 'searcher'));
  ok('lastAction describes the latest land', /landed/.test(r.lastAction));

  // wedged detail
  const w = by['arb-wedged'];
  ok('wedged statusInputs flag set', w.statusInputs.wedged === true);
  ok('wedged lastAction calls out losing the race', /losing the race/.test(w.lastAction));

  // bleeding detail: lands, but net negative
  const b = by['liq-bleeder'];
  ok('bleeding lands but is net negative', b.lands === 3 && b.sessionNet < 0);
  ok('bleeding is not flagged wedged', b.statusInputs.wedged === false);

  // liveness: the feed-dead searcher is excluded from the live set; a heartbeating one is included
  const handles = mev.discover();
  const live = mev.liveness(handles, {});
  ok('liveness includes a heartbeating searcher', live.has(path.join(root, 'searchers', 'arb-racer', 'events.jsonl')));
  ok('liveness excludes a feed-dead searcher', !live.has(path.join(root, 'searchers', 'arb-deadfeed', 'events.jsonl')));

  // --- control: writes arg-structured commands the searcher would poll ---
  const caps = mev.control.capabilities;
  ok('control advertises pause/resume/set-param/kill/unwind', ['pause', 'resume', 'set-param', 'kill', 'unwind'].every((c) => caps.includes(c)));

  const pr = mev.control.send('arb-racer', { cmd: 'pause' });
  ok('control.send(pause) reports ok', pr.ok === true);
  const ctrlLines = fs.readFileSync(path.join(root, 'searchers', 'arb-racer', 'control.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('pause command appended to control.jsonl as a structured record', ctrlLines.some((c) => c.cmd === 'pause' && typeof c.ts === 'number'));

  const sp = mev.control.send('arb-racer', { cmd: 'set-param', key: 'minProfit', value: 0.05 });
  ok('control.send(set-param) carries key/value', sp.ok && sp.command.key === 'minProfit' && sp.command.value === 0.05);

  const bad = mev.control.send('arb-racer', { cmd: 'rm -rf' });
  ok('control rejects an unknown command', bad.ok === false);

  const traversal = mev.control.send('../../etc', { cmd: 'kill' });
  ok('control rejects a path-traversal name', traversal.ok === false);

  // --- destructive `unwind`: refused without a confirm token, accepted with it ---
  const unwindNo = mev.control.send('liq-bleeder', { cmd: 'unwind' });
  ok('unwind without confirm token is refused', unwindNo.ok === false && /confirm token/.test(unwindNo.error));
  const unwindYes = mev.control.send('liq-bleeder', { cmd: 'unwind', confirm: 'unwind' });
  ok('unwind with confirm token lands', unwindYes.ok === true);
  const unwindRec = fs.readFileSync(path.join(root, 'searchers', 'liq-bleeder', 'control.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('the persisted unwind record never stores the confirm token', unwindRec.some((c) => c.cmd === 'unwind') && unwindRec.every((c) => c.confirm === undefined));

  // --- broadcast: pause reaches every searcher, but a destructive op can never be broadcast ---
  const bc = mev.control.broadcast({ cmd: 'pause' });
  ok('broadcast(pause) reaches all searchers', bc.ok && bc.sent === 5 && bc.total === 5);
  const pausedEverywhere = ['arb-racer', 'arb-wedged', 'liq-bleeder', 'arb-deadfeed', 'liq-quiet'].every((n) => {
    const f = path.join(root, 'searchers', n, 'control.jsonl');
    return fs.existsSync(f) && /"cmd":"pause"/.test(fs.readFileSync(f, 'utf8'));
  });
  ok('every searcher received the pause command', pausedEverywhere);

  const bcUnwind = mev.control.broadcast({ cmd: 'unwind', confirm: 'unwind' });
  ok('broadcast(unwind) is refused outright (no desk-wide unwind)', bcUnwind.ok === false);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} assertions passed.`);
})().catch((e) => { console.error('FAIL:', e.message); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} process.exit(1); });
