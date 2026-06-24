# Changelog

## 0.1.0

- Forked Conductor into **Codex Conductor**: package name, binaries, CLI help,
  cockpit branding, README, and bundled skill are now Codex-first.
- Added the `codex-code` adapter as the default. It reads
  `~/.codex/sessions/**/*.jsonl`, uses `~/.codex/session_index.jsonl` for thread
  names, and maps Codex events into the existing Conductor engine contract.
- Parameterized the managed tmux control plane so this product launches `codex`
  by default, uses a `codex-conductor` tmux session, and stores state in
  `~/.codex-conductor`.
- Kept legacy Conductor adapters available behind `--adapter`, with tests still
  exercising the original Claude, fleet, MEV, validator, and sales paths.

## 0.7.2

- **New `sales` adapter — supervise a fleet of governed sales agents.** Reads
  `~/.fleet/sales/*/events.jsonl` (typed `work`/`spend`/`send`/`gate`/`exception`/
  `heartbeat` records) and maps each agent to a supervise-by-exception status:
  **working** / **gated** (parked for a human) / **blocked** (send refused) /
  **halted** (cap / kill / pause) / **feed-dead**. Control is
  `pause`/`resume`/`set-param`/`kill`; `kill` is confirm-gated and can never be
  broadcast, so the desk-wide button only ever pauses the office. Same
  `_filetrail` plumbing as the trading-bot and MEV adapters. 21 no-mock tests.

## 0.7.1

