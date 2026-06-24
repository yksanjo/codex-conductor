#!/usr/bin/env node
'use strict';

// End-to-end COPILOT test. seat.test.js proves the seat SERVER over raw HTTP; this proves the
// whole chain a real teammate uses: the copilot's own MCP client (seat-mcp.js) → the live
// seat-server.js → seat.js's grant filter → policy.js's gate. We drive seat-mcp's actual tools
// (seat_connect / seat_whoami / seat_list_sessions / seat_read / seat_reply) in-process against
// a real server, with HOME pointed at a throwaway dir so the client's config + the host's seat
// state both live in the sandbox. No window is ever driven (the gate returns first), so no tmux
// or claude process is spawned. Zero dependencies.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// HOME must be set BEFORE requiring seat.js / seat-mcp.js so every path resolves into the sandbox.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-seat-e2e-'));
process.env.HOME = root;
const seat = require('./seat');
const mcp = require('./seat-mcp');   // the copilot's client (reads ~/.conductor/seat-client.json)

const PORT = 7895;
const URL = 'http://127.0.0.1:' + PORT;
let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(Date.now() - ms).toISOString();

// Drive one copilot tool and parse its JSON text result back into an object.
async function call(name, args) {
  const r = await mcp.callTool(name, args);
  return JSON.parse(r.content[0].text);
}

// --- sandbox projects tree: two live-ish sessions ---------------------------
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
const sidView = 'aaaaaaaa-1111-2222-3333-444444444444';   // granted: view
const sidCollab = 'bbbbbbbb-1111-2222-3333-444444444444'; // granted: collaborate
const sidSecret = 'cccccccc-1111-2222-3333-444444444444'; // NOT granted (must stay invisible)
writeSession('-Users-test-alpha', sidView, 'work on alpha', 'Should I keep going on alpha?');
writeSession('-Users-test-bravo', sidCollab, 'work on bravo', 'Ready for the next step on bravo?');
writeSession('-Users-test-charlie', sidSecret, 'secret charlie', 'private work nobody granted');

// --- mint a seat + grants (the host side) -----------------------------------
const created = seat.createSeat('alex');
const cred = created.credential;
seat.grant(created.id, sidView, 'view');
seat.grant(created.id, sidCollab, 'collaborate');

// --- spawn the REAL seat server ---------------------------------------------
const srv = spawn('node', [path.join(__dirname, 'seat-server.js')], {
  env: { ...process.env, HOME: root, CONDUCTOR_SEAT_PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitReady() {
  const http = require('http');
  for (let i = 0; i < 50; i++) {
    const up = await new Promise((res) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, path: '/seat/whoami', timeout: 1000 },
        (resp) => { resp.resume(); res(true); });
      r.on('error', () => res(false));
      r.on('timeout', () => { r.destroy(); res(false); });
      r.end();
    });
    if (up) return;
    await sleep(150);
  }
  throw new Error('seat server did not come up on :' + PORT);
}

(async () => {
  console.log('conductor Copilot Seat — end-to-end (via seat-mcp client):');
  await waitReady();

  // --- connect: the credential is the only key the copilot has ---
  const badConnect = await call('seat_connect', { url: URL, credential: created.id + '.totally-wrong-token' });
  ok('seat_connect with a wrong token fails cleanly (no config saved)', badConnect.ok === false && /HTTP 401/.test(badConnect.error || ''));
  ok('a failed connect leaves the copilot unconnected', !fs.existsSync(path.join(root, '.conductor', 'seat-client.json')));

  const conn = await call('seat_connect', { url: URL, credential: cred });
  ok('seat_connect with the real credential connects as "alex", sees 2 sessions', conn.ok === true && conn.seat === 'alex' && conn.sessions === 2);

  // --- whoami: cheap identity, no session data ---
  const who = await call('seat_whoami', {});
  ok('seat_whoami reports the seat + grant count', who.ok === true && who.seat === 'alex' && who.sessions === 2);

  // --- list: deny-by-default — only the granted windows, with the right write flag ---
  const list = await call('seat_list_sessions', {});
  const ids = (list.sessions || []).map((s) => s.sessionId);
  ok('seat_list_sessions returns exactly the 2 granted windows', list.count === 2 && ids.includes(sidView) && ids.includes(sidCollab));
  ok('the ungranted window is INVISIBLE to the copilot', !ids.includes(sidSecret));
  const vRow = (list.sessions || []).find((s) => s.sessionId === sidView);
  const cRow = (list.sessions || []).find((s) => s.sessionId === sidCollab);
  ok('view grant → canReply:false, collaborate grant → canReply:true', vRow && vRow.canReply === false && cRow && cRow.canReply === true);

  // --- read: a granted window opens; an ungranted one is "not shared", never confirmed to exist ---
  const readOk = await call('seat_read', { session: sidCollab });
  ok('seat_read on a granted window returns its transcript', readOk.ok === true && Array.isArray(readOk.recent) && readOk.recent.length > 0);
  const readMiss = await call('seat_read', { session: sidSecret });
  ok('seat_read on an ungranted window → "not shared", not an error leak', readMiss.ok === false && /not shared with you/.test(readMiss.error || ''));
  const readByLabel = await call('seat_read', { session: 'charlie' });
  ok('the ungranted window is unreachable by label too', readByLabel.ok === false && /not shared with you/.test(readByLabel.error || ''));

  // --- reply: view-only cannot write; collaborate can, but the gate still bites remotely ---
  const replyView = await call('seat_reply', { session: sidView, text: 'continue' });
  ok('seat_reply to a VIEW-only window is refused (not shared for collaboration)', replyView.ok === false && /collaboration/.test(replyView.error || ''));

  const replyGated = await call('seat_reply', { session: sidCollab, text: 'yes, deploy to prod now' });
  ok('seat_reply that would DEPLOY is gated, not sent — bounced to the host', replyGated.gated === true && replyGated.sent === false);
  ok('the gate names the category + echoes the proposed reply for the host', (replyGated.categories || []).includes('deploy') && replyGated.proposedReply === 'yes, deploy to prod now');

  // --- lifecycle: kill the seat → the copilot's connection dies ---
  seat.revokeSeat(created.id);
  const afterKill = await call('seat_whoami', {});
  ok('after the host kills the seat, the copilot is locked out (unauthorized)', afterKill.ok === false && /unauthorized/i.test(afterKill.error || ''));

  srv.kill();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} assertions passed.`);
})().catch((e) => { console.error('FAIL:', e.message); srv.kill(); try { fs.rmSync(root, { recursive: true, force: true }); } catch {} process.exit(1); });
