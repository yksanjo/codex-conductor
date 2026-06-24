'use strict';

// Conductor adapter: Solana validator ops.
//
// A validator is a unit with clear intent — stay in consensus, produce its assigned leader slots,
// maximize rewards, never double-sign — that the chain itself reports on. The Conductor-pure move
// is zero-instrumentation, CHAIN-SIDE observation: we query the cluster (getVoteAccounts,
// getEpochInfo, getBlockProduction, …), NOT the box, so delinquency / catchup / skip-rate are
// learned without touching the node. This adapter therefore does NOT use the ~/.fleet file-trail
// plumbing the bot/searcher adapters share — its trail is the chain.
//
// Config at <CONDUCTOR_DIR>/validators.json (CONDUCTOR_DIR defaults to ~/.conductor): an array of
//   { name, identityPubkey, votePubkey, cluster, rpcUrl, host?, controlChannel?, control? }
// One getVoteAccounts + getEpochInfo (+ optional getBlockProduction / getClusterNodes / getBalance)
// poll PER rpcUrl — batched, never per-node — drives every signal.
//
// SAFETY — non-negotiable:
//   • Default is observe-only. Control is OFF unless a per-capability flag is set in `control`,
//     and every control call additionally carries a confirm token (cmd === confirm).
//   • There is deliberately NO hot identity-swap. Swapping a validator identity while another copy
//     may still be voting is the classic double-sign → slashing / fund-loss footgun. It is left out
//     entirely; if it ever lands it needs a hard interlock proving the old identity is provably
//     stopped first.
//   • broadcast is read-only: it supports at most a non-mutating "report" — never a desk-wide
//     restart/drain. A destructive op can never be broadcast.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

const BEHIND_SLOTS = 256;      // rootSlot this far behind the cluster tip = failing catchup
const SKIP_RATE = 0.3;         // leader-slot skip rate above this over the epoch = degraded
const LOW_BALANCE_SOL = 1.0;   // identity SOL at/under this (near the vote-fee floor) = low-balance
const LAMPORTS = 1e9;
const RING = 8;

function conductorDir() { return process.env.CONDUCTOR_DIR || path.join(os.homedir(), '.conductor'); }
function safeName(name) { return /^[A-Za-z0-9_.-]+$/.test(String(name)); }

function readValidators() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(conductorDir(), 'validators.json'), 'utf8'));
    const arr = Array.isArray(j) ? j : (Array.isArray(j.validators) ? j.validators : []);
    return arr.filter((v) => v && safeName(v.name) && v.votePubkey && v.rpcUrl);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// JSON-RPC (batched, zero-dependency). The tests point rpcUrl at a tiny local stub server.
// ---------------------------------------------------------------------------

function rpc(url, calls, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: c.id != null ? c.id : i, method: c.method, params: c.params || [] }))));
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: (u.pathname || '/') + (u.search || ''), method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('rpc timeout')));
    req.write(body); req.end();
  });
}

function resultOf(byId, id) { const r = byId[id]; return r && !r.error ? r.result : undefined; }

