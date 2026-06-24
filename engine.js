'use strict';

// Conductor engine — the source-agnostic supervisory core.
//
// Conductor is supervisory awareness over a fleet of semi-autonomous workers that already
// emit an append-only activity trail. The engine knows NOTHING about Claude Code, trading
// bots, or any specific domain. It consumes a pluggable ADAPTER and owns the cross-cutting
// concerns: discovery orchestration, liveness application, grouping, status ranking, and
// sorting. Rendering + control live in the surfaces (scan.js / server.js / mcp.js).
//
// An adapter (adapters/<name>.js) owns where trails live and how to read them:
//   discover(opts)            -> array of trail handles (file paths, dirs, cursors)
//   liveness(handles, opts)   -> Set of handles that are "live right now"     (optional)
//   parse(handle, opts)       -> a normalized record (see below), or null
//   status(record, ctx)       -> a status string from record.statusInputs     (optional)
//   project(baseRow)          -> the public row shape for this domain          (optional)
//   statuses                  -> ordered status vocabulary [{key,title,...}]   (optional)
//   control                   -> { capabilities, send, broadcast }            (optional)
//
// Normalized record (the stable contract):
//   { id, shortId, label, title, intent, context[], recent[{actor,kind,summary,ts}],
//     lastAction, lastActivityTs, statusInputs }

const path = require('path');
const { relTime, mapLimit } = require('./util');
const { DEFAULT_ADAPTER } = require('./config');

const DEFAULT_STATUSES = [
  { key: 'active', title: 'ACTIVE', word: 'active', color: 'green' },
  { key: 'idle', title: 'IDLE', word: 'idle', color: 'dim' },
];

// Resolve an adapter by name. Whitelisted charset blocks path traversal — adapters only ever
// come from ./adapters/<name>.js.
function loadAdapter(name) {
  name = String(name || DEFAULT_ADAPTER).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid adapter name: "${name}"`);
  try {
    return require(path.join(__dirname, 'adapters', name));
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && e.message.includes(path.join('adapters', name))) {
      throw new Error(`unknown adapter "${name}" (looked for adapters/${name}.js)`);
    }
    throw e;
  }
}

function defaultStatus(_rec, ctx) { return ctx && ctx.live ? 'active' : 'idle'; }

// The heart: turn an adapter into a sorted list of public rows.
async function collect(adapter, opts = {}) {
  const handles = (await adapter.discover(opts)) || [];

  // Liveness is optional — without it the engine falls back to recency (every status fn keys
  // off lastActivityTs anyway, so absence just means nothing shows as "live right now").
  let liveSet = new Set();
  if (typeof adapter.liveness === 'function') {
    try { liveSet = (await adapter.liveness(handles, opts)) || new Set(); }
    catch { liveSet = new Set(); }
  }

  // Parse each handle into a record, bounding concurrency so a heavy fleet can't open thousands
  // of file descriptors at once. Keep the handle paired with its record for liveness lookup.
  const pairs = await mapLimit(handles, opts.concurrency || 24, async (h) => {
    let rec = null;
    try { rec = await adapter.parse(h, opts); } catch { rec = null; }
    return rec && rec.id != null ? { h, rec } : null;
  });

  // Group by stable id, keeping the freshest record per unit (and the handle it came from).
  const byId = new Map();
  for (const p of pairs) {
    if (!p) continue;
    const prev = byId.get(p.rec.id);
    if (!prev || (p.rec.lastActivityTs || 0) > (prev.rec.lastActivityTs || 0)) byId.set(p.rec.id, p);
  }

  const now = Date.now();
  const statusFn = typeof adapter.status === 'function' ? adapter.status : defaultStatus;
  let rows = [];
  for (const { h, rec } of byId.values()) {
    const live = liveSet.has(h);
    const base = {
      ...rec,
      live,
      status: statusFn(rec, { live, now }),
      lastActiveTs: rec.lastActivityTs || 0,
      lastActiveRel: relTime(rec.lastActivityTs || 0),
    };
    rows.push(typeof adapter.project === 'function' ? adapter.project(base) : base);
  }

  // Sort by the adapter's declared status order (sections), then most-recent first.
  const order = (adapter.statuses || DEFAULT_STATUSES).map((s) => s.key);
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  rows.sort((a, b) => rank(a.status) - rank(b.status) || (b.lastActiveTs - a.lastActiveTs));
  if (opts.limit > 0) rows = rows.slice(0, opts.limit);
  return rows;
}

module.exports = { loadAdapter, collect, DEFAULT_STATUSES };
