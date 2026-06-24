# Conductor — X / Twitter thread

Reframe: tweet 1 must carry **unattended progress + the single human gate moment** — NOT
"tidy your windows." Each tweet ≤280 chars.

---

**1/ (the hook — this is the reframe)**
You can't leave a coding agent alone. It might deploy, send, or spend the second it decides to.

So you babysit ten of them.

Conductor lets the fleet run unattended — and physically stops it before anything irreversible,
handing that one call to you. 🎼

---

**2/**
The metaphor: autopilot.

The autopilot flies the cruise. The pilot owns takeoff, landing, and anything unexpected.

Your agents handle the reversible work — edits, tests, commits, the routine "yes, continue."
You're the pilot for the moments that can't be undone.

---

**3/**
The split is the whole product:

• auto-continue reversible work → commodity, everyone has it
• auto-continue + a gate you CAN'T cross without a human thumb → the part you can trust

The moment a step would deploy / send / delete / spend, it stops cold and asks you.

---

**4/**
No model in the gate. It's auditable code (`policy.js`).

Bias is to stop when unsure: a false gate costs you one reply; a false pass can ship a bad
deploy or move real funds.

You can look away *because* it can't ship without you.

---

**5/ (how it works — no new infra)**
It reads the `.jsonl` transcript every Claude Code window already writes under
`~/.claude/projects/`. Zero instrumentation, nothing leaves your machine.

The window that needs you — wedged, done, or stopped at the gate — floats to the top.

---

**6/ (honest about what it's NOT)**
Not "autonomous agents that finish your work."

It runs the *reversible* stuff hands-off and stops at the *irreversible*. Control is only for
windows it launched or you `adopt`; "what's left" is inferred from the transcript. All in the
README, labeled.

---

**7/ (surfaces)**
Open-source MCP server, zero deps, one Node file per surface:

→ `conductor` — CLI table, problems first
→ `conductor up` — local web cockpit (binds 127.0.0.1)
→ MCP server — any orchestrator drives the fleet, still can't pass the gate

---

<!-- 8/ FINAL CTA — forks on reputation vs business (see NOTES.md) -->

**8/ — Variant A (reputation):**
MIT, no paid tier, built it because I needed to step away from my desk.

If you run more agents than you can watch, try it — and a ⭐ helps the next person find it.

→ github.com/yksanjo/conductor

**8/ — Variant B (business / open-core):**
Core is free + MIT.

Gauging interest in a team version: shared cockpit, role-based gate approvals, audit log of
every gated call + who answered. Early-access waitlist in the repo.

→ github.com/yksanjo/conductor
