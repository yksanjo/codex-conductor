#!/usr/bin/env node
'use strict';

// No-mock Copilot Seat test. We set HOME to a throwaway dir, build a fake ~/.claude/projects
// tree with three sessions, mint a real seat and grant TWO of the three, then spawn the REAL
// seat-server.js and prove the trust property over HTTP:
//   • deny-by-default: the ungranted session is invisible in listings AND 404s on direct read
//   • auth: no/wrong credential → 401; a revoked seat → 401
//   • view ≠ collaborate: a view grant cannot reply (404); collaborate can reach the gate
//   • the irreversibility gate still bites remotely (a "deploy to prod" reply is blocked, not sent)
//   • lifecycle: revoke a grant → invisible again; the audit log records every attempt
// We deliberately never drive a real window (matches mcp.test.js): the gate returns before any
// delivery, so no tmux/claude process is ever spawned. Zero dependencies.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// HOME must be set BEFORE requiring seat.js so its paths resolve into the temp dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-seat-'));
process.env.HOME = root;
const seat = require('./seat');

const PORT = 7894;
let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(Date.now() - ms).toISOString();

// --- fake projects tree: three live-ish sessions ----------------------------
function writeSession(folder, sid, prompt, lastText) {
  const dir = path.join(root, '.claude', 'projects', folder);
  fs.mkdirSync(dir, { recursive: true });
  const cwd = '/Users/test/' + folder.replace(/^-Users-test-/, '');
  const rows = [
    { type: 'last-prompt', sessionId: sid, lastPrompt: prompt },
    { type: 'assistant', sessionId: sid, cwd, gitBranch: 'main', timestamp: iso(3000),
      message: { content: [{ type: 'text', text: lastText }] } },
  ];
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
const sidA = 'aaaaaaaa-1111-2222-3333-444444444444';   // granted: view
const sidB = 'bbbbbbbb-1111-2222-3333-444444444444';   // granted: collaborate
const sidC = 'cccccccc-1111-2222-3333-444444444444';   // NOT granted (must stay invisible)
writeSession('-Users-test-alpha', sidA, 'work on alpha', 'Should I keep going on alpha?');
writeSession('-Users-test-bravo', sidB, 'work on bravo', 'Ready for the next step on bravo?');
writeSession('-Users-test-charlie', sidC, 'secret charlie', 'private work nobody granted');

// --- mint a seat + grants ---------------------------------------------------
const created = seat.createSeat('alex');
const cred = created.credential;
seat.grant(created.id, sidA, 'view');
seat.grant(created.id, sidB, 'collaborate');

// --- tiny HTTP client -------------------------------------------------------
function req(method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = opts.body ? JSON.stringify(opts.body) : null;
    const headers = {};
    if (opts.cred) headers.authorization = 'Bearer ' + opts.cred;
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, timeout: 4000 }, (res) => {
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => (d += c));
      res.on('end', () => { let j; try { j = JSON.parse(d || '{}'); } catch { j = {}; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

const srv = spawn('node', [path.join(__dirname, 'seat-server.js')], {
  env: { ...process.env, HOME: root, CONDUCTOR_SEAT_PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/seat/whoami', { cred }); if (r.status === 200 || r.status === 401) return; } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('seat server did not come up on :' + PORT);
}

(async () => {
  console.log('conductor Copilot Seat tests:');
  await waitReady();

  // --- auth ---
  const noAuth = await req('GET', '/seat/sessions');
  ok('no credential → 401', noAuth.status === 401 && noAuth.body.ok === false);
  const badAuth = await req('GET', '/seat/sessions', { cred: created.id + '.totally-wrong-token' });
  ok('wrong token → 401', badAuth.status === 401);

  const who = await req('GET', '/seat/whoami', { cred });
  ok('valid credential → whoami 200, label alex, 2 sessions', who.status === 200 && who.body.seat === 'alex' && who.body.sessions === 2);

  // --- deny-by-default visibility ---
  const list = await req('GET', '/seat/sessions', { cred });
  const ids = (list.body.sessions || []).map((s) => s.sessionId);
  ok('list returns exactly the 2 granted sessions', list.body.count === 2 && ids.includes(sidA) && ids.includes(sidB));
  ok('the ungranted session is INVISIBLE in the listing', !ids.includes(sidC));
  const aRow = (list.body.sessions || []).find((s) => s.sessionId === sidA);
  const bRow = (list.body.sessions || []).find((s) => s.sessionId === sidB);
  ok('view grant carries canReply:false; collaborate carries canReply:true', aRow && aRow.canReply === false && bRow && bRow.canReply === true);

  const readA = await req('GET', '/seat/session/' + sidA, { cred });
  ok('granted session reads (200) with transcript', readA.status === 200 && readA.body.ok === true && Array.isArray(readA.body.recent));
  const readC = await req('GET', '/seat/session/' + sidC, { cred });
  ok('ungranted session read → 404 (invisible, not 403)', readC.status === 404);
  const readCbyLabel = await req('GET', '/seat/session/Charlie', { cred });
  ok('ungranted session is unreachable by label too → 404', readCbyLabel.status === 404);

  // --- view ≠ collaborate ---
  const sayView = await req('POST', '/seat/say', { cred, body: { session: sidA, text: 'continue' } });
  ok('reply to a VIEW-only session → 404 (writes are invisible)', sayView.status === 404);

  // --- the irreversibility gate still bites remotely (no spawn — gate returns first) ---
  const sayGated = await req('POST', '/seat/say', { cred, body: { session: sidB, text: 'deploy to prod now' } });
  ok('collaborate reply that would DEPLOY is gated, not sent', sayGated.status === 200 && sayGated.body.gated === true && sayGated.body.sent === false);
  ok('gate names the category + returns the proposed reply for the host', (sayGated.body.categories || []).includes('deploy') && sayGated.body.proposedReply === 'deploy to prod now');

  // --- lifecycle: revoke one grant → invisible again ---
  seat.revoke(created.id, sidA);
  const list2 = await req('GET', '/seat/sessions', { cred });
  ok('after revoking A, only B remains visible', list2.body.count === 1 && list2.body.sessions[0].sessionId === sidB);
  const readARevoked = await req('GET', '/seat/session/' + sidA, { cred });
  ok('revoked session read → 404 again', readARevoked.status === 404);

  // --- kill the whole seat → credential stops working ---
  seat.revokeSeat(created.id);
  const afterKill = await req('GET', '/seat/whoami', { cred });
  ok('killed seat → 401 (credential dead)', afterKill.status === 401);

  // --- audit trail recorded the journey ---
  const audit = seat.readAudit(200);
  const outcomes = audit.map((e) => e.action + ':' + e.outcome);
  ok('audit logged a granted read (read:ok)', outcomes.includes('read:ok'));
  ok('audit logged the ungranted miss (read:miss)', outcomes.includes('read:miss'));
  ok('audit logged the gate block (say:gated)', outcomes.includes('say:gated'));
  ok('audit logged auth rejections (auth:reject)', outcomes.includes('auth:reject'));

  srv.kill();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} assertions passed.`);
})().catch((e) => { console.error('FAIL:', e.message); srv.kill(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} process.exit(1); });
