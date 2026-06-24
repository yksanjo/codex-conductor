#!/usr/bin/env node
'use strict';

// seat-server.js — the Copilot Seat: a SEPARATE, low-power remote surface.
//
// This is the ONLY part of Conductor a remote teammate can reach. It is deliberately NOT the
// full cockpit (server.js :7591, which stays bound to 127.0.0.1 forever and sees everything).
// The seat server:
//   • binds to 127.0.0.1:7593 by default — you expose it through a tunnel YOU control
//     (cloudflared / tailscale), so there's no open inbound port and no TLS to manage;
//   • authenticates every request with a per-seat bearer credential ("<id>.<token>");
//   • routes EVERY read and write through seat.js's grant filter, so a session the host didn't
//     grant is invisible (returns 404 — never 403, which would confirm it exists) and a write
//     to it is impossible;
//   • exposes NO host-only verbs (launch / kill / broadcast / adopt have no route here);
//   • still runs every collaborate-mode reply through the SAME irreversibility gate (policy.js)
//     the local driver uses — a remote copilot can never auto-approve deploy/send/delete/spend;
//   • appends every request to the audit log so the host can see exactly what a copilot did.
//
// Zero dependencies (node:http only).
//
//   conductor-seat                       start on :7593 (loopback), print the tunnel recipe
//   CONDUCTOR_SEAT_PORT=9000 conductor-seat
//   CONDUCTOR_SEAT_HOST=0.0.0.0 conductor-seat   # direct bind (discouraged; prefer a tunnel)

const http = require('http');
const { collectSessions } = require('./lib');
const policy = require('./policy');
const seat = require('./seat');
const { findSession, lastAssistantText, replyToSession } = require('./drive');

const PORT = parseInt(process.env.CONDUCTOR_SEAT_PORT, 10) || 7593;
const HOST = process.env.CONDUCTOR_SEAT_HOST || '127.0.0.1';

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, res, cb) {
  let b = '', over = false;
  req.on('data', (c) => {
    b += c;
    if (b.length > 8192 && !over) { over = true; sendJSON(res, 413, { ok: false, error: 'body too large' }); req.destroy(); }
  });
  req.on('end', () => {
    if (over) return;
    let p;
    try { p = JSON.parse(b || '{}'); } catch { return sendJSON(res, 400, { ok: false, error: 'invalid JSON body' }); }
    // cb may be async; surface its errors as a clean 500 rather than an unhandled rejection.
    Promise.resolve().then(() => cb(p)).catch((e) => { try { sendJSON(res, 500, { ok: false, error: e.message }); } catch { /* response already sent */ } });
  });
}

