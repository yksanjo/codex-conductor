'use strict';

// Conductor adapter: Claude Code.
//
// The original Conductor use case, ported onto the adapter contract. A "unit" is a live Claude
// Code window; its trail is the `.jsonl` transcript every session writes under
// ~/.claude/projects/<dir>/<session-id>.jsonl. Read-only observation; control rides the tmux
// channel in manage.js (the same one the cockpit uses).
//
// Engine output for this adapter is equivalent to Conductor's pre-engine behavior — the
// existing test suite (test.js / mcp.test.js / server.test.js) proves it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');
const { clip, prettify } = require('../util');
const manage = require('../manage');

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const LABELS_FILE = path.join(HOME, '.conductor', 'labels.json');
const RING = 40; // keep last N message-bearing records per session

// ---------------------------------------------------------------------------
// Friendly project labels — the "key" shown big on each card. Auto-derived from the working
// directory, overridable via ~/.conductor/labels.json (a flat { "<cwd-basename>": "Name" } map).
// ---------------------------------------------------------------------------
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
  const map = loadLabels();
  return map[base] || prettify(base);
}

// ---------------------------------------------------------------------------
// Transcript discovery + parsing
// ---------------------------------------------------------------------------
function findTranscripts(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'subagents') continue; // exclude subagent sub-threads
      findTranscripts(full, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function summarizeUser(r) {
  const c = r.message && r.message.content;
  if (typeof c === 'string') return { kind: 'prompt', userText: c, summary: clip(c, 100) };
  if (Array.isArray(c)) {
    const types = c.map((x) => x && x.type);
    if (types.includes('tool_result')) return { kind: 'tool_result', summary: 'tool result' };
    const textItem = c.find((x) => x && x.type === 'text');
    if (textItem) return { kind: 'prompt', userText: textItem.text, summary: clip(textItem.text, 100) };
  }
  return null;
}

// Assistant text keeps TWO clips: `summary` (100 chars, for display) and `text` (4000 chars).
// The irreversibility gate classifies the window's pending question = its last assistant text;
// gating on the 100-char display clip let a long message ending "…Deploy to prod now?" slip
// past unclassified. 4000 chars covers real messages without unbounding the per-session ring.
const FULL_TEXT_CAP = 4000;
function summarizeAssistant(r) {
  const c = r.message && r.message.content;
  if (typeof c === 'string') return { kind: 'text', summary: clip(c, 100), text: clip(c, FULL_TEXT_CAP) };
  if (Array.isArray(c)) {
    const tool = c.find((x) => x && x.type === 'tool_use');
    if (tool) {
      let hint = '';
      const inp = tool.input || {};
      if (inp.command) hint = clip(inp.command, 50);
      else if (inp.file_path) hint = clip(inp.file_path, 50);
      else if (inp.pattern) hint = clip(inp.pattern, 50);
      else if (inp.description) hint = clip(inp.description, 50);
      return { kind: 'tool_use', summary: hint ? `${tool.name}: ${hint}` : tool.name };
    }
    const txt = c.find((x) => x && x.type === 'text');
    if (txt) return { kind: 'text', summary: clip(txt.text, 100), text: clip(txt.text, FULL_TEXT_CAP) };
    if (c.some((x) => x && x.type === 'thinking')) return { kind: 'thinking', summary: '(thinking)' };
  }
  return null;
}

function pushRecent(s, item) {
  s.recent.push(item);
  if (s.recent.length > RING) s.recent.shift();
}

// Stream one transcript into an internal session object (never loads the whole file).
function readSession(file) {
  return new Promise((resolve) => {
    const s = {
      file, sessionId: null, cwd: null, gitBranch: null, slug: null,
      aiTitle: null, lastPrompt: null, lastUserText: null,
      lastActivityTs: 0, isSidechain: false, recent: [],
    };
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch { return resolve(s); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      let r;
      try { r = JSON.parse(line); } catch { return; }
      if (!r || typeof r !== 'object') return;
      if (r.sessionId) s.sessionId = r.sessionId;
      if (r.cwd && !s.cwd) s.cwd = r.cwd;   // FIRST cwd = launch dir = the session's project
      if (r.gitBranch) s.gitBranch = r.gitBranch;
      if (r.slug) s.slug = r.slug;
      if (r.isSidechain === true) s.isSidechain = true;
      const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
      if (!isNaN(ts) && ts > s.lastActivityTs) s.lastActivityTs = ts;
      switch (r.type) {
        case 'ai-title': if (r.aiTitle) s.aiTitle = r.aiTitle; return;
        case 'last-prompt': if (r.lastPrompt != null) s.lastPrompt = String(r.lastPrompt); return;
        case 'user': {
          const item = summarizeUser(r);
          if (item) {
            if (item.userText) s.lastUserText = item.userText;
            pushRecent(s, { role: 'user', ts, kind: item.kind, summary: item.summary });
          }
          return;
        }
        case 'assistant': {
          const item = summarizeAssistant(r);
          if (item) pushRecent(s, { role: 'assistant', ts, kind: item.kind, summary: item.summary, text: item.text });
          return;
        }
        default: return;
      }
    });
    rl.on('error', () => resolve(s));
    rl.on('close', () => resolve(s));
  });
}