- **Gate hardening: mixed approve+refuse replies no longer slip past the irreversibility gate.**
  The refusal shortcut in `policy.gate()` used to fire on any refusal word anywhere in the reply,
  so `"yes, go ahead and deploy — but do not merge anything else"` was relayed as if it were a
  decline. The shortcut now fires only for an unambiguous decline: negated clauses are stripped
  first, and a reply that still *orders* an irreversible action — or carries approval language
  outside its negated clauses (including deferred approvals like "wait for the build, then
  deploy") — is gated. Declines that name the action ("cancel the deploy") still relay.
  6 new regression tests.
- `conductor help` / `--help` now list all four adapters (mev-searcher and validator-fleet were
  missing).
- validator-fleet: a reachable, non-delinquent validator absent from the current vote set now
  reports **NOT IN VOTE SET** instead of being misfiled under BEHIND / "catching up".
- README: lead with the actual pitch (watch + reply to every window from one place), adapter
  abstraction moved below the fold, link to [Conductor V2](https://github.com/yksanjo/conductor2),
  and an honest note that the `X-Conductor` header is a browser-CSRF guard, not local-process auth.
- Repo hygiene: internal `*.local.md` playbooks untracked from the public repo; `docs/manual.pdf`
  added to the npm `files` allowlist (the README links it).

## 0.7.0

- **Honest broadcast delivery — you can now see, per window, whether a prompt actually landed.**
  Broadcasting ("prompt all managed") and single replies used to report success off the tmux
  `send-keys` exit code, which only proves keystrokes were delivered — not that Claude accepted
  them. On a CLI window sitting at the folder-trust prompt, the resume picker, or a busy/compacting
  state, the text was typed into the wrong place and the toast still said "sent to N windows."
  - **`manage.deliver(label, text)`** replaces the raw `say()` in the broadcast/reply path. It
    refuses to type unless `paneStage` is `ready` (otherwise returns `{status:'skipped', stage}`),
    then reads the pane back to classify the result: `started` (turn visibly running) or `sent`
    (delivered to a ready prompt). A broadcast fires every ready window first and settles **once**
    before confirming, so it no longer freezes the single-threaded cockpit per window.
  - **`sayAll()` returns a per-window breakdown** (`results[]` + `started`/`skipped`/`total`)
    instead of a single count. `/api/say` and the MCP `reply_to_session` route through `deliver`
    too, so both surfaces report when a window wasn't ready rather than failing silently.
  - **Cockpit shows it.** Each managed card paints a status chip after a broadcast/reply
    (✅ running · ↵ sent · ⏸ trust prompt/busy · ✕ gone), and the broadcast toast
    summarizes "N/M got it · K skipped (see cards)". Chips fade after ~45s.
- **Two more adapters — `mev-searcher` and `validator-fleet`.** Both supervise crypto-native fleets
  by exception, extending the engine with no surface changes.
  - **`adapters/mev-searcher.js`** — a MEV / liquidation searcher fleet reading
    `~/.fleet/searchers/*/events.jsonl` (`opportunity|bundle|submit|land|revert|pnl|gas|heartbeat|
    error`). Window signals **feed-dead** (disconnected) → **wedged** (losing every race) →
    **bleeding** (net-negative after tips+gas) → **racing** / **idle**. Control appends `pause|
    resume|set-param|kill|unwind`; `unwind` (flatten seized collateral) is destructive — confirm
    token required and **never broadcastable**. `tools/fakesearcher.js` emits realistic trails.
  - **`adapters/validator-fleet.js`** — Solana validator ops by **chain-side observation**: one
    batched `getVoteAccounts`+`getEpochInfo` poll per `rpcUrl` (never per-node) drives **delinquent**
    → **behind** → **degraded** (skip) → **low-balance** → **version-drift** → **healthy**. Control
    is **observe-only by default**, gated by a per-capability flag *and* a confirm token; **no hot
    identity-swap** (double-sign/slashing footgun, left out); `broadcast` is read-only (`report`).
  - **`adapters/_filetrail.js`** — shared `~/.fleet` plumbing (discover glob, streamed jsonl parse,
    tail-read liveness, structured control-file append with an opt-in destructive confirm gate);
    `fleet.js` + `mev-searcher.js` both import it. Each adapter ships a no-mock test
    (`adapters/mev-searcher.test.js`, `adapters/validator-fleet.test.js` — the latter against a stub
    RPC server); `npm test` stays green across all adapters + the cockpit guard. README gains the
    supported-adapters table and the four-ingredient fit test.
  - **Cockpit wired for every adapter.** The web cockpit is now data-driven: per-unit control
    buttons are generated from each adapter's advertised capabilities, commands in
    `control.destructive` get the danger style + a double-confirm, and the desk-wide band is built
    from an adapter `broadcastUi` hint (fleet → flatten-all *danger*; mev → pause-all; validator →
    a non-mutating report/refresh). The server's destructive gate now reads `adapter.control.
    destructive` instead of a hardcoded `flatten`, and forwards the validated confirm token to the
    adapter's own gate (defense in depth) — so `mev unwind` and every gated `validator` op are
    confirm-required end to end, while `validator broadcast` is limited to the non-mutating report.

The **irreversibility gate** — the auto-approve policy that makes end-to-end driving safe.
An orchestrator can now run the loop without rubber-stamping every reply: continue ordinary
work automatically, but bounce every irreversible step back to the human.

- New module `policy.js` — a zero-dependency, pure-function classifier over four irreversible
  classes (**deploy · send · delete · spend**) plus a `gate(question, reply)` decision. Biased
  to stop when unsure; an explicit refusal ("no, don't deploy") is always safe to relay.
- New MCP tool `auto_continue` — advances ONE waiting window under the gate: sends `"continue"`
  (or your text) when the question is ordinary work; when the question or reply trips an
  irreversible class it does NOT send and returns `gated:true` with the reason + question so
  you escalate. `reply_to_session` stays the raw, ungated channel for a human-authorized reply.
- `pending_questions` now flags each waiting window with `irreversible` + `categories`, so the
  triage feed itself tells you which windows you must not auto-approve.
- **Close a window from the cockpit** — managed cards now carry an **✕ close** button next to
  **↗ open**. It kills the window's tmux session (the same thing `conductor stop <label>` does).
  Closing is irreversible (the live session and its state are lost), so it double-confirms in the
  browser and the `/api/stop` endpoint requires a confirm token (the label) on top of the CSRF
  guard — mirroring how `flatten` is gated. Only conductor-managed windows get the button; plain
  windows run in your own terminal tabs and have no handle here, so they're closed from that
  terminal (the manual now says so). Covered by `server.test.js`.
- Tests: new `policy.test.js` (22 assertions — every class, the rubber-stamp save, refusals,
  ordinary continuation); MCP suite covers `auto_continue`'s gate path with no spawn.

- **Hardened `fleet` flatten (defense in depth).** `flatten` is now destructive *at the adapter
  layer*, matching `mev-searcher`/`validator-fleet`: `control.send`/`broadcast` reject it without a
  confirm token even when driven directly (MCP / script), not just through the cockpit — closing a
  path where flatten could be issued ungated. The desk-wide panic-flatten is preserved: `broadcast`
  still flattens every bot, but must carry the token (the cockpit already double-confirms; the
  server forwards the validated token to the adapter gate). `control.destructive` is now advertised.
  Covered by `fleet.test.js`.

## 0.6.0

Conductor's engine is now a **source-agnostic supervisory core** with a pluggable adapter
interface. Built once, proven on two adapters.

- **`engine.js` + `adapters/`** — the engine (`loadAdapter`, `collect`) owns discovery
  orchestration, liveness, grouping, status ranking, and sorting; it knows no domain. Adapters
  own where trails live and how to read them (`discover` / `liveness` / `parse` / `status` /
  `project` / `statuses` / `control`). Records are normalized to a stable contract.
- **`adapters/claude-code.js`** — the original reader, ported onto the contract. Behavior is
  unchanged; the existing test suite proves it.
- **`adapters/fleet.js`** — first new adapter: a trading-bot fleet reading
  `~/.fleet/bots/*/events.jsonl`. Liveness from heartbeats; `wedged` + `drawdown` signals;
  control appends `pause|resume|flatten|set-param` to `control.jsonl`; broadcast = desk-wide
  panic flatten. `tools/fakebot.js` emits realistic trails for testing.
- **Surfaces generalized** — `--adapter` on the CLI, cockpit, and MCP. The CLI sections come
  from the adapter's status vocabulary; the cockpit renders adapter-driven cards (fleet cards
  get pause/resume/flatten + a broadcast-flatten band); the MCP read tools take an `adapter`
  arg and gain `risk_snapshot` (PnL + drawdown + wedged units).
- **Security** — destructive control (flatten) and every broadcast require an explicit confirm
  token on top of the localhost + Origin + `X-Conductor` guard; the UI double-confirms. Tagline
  is now "read-only observation, opt-in control."
- Tests: new `fleet.test.js` (29) and `server.fleet.test.js` (14) join the unchanged Claude
  suites; full suite green.

## 0.5.0

The MCP server gains a **control surface** so an MCP-aware orchestrator can drive windows
end-to-end, not just watch them — the same tmux channel the web cockpit already uses.

- New MCP tool `pending_questions` — returns ONLY the windows blocked waiting on a human
  (Claude spoke last, then went quiet), with each window's question text. The triage feed.
- New MCP control tools `reply_to_session` (reply; adopts a read-only window first),
  `send_key` (Escape / C-c / Enter to a managed window), and `run_window` (launch a new
  managed window with an optional first prompt).
- No auto-approve policy: every reply is a deliberate tool call; irreversible steps stay a
  human decision. The boot→ready drive loop (`deliverAdopted`) is now shared by the cockpit
  and the MCP, so both adopt-and-drive windows identically.
- Tests: MCP suite covers all 7 tools incl. the new triage shape and write-tool guard paths.

## 0.4.0

Conductor is a read-only situational-awareness layer over your live Claude Code windows,
plus a tmux-based control plane for the ones you launch or adopt. Three surfaces share one
zero-dependency engine: a CLI, a web cockpit, and an MCP server.

### Read
- Discovers every session from `~/.claude/projects/**/*.jsonl` (mtime-gated, subagent
  threads excluded, grouped by session).
- Liveness by **process**, not file writes — a window is "open" if a live `claude` process
  owns it, so idle-but-open windows still show.
- Cards/boxes lead with the session's plain-language title (its `ai-title`), not the
  directory; project shown only when it's a real project dir.
- CLI: boxed, sectioned table (Working now / Open / Recently active / Idle).
- Web cockpit (`conductor up`, :7591): live cards, click-for-detail, status pills,
  in-place refresh that never wipes what you're typing.
- MCP server: `list_sessions`, `summarize_session`, `whats_left`.

### Control (tmux-managed windows)
- `conductor run <label>` — launch a window born-managed (auto-answers the trust prompt).
- `conductor adopt <session>` — fork an existing session into a managed window.
- `conductor say` / cockpit reply bars / broadcast — quick replies to one or all managed
  windows. Every card has a reply bar; replying to a plain window adopts it first.
- All tmux calls use argument arrays — reply text is never shelled.

### Quality
- 51 automated assertions (engine + MCP + control plane, incl. real tmux send→capture).
- All 11 dashboard functions verified end-to-end in a real browser.
- Zero runtime dependencies. Read-only core. Control only touches windows Conductor owns.