// Resolve the seat from the Authorization: Bearer <id>.<token> header. null ⇒ unauthenticated.
function authSeat(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  return seat.verifyCredential(m[1].trim());
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  // Auth first — before we touch session data at all. A bad/absent credential learns nothing.
  const s = authSeat(req);
  if (!s) {
    seat.audit({ action: 'auth', outcome: 'reject', detail: req.method + ' ' + url.pathname });
    return sendJSON(res, 401, { ok: false, error: 'unauthorized — Authorization: Bearer <seatId>.<token> required' });
  }

  // Who am I + what can I see? (cheap, no session data — just the grant count.)
  if (url.pathname === '/seat/whoami' && req.method === 'GET') {
    const n = Object.keys(s.grants || {}).length;
    seat.audit({ seatId: s.id, action: 'whoami', outcome: 'ok' });
    return sendJSON(res, 200, {
      ok: true, seat: s.label, sessions: n,
      note: `Scoped copilot seat. You can see ${n} session(s) the host shared. Everything else on the host is private and invisible to you.`,
    });
  }

  // List ONLY granted sessions. filterForSeat() drops everything else before it leaves the box.
  if (url.pathname === '/seat/sessions' && req.method === 'GET') {
    const rows = await collectSessions({ minutes: 4320, all: false });
    const visible = seat.filterForSeat(s, rows);
    seat.audit({ seatId: s.id, action: 'list', outcome: 'ok', detail: String(visible.length) });
    return sendJSON(res, 200, { ok: true, count: visible.length, sessions: visible });
  }

  // Read one granted session's detail + recent transcript. Ungranted/nonexistent → 404 (same
  // response for both, so the peer can't distinguish "not shared" from "doesn't exist").
  const readMatch = /^\/seat\/session\/(.+)$/.exec(url.pathname);
  if (readMatch && req.method === 'GET') {
    const ref = decodeURIComponent(readMatch[1]);
    const sess = await findSession(ref);
    if (!sess || !seat.seatCan(s, sess.sessionId, 'read')) {
      seat.audit({ seatId: s.id, action: 'read', outcome: 'miss', sessionId: sess ? sess.sessionId : ref });
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    }
    seat.audit({ seatId: s.id, action: 'read', outcome: 'ok', sessionId: sess.sessionId });
    const g = s.grants[sess.sessionId];
    return sendJSON(res, 200, {
      ok: true, label: sess.label, sessionId: sess.sessionId, shortId: sess.shortId,
      cwd: sess.cwd, branch: sess.gitBranch, status: sess.status, lastActive: sess.lastActiveRel,
      mode: g.mode, canReply: g.mode === 'collaborate',
      goal: sess.intent || sess.task || sess.title, doingNow: sess.lastAction,
      recent: (sess.recent || []).map((e) => `${e.actor === 'assistant' ? 'agent' : (e.actor || 'you')}: ${e.summary}`),
    });
  }

  // Reply to a granted collaborate session. Three gates in order:
  //   1. seatCan('reply') — must be a collaborate grant, else 404 (view-only is invisible to writes).
  //   2. policy.gate — irreversible actions (deploy/send/delete/spend) are NEVER auto-approved
  //      for a remote copilot; they bounce back for the HOST human to handle.
  //   3. replyToSession — the same adopt-then-deliver path the local cockpit uses.
  if (url.pathname === '/seat/say' && req.method === 'POST') {
    return readBody(req, res, async (p) => {
      const ref = p.session;
      const text = String(p.text || '');
      if (!ref || !text.trim()) return sendJSON(res, 400, { ok: false, error: 'session and text are required' });
      const sess = await findSession(ref);
      if (!sess || !seat.seatCan(s, sess.sessionId, 'reply')) {
        seat.audit({ seatId: s.id, action: 'say', outcome: 'miss', sessionId: sess ? sess.sessionId : ref });
        return sendJSON(res, 404, { ok: false, error: 'not found' });   // ungranted, view-only, or nonexistent
      }
      const question = lastAssistantText(sess);
      const decision = policy.gate(question, text);
      if (!decision.allow) {
        seat.audit({ seatId: s.id, action: 'say', outcome: 'gated', sessionId: sess.sessionId, detail: (decision.categories || []).join(',') });
        return sendJSON(res, 200, {
          ok: false, gated: true, sent: false, session: sess.label,
          reason: decision.reason, categories: decision.categories, matched: decision.matched,
          question, proposedReply: text,
          note: 'NOT sent — an irreversible action (deploy/send/delete/spend) needs the HOST human, not a remote copilot. Ask the host to approve and send it.',
        });
      }
      const r = await replyToSession(ref, text);
      seat.audit({ seatId: s.id, action: 'say', outcome: r.ok ? 'sent' : 'fail', sessionId: sess.sessionId });
      return sendJSON(res, r.ok ? 200 : 400, { ...r, gated: false, sent: !!r.ok });
    });
  }

  // No other route exists — and crucially, no launch/kill/broadcast/adopt verb is reachable here.
  seat.audit({ seatId: s.id, action: 'route', outcome: 'reject', detail: req.method + ' ' + url.pathname });
  return sendJSON(res, 404, { ok: false, error: 'not found' });
}

function isLoopback(host) { return host === '127.0.0.1' || host === '::1' || host === 'localhost'; }

function main() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { sendJSON(res, 500, { ok: false, error: e.message }); } catch { /* sent */ } });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is busy. Set CONDUCTOR_SEAT_PORT to another port.`); process.exit(1); }
    console.error('seat server error:', e.message); process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`🪑 Conductor Copilot Seat → http://${HOST}:${PORT}  (Ctrl+C to stop)`);
    if (isLoopback(HOST)) {
      console.log('   Bound to loopback only. Expose it to a remote copilot via a tunnel you control:');
      console.log(`     cloudflared tunnel --url http://127.0.0.1:${PORT}`);
      console.log('     # or:  tailscale serve / funnel');
      console.log('   The full cockpit (:7591) stays local — only THIS scoped seat is reachable.');
    } else {
      console.log(`   ⚠ Bound to ${HOST} (non-loopback). Every request still needs a seat credential and`);
      console.log('   ⚠ deny-by-default still applies, but prefer a tunnel over an open inbound port.');
    }
    console.log('   Mint a seat + grant windows from the cockpit (🪑), or the conductor MCP (seat_create / seat_grant).');
  });
}

if (require.main === module) main();
module.exports = { handle };
