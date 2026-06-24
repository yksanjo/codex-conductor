#!/usr/bin/env node
'use strict';

// seat-mcp.js — the copilot's side of a Copilot Seat.
//
// A remote teammate (or their agent) runs THIS MCP to co-work on the windows a host shared with
// them. It speaks MCP over stdio (like mcp.js) but talks to a remote host's seat server over
// HTTP, carrying the bearer credential the host handed out. The copilot only ever sees the
// sessions the host granted — this client can't even ask for anything else, and the host's
// server would 404 it if it tried.
//
//   seat_connect{url, credential}  — store the host's seat URL + credential (verifies the link)
//   seat_whoami                    — which seat am I, and how many sessions can I see?
//   seat_list_sessions             — the granted windows (only those)
//   seat_read{session}             — read one granted window's transcript
//   seat_reply{session, text}      — reply to a collaborate-granted window (host's gate still applies)
//
// Zero dependencies (node http/https only). Connection config: ~/.conductor/seat-client.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'conductor-seat', version: '0.1.0' };
const CFG_FILE = path.join(os.homedir(), '.conductor', 'seat-client.json');

function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return null; } }
function saveCfg(c) {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

// Minimal JSON HTTP client over node's http/https — no dependencies. Resolves
// { status, body } and never rejects on an HTTP error code (only on transport failure).
function request(method, fullUrl, cred, body) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('bad url: ' + fullUrl)); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (cred) headers.authorization = 'Bearer ' + cred;
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = lib.request(u, { method, headers, timeout: 15000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(d || '{}'); } catch { j = { ok: false, error: 'non-JSON response', raw: d.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'seat_connect',
    description: 'Connect to a host\'s Copilot Seat. Provide the seat-server URL the host gave you and the one-time credential ("<id>.<token>"). Verifies the link and remembers it for the other seat_* tools. You will only ever see the windows the host explicitly shared with your seat.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The host\'s seat-server URL, e.g. https://abc.trycloudflare.com or http://127.0.0.1:7593.' },
        credential: { type: 'string', description: 'The seat credential the host shared ("<id>.<token>").' },
      },
      required: ['url', 'credential'],
    },
  },
  {
    name: 'seat_whoami',
    description: 'Show which seat you are connected as and how many sessions the host has shared with you. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'seat_list_sessions',
    description: 'List the windows the host shared with your seat — and ONLY those. Each shows its label, status, task, branch, and whether you can reply (canReply = collaborate grant) or only read (view grant). Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'seat_read',
    description: 'Read one shared window\'s goal, current action, and recent transcript. Identify it by sessionId, shortId, or label (from seat_list_sessions). If it is not shared with you, you get a clean "not shared" message — you cannot read anything the host did not grant.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'sessionId, shortId, or label of a shared window.' } },
      required: ['session'],
    },
  },
  {
    name: 'seat_reply',
    description: 'Reply to a window the host shared for COLLABORATION, advancing it. WRITE action. The host\'s irreversibility gate still applies remotely: a reply that would deploy / send / delete / spend is NOT sent — it bounces back for the host human to approve. View-only or ungranted windows return "not shared for collaboration".',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'sessionId, shortId, or label of a collaborate-granted window.' },
        text: { type: 'string', description: 'The reply to send (e.g. "continue", "yes", or a full instruction).' },
      },
      required: ['session', 'text'],
    },
  },
];

function textResult(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return { content: [{ type: 'text', text }] };
}

async function callTool(name, args) {
  args = args || {};
  if (name === 'seat_connect') {
    if (!args.url || !args.credential) throw new Error('url and credential are required');
    const url = String(args.url).replace(/\/+$/, '');
    const { status, body } = await request('GET', url + '/seat/whoami', args.credential);
    if (status !== 200 || !body.ok) {
      return textResult({ ok: false, error: `could not connect (HTTP ${status}) — check the URL and credential. ${(body && body.error) || ''}`.trim() });
    }
    saveCfg({ url, credential: args.credential });
    return textResult({ ok: true, connected: true, seat: body.seat, sessions: body.sessions, note: body.note });
  }

  const cfg = loadCfg();
  if (!cfg) return textResult({ ok: false, error: 'not connected — run seat_connect{url, credential} first.' });

  if (name === 'seat_whoami') {
    const { status, body } = await request('GET', cfg.url + '/seat/whoami', cfg.credential);
    return textResult(status === 200 ? body : { ok: false, error: `HTTP ${status}`, ...body });
  }
  if (name === 'seat_list_sessions') {
    const { status, body } = await request('GET', cfg.url + '/seat/sessions', cfg.credential);
    return textResult(status === 200 ? body : { ok: false, error: `HTTP ${status}`, ...body });
  }
  if (name === 'seat_read') {
    if (!args.session) throw new Error('session is required');
    const { status, body } = await request('GET', cfg.url + '/seat/session/' + encodeURIComponent(args.session), cfg.credential);
    if (status === 404) return textResult({ ok: false, error: `"${args.session}" is not shared with you (or does not exist). Only windows the host granted to your seat are visible — run seat_list_sessions.` });
    return textResult(status === 200 ? body : { ok: false, error: `HTTP ${status}`, ...body });
  }
  if (name === 'seat_reply') {
    if (!args.session || !args.text) throw new Error('session and text are required');
    const { status, body } = await request('POST', cfg.url + '/seat/say', cfg.credential, { session: args.session, text: args.text });
    if (status === 404) return textResult({ ok: false, error: `"${args.session}" is not shared with you for collaboration (it may be view-only or not granted). Run seat_list_sessions — you can only reply where canReply is true.` });
    return textResult(body);
  }
  throw new Error(`unknown tool: ${name}`);
}

// --- JSON-RPC / MCP plumbing over stdio (identical shape to mcp.js) ---------
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      if (!isNotification) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const tname = params && params.name;
      try { reply(id, await callTool(tname, params && params.arguments)); }
      catch (e) { reply(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
      return;
    }
    default:
      if (!isNotification) fail(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg).catch((e) => process.stderr.write('conductor-seat-mcp error: ' + e.message + '\n'));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write('conductor-seat-mcp ready (stdio)\n');
}

if (require.main === module) main();
module.exports = { callTool, TOOLS };
