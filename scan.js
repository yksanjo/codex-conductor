#!/usr/bin/env node
'use strict';

// Conductor CLI — boxed, sectioned table (or JSON) of a worker fleet. Adapter-driven: the
// sections come from the adapter's status vocabulary, not a hardcoded list. Read-only.
//
//   codex-conductor                    boxed table (Codex), active in last 10 min
//   codex-conductor --adapter fleet    read the trading-bot fleet instead
//   codex-conductor --minutes 60       widen the window
//   codex-conductor --all              every unit, ignore the time filter
//   codex-conductor --json             structured JSON
//   codex-conductor --limit N          cap rows

const engine = require('./engine');
const { DEFAULT_ADAPTER, PRODUCT_NAME, CLI_NAME } = require('./config');

function parseArgs(argv) {
  const a = { json: false, minutes: 10, all: false, limit: 0, adapter: DEFAULT_ADAPTER };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--json') a.json = true;
    else if (v === '--all') a.all = true;
    else if (v === '--minutes') a.minutes = parseInt(argv[++i], 10) || 10;
    else if (v === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
    else if (v === '--adapter') a.adapter = String(argv[++i] || DEFAULT_ADAPTER);
    else if (v === '-h' || v === '--help') a.help = true;
  }
  return a;
}

const TTY = process.stdout.isTTY;
const RAW = TTY
  ? { green: '\x1b[32m', cyan: '\x1b[36m', amber: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[90m', b: '\x1b[1m', faint: '\x1b[2m', r: '\x1b[0m' }
  : { green: '', cyan: '', amber: '', red: '', dim: '', b: '', faint: '', r: '' };
function col(name) { return RAW[name] || RAW.dim; }

// strip emoji / wide chars so fixed-width box math stays correct (keep box-drawing + ·, …, ▸)
function plain(s) {
  return String(s == null ? '' : s)
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu, '')
    .replace(/\s+/g, ' ').trim();
}
function fit(s, w) { s = plain(s); return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w); }

function box(W, r, statusMap) {
  const inner = W - 4;                       // content width between "│ " and " │"
  const lines = [];
  // top border carries the short id like a window tab: ┌─ 1a2b3c4d ───┐
  const tab = `─ ${r.shortId} `;
  lines.push(RAW.dim + '┌' + tab + '─'.repeat(Math.max(0, W - 2 - tab.length)) + '┐' + RAW.r);

  // header row: ● <what it's about> .................... <age>
  const st = statusMap[r.status] || { color: 'dim' };
  const right = r.lastActiveRel;
  const leftW = Math.max(4, inner - right.length - 3);   // ● + two spaces = 3 cells
  const heading = fit(r.title || r.label, leftW);        // lead with the plain-language title
  const head = `${col(st.color)}●${RAW.r} ${RAW.b}${heading}${RAW.r} ${RAW.dim}${right}${RAW.r}`;
  lines.push(`${RAW.dim}│${RAW.r} ${head} ${RAW.dim}│${RAW.r}`);

  // context chips (project/branch, or venue/position/PnL) + last action
  const ctx = (r.context && r.context.length) ? r.context.join(' · ') : '—';
  lines.push(`${RAW.dim}│${RAW.r} ${RAW.faint}${fit(ctx, inner)}${RAW.r} ${RAW.dim}│${RAW.r}`);
  lines.push(`${RAW.dim}│${RAW.r} ${fit('› ' + plain(r.lastAction), inner)} ${RAW.dim}│${RAW.r}`);

  lines.push(RAW.dim + '└' + '─'.repeat(W - 2) + '┘' + RAW.r);
  return lines.join('\n');
}

function render(rows, args, adapter) {
  const statuses = adapter.statuses || engine.DEFAULT_STATUSES;
  const statusMap = Object.fromEntries(statuses.map((s) => [s.key, s]));
  if (!rows.length) {
    console.log(`\nNo ${args.adapter} units in the last ${args.minutes} min. Try: ${CLI_NAME} --adapter ${args.adapter} --all\n`);
    return;
  }
  const W = Math.min((process.stdout.columns || 80) - 1, 86);
  const hint = args.adapter === 'fleet'
    ? `cockpit: ${CLI_NAME} up --adapter fleet   ·   panic: broadcast-flatten in the cockpit`
    : args.adapter === 'codex-code'
      ? `cockpit: ${CLI_NAME} up   ·   control: ${CLI_NAME} run <label> / ${CLI_NAME} say <label> continue`
      : `cockpit: ${CLI_NAME} up --adapter ${args.adapter}   ·   control: ${CLI_NAME} run <label> / ${CLI_NAME} say <label> yes`;
  console.log('');
  console.log(`${RAW.b}${PRODUCT_NAME}${RAW.r} ${RAW.dim}(${args.adapter})${RAW.r} — ${rows.length} unit${rows.length > 1 ? 's' : ''} ${RAW.dim}· last ${args.all ? 'all' : args.minutes + ' min'}${RAW.r}`);
  console.log(`${RAW.dim}   ${hint}${RAW.r}`);

  for (const s of statuses) {
    const items = rows.filter((r) => r.status === s.key);
    if (!items.length) continue;
    console.log(`\n${col(s.color)}${RAW.b}${s.title}${RAW.r} ${RAW.dim}${'─'.repeat(Math.max(0, W - s.title.length - 1))}${RAW.r}`);
    for (const r of items) console.log(box(W, r, statusMap));
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`${CLI_NAME} — situational awareness across your Codex sessions\n`);
    console.log(`Usage: ${CLI_NAME} [--adapter codex-code|claude-code|fleet|mev-searcher|validator-fleet|sales] [--json] [--minutes N] [--all] [--limit N]`);
    console.log(`       ${CLI_NAME} up        # open the web cockpit`);
    console.log(`       ${CLI_NAME} help      # full command list`);
    return;
  }
  let adapter;
  try { adapter = engine.loadAdapter(args.adapter); }
  catch (e) { console.error(`${CLI_NAME}: ` + e.message); process.exit(1); }

  const rows = await engine.collect(adapter, args);
  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), adapter: args.adapter, windowMinutes: args.minutes, count: rows.length, sessions: rows }, null, 2));
    return;
  }
  render(rows, args, adapter);
}

main().catch((e) => { console.error(`${CLI_NAME} error:`, e.message); process.exit(1); });