function lastActionOf(s) {
  for (let i = s.recent.length - 1; i >= 0; i--) {
    const r = s.recent[i];
    if (r.kind === 'tool_use') return '🔧 ' + r.summary;
    if (r.kind === 'text' && r.role === 'assistant') return '💬 ' + r.summary;
  }
  return s.recent.length ? s.recent[s.recent.length - 1].summary : '—';
}

// status: how alive is this window.
//   active = open process AND wrote in last 5 min (working right now)
//   open   = a live `claude` process exists for it, but it's been quiet
//   recent = no detected process, but wrote within the hour
//   idle   = quiet and no process (likely closed; only shown via a wide time window)
function statusOf(lastActivityTs, isOpen) {
  const min = (Date.now() - lastActivityTs) / 60000;
  if (isOpen) return min < 5 ? 'active' : 'open';
  if (min < 5) return 'active';
  if (min < 60) return 'recent';
  return 'idle';
}

// "Needs you": a LIVE window where Claude has spoken last and then gone quiet — sitting at the
// prompt waiting for your reply. Keyed off a live process so closed/idle transcripts don't nag,
// and requires a few seconds of quiet so a still-streaming response isn't flagged.
function waitingForYou(row) {
  if (!row.live || !row.recent.length) return false;
  const last = row.recent[row.recent.length - 1];
  const quietSec = (Date.now() - row.lastActiveTs) / 1000;
  return last.actor === 'assistant' && last.kind === 'text' && quietSec >= 15;
}

// Detect actually-open windows by their running `claude` process. The transcript file isn't held
// open, so process presence (not file mtime) is the real "this window is open" signal. Many
// windows can share one cwd, so for a cwd with K live procs we treat the K most-recently-used
// transcripts in that folder as those windows (best-effort heuristic). Cached briefly so a single
// collect()'s discover()+liveness() share one lsof, while the cockpit's 4s poll still refreshes.
let _openCache = null;
let _openCacheAt = 0;
function listOpenWindows() {
  if (_openCache && (Date.now() - _openCacheAt) < 3000) return _openCache;
  const result = { files: new Set(), count: 0 };
  let out;
  try {
    out = execSync('lsof -a -c claude -d cwd -nP -Fpn', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
  } catch { _openCache = result; _openCacheAt = Date.now(); return result; }

  const cwdCounts = new Map();
  for (const line of out.split('\n')) {
    if (line[0] === 'n') {
      const cwd = line.slice(1);
      cwdCounts.set(cwd, (cwdCounts.get(cwd) || 0) + 1);
    }
  }
  for (const [cwd, k] of cwdCounts) {
    // Same transform as manage.js folderFor(): Claude replaces every non-alphanumeric, not just '/'.
    const dir = path.join(PROJECTS_DIR, cwd.replace(/[^A-Za-z0-9]/g, '-'));
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); }
    catch { continue; }
    const newest = names
      .map((f) => { const p = path.join(dir, f); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { } return { p, m }; })
      .sort((a, b) => b.m - a.m)
      .slice(0, k);
    for (const { p } of newest) result.files.add(p);
    result.count += newest.length;
  }
  _openCache = result; _openCacheAt = Date.now();
  return result;
}

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

