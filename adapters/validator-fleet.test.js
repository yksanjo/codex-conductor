#!/usr/bin/env node
'use strict';

// No-mock tests for the Solana validator adapter. Stands up a tiny local HTTP server that answers
// the batched JSON-RPC poll from a fixture (getVoteAccounts / getEpochInfo / getClusterNodes /
// getBalance / getBlockProduction), writes a real validators.json into an isolated CONDUCTOR_DIR,
// and runs the whole thing through the real engine. Asserts the status mapping (delinquent →
// critical, behind → degraded, low-balance → warning, healthy → active) and the control gate
// (refused without the per-capability flag AND without a confirm token). Zero dependencies.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

const SOL = 1e9;
const TIP = 100000;

// --- chain fixture -----------------------------------------------------------
const fixture = {
  epochInfo: { absoluteSlot: TIP, epoch: 600, slotIndex: 1000, slotsInEpoch: 432000, blockHeight: 99000 },
  voteAccounts: {
    current: [
      { votePubkey: 'voteHEALTHY', nodePubkey: 'idHEALTHY', activatedStake: 50000 * SOL, commission: 5, epochVoteAccount: true, epochCredits: [[600, 12000, 11000]], lastVote: 99999, rootSlot: 99990 },
      { votePubkey: 'voteBEHIND', nodePubkey: 'idBEHIND', activatedStake: 30000 * SOL, commission: 7, epochVoteAccount: true, epochCredits: [[600, 9000, 8000]], lastVote: 99000, rootSlot: 95000 },
      { votePubkey: 'voteLOWBAL', nodePubkey: 'idLOWBAL', activatedStake: 20000 * SOL, commission: 0, epochVoteAccount: true, epochCredits: [[600, 8000, 7000]], lastVote: 99998, rootSlot: 99990 },
    ],
    delinquent: [
      { votePubkey: 'voteDELINQ', nodePubkey: 'idDELINQ', activatedStake: 10000 * SOL, commission: 10, epochVoteAccount: true, epochCredits: [[600, 5000, 5000]], lastVote: 90000, rootSlot: 90000 },
    ],
  },
  nodes: [
    { pubkey: 'idHEALTHY', version: '1.18.23' },
    { pubkey: 'idBEHIND', version: '1.18.23' },
    { pubkey: 'idLOWBAL', version: '1.18.23' },
    { pubkey: 'idDELINQ', version: '1.18.23' },
    { pubkey: 'idOTHER', version: '1.18.23' },
  ],
  balances: { idHEALTHY: 5 * SOL, idBEHIND: 5 * SOL, idLOWBAL: 0.5 * SOL, idDELINQ: 5 * SOL },
  production: { idHEALTHY: [100, 98], idBEHIND: [100, 99], idLOWBAL: [100, 99], idDELINQ: [50, 0] },
};

function answer(call) {
  const p = call.params || [];
  switch (call.method) {
    case 'getVoteAccounts': return fixture.voteAccounts;
    case 'getEpochInfo': return fixture.epochInfo;
    case 'getClusterNodes': return fixture.nodes;
    case 'getBalance': return { context: { slot: TIP }, value: fixture.balances[p[0]] || 0 };
    case 'getBlockProduction': {
      const id = p[0] && p[0].identity;
      return { context: { slot: TIP }, value: { byIdentity: id && fixture.production[id] ? { [id]: fixture.production[id] } : {}, range: { firstSlot: 0, lastSlot: TIP } } };
    }
    default: return null;
  }
}

