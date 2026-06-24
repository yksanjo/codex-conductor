'use strict';

// seat.js — the Copilot Seat trust core.
//
// Conductor's full cockpit (server.js :7591) sees EVERY live window on the box and can drive
// any of them. That's right for the solo operator at the keyboard, but you can't hand that to a
// remote teammate. A "seat" is the scoped, deny-by-default surface you DO hand out: a remote
// copilot connected to a seat can see and act on ONLY the sessions you explicitly granted it —
// everything else on your machine is invisible (un-enumerable) and unreachable.
//
// The trust property lives in one place: filterForSeat() / seatCan() are the ONLY way session
// data or a write reaches a peer, and both deny unless there's an explicit grant. The seat
// server (seat-server.js) has no code path that takes an arbitrary sessionId without first
// passing it through here, so a non-granted session can't leak even by enumeration — callers
// return 404 (invisible), never 403 (forbidden, which would confirm it exists).
//
// Auth is a per-seat bearer credential ("<id>.<token>"). We store only an HMAC of the token
// (keyed by a local secret), never the token itself — same shape as the soag-gate cookie. Every
// grant, revoke, read, reply, and miss is appended to an audit log so the host can see exactly
// what a copilot has done. Zero dependencies; node built-ins only.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// All seat state lives under ~/.conductor (the same dir manage.js uses for managed.json).
const DIR = path.join(os.homedir(), '.conductor');
const SEATS_FILE = path.join(DIR, 'seats.json');
const SECRET_FILE = path.join(DIR, 'seat-secret');     // 0600; HMAC key for token hashing
const AUDIT_FILE = path.join(DIR, 'seat-audit.log');   // append-only; one JSON line per event

const MODES = ['view', 'collaborate'];

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

// The HMAC key. Generated once, 0600, and never leaves the box. Rotating it invalidates every
// existing credential (a deliberate panic lever: delete seat-secret to cut all seats at once).
function loadSecret() {
  ensureDir();
  try { const s = fs.readFileSync(SECRET_FILE, 'utf8').trim(); if (s) return s; } catch { /* generate below */ }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch { /* best effort on platforms without chmod */ }
  return secret;
}

// We persist this, never the raw token. Verification re-hashes the presented token and compares.
function hashToken(token) {
  return crypto.createHmac('sha256', loadSecret()).update(String(token)).digest('hex');
}

function load() {
  try { return JSON.parse(fs.readFileSync(SEATS_FILE, 'utf8')); } catch { return { seats: {} }; }
}
function save(store) { ensureDir(); fs.writeFileSync(SEATS_FILE, JSON.stringify(store, null, 2)); }

function nowIso() { return new Date().toISOString(); }
// Seat ids are hex (no '.') so the "<id>.<token>" credential splits unambiguously — base64url
// tokens contain only [A-Za-z0-9_-], also no '.'.
function genId() { return 's' + crypto.randomBytes(5).toString('hex'); }
function genToken() { return crypto.randomBytes(32).toString('base64url'); }

