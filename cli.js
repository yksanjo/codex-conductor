#!/usr/bin/env node
'use strict';

// conductor — one entry point. Read view: table / cockpit / mcp. Control: run / say /
// attach / managed / stop (tmux-managed windows). Zero dependencies.

const path = require('path');
const { spawn } = require('child_process');
const engine = require('./engine');
const { DEFAULT_ADAPTER, CLI_NAME } = require('./config');

const args = process.argv.slice(2);
const cmd = (args[0] || '').toLowerCase();
const rest = args.slice(1);
const HERE = __dirname;

const HELP = `Codex Conductor — situational awareness + control across your Codex sessions

read
  ${CLI_NAME}                list your live Codex sessions (table)
  ${CLI_NAME} ls [opts]        opts: --adapter NAME  --minutes N  --all  --json  --limit N
  ${CLI_NAME} up [opts]        launch the web cockpit  (--adapter NAME, --port N, --no-open)
  ${CLI_NAME} mcp              run the MCP server (stdio)

copilot seats (scoped remote co-working — deny-by-default)
  ${CLI_NAME} seat             run the Copilot Seat server (:7593, loopback) — the ONLY surface a
                             remote teammate can reach; expose it via a tunnel you control.
                             mint seats + grant windows from the cockpit (🪑) or MCP (seat_create).
  ${CLI_NAME} seat-mcp         run the copilot's side (stdio) — connect to a host's seat with the
                             credential they shared, then see ONLY the windows they granted.

adapters (--adapter NAME, default codex-code)
  codex-code               your local Codex CLI/app sessions from ~/.codex/sessions
  claude-code              your live Claude Code windows (tmux control plane)
  fleet                    a trading-bot fleet at ~/.fleet/bots/*/events.jsonl
  mev-searcher             a MEV searcher fleet (read-only liveness/pnl trails)
  validator-fleet          Solana validators by vote liveness (read-only)
  sales                    a sales-agent fleet at ~/.fleet/sales/*/events.jsonl (governed; pause/kill)

control (tmux-managed windows)
  ${CLI_NAME} run <label> [-- codex args]  launch a managed Codex window in tmux
  ${CLI_NAME} adopt <session> [label]      re-open an existing session in tmux,
                                           so you can control it; then close the old tab
  ${CLI_NAME} say <label> <text...>        send a reply into that window
  ${CLI_NAME} attach <label>               attach your terminal to it (type long commands)
  ${CLI_NAME} managed                      list managed windows
  ${CLI_NAME} stop <label>                 close a managed window

examples
  ${CLI_NAME} run soag                     # start a managed Codex window labelled "soag"
  ${CLI_NAME} say soag continue            # answer its prompt
  ${CLI_NAME} say soag "review and test it before deploying"
  ${CLI_NAME} up                           # cockpit with reply buttons on managed cards

labels    edit ~/.codex-conductor/labels.json to name your projects (live-reloads)
read view is read-only; control only touches windows you launched via "${CLI_NAME} run"`;

