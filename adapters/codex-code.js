'use strict';

// Codex adapter.
//
// Codex writes session transcripts under ~/.codex/sessions/YYYY/MM/DD/*.jsonl and keeps a
// thread-name index at ~/.codex/session_index.jsonl. This adapter is read-first: it maps Codex's
// rollout event stream onto Codex Conductor's normalized row model.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');
const { clip, prettify } = require('../util');
const manage = require('../manage');

const HOME = os.homedir();
const CODEX_DIR = process.env.CODEX_HOME || path.join(HOME, '.codex');
const SESSIONS_DIR = process.env.CODEX_SESSIONS_DIR || path.join(CODEX_DIR, 'sessions');
const INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');
const LABELS_FILE = path.join(HOME, '.codex-conductor', 'labels.json');
const RING = 40;
const FULL_TEXT_CAP = 4000;

let _index = null;
let _indexMtime = 0;
function loadIndex() {
  try {
    const st = fs.statSync(INDEX_FILE);
    if (_index && st.mtimeMs === _indexMtime) return _index;
    const map = new Map();
    for (const line of fs.readFileSync(INDEX_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.id) map.set(String(r.id), { title: r.thread_name || null, updatedAt: r.updated_at || null });
      } catch { /* ignore malformed index rows */ }
    }
    _index = map;
    _indexMtime = st.mtimeMs;
  } catch {
    _index = new Map();
  }
  return _index;
}

let _labelCache = null;
let _labelMtime = 0;
function loadLabels() {
  try {
    const st = fs.statSync(LABELS_FILE);
    if (_labelCache && st.mtimeMs === _labelMtime) return _labelCache;
    _labelCache = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
    _labelMtime = st.mtimeMs;
  } catch {
    _labelCache = {};
  }
  return _labelCache;
}

function labelFor(cwd) {
  if (!cwd) return '(unknown)';
  const base = path.basename(cwd);
  return loadLabels()[base] || prettify(base);
}