// --- audit ------------------------------------------------------------------
// Append one JSON line per event. Audit failure must NEVER break a request, so it's best-effort.
function audit(entry) {
  try { ensureDir(); fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: nowIso(), ...entry }) + '\n'); }
  catch { /* ignore */ }
}
function readAudit(limit = 50) {
  let txt;
  try { txt = fs.readFileSync(AUDIT_FILE, 'utf8'); } catch { return []; }
  return txt.split('\n').filter(Boolean).slice(-limit)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// --- seat lifecycle ---------------------------------------------------------
// Mint a seat. Returns the token + combined credential ONCE — only the HMAC is stored, so this
// is the only moment the host can copy it. Share url + credential with the copilot out of band.
function createSeat(label) {
  const store = load();
  const id = genId();
  const token = genToken();
  const clean = String(label || 'copilot').replace(/\s+/g, ' ').trim().slice(0, 60) || 'copilot';
  store.seats[id] = { id, label: clean, tokenHash: hashToken(token), createdAt: nowIso(), grants: {}, revokedAt: null };
  save(store);
  audit({ seatId: id, action: 'seat-create', outcome: 'ok', detail: clean });
  return { id, label: clean, token, credential: id + '.' + token };
}

function getSeat(id) { return load().seats[id] || null; }

// Verify a presented token against a seat. Constant-time, and revoked seats always fail.
function verifyToken(id, token) {
  const s = getSeat(id);
  if (!s || s.revokedAt) return null;
  const want = Buffer.from(s.tokenHash, 'hex');
  const got = Buffer.from(hashToken(token), 'hex');
  if (want.length !== got.length) return null;          // timingSafeEqual throws on length mismatch
  if (!crypto.timingSafeEqual(want, got)) return null;
  return s;
}
// Verify a combined "<id>.<token>" credential. Returns the seat or null.
function verifyCredential(cred) {
  const str = String(cred || '');
  const dot = str.indexOf('.');
  if (dot <= 0 || dot === str.length - 1) return null;
  return verifyToken(str.slice(0, dot), str.slice(dot + 1));
}

function grant(id, sessionId, mode = 'view', note) {
  if (!MODES.includes(mode)) return { ok: false, error: `mode must be one of: ${MODES.join(', ')}` };
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  const store = load();
  const s = store.seats[id];
  if (!s) return { ok: false, error: `no seat "${id}"` };
  if (s.revokedAt) return { ok: false, error: `seat "${id}" is revoked` };
  s.grants[sessionId] = { mode, grantedAt: nowIso(), note: note ? String(note).slice(0, 140) : undefined };
  save(store);
  audit({ seatId: id, action: 'grant', outcome: 'ok', sessionId, detail: mode });
  return { ok: true, seatId: id, sessionId, mode };
}

function revoke(id, sessionId) {
  const store = load();
  const s = store.seats[id];
  if (!s) return { ok: false, error: `no seat "${id}"` };
  const had = !!(s.grants && s.grants[sessionId]);
  if (s.grants) delete s.grants[sessionId];
  save(store);
  audit({ seatId: id, action: 'revoke', outcome: had ? 'ok' : 'noop', sessionId });
  return { ok: true, seatId: id, sessionId, removed: had };
}

// Kill a whole seat: future requests with its credential all fail (revoked seats never verify).
function revokeSeat(id) {
  const store = load();
  const s = store.seats[id];
  if (!s) return { ok: false, error: `no seat "${id}"` };
  s.revokedAt = nowIso();
  save(store);
  audit({ seatId: id, action: 'revoke-seat', outcome: 'ok' });
  return { ok: true, seatId: id, revoked: true };
}

// --- the trust choke point --------------------------------------------------
// Can this seat do `action` ('read' | 'reply') on this session? Deny unless an explicit grant
// says so. 'reply' additionally requires the grant be 'collaborate' (view grants are read-only).
function seatCan(seat, sessionId, action) {
  if (!seat || seat.revokedAt) return false;
  const g = seat.grants && seat.grants[sessionId];
  if (!g) return false;
  if (action === 'read') return true;
  if (action === 'reply') return g.mode === 'collaborate';
  return false;
}

// Project full session rows down to ONLY the granted ones, in a minimal shape. This is the only
// path session data leaves the box for a peer — a non-granted row is dropped here, so it never
// appears in any listing the peer can request.
function filterForSeat(seat, rows) {
  if (!seat || seat.revokedAt) return [];
  const grants = seat.grants || {};
  const out = [];
  for (const r of rows || []) {
    const g = grants[r.sessionId];
    if (!g) continue;
    out.push({
      sessionId: r.sessionId, shortId: r.shortId, label: r.label, title: r.title,
      status: r.status, task: r.task, gitBranch: r.gitBranch, cwd: r.cwd,
      lastActiveRel: r.lastActiveRel, mode: g.mode, canReply: g.mode === 'collaborate',
    });
  }
  return out;
}

// --- host-side views (for the cockpit / MCP status) -------------------------
// sessionId -> [{seatId, seatLabel, mode}] across all live seats, so the cockpit can badge each
// card "shared with X". Revoked seats contribute nothing.
function visibilityMap() {
  const store = load();
  const map = {};
  for (const s of Object.values(store.seats)) {
    if (s.revokedAt) continue;
    for (const [sessionId, g] of Object.entries(s.grants || {})) {
      (map[sessionId] = map[sessionId] || []).push({ seatId: s.id, seatLabel: s.label, mode: g.mode });
    }
  }
  return map;
}

// All seats, token-free, with grants as an array + last-seen time from the audit trail.
function listSeats() {
  const store = load();
  const last = {};
  for (const e of readAudit(800)) { if (e.seatId) last[e.seatId] = e.ts; }
  return Object.values(store.seats).map((s) => ({
    id: s.id, label: s.label, createdAt: s.createdAt, revokedAt: s.revokedAt || null,
    grants: Object.entries(s.grants || {}).map(([sessionId, g]) => ({ sessionId, mode: g.mode, grantedAt: g.grantedAt, note: g.note })),
    lastSeen: last[s.id] || null,
  }));
}

module.exports = {
  MODES, SEATS_FILE, SECRET_FILE, AUDIT_FILE,
  createSeat, getSeat, verifyToken, verifyCredential,
  grant, revoke, revokeSeat, seatCan, filterForSeat,
  visibilityMap, listSeats, audit, readAudit,
};