function run(script, a) {
  const child = spawn(process.execPath, [path.join(HERE, script), ...a], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  child.on('error', (e) => { console.error(`${CLI_NAME}: ` + e.message); process.exit(1); });
}

async function manageCmd() {
  const m = require('./manage');
  if (cmd === 'adopt') {
    const ref = rest[0];
    if (!ref) { console.error(`usage: ${CLI_NAME} adopt <session|shortId|label> [newlabel]`); process.exit(1); }
    const rows = await engine.collect(engine.loadAdapter(DEFAULT_ADAPTER), { minutes: 4320 });   // last ~3 days
    const k = ref.toLowerCase();
    const s = rows.find((r) => r.sessionId.toLowerCase() === k || r.shortId.toLowerCase() === k || (r.label || '').toLowerCase() === k);
    if (!s) { console.error(`${CLI_NAME}: no live session matched "${ref}". See: ${CLI_NAME} ls --all`); process.exit(1); }
    const label = rest[1] || m.sanitize(s.label) || s.shortId;
    const res = m.adopt(label, s.sessionId, s.cwd);
    if (!res.ok) { console.error(`${CLI_NAME}: ` + res.error); process.exit(1); }
    console.log(`adopting ${s.shortId} (${s.label}) -> managed window "${res.label}".`);
    console.log(`   close the original tab if you do not want two live clients on this session.`);
    console.log(`   reply:  ${CLI_NAME} say ${res.label} "continue"`);
    console.log(`   attach: ${res.attach}`);
    return;
  }
  if (cmd === 'run') {
    const label = rest[0];
    if (!label) { console.error(`usage: ${CLI_NAME} run <label> [-- codex args]`); process.exit(1); }
    const sep = rest.indexOf('--');
    const agentArgs = sep >= 0 ? rest.slice(sep + 1) : [];
    const res = m.run(label, agentArgs, process.cwd());
    if (!res.ok) { console.error(`${CLI_NAME}: ` + res.error); process.exit(1); }
    console.log(`managed Codex window "${res.label}" started in tmux${res.sessionId ? '' : ' (sessionId not captured yet)'}.`);
    console.log(`   reply:  ${CLI_NAME} say ${res.label} "continue"`);
    console.log(`   attach: ${res.attach}`);
    return;
  }
  if (cmd === 'say') {
    const label = rest[0];
    const text = rest.slice(1).join(' ');
    if (!label || !text) { console.error(`usage: ${CLI_NAME} say <label> <text...>`); process.exit(1); }
    const res = m.say(label, text);
    if (!res.ok) { console.error(`${CLI_NAME}: ` + res.error); process.exit(1); }
    console.log(`→ sent to ${res.label}: ${res.sent}`);
    return;
  }
  if (cmd === 'attach') {
    const label = m.sanitize(rest[0] || '');
    if (!rest[0]) { console.error(`usage: ${CLI_NAME} attach <label>`); process.exit(1); }
    const child = spawn('tmux', ['attach', '-t', m.SESSION, ';', 'select-window', '-t', label], { stdio: 'inherit' });
    child.on('exit', (c) => process.exit(c == null ? 0 : c));
    child.on('error', (e) => { console.error(`${CLI_NAME}: ` + e.message); process.exit(1); });
    return;
  }
  if (cmd === 'managed') {
    const list = m.listManaged();
    if (!list.length) { console.log(`no managed windows. start one: ${CLI_NAME} run <label>`); return; }
    console.log('managed windows:');
    for (const w of list) console.log(`  ● ${w.label}  (${w.target})  cwd:${w.cwd}${w.sessionId ? '' : '  [no sessionId]'}`);
    return;
  }
  if (cmd === 'stop') {
    if (!rest[0]) { console.error(`usage: ${CLI_NAME} stop <label>`); process.exit(1); }
    const res = m.stop(rest[0]);
    console.log(res.ok ? `stopped ${res.label}` : `${CLI_NAME}: could not stop ${res.label} - ${res.error}`);
    return;
  }
}

if (['help', '-h', '--help'].includes(cmd)) {
  console.log(HELP);
} else if (['run', 'adopt', 'say', 'attach', 'managed', 'stop'].includes(cmd)) {
  manageCmd().catch((e) => { console.error(`${CLI_NAME}: ` + e.message); process.exit(1); });
} else if (cmd === '' || cmd.startsWith('-')) {
  run('scan.js', args);
} else if (['ls', 'list', 'table'].includes(cmd)) {
  run('scan.js', rest);
} else if (['up', 'cockpit', 'serve', 'web'].includes(cmd)) {
  run('server.js', rest);
} else if (cmd === 'mcp') {
  run('mcp.js', rest);
} else if (['seat', 'seat-server'].includes(cmd)) {
  run('seat-server.js', rest);
} else if (cmd === 'seat-mcp') {
  run('seat-mcp.js', rest);
} else {
  console.error(`${CLI_NAME}: unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exit(1);
}
