#!/usr/bin/env node
'use strict';

// No-mock tests for the control plane. Registry is isolated to a temp HOME so the real
// ~/.conductor/managed.json is never touched, and the tmux session name is overridden
// (CONDUCTOR_TMUX_SESSION) so the tests never touch the user's real "conductor" session —
// an assertion failure can't leak windows into it. tmux parts run a real send-keys →
// capture-pane roundtrip in a throwaway session, and are skipped cleanly if tmux is unavailable.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-manage-'));
process.env.HOME = root; // isolate REG_FILE + PROJECTS_DIR before requiring the module
process.env.CONDUCTOR_TMUX_SESSION = 'ctestsess' + process.pid; // throwaway session, never 'conductor'
const m = require('./manage');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
function tmuxOk() { try { return spawnSync('tmux', ['-V']).status === 0; } catch { return false; } }
// Belt and braces: even on a crash/assertion failure, the throwaway session dies with us.
function killSession() { try { spawnSync('tmux', ['kill-session', '-t', m.SESSION]); } catch { /* ignore */ } }
process.on('exit', killSession);

console.log('conductor control-plane tests:');

// pure helpers (no tmux)
ok('sanitize strips unsafe chars', m.sanitize('SOAG · Grid!') === 'SOAG-Grid');
ok('sanitize collapses + trims', m.sanitize('  a // b  ') === 'a-b');
ok('sanitize falls back for empty', m.sanitize('!!!') === 'window');
ok('SESSION honors CONDUCTOR_TMUX_SESSION', m.SESSION === 'ctestsess' + process.pid);
ok('attachCommand references tmux + session', new RegExp('tmux attach -t ' + m.SESSION).test(m.attachCommand('x')));

// --- pane chrome is matched in the bottom rows only: transcript content mentioning
// "trust this folder" higher up must NOT be read as the trust prompt (V2 BUG-2 port).
const transcriptDiscussingTrust = 'the code checks "trust this folder" in manage.js\n'
  + Array(30).fill('  reading source, taking notes, working...').join('\n')
  + '\n⏺ wrote out/stage-1.md\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)';
ok('trust phrase up in scrollback is excluded by tailLines', !/trust this folder/i.test(m.tailLines(transcriptDiscussingTrust)));
const actualTrustPrompt = 'some output\n'.repeat(30) + 'Do you trust this folder?\n❯ 1. Yes, I trust';
ok('a real trust prompt at the bottom is still caught', /trust this folder/i.test(m.tailLines(actualTrustPrompt)));

// --- a turn in progress ("esc to interrupt") is 'running', NOT 'ready', so paneStage and
// confirmDelivery never disagree (V2 BUG-3 port). classifyPane is the pure core.
const C = m.classifyPane;
ok("empty caret + 'esc to interrupt' = running, not ready", C('❯ \n  ⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt') === 'running');
ok('idle prompt (no interrupt marker) = ready', C('❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)') === 'ready');
ok('trust prompt classified', C('Do you trust this folder?\n❯ 1. Yes, I trust') === 'trust');
ok('resume picker classified', C('Resume from summary\nResume full session as-is') === 'resume');
ok('ready footer vs unknown=busy', C('? for shortcuts') === 'ready' && C('loading a huge transcript…') === 'busy');

// --- a turn-time permission menu classifies as 'menu' — typed text would land as a menu
// SELECTION, not a reply (V2 H1 port). Fixture = a real Claude Code permission menu.
const MENU_PANE = '⏺ Bash(rm -rf node_modules)\n\nDo you want to run this command?\n  rm -rf node_modules\n\n'
  + "❯ 1. Yes\n  2. Yes, and don't ask again for rm commands in this project\n  3. No, and tell Claude what to do differently (esc)";
ok('a captured permission menu classifies as menu', C(MENU_PANE) === 'menu');
ok('generic proceed menu classifies as menu', C('Do you want to proceed?\n❯ 1. Yes\n  2. No') === 'menu');
ok('trust prompt still wins over the menu pattern (both render "❯ 1.")', C('Do you trust this folder?\n❯ 1. Yes, I trust') === 'trust');

