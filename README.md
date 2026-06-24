# Codex Conductor

Codex Conductor is a Codex-first fork of Conductor: a local cockpit, CLI, and MCP server for watching your Codex sessions across projects.

It reads the local Codex transcript trail under `~/.codex/sessions/`, joins it with `~/.codex/session_index.jsonl` when available, and turns scattered runs into a status board grouped by working, open, recent, and idle sessions.

## Why

Codex already stores local transcripts so you can resume work later. Codex Conductor turns those transcripts into operational awareness:

- `codex-conductor` gives you a fast terminal table of recent sessions.
- `codex-conductor up` opens a local cockpit on `127.0.0.1`.
- `codex-conductor mcp` lets an MCP-aware agent ask what is active, what is blocked, and what is left.
- Managed tmux windows let you launch or drive Codex sessions from one board.
- The irreversibility gate refuses unattended deploy, send, delete, and spend approvals.

The original Conductor adapters are still included. Codex is the default; use `--adapter claude-code`, `--adapter fleet`, `--adapter mev-searcher`, `--adapter validator-fleet`, or `--adapter sales` when you want the older views.

## Install

```bash
git clone https://github.com/yksanjo/codex-conductor ~/codex-conductor
cd ~/codex-conductor
npm link
```

No build step and no runtime dependencies.

## Usage

```bash
codex-conductor                 # table of recent Codex sessions
codex-conductor --minutes 120   # widen the lookback window
codex-conductor --all           # include older local sessions
codex-conductor --json          # structured output
codex-conductor up              # local web cockpit
codex-conductor mcp             # MCP server over stdio
```

The cockpit binds to localhost. State-changing endpoints require a local origin and the `X-Conductor: 1` header.

## Codex Adapter

The default `codex-code` adapter reads:

- `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- `~/.codex/session_index.jsonl`

Labels come from the session working directory. Override labels with:

```json
{
  "my-project": "My Product",
  "codex-conductor": "Codex Conductor"
}
```

Save that as `~/.codex-conductor/labels.json`.

## Managed Codex Windows

Managed windows run inside a dedicated tmux session. This is the reliable control channel for sending replies or keys.

```bash
codex-conductor run review
codex-conductor say review "continue"
codex-conductor attach review
codex-conductor managed
codex-conductor stop review
```

Adopting an existing Codex session opens it with `codex resume <SESSION_ID>` in tmux:

```bash
codex-conductor ls --all
codex-conductor adopt 019f1111 review
```

If you keep the original tab open too, you will have two clients pointed at related work. Close the old tab when you want one control surface.

## MCP

Run the server:

```bash
codex-conductor mcp
```

Useful tools:

- `list_sessions` lists Codex sessions by default.
- `summarize_session` expands one session by id, short id, or label.
- `whats_left` returns inferred goals and recent actions.
- `pending_questions` lists live sessions that appear blocked on a human.
- `auto_continue` sends `continue` only when the irreversibility gate allows it.
- `reply_to_session`, `send_key`, and `run_window` drive managed tmux windows.

Example Codex MCP config:

```toml
[mcp_servers.codex_conductor]
command = "node"
args = ["/Users/you/codex-conductor/mcp.js"]
```

## Compatibility Adapters

Codex is the product default, but the source-agnostic Conductor engine remains:

```bash
codex-conductor --adapter claude-code
codex-conductor up --adapter fleet
codex-conductor --adapter validator-fleet --json
```

## Development

```bash
npm test
```

The test suite includes a temporary Codex transcript fixture plus the original Conductor adapter tests.

## License

MIT
