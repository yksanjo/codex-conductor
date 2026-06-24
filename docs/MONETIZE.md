# Conductor — Monetization Brief

*Written 2026-06-13. The honest WHO-PAYS analysis, not a feature roadmap.*

## What Conductor actually is (the asset)

A zero-dep, local-first, MIT control plane for fleets of semi-autonomous workers.
The differentiated part is **not** the dashboard — it's the **model-free irreversibility
gate**: the orchestrator flies all reversible work unattended, and a hard gate physically
stops the fleet before anything that *deploys, sends, deletes, or spends*, handing that one
call to a human. Plus a hash-chained audit trail of who approved what. Adapters already
exist for Claude Code, trading bots, MEV searchers, validators, and a sales fleet.

Dashboards get commoditized — every coding-agent vendor (Claude Code, Cursor, etc.) ships
its own. **The gate + audit chain is the defensible niche.** Bet there.

## The trap (name it first)

Yoshi's pattern is *build → under-distribute*. The wrong move here is to spend two weeks
adding Stripe + a "Team tier" to an open-source CLI and reach $0 MRR, because:
- Solo open-core dev tools rarely cross meaningful MRR without a distribution machine.
- The buyer pain ("too many agent approvals to route") is **early** — most teams aren't yet
  running fleets large enough to pay for approval routing.
- It's *more building*, which is the comfortable-but-unprofitable default.

His revenue engine is **BD / deals / role**, not SaaS subscriptions. Monetization should
route through that strength.

## Verdict

**Do not paywall Conductor.** Keep it public and free — it's the proof-of-competence and
lead magnet. Monetize the **governance substrate underneath it** via BD, one bespoke buyer
at a time.

This is already working: `capy-agent-office` ("Agent-Native Sales Office") is a live BD deal
built on *this same L4/L5 governance substrate*. That is the template, not an exception:

> Conductor (public, free) = credibility + distribution.
> Revenue unit = a bespoke **"governed agent fleet for <buyer>"** deployment, sold via BD,
> where the governance (caps, approval gates, audit chain) *is* the product.

## The one SKU worth pre-building — but only on a real "yes"

**Approval-routing + audit as a service** ("the gate, productized"):
- Approvals at irreversible steps route to the *right* human (Slack/phone) with an SLA.
- Policy config: anyone approves a doc edit; only a lead approves a deploy; a fund move
  needs 2 sign-offs.
- Tamper-evident audit chain for compliance.

Buyer = eng-leadership / platform team running ≥5 parallel agents who feel approval chaos.
It's a *safety/compliance* budget line, not a nice-to-have. **But build it only after one
named buyer says "yes, I'd pay for this."** Do not build it on spec.

## Licensing — the open-core hinge (decided, not implicit)

The model is open core, but it only *locks in* as open core if the relay is proprietary.
Three outcomes; only the first is a moat:

- **Relay proprietary → real open core.** Nobody runs the paid features without you. ✅
- **Relay also MIT → not open core.** Anyone self-hosts the relay; you've given away the
  *capability* (cross-machine aggregation, org policy, kill-switch *are* capabilities, not
  conveniences). Weak.
- **Core closed too → just proprietary.** Not our situation.

**The decision:** *MIT client (the lead magnet) · proprietary, closed relay · we own and
version the client↔relay wire protocol · the relay holds governance metadata only.*

Two things that are easy to get wrong:

1. **The moat hinge is the protocol, not the relay's source.** An MIT core is the soft spot
   for open core: even with a closed relay, if the client↔relay protocol is published and
   frozen, a competitor reimplements the relay and points *our* installed MIT clients at
   *theirs* — capturing the funnel without ever seeing our code. So: keep the relay closed
   **and** never ship a stable, public relay API spec inviting a drop-in replacement. Owning
   and versioning the protocol is what keeps the canonical-host position. (This is why most
   open-core cos move the core off permissive licenses to BSL/SSPL/FSL — but for us, MIT core
   is fine *because the defense is the closed relay + protocol control, not the license*.)

2. **The relay aggregates governance metadata, never transcripts/source.** This squares the
   relay with the local-first / "we never touch your code" posture — which is itself part of
   the trust moat and what makes the enterprise security review winnable. Relay state =
   statuses, approval requests + decisions, the audit-hash chain, spend tallies, kill-switch.
   Source + transcripts stay on the dev's machine. Bonus: that accumulated org governance
   state on the relay *is* the canonical-host effect made concrete — a forked relay starts
   empty.

Relay license: plain proprietary/closed is simplest. The relay isn't the funnel, so there's
no adoption benefit to source-availability — skip the BSL/FSL goodwill-vs-restriction call.

## Next actions (BD, cheap, this week — not code)

1. **Reframe the top-line.** Conductor's README/site leads with "situational awareness."
   Repoint it to the buyer-facing frame: *"bounded-autonomy / human-approval control plane
   for agent fleets."* Makes it read as a capability you sell, not a hobby CLI. (~1 hr.)
2. **Turn Capy into a reference case.** "We deployed a governed 6-agent sales office on this
   substrate" — one paragraph + (de-branded) screenshot. Credibility for the next deal.
3. **Make one explicit ASK.** Find one team running ≥5 agents, ask if approval routing is a
   real pain they'd pay to solve. *One* "yes" unlocks the SKU. Zero yeses → stays a calling
   card, and that's a valid result.

## What NOT to do
- No hosted SaaS that ingests transcripts — breaks the local-first / no-infra design and
  creates a sensitive-data surface (you'd be hosting customers' source + secrets).
- No adapter marketplace — too thin to be a business.
- No paywall on the CLI — kills distribution for trivial revenue.
