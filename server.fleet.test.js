#!/usr/bin/env node
'use strict';

// No-mock test for the cockpit's FLEET adapter mode + the destructive-control confirm guard.
// Spawns the real server with --adapter fleet against an isolated FLEET_DIR seeded by fakebot,
// then drives it with raw HTTP. Complements server.test.js (which covers the CSRF guard on the
// claude path). Zero dependencies.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-fleetsrv-'));
const FLEET_DIR = path.join(root, '.fleet');
const PORT = 7594;
let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

function req(method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: headers || {} }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const local = { 'content-type': 'application/json', 'x-conductor': '1', origin: 'http://localhost:' + PORT };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const NOW = Date.now();
  for (const sc of ['healthy', 'wedged', 'drawdown']) {
    execFileSync('node', [path.join(__dirname, 'tools', 'fakebot.js'), 'bot-' + sc, '--scenario', sc, '--dir', FLEET_DIR, '--now', String(NOW)]);
  }

  const srv = spawn('node', [path.join(__dirname, 'server.js'), '--adapter', 'fleet', '--port', String(PORT), '--no-open'],
    { env: { ...process.env, HOME: root, FLEET_DIR }, stdio: 'ignore' });
  try {
    await sleep(1400);
    console.log('conductor cockpit (fleet) tests:');

    const meta = JSON.parse((await req('GET', '/api/meta')).body);
    ok('/api/meta reports the fleet adapter', meta.adapter === 'fleet');
    ok('/api/meta advertises control capabilities', meta.capabilities.includes('flatten') && meta.capabilities.includes('pause'));
    ok('/api/meta carries the fleet status vocabulary', meta.statuses.map((s) => s.key).join('>') === 'wedged>drawdown>active>idle');

    const sess = JSON.parse((await req('GET', '/api/sessions?adapter=fleet&minutes=60')).body);
    ok('/api/sessions returns the three bots', sess.count === 3);
    ok('  …sectioned by fleet status', sess.sessions.some((s) => s.status === 'wedged') && sess.sessions.some((s) => s.status === 'drawdown'));

    // non-destructive control: pause needs no confirm token, just the CSRF guard
    const pause = await req('POST', '/api/control', local, JSON.stringify({ adapter: 'fleet', target: 'bot-healthy', command: { cmd: 'pause' } }));
    ok('pause (non-destructive) → 200', pause.status === 200);
    ok('  …writes the command to control.jsonl', /"cmd":"pause"/.test(fs.readFileSync(path.join(FLEET_DIR, 'bots', 'bot-healthy', 'control.jsonl'), 'utf8')));

    // destructive control: flatten WITHOUT a confirm token is rejected
    const noConfirm = await req('POST', '/api/control', local, JSON.stringify({ adapter: 'fleet', target: 'bot-healthy', command: { cmd: 'flatten' } }));
    ok('flatten without confirm token → 400', noConfirm.status === 400);

    // …and WITH the confirm token it lands
    const withConfirm = await req('POST', '/api/control', local, JSON.stringify({ adapter: 'fleet', target: 'bot-healthy', command: { cmd: 'flatten' }, confirm: 'flatten' }));
    ok('flatten with confirm token → 200', withConfirm.status === 200);

    // CSRF guard still applies on the control plane: no X-Conductor header → 403
    const noHdr = await req('POST', '/api/control', { 'content-type': 'application/json' }, JSON.stringify({ adapter: 'fleet', target: 'bot-healthy', command: { cmd: 'pause' } }));
    ok('control without X-Conductor → 403', noHdr.status === 403);

    // foreign Origin → 403 even with the header
    const badOrigin = await req('POST', '/api/control', { 'content-type': 'application/json', 'x-conductor': '1', origin: 'http://evil.example' }, JSON.stringify({ adapter: 'fleet', target: 'bot-healthy', command: { cmd: 'pause' } }));
    ok('control from foreign Origin → 403', badOrigin.status === 403);

    // broadcast (desk-wide flatten) requires the confirm token
    const bcNo = await req('POST', '/api/broadcast', local, JSON.stringify({ adapter: 'fleet', command: { cmd: 'flatten' } }));
    ok('broadcast without confirm → 400', bcNo.status === 400);
    const bcYes = await req('POST', '/api/broadcast', local, JSON.stringify({ adapter: 'fleet', command: { cmd: 'flatten' }, confirm: 'flatten' }));
    const bcData = JSON.parse(bcYes.body);
    ok('broadcast with confirm → 200, flattens all 3 bots', bcYes.status === 200 && bcData.sent === 3);

    // the page boots in fleet mode (token replacement)
    const page = await req('GET', '/');
    ok('cockpit page boots in fleet mode', /const ADAPTER = 'fleet'/.test(page.body));

    srv.kill();
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${pass} assertions passed.`);
  } catch (e) {
    srv.kill(); fs.rmSync(root, { recursive: true, force: true });
    console.error('FAIL:', e.message); process.exit(1);
  }
})();
