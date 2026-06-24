# Changelog

## 0.1.0

- Created Codex Conductor as a Codex-specific local session cockpit.
- Added the `codex-code` adapter as the product adapter. It reads
  `~/.codex/sessions/**/*.jsonl`, uses `~/.codex/session_index.jsonl` for
  thread names, and maps Codex events into the dashboard row model.
- Added Codex-specific package metadata, binaries, README, cockpit branding,
  manual, bundled skill, and tests.
- Parameterized the managed tmux control plane to launch `codex`, use the
  `codex-conductor` tmux session, and store state in `~/.codex-conductor`.
- Kept the irreversibility gate for unattended continuation: deploy, send,
  delete, and spend approvals are blocked unless a human explicitly handles them.
