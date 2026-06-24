---
name: codex-conductor
description: Situational awareness across local Codex sessions. Use when the user says "sort out my Codex sessions", "what is Codex doing", "summarize my Codex windows", "codex conductor", or "what's running".
---

# Codex Conductor

You are using Codex Conductor as a read-only session supervisor. It reads local Codex
transcripts and reports what other sessions appear to be doing. Do not interrupt or
type into other sessions unless the user explicitly asks for control.

## Step 1 - Gather Sessions

Run the scanner:

```bash
node ~/codex-conductor/scan.js --json --minutes 30
```

It scans `~/.codex/sessions/**/*.jsonl`, uses `~/.codex/session_index.jsonl` for
thread names when available, groups by session id, and returns structured JSON.

Widen the window with `--minutes 60`, or pass `--all` when the user wants older
local history.

## Step 2 - Render The Table

For each session, use:

- `label` / `project` - where it is working.
- `title`, `task`, and `intent` - what the session appears to be about.
- `recent` and `lastAction` - what happened recently.
- `lastActiveRel` - how long since real activity.
- `status` - active, open, recent, or idle.

Output format:

```text
N Codex sessions

* <label> · <status> · <lastActiveRel>
  doing now  : <one-line inference from lastAction/recent>
  done       : <best-effort summary from recent records>
  what's left: <best-effort next step; mark uncertain guesses with ?>
```

## Rules

- "What's left" is inference, not fact. The transcript shows activity, not a confirmed todo list.
- Keep it scannable. The user is triaging sessions, not reading a report.
- If `count` is 0, say no recent Codex sessions were found and suggest `--minutes 60` or `--all`.
- This skill is read-only. For control, point the user at `codex-conductor run <label>`,
  `codex-conductor say <label> <text>`, and `codex-conductor adopt <id>`, or use the
  MCP tools if available.
- `auto_continue` runs under the irreversibility gate and refuses unattended deploy,
  send, delete, or spend approvals.