// --- N windows sharing one cwd must resolve to N DISTINCT sessionIds, not collapse onto the
// newest transcript (V2 BUG-1 port). Fake registry entries + transcripts, drive resolveSession
// in launch order exactly as listManaged does.
{
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  const projDir = path.join(root, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  const base = Date.now() - 5000;
  [['aaa', 0], ['bbb', 1000], ['ccc', 2000]].forEach(([id, dt]) => {
    const f = path.join(projDir, id + '.jsonl');
    fs.writeFileSync(f, '{}\n');
    fs.utimesSync(f, (base + dt) / 1000, (base + dt) / 1000);
  });
  const wins = ['w1', 'w2', 'w3'].map((label, i) => ({ label, cwd, created: base - 200 + i * 10, sessionId: null }));
  const claimed = new Set();
  const bound = wins.map((w) => { const id = m.resolveSession(w, claimed); if (id) claimed.add(id); return id; });
  ok('three same-cwd windows resolve to three DISTINCT sessionIds (was: all one)', bound.every(Boolean) && new Set(bound).size === 3);
  const naive = wins.map((w) => m.resolveSession(w, new Set()));
  ok('control: with no claim-tracking all three collapse to one — the bug the fix prevents', new Set(naive).size === 1);

  // F1 port: Claude transforms EVERY non-alphanumeric cwd char to '-', not just '/'. A cwd with
  // '.', '_', or a space must still resolve — the '/'-only transform computed a directory that
  // doesn't exist and silently lost the window.
  const oddCwd = path.join(root, 'repo.v1_x y');
  fs.mkdirSync(oddCwd, { recursive: true });
  const oddProj = path.join(root, '.claude', 'projects', oddCwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(oddProj, { recursive: true });
  fs.writeFileSync(path.join(oddProj, 'odd1.jsonl'), '{}\n');
  const oddReg = { label: 'odd', cwd: oddCwd, created: Date.now() - 5000, sessionId: null };
  ok("cwd with '.', '_', and space still resolves its transcript (was: silently lost)", m.resolveSession(oddReg, new Set()) === 'odd1');
}

ok('listManaged empty on fresh registry', m.listManaged().length === 0);
ok('uniqueLabel returns the base label when nothing clashes', m.uniqueLabel('Home / scratch', 'abc123') === 'Home-scratch');

if (!tmuxOk()) {
  console.log('  ⚠ tmux not found — skipping live send/capture tests');
} else {
  try {
    const LBL = 'ctest' + process.pid;
    const tgt = m.SESSION + ':' + LBL;
    // make a real throwaway window (running a shell) in the throwaway session
    const has = spawnSync('tmux', ['has-session', '-t', m.SESSION]).status === 0;
    if (has) spawnSync('tmux', ['new-window', '-t', m.SESSION, '-n', LBL]);
    else spawnSync('tmux', ['new-session', '-d', '-s', m.SESSION, '-n', LBL]);

    // register it (as if conductor run had captured it) in the isolated registry
    fs.mkdirSync(path.dirname(m.REG_FILE), { recursive: true });
    fs.writeFileSync(m.REG_FILE, JSON.stringify({ windows: { [LBL]: { label: LBL, target: tgt, cwd: '/x', created: 1, sessionId: 'sess-' + LBL } } }));

    ok('listManaged sees the live window', m.listManaged().some((w) => w.label === LBL));
    ok('managedBySession maps sessionId -> window', m.managedBySession()['sess-' + LBL] && m.managedBySession()['sess-' + LBL].label === LBL);

    // send a reply; the shell echoes it back -> prove it landed via capture-pane
    const marker = 'conductor_marker_' + process.pid;
    const r = m.say(LBL, 'echo ' + marker);
    ok('say() reports ok', r.ok === true);
    spawnSync('sleep', ['0.5']);
    const pane = spawnSync('tmux', ['capture-pane', '-p', '-t', tgt], { encoding: 'utf8' }).stdout || '';
    ok('reply text actually reached the window (capture-pane)', pane.includes(marker));

    ok('key() sends a named key', m.key(LBL, 'C-c').ok === true);
    ok('say to unknown window fails gracefully', m.say('no-such-window-xyz', 'hi').ok === false);

    // --- run() launch + say into a run-created window (cmd:'cat' avoids spawning real claude;
    //     cat keeps the pane alive and echoes whatever we send) ---
    const RL = 'rtest' + process.pid;
    const rr = m.run(RL, [], os.tmpdir(), { cmd: 'cat', capture: false });
    ok('run() launches a managed window', rr.ok && rr.target === m.SESSION + ':' + RL);
    spawnSync('sleep', ['0.4']);
    ok('run() registered it', m.listManaged().some((w) => w.label === RL));
    const rmark = 'run_marker_' + process.pid;
    m.say(RL, rmark);
    spawnSync('sleep', ['0.4']);
    const rpane = spawnSync('tmux', ['capture-pane', '-p', '-t', m.SESSION + ':' + RL], { encoding: 'utf8' }).stdout || '';
    ok('say into a run-created window lands', rpane.includes(rmark));

    // --- deliver() GATES on readiness: a plain cat/shell pane is not a ready Claude prompt, so
    //     the prompt must NOT be typed in blind (the bug being fixed) — it comes back skipped. ---
    const gmark = 'gate_' + process.pid;
    const gres = m.deliver(RL, gmark);
    ok('deliver() skips a non-ready pane (does not type blind)', gres.ok === false && gres.status === 'skipped');
    spawnSync('sleep', ['0.3']);
    const gpane = spawnSync('tmux', ['capture-pane', '-p', '-t', m.SESSION + ':' + RL], { encoding: 'utf8' }).stdout || '';
    ok('deliver() left the non-ready pane untouched (marker absent)', !gpane.includes(gmark));

    // --- deliver() into a pane that LOOKS ready (inject a Claude footer so paneStage→ready) lands ---
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + RL, '-l', '--', '? for shortcuts']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + RL, 'Enter']); spawnSync('sleep', ['0.3']);
    ok('paneStage sees the injected footer as ready', m.paneStage(RL) === 'ready');
    const dmark = 'deliver_' + process.pid;
    const dres = m.deliver(RL, dmark);
    ok('deliver() into a ready pane reports ok with a status', dres.ok === true && !!dres.status);
    spawnSync('sleep', ['0.3']);
    const dpane = spawnSync('tmux', ['capture-pane', '-p', '-t', m.SESSION + ':' + RL], { encoding: 'utf8' }).stdout || '';
    ok('deliver() into a ready pane actually sends the text', dpane.includes(dmark));

    // --- a turn in progress ("esc to interrupt" at the bottom) is running → deliver refuses ---
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + RL, '-l', '--', 'esc to interrupt']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + RL, 'Enter']); spawnSync('sleep', ['0.3']);
    ok('paneStage classifies a running turn as running (not ready)', m.paneStage(RL) === 'running');
    const runres = m.deliver(RL, 'should_not_land_' + process.pid);
    ok('deliver() refuses a running pane', runres.ok === false && runres.status === 'skipped' && runres.stage === 'running');

    // --- a live permission menu refuses text delivery (typed text = a menu selection) ---
    const ML = 'mtest' + process.pid;
    m.run(ML, [], os.tmpdir(), { cmd: 'cat', capture: false });
    spawnSync('sleep', ['0.3']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + ML, '-l', '--', 'Do you want to run this command? 1. Yes 2. No']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + ML, 'Enter']); spawnSync('sleep', ['0.3']);
    ok('paneStage detects a live permission menu', m.paneStage(ML) === 'menu');
    const mres = m.deliver(ML, 'menu_eat_' + process.pid);
    ok('deliver() refuses text at a permission menu', mres.ok === false && mres.status === 'skipped' && mres.stage === 'menu');
    ok("the refusal says approve/deny it, don't type into it", /permission menu/.test(mres.error || ''));
    m.stop(ML);

    // --- sayAll returns a per-window breakdown (the cockpit renders it as chips) ---
    const ball = m.sayAll({ text: 'bcast_' + process.pid });
    ok('sayAll returns per-window results + counts', ball.ok && Array.isArray(ball.results)
       && ball.results.length === ball.total && (ball.started + ball.skipped) <= ball.total);

    // --- adopt() launches `--resume <id> --fork-session` (cmd:'echo' lets us read the args) ---
    const AL = 'atest' + process.pid;
    m.adopt(AL, 'SID123', os.tmpdir(), { cmd: 'echo', capture: false });
    spawnSync('sleep', ['0.5']);
    const apane = spawnSync('tmux', ['capture-pane', '-p', '-t', m.SESSION + ':' + AL], { encoding: 'utf8' }).stdout || '';
    ok('adopt() forks via --resume <id> --fork-session', /--resume SID123 --fork-session/.test(apane));

    // adopt() records the original session id so the clicked card flips to managed (the fork
    // gets a fresh id). managedBySession() must map that adopted-from id back to the window.
    ok('managedBySession maps the adopted-from session', m.managedBySession().SID123 && m.managedBySession().SID123.label === AL);
    // a DIFFERENT session in the same label space must not collide onto AL's window
    ok('uniqueLabel keeps the base for the same session', m.uniqueLabel(AL, 'SID123') === AL);
    ok('uniqueLabel suffixes for a different session', m.uniqueLabel(AL, 'OTHERSID') === m.sanitize(AL + '-OTHERSID'));

    // --- run() shell-quotes launch args: an arg with spaces/quotes arrives as ONE argv entry ---
    const QL = 'qtest' + process.pid;
    m.run(QL, ["it's got spaces"], os.tmpdir(), { cmd: 'echo', capture: false });
    spawnSync('sleep', ['0.5']);
    const qpane = spawnSync('tmux', ['capture-pane', '-p', '-t', m.SESSION + ':' + QL], { encoding: 'utf8' }).stdout || '';
    ok('run() shell-quotes args (spaces + quote survive the shell)', qpane.includes("it's got spaces"));
    m.stop(QL);

    // --- paneStage classifies the startup menus by what's on screen (drive a `cat` pane) ---
    const SL = 'stest' + process.pid;
    m.run(SL, [], os.tmpdir(), { cmd: 'cat', capture: false });
    spawnSync('sleep', ['0.3']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + SL, '-l', '--', 'Quick safety check: Is this a project you trust this folder']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + SL, 'Enter']); spawnSync('sleep', ['0.3']);
    ok('paneStage detects the trust prompt', m.paneStage(SL) === 'trust');
    m.stop(SL);
    // fresh pane for the resume picker (the trust text above mustn't linger on screen)
    const SL2 = 'stest2' + process.pid;
    m.run(SL2, [], os.tmpdir(), { cmd: 'cat', capture: false });
    spawnSync('sleep', ['0.3']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + SL2, '-l', '--', 'We recommend resuming from a summary. Resume from summary Resume full session as-is']);
    spawnSync('tmux', ['send-keys', '-t', m.SESSION + ':' + SL2, 'Enter']); spawnSync('sleep', ['0.3']);
    ok('paneStage detects the resume picker', m.paneStage(SL2) === 'resume');
    m.stop(SL2);

    // --- trustPromptShowing is false for a normal shell pane (no false positives) ---
    ok('trustPromptShowing false on a plain pane', m.trustPromptShowing(RL) === false);

    // --- stop() failure carries the reason ---
    const sfail = m.stop('no-such-window-xyz');
    ok('stop() on an unknown window reports ok:false with an error', sfail.ok === false && !!sfail.error);

    // cleanup
    m.stop(RL); m.stop(AL);
    m.stop(LBL);
    ok('stop() removes it from the registry', !m.listManaged().some((w) => w.label === LBL));
  } finally {
    killSession();   // never leave throwaway windows behind, even on assertion failure
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} assertions passed.`);
