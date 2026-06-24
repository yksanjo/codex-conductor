# Conductor — positioning notes

## ⬆️ PICK A HEADLINE (top of the list = current site default)

The headline has to land **bounded autonomy in one read**: agents run on their own +
there's a hard stop you control. Not "watch your windows" (commodity), not "it finishes
the work for you" (dishonest/crowded).

1. **Your agents run unattended — until something can't be undone.** ← live on site now
   - One read gives you both halves: autonomy + the hard stop. No metaphor needed to parse it.
2. **Autopilot for your agents — with a hard stop you control.**
   - Leads with the metaphor; "hard stop you control" carries the gate. Tighter, slightly softer.
3. **Look away. It can't deploy, send, or spend without your yes.**
   - Most visceral; names the gated verbs. "Look away" = the benefit (trust) stated as a command.
4. **Your fleet flies the cruise. You own takeoff, landing, and every irreversible call.**
   - Fullest expression of the cockpit metaphor; longest read, best for a deck/cover slide.

### One-liner (used in README hero + site subhead — keep them identical)
> Autopilot for a fleet of Claude Code agents. They fly the reversible work unattended; a
> model-free gate stops the fleet before anything that deploys, sends, deletes, or spends —
> and hands that one call to you. You can look away _because_ it can't ship without you.

---

## 🔀 UNRESOLVED FORK — reputation vs. business (you decide)

This drives the **hero CTA** and **whether we add a waitlist**. Copy is written both ways and
labeled A / B everywhere it forks. The site renders **A** live; **B** is inline as commented
HTML blocks (search `Variant B` in `site/index.html`) — flip by un/commenting.

| | **A — reputation asset** | **B — business (open-core)** |
|---|---|---|
| Goal | Max mindshare; Conductor is a calling card | Revenue: free core + paid team cockpit |
| Hero CTA | `Add the MCP →` + `Star on GitHub` | `Add the MCP — free →` + `Join the team-cockpit waitlist` |
| Waitlist? | **No** | **Yes** (gate the paid tier, start a list now) |
| Paid surface | none | team cockpit: shared view, role-based gate approvals, audit log |
| Get-started | Two cards (MCP, cockpit) | Three cards (+ "Run a fleet across your team — paid") |
| Risk | Leaves money on the table if it takes off | Monetizing pre-traction can cap adoption / mindshare |

**Where the copy forks (so you can find every spot):**
- `site/index.html` hero `.hero-cta` — A live, B commented right below it.
- `site/index.html` get-started — A heading "Two ways…"; B adds a third card (`#waitlist`) + heading "Three ways…".
- `marketing/show-hn.md` — closing line has an A and a B variant.
- `marketing/x-thread.md` — final CTA tweet has an A and a B variant.

**Note on B honesty:** the paid tier (team cockpit / governed gate / audit log) does **not exist
yet**. If we go B, the waitlist must say "early access / coming" — don't imply it ships today.

---

## Guardrails for any future copy
- Foreground **trust + the gate**. That's the moat, not the dashboard.
- Keep "full autonomy / runs it to the finish line" **light and proportional** — today it
  auto-continues *reversible* work and stops at the gate. Don't imply it ships features solo.
- Don't touch the **honest-limits** facts: control is managed/adopted windows only; "what's
  left" is inferred from the transcript; "live" = recently touched.
- Don't restate the gate mechanics differently from `policy.js` — reframe presentation only.
