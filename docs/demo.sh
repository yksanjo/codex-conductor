#!/usr/bin/env bash
# Conductor demo — sanitized, for a shareable clip. No real project names.
set -u

CYAN=$'\033[36m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'; BOLD=$'\033[1m'

type_cmd() {  # simulate a human typing a command
  printf "%s$ %s" "$DIM" "$RST"
  local s="$1"
  for ((i=0; i<${#s}; i++)); do printf "%s" "${s:$i:1}"; sleep 0.06; done
  printf "\n"; sleep 0.4
}

clear
sleep 0.6
type_cmd "conductor"

cat <<EOF
${CYAN}🎼 Conductor (claude-code) — 8 units · last 10 min${RST}
   ${DIM}cockpit: conductor up   ·   control: conductor run <label> / conductor say <label> yes${RST}

${BOLD}WORKING NOW${RST} ───────────────────────────────────────────────────────────────────
┌─ a1f3 ──────────────────────────────────────────────────────────────────────┐
│ ${GRN}●${RST} Add Stripe checkout to billing flow                          3s ago │
│ ${DIM}payments-api · feat/checkout${RST}                                          │
│ ${DIM}› Edit: src/billing/checkout.ts${RST}                                       │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ b7c9 ──────────────────────────────────────────────────────────────────────┐
│ ${GRN}●${RST} Migrate user table to new schema                            12s ago │
│ ${DIM}data-indexer · main${RST}                                                   │
│ ${DIM}› Bash: npm run migrate:up${RST}                                            │
└──────────────────────────────────────────────────────────────────────────────┘
EOF
sleep 0.5
cat <<EOF

${BOLD}OPEN${RST} ──────────────────────────────────────────────────────────────────────────
┌─ c2d8 ──────────────────────────────────────────────────────────────────────┐
│ ${YEL}●${RST} Redesign landing page hero                                   4m ago │
│ ${DIM}marketing-site · feat/hero${RST}                                            │
│ ${DIM}› Done. Want me to wire up the email capture next?${RST}                    │
└──────────────────────────────────────────────────────────────────────────────┘
┌─ e5a1 ──────────────────────────────────────────────────────────────────────┐
│ ${YEL}●${RST} Fix flaky auth integration test                              6m ago │
│ ${DIM}auth-service · fix/flaky-test${RST}                                         │
│ ${DIM}› Root cause found: token clock skew. Patching now…${RST}                   │
└──────────────────────────────────────────────────────────────────────────────┘
EOF
sleep 0.5
cat <<EOF

${BOLD}IDLE${RST} ──────────────────────────────────────────────────────────────────────────
┌─ f0b4 ──────────────────────────────────────────────────────────────────────┐
│ ${DIM}○ Write API docs for v2 endpoints                            38m ago${RST} │
│ ${DIM}docs-site · main${RST}                                                      │
└──────────────────────────────────────────────────────────────────────────────┘

${DIM}8 windows · 2 working · 2 open · 1 idle · read-only${RST}
EOF
sleep 2.5