function majorityVersion(nodes) {
  if (!Array.isArray(nodes)) return null;
  const counts = new Map();
  for (const n of nodes) { if (!n || !n.version) continue; counts.set(n.version, (counts.get(n.version) || 0) + 1); }
  let best = null, bestN = -1;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

// discover() does ALL the network I/O, once per unique rpcUrl, and returns enriched handles so
// parse() is pure (no per-node calls). This is what keeps observation chain-side + batched.
async function discover(opts = {}) {
  const cfgs = readValidators();
  const groups = new Map();
  for (const c of cfgs) { if (!groups.has(c.rpcUrl)) groups.set(c.rpcUrl, []); groups.get(c.rpcUrl).push(c); }

  const handles = [];
  for (const [url, members] of groups) {
    const calls = [
      { id: 'vote', method: 'getVoteAccounts' },
      { id: 'epoch', method: 'getEpochInfo' },
      { id: 'nodes', method: 'getClusterNodes' },
    ];
    for (const m of members) {
      calls.push({ id: 'bal:' + m.identityPubkey, method: 'getBalance', params: [m.identityPubkey] });
      calls.push({ id: 'prod:' + m.identityPubkey, method: 'getBlockProduction', params: [{ identity: m.identityPubkey }] });
    }
    let resp = null, err = null;
    try { resp = await rpc(url, calls, opts.timeoutMs); } catch (e) { err = e.message; }
    const byId = {};
    if (Array.isArray(resp)) for (const r of resp) byId[r.id] = r;
    const majVer = majorityVersion(resultOf(byId, 'nodes'));
    for (const m of members) handles.push({ cfg: m, byId, majVer, rpcError: err });
  }
  return handles;
}

// Liveness for the UI: a validator is "live" if it is currently voting (in the cluster's current
// vote-account set). Status does not depend on this — it is computed from the same poll below.
function liveness(handles) {
  const live = new Set();
  for (const h of handles) {
    const vote = resultOf(h.byId, 'vote');
    if (vote && Array.isArray(vote.current) && vote.current.some((v) => v.votePubkey === h.cfg.votePubkey)) live.add(h);
  }
  return live;
}

async function parse(handle, opts = {}) {
  const { cfg, byId, majVer, rpcError } = handle;
  const name = cfg.name;
  if (!safeName(name)) return null;

  const vote = resultOf(byId, 'vote');
  const epoch = resultOf(byId, 'epoch');
  const nodes = resultOf(byId, 'nodes');
  const balLamports = resultOf(byId, 'bal:' + cfg.identityPubkey);
  const prod = resultOf(byId, 'prod:' + cfg.identityPubkey);

  const cur = vote && Array.isArray(vote.current) ? vote.current.find((v) => v.votePubkey === cfg.votePubkey) : null;
  const del = vote && Array.isArray(vote.delinquent) ? vote.delinquent.find((v) => v.votePubkey === cfg.votePubkey) : null;
  const acct = cur || del || null;

  const tip = epoch && epoch.absoluteSlot != null ? epoch.absoluteSlot : null;
  const rootSlot = acct && acct.rootSlot != null ? acct.rootSlot : null;
  const lastVote = acct && acct.lastVote != null ? acct.lastVote : null;

  const slotsBehind = (tip != null && rootSlot != null) ? Math.max(0, tip - rootSlot) : null;
  const behindThresh = opts.behindSlots || BEHIND_SLOTS;

  // skip rate from leader-slot production, when the RPC supports it.
  let leaderSlots = null, produced = null, skipRate = null;
  const pv = prod && prod.value && prod.value.byIdentity ? prod.value.byIdentity[cfg.identityPubkey] : null;
  if (Array.isArray(pv)) { leaderSlots = pv[0]; produced = pv[1]; skipRate = leaderSlots > 0 ? Math.max(0, 1 - produced / leaderSlots) : 0; }

  const balanceSol = typeof balLamports === 'number' ? balLamports / LAMPORTS
    : (balLamports && typeof balLamports.value === 'number' ? balLamports.value / LAMPORTS : null);

  // node software version (from gossip), for version-drift vs the cluster majority.
  let myVersion = null;
  if (Array.isArray(nodes)) { const n = nodes.find((x) => x && x.pubkey === cfg.identityPubkey); if (n) myVersion = n.version; }

  // --- signals (priority order resolved in status()) ---
  const delinquent = !!del;
  const voting = !!cur;
  const behind = voting && slotsBehind != null && slotsBehind > behindThresh;
  const highSkip = voting && skipRate != null && skipRate > (opts.skipRate || SKIP_RATE);
  const lowBalance = balanceSol != null && balanceSol <= (opts.lowBalanceSol || LOW_BALANCE_SOL);
  const versionDrift = !!(myVersion && majVer && myVersion !== majVer);
  const unreachable = !!rpcError || (!vote && !epoch);

  const stake = acct && acct.activatedStake != null ? acct.activatedStake / LAMPORTS : null;
  const commission = acct && acct.commission != null ? acct.commission : null;
  const epochCredits = acct && Array.isArray(acct.epochCredits) && acct.epochCredits.length ? acct.epochCredits[acct.epochCredits.length - 1] : null;
  const creditDelta = epochCredits ? (epochCredits[1] - epochCredits[2]) : null;

  const client = cfg.client || (myVersion ? 'Agave' : null);
  const context = [
    cfg.cluster || null,
    stake != null ? `${Math.round(stake).toLocaleString()} SOL staked` : null,
    commission != null ? `${commission}% comm` : null,
    myVersion ? `${client || 'client'} ${myVersion}${versionDrift ? ' (drift)' : ''}` : (client || null),
    balanceSol != null ? `id ${balanceSol.toFixed(2)} SOL` : null,
  ].filter(Boolean);

  const recent = [];
  const now = Date.now();
  if (leaderSlots != null) recent.push({ actor: 'chain', kind: 'production', summary: `${produced}/${leaderSlots} leader slots (${((skipRate || 0) * 100).toFixed(1)}% skip)`, ts: now });
  if (lastVote != null) recent.push({ actor: 'chain', kind: 'vote', summary: `last vote slot ${lastVote}${slotsBehind != null ? `, ${slotsBehind} behind tip` : ''}`, ts: now });
  if (creditDelta != null) recent.push({ actor: 'chain', kind: 'credits', summary: `+${creditDelta} credits this epoch`, ts: now });
  if (balanceSol != null) recent.push({ actor: 'chain', kind: 'balance', summary: `identity ${balanceSol.toFixed(3)} SOL`, ts: now });
  if (rpcError) recent.push({ actor: 'chain', kind: 'error', summary: `RPC: ${rpcError}`, ts: now });

  let lastAction;
  if (unreachable) lastAction = 'RPC unreachable — cannot observe';
  else if (delinquent) lastAction = `delinquent — not voting${lastVote != null ? ` (last vote ${lastVote})` : ''}`;
  else if (behind) lastAction = `catching up — ${slotsBehind} slots behind tip`;
  else if (leaderSlots != null) lastAction = `produced ${produced}/${leaderSlots} leader slots, ${leaderSlots - produced} skipped`;
  else if (voting) lastAction = `voting${lastVote != null ? ` (slot ${lastVote})` : ''}`;
  else lastAction = 'not in the current vote set';

  return {
    id: name,
    shortId: name.length > 12 ? name.slice(0, 12) : name,
    label: cfg.label || name,
    title: `consensus + leader slots + rewards on ${cfg.cluster || 'cluster'}`,
    intent: cfg.mandate || 'stay in consensus, produce assigned slots, never double-sign',
    context,
    recent: recent.slice(-RING),
    lastAction,
    // A validator we can't see in the vote set has UNKNOWN age — report 0 (renders "unknown"
    // via relTime), never a fabricated "1m ago".
    lastActivityTs: (lastVote != null || acct) ? now : 0,
    statusInputs: { delinquent, behind, highSkip, lowBalance, versionDrift, unreachable, voting, slotsBehind, skipRate },
    // --- passthrough ---
    cluster: cfg.cluster || null, votePubkey: cfg.votePubkey, identityPubkey: cfg.identityPubkey,
    delinquent, voting, slotsBehind, skipRate, balanceSol, version: myVersion, majorityVersion: majVer,
  };
}

function status(rec) {
  const si = rec.statusInputs || {};
  if (si.delinquent) return 'delinquent';
  if (si.unreachable) return 'unreachable';
  if (si.behind) return 'behind';
  if (si.highSkip) return 'degraded';
  if (si.lowBalance) return 'low-balance';
  if (si.versionDrift) return 'version-drift';
  if (si.voting) return 'healthy';
  // Not delinquent, reachable, but absent from the current vote set — a different condition
  // than "catching up"; don't file it under BEHIND.
  return 'not-voting';
}

const statuses = [
  { key: 'delinquent', title: 'DELINQUENT', word: 'delinquent', color: 'red' },
  { key: 'unreachable', title: 'UNREACHABLE', word: 'no RPC', color: 'amber' },
  { key: 'behind', title: 'BEHIND', word: 'catching up', color: 'amber' },
  { key: 'degraded', title: 'DEGRADED', word: 'high skip', color: 'amber' },
  { key: 'low-balance', title: 'LOW BALANCE', word: 'low balance', color: 'amber' },
  { key: 'version-drift', title: 'VERSION DRIFT', word: 'version drift', color: 'dim' },
  { key: 'not-voting', title: 'NOT IN VOTE SET', word: 'not voting', color: 'amber' },
  { key: 'healthy', title: 'VOTING', word: 'voting', color: 'green' },
];

// ---------------------------------------------------------------------------
// Control — OPT-IN, gated, observe-only by default. Every capability is destructive: it requires
// BOTH a per-validator enable flag (cfg.control[cmd] === true) AND a confirm token (cmd === confirm).
// Channel is a control file the node-side agent polls (default), or an SSH exec to cfg.host — both
// use argument-structured payloads, never string interpolation. There is NO identity-swap.
// ---------------------------------------------------------------------------
const CAPS = ['restart', 'catchup', 'topup-identity', 'drain'];

function controlFileWrite(name, rec) {
  const dir = path.join(conductorDir(), 'validators', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'control.jsonl'), JSON.stringify(rec) + '\n');
  return { ok: true, validator: name, channel: 'file', command: rec };
}

