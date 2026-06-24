# Show HN: Conductor — let your Claude Code agents run unattended, with a hard stop before anything irreversible

**Title (≤80 chars):**
`Show HN: Conductor – agents run unattended, a gate stops them before deploy/send/spend`

---

## Post body

I run a lot of Claude Code windows at once. The thing that actually kept me chained to the
desk wasn't keeping track of them — it was that any one of them could **deploy, send, delete,
or spend** the second it decided to. So I couldn't leave. I sat there alt-tabbing, ready to
yank the wheel, doing the exact babysitting a fleet of agents was supposed to free me from.

A nicer dashboard doesn't fix that. tmux already shows me my terminals. What I wanted was to
be able to *look away*.

Conductor is the autopilot for that. It reads the live `.jsonl` transcript each Claude Code
window already writes under `~/.claude/projects/` (no instrumentation, nothing leaves the
machine), and an orchestrator drives the **reversible** work end-to-end — edits, tests,
commits, the routine "yes, continue" prompts. The moment a window's next step would touch
something **irreversible**, a model-free gate in `policy.js` physically stops and hands that
one decision back to me, with the reason.

The hook is the split: **auto-continue is commodity. Auto-continue plus a gate you can't cross
without a human thumb is the part you can trust.** The bias is to stop when unsure — a false
gate costs me one manual reply; a false pass can ship a bad deploy or move real funds. There's
no model in the gate; it's auditable code you can read.

It's an open-source MCP server, zero dependencies, one Node file per surface. Three ways to use it:
- `conductor` — a CLI table of your live windows, problems first
- `conductor up` — a local web cockpit (binds `127.0.0.1`), color-coded, the window that needs
  you floats to the top
- as an MCP server — any orchestrator agent calls `list_sessions` / `whats_left` /
  `pending_questions` and the gated control tools, and still can't push past the gate

### Honest limits (these are real, and they're in the README)
- **Control is managed-only.** Conductor can reply to windows it launched (via tmux) or ones
  you explicitly `adopt` (forked into a managed window, history intact). A plain terminal you
  opened yourself stays **read-only** — there's no reliable way to inject input into it.
- **"What's left" is inferred** from the transcript, not a real todo list. Best-effort, and
  labeled as such.
- **"Live" = recently touched.** Per-row time always shows true last activity.
- The cockpit is local-first: reads only your own `~/.claude`, binds to `127.0.0.1`,
  state-changing requests need a local origin + CSRF header, destructive control needs a
  confirm token. The header stops hostile webpages, not local processes — run it for
  yourself, not as a service.

So it's not "fully autonomous agents that finish the work for you." It runs the reversible
stuff unattended and stops cold before the irreversible stuff. That boundary is the whole point.

There's also a sibling, Conductor V2, that flips the order — you design a swarm formation and
fire a fleet into tmux — but V1 (this) is the watcher/autopilot for windows you run.

Repo: https://github.com/yksanjo/conductor
Would love feedback on the gate model specifically — what reversible/irreversible calls would
you want it to make differently?

---

<!-- CLOSING CTA — forks on the reputation/business decision (see NOTES.md) -->
**Variant A (reputation):** It's MIT and there's no paid tier — I built it because I needed it.
If it's useful, a GitHub star helps it find the next person who's stuck at their desk.

**Variant B (business / open-core):** The core is free and MIT. I'm gauging interest in a team
version — shared cockpit, role-based approvals on the gate, and an audit log of every gated
call and who answered it. If that's something your team would want, there's an (early-access)
waitlist linked from the repo.
