'use strict';

// Shared file-trail plumbing for the convention-over-config adapters that read an append-only
// `events.jsonl` per unit under ~/.fleet/<kind>/<name>/ and accept commands the unit polls from a
// sibling `control.jsonl`. The trading-bot fleet (kind = "bots") and the MEV searcher fleet
// (kind = "searchers") both ride on this; only the per-domain parse()/status() differ.
//
// The fleet root is ~/.fleet, overridable with FLEET_DIR (used by the tests). Unit names are
// validated against a whitelist charset so a name can never escape its kind directory, and
// control commands are written as structured JSON — never interpolated into a shell.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

function fleetRoot() { return process.env.FLEET_DIR || path.join(os.homedir(), '.fleet'); }
function kindDir(kind) { return path.join(fleetRoot(), kind); }
function safeName(name) { return /^[A-Za-z0-9_.-]+$/.test(String(name)); }
function unitName(handle) { return path.basename(path.dirname(handle)); }

// ---------------------------------------------------------------------------
// Reading trails
// ---------------------------------------------------------------------------

function tsOf(r) {
  if (r == null) return NaN;
  if (typeof r.ts === 'number') return r.ts;
  const t = Date.parse(r.ts);
  return isNaN(t) ? NaN : t;
}

// Read just the tail of a file (last `bytes`) and return the parsed complete JSON lines. Used by
// liveness so we never stream a whole large log just to learn its newest timestamp.
function tailRecords(file, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
  catch { return {}; }
}

// Stream a (possibly large) trail line-by-line, invoking onEvent(ev, ts) for each parsed record.
// Resolves when the stream closes; malformed lines are skipped, never thrown.
async function streamEvents(handle, onEvent) {
  await new Promise((resolve) => {
    let stream;
    try { stream = fs.createReadStream(handle, { encoding: 'utf8' }); }
    catch { return resolve(); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      onEvent(ev, tsOf(ev));
    });
    rl.on('error', resolve);
    rl.on('close', resolve);
  });
}

// ---------------------------------------------------------------------------
// Discovery + liveness
// ---------------------------------------------------------------------------

function listUnits(kind) {
  let entries;
  try { entries = fs.readdirSync(kindDir(kind), { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((e) => e.isDirectory() && safeName(e.name)).map((e) => e.name);
}

function discover(kind, file = 'events.jsonl') {
  const out = [];
  for (const u of listUnits(kind)) {
    const f = path.join(kindDir(kind), u, file);
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

// Newest timestamp in a trail's tail, optionally restricted to certain event types (so an adapter
// can define "live" as e.g. a fresh heartbeat/opportunity rather than any event at all).
function newestTs(handle, types) {
  let newest = 0;
  for (const r of tailRecords(handle)) {
    if (types && !types.includes(r.type)) continue;
    const t = tsOf(r);
    if (!isNaN(t) && t > newest) newest = t;
  }
  return newest;
}

// A unit is "live" if it emitted a qualifying event within `liveMs`. opts.types narrows what counts.
function liveness(handles, liveMs, opts = {}) {
  const now = Date.now();
  const live = new Set();
  for (const h of handles) { const n = newestTs(h, opts.types); if (n && (now - n) <= liveMs) live.add(h); }
  return live;
}

// ---------------------------------------------------------------------------
// Control — append commands the unit polls. Names are validated (no traversal); commands are
// written as structured JSON, never interpolated into a shell. Capabilities listed in
// opts.destructive additionally require a confirm token (command.confirm === command.cmd) at the
// adapter layer itself — defense in depth, independent of the cockpit's own confirm guard, so the
// adapter is safe even when driven directly (e.g. from a test or the MCP plane).
// ---------------------------------------------------------------------------

function writeControl(kind, name, command = {}, opts = {}) {
  const caps = opts.caps || [];
  const destructive = opts.destructive instanceof Set ? opts.destructive : new Set(opts.destructive || []);
  if (!safeName(name)) return { ok: false, error: `invalid name "${name}"` };
  const cmd = command.cmd;
  if (!caps.includes(cmd)) return { ok: false, error: `unknown command "${cmd}" (capabilities: ${caps.join(', ')})` };
  if (destructive.has(cmd) && command.confirm !== cmd) {
    return { ok: false, error: `"${cmd}" is destructive — confirm token required` };
  }
  const dir = path.join(kindDir(kind), name);
  if (!fs.existsSync(dir)) return { ok: false, error: `no such unit "${name}"` };
  const { confirm, ...rest } = command; // never persist the confirm token
  const rec = { ts: Date.now(), ...rest };
  try {
    fs.appendFileSync(path.join(dir, 'control.jsonl'), JSON.stringify(rec) + '\n');
    return { ok: true, unit: name, command: rec };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Desk-wide broadcast. Destructive commands are gated up front (one clear refusal, not N
// per-unit failures): with opts.noDestructiveBroadcast they can NEVER be broadcast (mev's
// unwind — per-unit confirm only); otherwise they must carry the confirm token (fleet's
// panic-flatten). Both adapters route here so the policy can't drift between copies again.
function broadcast(kind, command = {}, opts = {}) {
  const destructive = opts.destructive instanceof Set ? opts.destructive : new Set(opts.destructive || []);
  if (destructive.has(command.cmd)) {
    if (opts.noDestructiveBroadcast) {
      return { ok: false, error: `"${command.cmd}" cannot be broadcast — per-unit confirm required` };
    }
    if (command.confirm !== command.cmd) {
      return { ok: false, error: `"${command.cmd}" cannot be broadcast without a confirm token` };
    }
  }
  const units = listUnits(kind);
  let sent = 0; const errors = [];
  for (const u of units) { const r = writeControl(kind, u, command, opts); if (r.ok) sent++; else errors.push(u); }
  return { ok: true, sent, total: units.length, errors };
}

module.exports = {
  fleetRoot, kindDir, safeName, unitName,
  tsOf, tailRecords, readMeta, streamEvents,
  listUnits, discover, newestTs, liveness,
  writeControl, broadcast,
};
