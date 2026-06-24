#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓ ' + name);
  pass++;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-conductor-'));
const codexHome = path.join(root, '.codex');
const day = path.join(codexHome, 'sessions', '2026', '06', '24');
fs.mkdirSync(day, { recursive: true });

const sid = '019f1111-2222-7333-8444-555566667777';
const file = path.join(day, `rollout-2026-06-24T10-00-00-${sid}.jsonl`);
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

function jsonl(records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({
  id: sid,
  thread_name: 'Build Codex monitor',
  updated_at: iso(1000),
}) + '\n');

jsonl([
  { timestamp: iso(60000), type: 'session_meta', payload: { id: sid, cwd: '/Users/test/codex-app', originator: 'Codex CLI' } },
  { timestamp: iso(50000), type: 'event_msg', payload: { type: 'user_message', message: 'watch my Codex work' } },
  { timestamp: iso(30000), type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: '{"path":"README.md"}' } },
  { timestamp: iso(10000), type: 'event_msg', payload: { type: 'agent_message', message: 'I am scanning the Codex session history now.' } },
]);

function run(args) {
  return execFileSync('node', [path.join(__dirname, 'scan.js'), ...args], {
    env: { ...process.env, HOME: root, CODEX_HOME: codexHome },
    encoding: 'utf8',
  });
}

console.log('codex-conductor tests:');

const json = JSON.parse(run(['--json', '--minutes', '60']));
ok('defaults to the Codex source', json.source === 'codex');
ok('finds the fake Codex session', json.count === 1 && json.sessions[0].sessionId === sid);
ok('uses session_index thread name as the task/title', json.sessions[0].task === 'Build Codex monitor');
ok('labels the project from cwd basename', json.sessions[0].label === 'Codex App');
ok('captures the Codex assistant message as last action', /scanning the Codex session history/.test(json.sessions[0].lastAction));
ok('keeps Codex context chip', json.sessions[0].context.includes('codex'));

const table = run(['--minutes', '60']);
ok('pretty table renders Codex Conductor', table.includes('Codex Conductor'));
ok('pretty table renders the short session id', table.includes(sid.slice(0, 8)));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} assertions passed.`);
