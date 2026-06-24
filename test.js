#!/usr/bin/env node
'use strict';

// No-mock tests: build real .jsonl transcripts in a temp dir, point the scanner at it,
// and assert real behavior. Zero dependencies (node:assert / node:fs).

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

// --- build a fake ~/.claude/projects tree ---------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-test-'));
const projects = path.join(root, '.claude', 'projects');
const projA = path.join(projects, '-Users-test-alpha');
const projB = path.join(projects, '-Users-test-beta');
fs.mkdirSync(path.join(projA, 'subagents'), { recursive: true });
fs.mkdirSync(projB, { recursive: true });

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

function jsonl(file, records) {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Session A: a real, recent coding session in /alpha on branch "feat".
const sessA = '11111111-aaaa-bbbb-cccc-000000000001';
jsonl(path.join(projA, sessA + '.jsonl'), [
  { type: 'user', sessionId: sessA, cwd: '/Users/test/alpha', gitBranch: 'feat', timestamp: iso(60000), message: { content: 'add a login form' } },
  { type: 'ai-title', sessionId: sessA, aiTitle: 'Build the login form' },
  { type: 'last-prompt', sessionId: sessA, lastPrompt: 'add a login form' },
  { type: 'assistant', sessionId: sessA, timestamp: iso(40000), message: { content: [{ type: 'thinking', thinking: 'hmm' }] } },
  { type: 'assistant', sessionId: sessA, timestamp: iso(20000), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/Login.tsx' } }] } },
  { type: 'permission-mode', sessionId: sessA, mode: 'default' }, // unknown-ish type, must be ignored
  { type: 'user', sessionId: sessA, timestamp: iso(15000), message: { content: [{ type: 'tool_result', content: 'ok' }] } },
]);

// Subagent thread under A/subagents — MUST be excluded.
jsonl(path.join(projA, 'subagents', 'agent-zzz.jsonl'), [
  { type: 'assistant', sessionId: 'subagent-xyz', isSidechain: true, cwd: '/Users/test/alpha', timestamp: iso(10000), message: { content: [{ type: 'text', text: 'subagent work' }] } },
]);

// Session B: recent session in /beta.
const sessB = '22222222-aaaa-bbbb-cccc-000000000002';
jsonl(path.join(projB, sessB + '.jsonl'), [
  { type: 'ai-title', sessionId: sessB, aiTitle: 'Research pricing' },
  { type: 'last-prompt', sessionId: sessB, lastPrompt: 'compare competitor pricing' },
  { type: 'assistant', sessionId: sessB, cwd: '/Users/test/beta', gitBranch: 'main', timestamp: iso(5000), message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'pricing' } }] } },
]);

// Session C: an OLD session (10 days ago) — should be filtered out by mtime.
const sessC = '33333333-aaaa-bbbb-cccc-000000000003';
const oldFile = path.join(projB, sessC + '.jsonl');
jsonl(oldFile, [
  { type: 'assistant', sessionId: sessC, cwd: '/Users/test/beta', timestamp: iso(10 * 86400000), message: { content: [{ type: 'text', text: 'old' }] } },
]);
const old = (now - 10 * 86400000) / 1000;
fs.utimesSync(oldFile, old, old); // backdate mtime so it fails the live filter

// A malformed file — scanner must not crash.
fs.writeFileSync(path.join(projB, '44444444-dead.jsonl'), 'not json\n{also broken\n');

// --- run the scanner against the fake HOME --------------------------------
function run(args) {
  const out = execFileSync('node', [path.join(__dirname, 'scan.js'), ...args], {
    env: { ...process.env, HOME: root },
    encoding: 'utf8',
  });
  return out;
}

console.log('conductor tests:');

const json = JSON.parse(run(['--json', '--minutes', '60']));
const ids = json.sessions.map((s) => s.sessionId);

ok('finds the two live sessions', json.count === 2);
ok('includes session A', ids.includes(sessA));
ok('includes session B', ids.includes(sessB));
ok('excludes the old (backdated-mtime) session C', !ids.includes(sessC));
ok('excludes subagent sidechain thread', !ids.some((id) => id === 'subagent-xyz'));

const a = json.sessions.find((s) => s.sessionId === sessA);
ok('A: project name from cwd basename', a.project === 'alpha');
ok('A: friendly label prettified from dir', a.label === 'Alpha');
ok('A: git branch parsed', a.gitBranch === 'feat');
ok('A: aiTitle captured as task', a.task === 'Build the login form');
ok('A: lastPrompt captured as intent', a.intent === 'add a login form');
ok('A: last action is the Edit tool (not the tool_result after it)', /Edit/.test(a.lastAction));
ok('A: status is active/recent (activity <60m ago)', a.status === 'active' || a.status === 'recent');
ok('A: has open flag (boolean)', typeof a.open === 'boolean');

const b = json.sessions.find((s) => s.sessionId === sessB);
ok('B: task captured', b.task === 'Research pricing');
ok('B: last action is WebSearch', /WebSearch/.test(b.lastAction));

ok('newest activity sorted first (B more recent than A)', json.sessions[0].sessionId === sessB);

const table = run(['--minutes', '60']);
ok('pretty table renders session ids', table.includes(sessA.slice(0, 8)) && table.includes(sessB.slice(0, 8)));
ok('pretty table does not crash on malformed file', table.includes('Conductor'));

const empty = run(['--minutes', '60', '--limit', '0', '--json']);
ok('limit 0 means no cap', JSON.parse(empty).count === 2);

// cleanup
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} assertions passed.`);