const server = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    let calls; try { calls = JSON.parse(d); } catch { res.writeHead(400); return res.end('bad'); }
    const arr = Array.isArray(calls) ? calls : [calls];
    const out = arr.map((c) => ({ jsonrpc: '2.0', id: c.id, result: answer(c) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(calls) ? out : out[0]));
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const rpcUrl = `http://127.0.0.1:${port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-val-'));
  process.env.CONDUCTOR_DIR = dir;
  const cluster = 'mainnet-beta';
  fs.writeFileSync(path.join(dir, 'validators.json'), JSON.stringify([
    { name: 'val-healthy', identityPubkey: 'idHEALTHY', votePubkey: 'voteHEALTHY', cluster, rpcUrl },
    { name: 'val-delinquent', identityPubkey: 'idDELINQ', votePubkey: 'voteDELINQ', cluster, rpcUrl },
    { name: 'val-behind', identityPubkey: 'idBEHIND', votePubkey: 'voteBEHIND', cluster, rpcUrl },
    { name: 'val-lowbal', identityPubkey: 'idLOWBAL', votePubkey: 'voteLOWBAL', cluster, rpcUrl, control: { catchup: true } },
  ], null, 2));

  const engine = require('../engine');
  const val = require('./validator-fleet');

  console.log('conductor validator-fleet adapter tests:');

  const rows = await engine.collect(val, {});
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  // --- status mapping from one batched chain poll ---
  ok('discovers all four validators', rows.length === 4);
  ok('healthy validator → VOTING (active/healthy)', by['val-healthy'].status === 'healthy');
  ok('delinquent validator → DELINQUENT (critical)', by['val-delinquent'].status === 'delinquent');
  ok('behind validator → BEHIND (degraded)', by['val-behind'].status === 'behind');
  ok('low-balance validator → LOW BALANCE (warning)', by['val-lowbal'].status === 'low-balance');

  // sectioned problems-first: delinquent leads, healthy trails
  ok('rows sorted by status priority (delinquent first, healthy last)',
    rows[0].status === 'delinquent' && rows[rows.length - 1].status === 'healthy');

  // --- parse detail proves it read the chain, not the box ---
  const h = by['val-healthy'];
  ok('title names consensus + leader slots + rewards', /consensus \+ leader slots \+ rewards/.test(h.title));
  ok('cluster context chip present', h.context.some((c) => /mainnet-beta/.test(c)));
  ok('stake context chip present', h.context.some((c) => /staked/.test(c)));
  ok('identity balance surfaced', Math.abs(h.balanceSol - 5) < 1e-9);
  ok('healthy is voting, not delinquent', h.voting === true && h.delinquent === false);
  ok('lastAction reports leader-slot production', /leader slots/.test(h.lastAction));

  const beh = by['val-behind'];
  ok('behind exposes slotsBehind = 5000', beh.slotsBehind === 5000);
  ok('behind lastAction calls out catchup', /catching up/.test(beh.lastAction));

  const low = by['val-lowbal'];
  ok('low-balance flag set in statusInputs', low.statusInputs.lowBalance === true);
  ok('low-balance validator is still voting (not delinquent/behind)', low.voting === true && low.statusInputs.behind === false);

  const del = by['val-delinquent'];
  ok('delinquent flag set in statusInputs', del.statusInputs.delinquent === true);

  // liveness = currently voting; delinquent excluded
  const handles = await val.discover({});
  const live = val.liveness(handles);
  ok('liveness includes a voting validator', [...live].some((x) => x.cfg.name === 'val-healthy'));
  ok('liveness excludes a delinquent validator', ![...live].some((x) => x.cfg.name === 'val-delinquent'));

  // --- control is observe-only by default; gated by per-capability flag AND confirm token ---
  const caps = val.control.capabilities;
  ok('control advertises restart/catchup/topup-identity/drain', ['restart', 'catchup', 'topup-identity', 'drain'].every((c) => caps.includes(c)));
  ok('there is NO identity-swap capability (double-sign footgun left out)', !caps.some((c) => /swap|identity-swap/.test(c)));

  // observe-only validator: control disabled entirely
  const obs = val.control.send('val-healthy', { cmd: 'restart', confirm: 'restart' });
  ok('control refused on an observe-only validator (no per-capability flag)', obs.ok === false && /not enabled/.test(obs.error));

  // enabled capability but NO confirm token → refused
  const noTok = val.control.send('val-lowbal', { cmd: 'catchup' });
  ok('enabled capability without confirm token → refused', noTok.ok === false && /confirm token/.test(noTok.error));

  // enabled flag is per-capability: catchup is on, restart is not
  const wrongCap = val.control.send('val-lowbal', { cmd: 'restart', confirm: 'restart' });
  ok('a different capability is still refused (per-capability flag)', wrongCap.ok === false && /not enabled/.test(wrongCap.error));

  // flag + confirm token → lands on the file channel, confirm never persisted
  const good = val.control.send('val-lowbal', { cmd: 'catchup', confirm: 'catchup' });
  ok('enabled capability WITH confirm token → ok (file channel)', good.ok === true && good.channel === 'file');
  const ctrl = fs.readFileSync(path.join(dir, 'validators', 'val-lowbal', 'control.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('catchup command appended as a structured record', ctrl.some((c) => c.cmd === 'catchup' && typeof c.ts === 'number'));
  ok('the confirm token is never persisted', ctrl.every((c) => c.confirm === undefined));

  const traversal = val.control.send('../../etc', { cmd: 'restart', confirm: 'restart' });
  ok('control rejects a path-traversal validator name', traversal.ok === false);

  // --- broadcast can never carry a destructive op ---
  const bcRestart = val.control.broadcast({ cmd: 'restart', confirm: 'restart' });
  ok('broadcast(restart) is refused outright (no desk-wide restart)', bcRestart.ok === false);
  const bcReport = val.control.broadcast({ cmd: 'report' });
  ok('broadcast(report) — the only non-mutating broadcast — is allowed', bcReport.ok === true && bcReport.report === true && bcReport.units.length === 4);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} assertions passed.`);
})().catch((e) => { try { server.close(); } catch {} console.error('FAIL:', e.message); process.exit(1); });