// Candidate handles = open windows (always) ∪ recently-touched transcripts (time filter). The
// folders hold thousands of historical sessions, so we never parse them all — only live ones.
function discover(opts = {}) {
  const minutes = opts.minutes || 10;
  const all = !!opts.all;
  const files = findTranscripts(PROJECTS_DIR, []);
  const cutoff = Date.now() - minutes * 60 * 1000;
  const open = opts.detectOpen === false ? { files: new Set() } : listOpenWindows();
  const fresh = [];
  for (const f of files) {
    try {
      if (open.files.has(f)) { fresh.push(f); continue; }
      const st = fs.statSync(f);
      if (all || st.mtimeMs >= cutoff) fresh.push(f);
    } catch { /* ignore */ }
  }
  return fresh;
}

function liveness(_handles, opts = {}) {
  if (opts.detectOpen === false) return new Set();
  return listOpenWindows().files;
}

async function parse(file) {
  const s = await readSession(file);
  if (s.isSidechain || !s.sessionId) return null;   // exclude subagent threads / id-less files
  const homeBase = path.basename(HOME);
  const place = s.cwd && path.basename(s.cwd) !== homeBase ? labelFor(s.cwd) : '';
  return {
    id: s.sessionId,
    shortId: s.sessionId.slice(0, 8),
    label: labelFor(s.cwd),
    title: s.aiTitle || null,                       // plain-language "what this window is about"
    intent: s.lastPrompt || s.lastUserText || null, // its goal / mandate
    context: [place, s.gitBranch].filter(Boolean),  // chips for generic surfaces
    recent: s.recent.slice(-12).map((e) => ({ actor: e.role, kind: e.kind, summary: e.summary, text: e.text, ts: e.ts })),
    lastAction: lastActionOf(s),
    lastActivityTs: s.lastActivityTs,
    statusInputs: { lastActivityTs: s.lastActivityTs },
    // --- Claude Code passthrough (used by the legacy row shape + the surfaces) ---
    sessionId: s.sessionId,
    cwd: s.cwd,
    gitBranch: s.gitBranch || null,
    project: s.cwd ? path.basename(s.cwd) : '(unknown)',
    place,
    task: s.aiTitle || s.slug || null,              // back-compat alias
    file: s.file,
  };
}

function status(rec, ctx) { return statusOf(rec.statusInputs.lastActivityTs, !!(ctx && ctx.live)); }

// Project the engine's base row into Conductor's historical public shape, so collectSessions()
// and the surfaces see exactly the fields they always have (open/waiting/project/place/...).
function project(base) {
  return { ...base, open: base.live, waiting: waitingForYou(base) };
}

const statuses = [
  { key: 'active', title: 'WORKING NOW', word: 'working', color: 'green' },
  { key: 'open', title: 'OPEN', word: 'open', color: 'cyan' },
  { key: 'recent', title: 'RECENTLY ACTIVE', word: 'recent', color: 'amber' },
  { key: 'idle', title: 'IDLE', word: 'idle', color: 'dim' },
];

// Uniform control surface. The Claude cockpit/MCP paths still call manage.js directly (adopt,
// run, broadcast) for their richer flows; this object exists so every adapter exposes control
// the same way for generic callers.
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
  // exported for the surfaces / back-compat
  labelFor, PROJECTS_DIR, LABELS_FILE,
};
