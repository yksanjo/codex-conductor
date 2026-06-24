#!/usr/bin/env node
'use strict';

// Codex Conductor daemon — serves a live, glanceable web cockpit of your Codex sessions.
// Zero dependencies (node:http only). The page polls /api/sessions and re-renders only when
// the data changes; click a card to pop that session up as a clean CLI window, or use the
// reply controls to steer it.
//
//   codex-cockpit                 start on :7591, open browser, 60-min window
//   codex-cockpit --port 8080
//   codex-cockpit --no-open       don't auto-open the browser

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const engine = require('./engine');
const manage = require('./manage');
const seat = require('./seat');
const { DEFAULT_ADAPTER, PRODUCT_NAME, CLI_NAME } = require('./config');

let MANUAL = '<!doctype html><title>Codex Conductor manual</title><body style="font:14px sans-serif;padding:40px">Manual not found.</body>';
try { MANUAL = fs.readFileSync(path.join(__dirname, 'docs', 'manual.html'), 'utf8'); } catch { /* ignore */ }

function parseArgs(argv) {
  const a = { port: parseInt(process.env.CONDUCTOR_PORT, 10) || 7591, open: true };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--port') a.port = parseInt(argv[++i], 10) || a.port;
    else if (v === '--no-open') a.open = false;
  }
  return a;
}

let ADAPTER_NAME = DEFAULT_ADAPTER;
let lastAdapterError = null;
function activeAdapter() {
  try { return engine.loadAdapter(ADAPTER_NAME); }
  catch (e) {
    if (lastAdapterError !== e.message) { lastAdapterError = e.message; console.error(`${CLI_NAME}: adapter "${ADAPTER_NAME}" failed to load (${e.message}) - falling back to ${DEFAULT_ADAPTER}`); }
    ADAPTER_NAME = DEFAULT_ADAPTER;
    return engine.loadAdapter(DEFAULT_ADAPTER);
  }
}
function colorHex(name) {
  return ({ green: '#3ee07f', cyan: '#46d8c6', amber: '#f5b13f', red: '#ff5a6a', dim: '#6a6a85' })[name] || '#6a6a85';
}
function adapterMeta() {
  const a = activeAdapter();
  const statuses = (a.statuses || engine.DEFAULT_STATUSES).map((s) => ({ key: s.key, title: s.title, word: s.word, color: colorHex(s.color) }));
  return { adapter: ADAPTER_NAME, statuses, capabilities: [], destructive: [], broadcastUi: null, lastAdapterError };
}
async function collectAgentRows(opts) {
  return engine.collect(activeAdapter(), opts);
}

// The cockpit page lives in ui.html (HTML+CSS+client JS), loaded once at boot like MANUAL
// above. It carries two serve-time tokens: __ADAPTER__ (the active adapter name, whitelisted
// by engine.loadAdapter) and __META__ (the adapter meta JSON, </script>-safe — see / below).
let PAGE = '<!doctype html><title>Codex Conductor</title><body style="font:14px sans-serif;padding:40px">ui.html not found — reinstall codex-conductor.</body>';
try { PAGE = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8'); } catch { /* ignore */ }

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req, res, cb) {
  let b = '', over = false;
  req.on('data', (c) => {
    b += c;
    if (b.length > 8192 && !over) { over = true; sendJSON(res, 413, { ok: false, error: 'body too large' }); req.destroy(); }
  });
  // Malformed JSON is a caller bug — say so with a 400 instead of silently treating it as {}
  // (which made e.g. /api/say "succeed" against an empty label).
  req.on('end', () => {
    if (over) return;
    let p;
    try { p = JSON.parse(b || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'invalid JSON body' }); }
    cb(p);
  });
}

// CSRF + DNS-rebinding guard for state-changing (POST) requests. The control endpoints
// inject keystrokes into live Codex windows, so a malicious page in the same browser must
// not be able to fire them. Three checks; any one largely closes it, we require all:
//  - Host must be localhost/127.0.0.1 (defeats DNS rebinding)
//  - Origin (when present) must be local (blocks cross-site form/fetch)
//  - a custom X-Conductor header — a cross-origin "simple request" can't set it without a
//    preflight, which we never answer, so the side effect never fires.
function localHost(req) {
  const h = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}