function findTranscripts(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findTranscripts(full, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((x) => {
      if (!x || typeof x !== 'object') return '';
      if (typeof x.text === 'string') return x.text;
      if (typeof x.input_text === 'string') return x.input_text;
      if (typeof x.output_text === 'string') return x.output_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type === 'message') {
    const text = textFromContent(payload.content);
    return text ? { actor: payload.role || 'assistant', kind: 'text', summary: clip(text, 100), text: clip(text, FULL_TEXT_CAP) } : null;
  }
  if (payload.type === 'function_call') {
    let hint = payload.name || 'tool';
    if (payload.arguments) hint += ': ' + clip(String(payload.arguments), 60);
    return { actor: 'assistant', kind: 'tool_use', summary: hint };
  }
  if (payload.type === 'function_call_output') {
    return { actor: 'tool', kind: 'tool_result', summary: clip(String(payload.output || 'tool result'), 100) };
  }
  if (payload.type === 'reasoning') return { actor: 'assistant', kind: 'thinking', summary: '(thinking)' };
  return null;
}

function pushRecent(s, item) {
  s.recent.push(item);
  if (s.recent.length > RING) s.recent.shift();
}

function readSession(file) {
  return new Promise((resolve) => {
    const s = { file, sessionId: null, cwd: null, title: null, lastUserText: null, lastActivityTs: 0, recent: [] };
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch { return resolve(s); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      let r;
      try { r = JSON.parse(line); } catch { return; }
      const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
      if (!isNaN(ts) && ts > s.lastActivityTs) s.lastActivityTs = ts;
      if (r.type === 'session_meta' && r.payload) {
        s.sessionId = r.payload.session_id || r.payload.id || s.sessionId;
        s.cwd = r.payload.cwd || s.cwd;
        return;
      }
      if (r.type === 'event_msg' && r.payload && r.payload.type === 'user_message') {
        const msg = String(r.payload.message || '');
        if (msg) {
          s.lastUserText = msg;
          pushRecent(s, { actor: 'user', kind: 'text', summary: clip(msg, 100), text: clip(msg, FULL_TEXT_CAP), ts });
        }
        return;
      }
      if (r.type === 'event_msg' && r.payload && r.payload.type === 'agent_message') {
        const msg = String(r.payload.message || '');
        if (msg) pushRecent(s, { actor: 'assistant', kind: 'text', summary: clip(msg, 100), text: clip(msg, FULL_TEXT_CAP), ts });
        return;
      }
      if (r.type !== 'response_item') return;
      const item = summarizePayload(r.payload);
      if (!item) return;
      if (item.actor === 'user' && item.text) s.lastUserText = item.text;
      pushRecent(s, { actor: item.actor, kind: item.kind, summary: item.summary, ts });
    });
    rl.on('error', () => resolve(s));
    rl.on('close', () => resolve(s));
  });
}

function lastActionOf(s) {
  for (let i = s.recent.length - 1; i >= 0; i--) {
    const r = s.recent[i];
    if (r.kind === 'tool_use') return 'tool: ' + r.summary;
    if (r.kind === 'text' && r.actor === 'assistant') return r.summary;
  }
  return s.recent.length ? s.recent[s.recent.length - 1].summary : '-';
}

let _openCache = null;
let _openCacheAt = 0;
function openCwds() {
  if (_openCache && (Date.now() - _openCacheAt) < 3000) return _openCache;
  const set = new Set();
  let out = '';
  try {
    out = execSync('lsof -a -c codex -d cwd -nP -Fpn', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
  } catch {
    _openCache = set; _openCacheAt = Date.now(); return set;
  }
  for (const line of out.split('\n')) if (line[0] === 'n') set.add(line.slice(1));
  _openCache = set; _openCacheAt = Date.now();
  return set;
}

function statusOf(lastActivityTs, isOpen) {
  const min = (Date.now() - lastActivityTs) / 60000;
  if (isOpen) return min < 5 ? 'active' : 'open';
  if (min < 5) return 'active';
  if (min < 60) return 'recent';
  return 'idle';
}

function discover(opts = {}) {
  const minutes = opts.minutes || 10;
  const all = !!opts.all;
  const cutoff = Date.now() - minutes * 60 * 1000;
  const files = findTranscripts(SESSIONS_DIR, []);
  return files.filter((f) => {
    try {
      const st = fs.statSync(f);
      return all || st.mtimeMs >= cutoff;
    } catch { return false; }
  });
}

function liveness() {
  // Codex stores sessions by date, not cwd, so liveness is applied after parse via cwd.
  return new Set();
}

async function parse(file) {
  const s = await readSession(file);
  if (!s.sessionId) {
    const m = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    if (m) s.sessionId = m[1];
  }
  if (!s.sessionId) return null;
  const idx = loadIndex().get(s.sessionId) || {};
  const title = idx.title || s.title || null;
  const live = s.cwd ? openCwds().has(s.cwd) : false;
  const place = s.cwd && path.basename(s.cwd) !== path.basename(HOME) ? labelFor(s.cwd) : '';
  return {
    id: s.sessionId,
    shortId: s.sessionId.slice(0, 8),
    label: labelFor(s.cwd),
    title,
    intent: title || s.lastUserText || null,
    context: [place, 'codex'].filter(Boolean),
    recent: s.recent.slice(-12),
    lastAction: lastActionOf(s),
    lastActivityTs: s.lastActivityTs,
    statusInputs: { lastActivityTs: s.lastActivityTs, live },
    sessionId: s.sessionId,
    cwd: s.cwd,
    gitBranch: null,
    project: s.cwd ? path.basename(s.cwd) : '(unknown)',
    place,
    task: title,
    file,
  };
}

function status(rec) { return statusOf(rec.statusInputs.lastActivityTs, !!rec.statusInputs.live); }

function waitingForYou(row) {
  if (!row.live || !row.recent.length) return false;
  const last = row.recent[row.recent.length - 1];
  const quietSec = (Date.now() - row.lastActiveTs) / 1000;
  return last.actor === 'assistant' && last.kind === 'text' && quietSec >= 15;
}

function project(base) {
  const live = !!(base.statusInputs && base.statusInputs.live);
  return { ...base, live, open: live, waiting: waitingForYou({ ...base, live }) };
}

const statuses = [
  { key: 'active', title: 'WORKING NOW', word: 'working', color: 'green' },
  { key: 'open', title: 'OPEN', word: 'open', color: 'cyan' },
  { key: 'recent', title: 'RECENTLY ACTIVE', word: 'recent', color: 'amber' },
  { key: 'idle', title: 'IDLE', word: 'idle', color: 'dim' },
];

const control = {
  capabilities: ['reply', 'key', 'run', 'broadcast'],
  send(target, command = {}) {
    return command.key ? manage.key(target, command.key) : manage.say(target, command.text || '');
  },
  broadcast(command = {}) {
    return manage.sayAll(command.key ? { key: command.key } : { text: command.text || '' });
  },
};

module.exports = {
  discover, liveness, parse, status, project, statuses, control,
  labelFor, statuses_: statuses, PROJECTS_DIR: SESSIONS_DIR, LABELS_FILE,
};