function controlSshExec(cfg, rec) {
  // ssh is argv-structured on OUR side, but it re-joins the remote argv into one string and
  // hands it to the remote login shell — raw JSON would have its quotes eaten there. So the
  // payload travels base64-encoded (shell-inert charset); conductor-validator-ctl receives
  // `<cmd> <base64(JSON)>` and decodes it.
  const { execFileSync } = require('child_process');
  const payload = Buffer.from(JSON.stringify(rec)).toString('base64');
  try {
    execFileSync('ssh', [String(cfg.host), '--', 'conductor-validator-ctl', rec.cmd, payload], { timeout: 15000, stdio: 'ignore' });
    return { ok: true, validator: cfg.name, channel: 'ssh', command: rec };
  } catch (e) { return { ok: false, error: `ssh exec failed: ${e.message}` }; }
}

function send(target, command = {}) {
  if (!safeName(target)) return { ok: false, error: `invalid validator name "${target}"` };
  const cfg = readValidators().find((v) => v.name === target);
  if (!cfg) return { ok: false, error: `no such validator "${target}"` };
  const cmd = command.cmd;
  if (!CAPS.includes(cmd)) return { ok: false, error: `unknown command "${cmd}" (capabilities: ${CAPS.join(', ')})` };
  // per-capability enable flag — default is observe-only.
  if (!(cfg.control && cfg.control[cmd] === true)) return { ok: false, error: `control "${cmd}" is not enabled for "${target}" (observe-only)` };
  // every capability is destructive → confirm token required.
  if (command.confirm !== cmd) return { ok: false, error: `"${cmd}" is gated — confirm token required` };
  const { confirm, ...rest } = command; // never persist / forward the confirm token
  const rec = { ts: Date.now(), ...rest };
  return (cfg.controlChannel === 'ssh' && cfg.host) ? controlSshExec(cfg, rec) : controlFileWrite(target, rec);
}

const control = {
  capabilities: CAPS,
  destructive: CAPS.slice(),   // all of them
  // Cockpit hint: the only desk-wide action is a non-mutating refresh/report — never restart-all.
  broadcastUi: { cmd: 'report', label: '🔄 Refresh — report all', danger: false },
  send,
  // broadcast is read-only: a non-mutating "report" at most. A destructive op can never be broadcast.
  broadcast(command = {}) {
    if (command.cmd !== 'report') {
      return { ok: false, error: `broadcast supports only the non-mutating "report" — ${command.cmd ? `"${command.cmd}" is per-validator + confirmed` : 'no command'}` };
    }
    return { ok: true, report: true, units: readValidators().map((v) => v.name) };
  },
};

module.exports = { discover, liveness, parse, status, statuses, control, readValidators, conductorDir };