function localOrigin(req) {
  const o = req.headers.origin;
  if (!o || o === 'null') return true;
  try { const u = new URL(o); return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'; }
  catch { return false; }
}
function writeAllowed(req) {
  return localHost(req) && localOrigin(req) && req.headers['x-conductor'] === '1';
}
// Drive a freshly launched/adopted window from boot to "ready" and deliver the reply once the
// prompt box is up. Shared with the MCP control tools — see manage.deliverAdopted.
const deliverAdopted = manage.deliverAdopted;

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  // All state-changing endpoints are POST; gate them against CSRF / DNS rebinding.
  if (req.method === 'POST' && !writeAllowed(req)) {
    return sendJSON(res, 403, { ok: false, error: 'forbidden — local origin + X-Conductor header required' });
  }
  if (url.pathname === '/api/meta') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(adapterMeta()));
    return;
  }

  if (url.pathname === '/api/sessions') {
    const all = url.searchParams.get('all') === '1';
    const minutes = parseInt(url.searchParams.get('minutes'), 10) || 60;
    const meta = adapterMeta();
    try {
      let rows;
      rows = await collectAgentRows({ minutes, all });
      const mgd = manage.managedBySession();         // sessionId -> managed window
      const vis = seat.visibilityMap();              // sessionId -> [{seatId, seatLabel, mode}]
      for (const r of rows) {
        const w = mgd[r.sessionId];
        if (w) { r.managed = true; r.mlabel = w.label; }
        const v = vis[r.sessionId];
        if (v && v.length) r.seatVisibility = v;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ generatedAt: new Date().toISOString(), adapter: meta.adapter, statuses: meta.statuses, capabilities: meta.capabilities, destructive: meta.destructive, broadcastUi: meta.broadcastUi, count: rows.length, sessions: rows }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Copilot Seats: the host-side view + management of scoped remote access. GET is read-only
  // (the trust audit the cockpit renders); POST create/grant/revoke is CSRF-gated like every
  // other state change. The remote surface itself lives in seat-server.js, never here.
  if (url.pathname === '/api/seats' && req.method === 'GET') {
    const seats = seat.listSeats();
    try {
      const rows = await collectAgentRows({ minutes: 4320, all: false });
      const labelBySid = {};
      for (const r of rows) labelBySid[r.sessionId] = r.label;
      for (const st of seats) for (const g of st.grants) g.session = labelBySid[g.sessionId] || g.sessionId;
    } catch { /* a granted window may be gone; fall back to the raw id */ }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ seats, recentActivity: seat.readAudit(30) }));
    return;
  }
  if (url.pathname === '/api/seats' && req.method === 'POST') {
    readBody(req, res, async (p) => {
      try {
        if (p.action === 'create') {
          const r = seat.createSeat(p.label);
          return sendJSON(res, 200, { ok: true, seatId: r.id, ...r });   // seatId alias for the UI/MCP
        }
        if (p.action === 'grant') {
          if (!p.seatId || !p.session) return sendJSON(res, 400, { ok: false, error: 'seatId and session required' });
          const mode = p.mode === 'collaborate' ? 'collaborate' : 'view';
          const rows = await collectAgentRows({ minutes: 4320 });
          const s = rows.find((r) => r.sessionId === p.session || r.shortId === p.session);
          if (!s) return sendJSON(res, 400, { ok: false, error: 'session not found' });
          return sendJSON(res, 200, seat.grant(p.seatId, s.sessionId, mode));
        }
        if (p.action === 'revoke') {
          if (!p.seatId) return sendJSON(res, 400, { ok: false, error: 'seatId required' });
          // p.session here is a sessionId (the UI knows it); omit to kill the whole seat.
          return sendJSON(res, 200, p.session ? seat.revoke(p.seatId, p.session) : seat.revokeSeat(p.seatId));
        }
        return sendJSON(res, 400, { ok: false, error: 'unknown action (create|grant|revoke)' });
      } catch (e) { sendJSON(res, 400, { ok: false, error: e.message }); }
    });
    return;
  }

  if (url.pathname === '/api/say' && req.method === 'POST') {
    readBody(req, res, (p) => {
      // deliver() gates on readiness + confirms the prompt landed (returns a status the UI chips);
      // key sends stay raw (interrupt must fire regardless of pane state).
      const r = p.key ? manage.key(p.label, p.key) : manage.deliver(p.label, p.text || '');
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }

  // Bring a managed window's terminal to the front (macOS).
  if (url.pathname === '/api/open' && req.method === 'POST') {
    readBody(req, res, (p) => { const r = manage.openTerminal(p.label); sendJSON(res, r.ok ? 200 : 400, r); });
    return;
  }

  // Close a managed window: kill its tmux window. Irreversible (the live session's state is
  // lost), so — like flatten — it requires a confirm token (confirm === the window label) on
  // top of the CSRF guard; the UI also double-confirms. Only conductor-managed windows live in
  // tmux and can be killed this way; plain windows running in the user's own terminal tabs have
  // no handle here and must be closed from that terminal.
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    readBody(req, res, (p) => {
      if (!p.label) return sendJSON(res, 400, { ok: false, error: 'label required' });
      if (p.confirm !== p.label) return sendJSON(res, 400, { ok: false, error: 'closing a window is irreversible — confirm token (the label) required' });
      const r = manage.stop(p.label);
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }

  // Broadcast to every managed window at once.
  if (url.pathname === '/api/say-all' && req.method === 'POST') {
    readBody(req, res, (p) => sendJSON(res, 200, manage.sayAll(p)));
    return;
  }

  // Launch a brand-new managed window (born in tmux, no fork needed).
  if (url.pathname === '/api/run' && req.method === 'POST') {
    readBody(req, res, (p) => {
      const label = (p.label || '').trim();
      if (!label) return sendJSON(res, 400, { ok: false, error: 'label required' });
      let cwd = (p.cwd || '').trim();
      cwd = cwd ? cwd.replace(/^~(?=$|\/)/, os.homedir()) : os.homedir();
      const r = manage.run(label, [], cwd, { capture: false });   // non-blocking; lazy-resolve later
      if (r.ok) deliverAdopted(r.label, '');                      // accept startup prompts → ready
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }

  // Reply to a plain window: adopt it (if not already managed), then deliver the message.
  if (url.pathname === '/api/adopt-say' && req.method === 'POST') {
    readBody(req, res, async (p) => {
      try {
        const text = p.text || '';
        const existing = manage.managedBySession()[p.session];
        if (existing) {                       // already managed → just send
          const r = manage.say(existing.label, text);
          return sendJSON(res, r.ok ? 200 : 400, { ...r, label: existing.label });
        }
        const rows = await collectAgentRows({ minutes: 4320 });
        const s = rows.find((r) => r.sessionId === p.session || r.shortId === p.session);
        if (!s) return sendJSON(res, 400, { ok: false, error: 'session not found' });
        const label = manage.uniqueLabel(s.label || s.shortId, s.sessionId);
        const r = manage.adopt(label, s.sessionId, s.cwd, { capture: false });
        if (r.ok) {
          deliverAdopted(label, text);        // accept startup prompts, then deliver once ready
          return sendJSON(res, 200, { ok: true, label, adopted: true });
        }
        // adopt failed (commonly: a managed copy of this window already exists) → send to it
        const sr = manage.say(label, text);
        sendJSON(res, sr.ok ? 200 : 400, { ok: sr.ok, label, error: sr.ok ? undefined : r.error });
      } catch (e) { sendJSON(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  // Bring an existing (read-only) window under management by forking it into tmux.
  if (url.pathname === '/api/adopt' && req.method === 'POST') {
    readBody(req, res, async (p) => {
      try {
        const rows = await collectAgentRows({ minutes: 4320 });
        const s = rows.find((r) => r.sessionId === p.session || r.shortId === p.session);
        if (!s) return sendJSON(res, 400, { ok: false, error: 'session not found' });
        const label = manage.uniqueLabel(s.label || s.shortId, s.sessionId);
        const r = manage.adopt(label, s.sessionId, s.cwd, { capture: false });
        if (r.ok) deliverAdopted(r.label, '');
        sendJSON(res, r.ok ? 200 : 400, r);
      } catch (e) { sendJSON(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/manual') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(MANUAL);
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    // __ADAPTER__ is whitelisted ([a-z0-9-]) by engine.loadAdapter; __META__ is JSON landing in
    // a <script> context, so '<' is emitted as the \u003c JSON escape — a value can't close the tag.
    const html = PAGE
      .replace('__ADAPTER__', ADAPTER_NAME)
      .replace('__META__', () => JSON.stringify(adapterMeta()).replace(/</g, '\\u003c'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

function openBrowser(url) {
  if (process.platform === 'darwin') execFile('open', [url]);
  else if (process.platform === 'linux') execFile('xdg-open', [url]);
  else console.log(`open ${url}`);
}

function main() {
  const args = parseArgs(process.argv);
  try { engine.loadAdapter(DEFAULT_ADAPTER); ADAPTER_NAME = DEFAULT_ADAPTER; }
  catch (e) { console.error(`${CLI_NAME}: ${e.message}`); process.exit(1); }
  const url = `http://localhost:${args.port}`;
  const server = http.createServer(handle);

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // Already running? If it answers like a conductor cockpit, just open it (idempotent).
      const req = http.get({ host: '127.0.0.1', port: args.port, path: '/api/sessions?minutes=1', timeout: 1500 }, (r) => {
        let d = ''; r.on('data', (c) => d += c);
        r.on('end', () => {
          if (d.includes('"sessions"')) {
            console.log(`${PRODUCT_NAME} is already running -> ${url}  (opening it)`);
            if (args.open) openBrowser(url);
            process.exit(0);
          } else {
            console.error(`Port ${args.port} is in use by something else. Try: ${CLI_NAME} up --port 8080`);
            process.exit(1);
          }
        });
      });
      req.on('error', () => { console.error(`Port ${args.port} is busy. Try: ${CLI_NAME} up --port 8080`); process.exit(1); });
      req.on('timeout', () => { req.destroy(); console.error(`Port ${args.port} is busy. Try: ${CLI_NAME} up --port 8080`); process.exit(1); });
      return;
    }
    console.error(`${CLI_NAME} server error:`, e.message);
    process.exit(1);
  });

  server.listen(args.port, '127.0.0.1', () => {
    console.log(`${PRODUCT_NAME} cockpit -> ${url}  (Ctrl+C to stop)`);
    if (args.open) openBrowser(url);
  });
}

main();
