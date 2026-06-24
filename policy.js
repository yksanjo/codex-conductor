'use strict';

// policy.js — the irreversibility gate for autonomous window-driving.
//
// Conductor's MCP lets an orchestrator agent drive your live windows end-to-end. The
// failure mode is the rubber stamp: a window asks "deploy to prod?" and the loop blindly
// answers "yes". This module is the gate. Its single rule — the one you chose:
//
//   An autonomous driver may freely CONTINUE ordinary work, but must NEVER approve an
//   IRREVERSIBLE action on your behalf. Irreversible = the four classes you named:
//   DEPLOY · SEND · DELETE · SPEND. Anything tripping them is escalated to you, not sent.
//
// When uncertain, gate. A false gate costs you one manual reply; a false pass can ship a
// bad deploy, fire off a message, drop a table, or move real money. Asymmetric downside →
// bias toward stopping. This reads INTENT from the window's question + the proposed reply;
// it is a guardrail, not a sandbox — it cannot see what a window does after you say "go".
// Zero dependencies, pure functions, unit-tested in policy.test.js.

// Verb/phrase signatures per irreversible class. Case-insensitive, word-boundaried to keep
// "now" from matching "no" and "released" from matching a bare "release" only when intended.
const CATEGORIES = {
  deploy: [
    /\bdeploy(ing|ed|ment|s)?\b/i, /\bship(ping|ped)?\s+(it|this|to\s+prod)/i, /\bto\s+prod(uction)?\b/i,
    /\bgo(ing)?\s+live\b/i, /\bpublish(ing|ed)?\b/i, /\bnpm\s+publish\b/i, /\bgit\s+push\b/i,
    /\bforce[-\s]?push(ing|ed)?\b/i, /\bvercel\s+(deploy|--prod)/i, /\bwrangler\s+deploy\b/i,
    /\bmerge\b[^.]*\b(pr|pull\s+request|to\s+main|into\s+main|prod)/i, /\bpush\s+to\s+(main|prod|origin|remote)/i,
    /\bcut\s+a\s+release\b/i, /\btag\s+a\s+release\b/i,
  ],
  send: [
    /\bsend(ing)?\s+(the\s+|a\s+|this\s+|that\s+)?(email|e-mail|message|msg|dm|tweet|post|tx|transaction|payment|invite|reply)/i,
    /\bpost(ing)?\s+(to\s+|on\s+|it\s+to\s+)?(x|twitter|tg|telegram|slack|discord|the\s+channel|publicly|live)/i,
    /\btweet(ing)?\b/i, /\bbroadcast(ing)?\b/i, /\bemail\s+(them|him|her|the\b)/i, /\bsend\s+it\b/i,
    /\bsubmit(ting)?\s+(the\s+)?(form|application|pr|pull\s+request|grant)/i, /\bgo\s+public\b/i,
  ],
  'delete': [
    /\brm\s+-rf?\b/i, /\bdrop\s+(the\s+)?table\b/i, /\bdrop\s+(the\s+)?database\b/i, /\btruncate\b/i,
    /\bdelet(e|ing|ed)\b/i, /\bdestroy(ing|ed)?\b/i, /\bremov(e|ing|ed)\b/i, /\bwip(e|ing|ed)\b/i,
    /\bpurg(e|ing|ed)\b/i, /\breset\s+--hard\b/i, /\brevok(e|ing|ed)\b/i, /\bdelete\s+the\s+branch\b/i,
  ],
  spend: [
    /\bspend(ing)?\b/i, /\bbuy(ing)?\b/i, /\bsell(ing)?\b/i, /\bswap(ping)?\b/i, /\bpay(ing|ment)?\b/i,
    /\bfund(ing)?\b/i, /\bwithdraw(ing|al)?\b/i, /\btransfer\s+(funds|sol|usdc|usd|money|\$|eth)/i,
    /\bmainnet\b/i, /\breal\s+(money|sol|funds|usdc)\b/i, /\bsign\s+(the\s+)?(tx|transaction|swap)/i,
    /\bapprove\s+(the\s+)?(token|spend|tx|transaction|allowance)/i, /\$\s?\d/, /\b\d+(\.\d+)?\s*(sol|usdc|usd|eth|btc)\b/i,
    /\bplace\s+(an?\s+)?(order|trade|bet)/i, /\bexecute\s+(the\s+)?(trade|order|swap)/i,
  ],
};

// A reply that is purely an approval ("yes" / "go ahead" / "ship it") — the dangerous half
// of the rubber stamp when paired with an irreversible question.
const AFFIRMATIVE = /^\s*(y|yes|yep|yeah|ya|sure|ok|okay|k|go|go ahead|do it|proceed|continue|approve|approved|confirm|confirmed|ship it|send it|lgtm|sounds good|👍|✅)\s*[.!]*\s*$/i;

// A reply that DECLINES or HALTS. Declining an irreversible action is itself reversible, so
// a clear refusal is always safe to relay — that's how you say "no, don't deploy" through the loop.
const REFUSAL = /\b(no|nope|don'?t|do\s+not|stop|halt|cancel|abort|hold\s+(on|off)|skip|decline|reject|wait)\b/i;

// Approval language ANYWHERE in a reply — not just a pure-approval reply. "Yes, go ahead and
// deploy — but do not merge anything else" both refuses and approves; the refusal half must not
// smuggle the approval half past the gate.
const APPROVAL_ANYWHERE = /\b(yes|yep|yeah|sure|ok(ay)?|go\s+ahead|do\s+it|proceed|approve[ds]?|confirm(ed)?|ship\s+it|send\s+it|lgtm|sounds\s+good|green\s*-?light|continue)\b/i;

// Negators that genuinely CANCEL the clause that follows ("don't deploy", "hold off on the
// email", "without pushing"). Deliberately excludes "wait"/"hold on", which merely DEFER —
// "wait for the build, then deploy" is still an order to deploy.
const NEGATED_CLAUSE = /\b(don'?t|do\s+not|never|stop|halt|cancel|abort|skip|decline|reject|without|hold\s+off(\s+on)?|rather\s+than)\b[^,.;:!?]*/gi;

function stripNegated(text) { return String(text || '').replace(NEGATED_CLAUSE, ' '); }

// classify(text) → { categories:[...], matched:[...], irreversible:bool }
// Which irreversible classes does this text touch, and the literal substrings that tripped it.
function classify(text) {
  const t = String(text || '');   // every signature regex carries /i — no pre-lowercasing needed
  const categories = [];
  const matched = [];
  for (const cat of Object.keys(CATEGORIES)) {
    for (const re of CATEGORIES[cat]) {
      const m = t.match(re);
      if (m) {
        if (!categories.includes(cat)) categories.push(cat);
        matched.push(m[0].trim());
      }
    }
  }
  return { categories, matched, irreversible: categories.length > 0 };
}

// gate(question, reply) → { allow, gated, reason, categories?, matched? }
// Should an autonomous driver be allowed to send `reply` to a window blocked on `question`?
function gate(question, reply) {
  const r = String(reply || '');
  const q = classify(question);
  // Classify only what the reply actually ORDERS: drop negated clauses first, so a refusal's
  // own mention of the action ("no, don't deploy") doesn't trip the gate on itself.
  const stripped = stripNegated(r);
  const ordered = classify(stripped);
  // The refusal shortcut fires ONLY for an unambiguous decline: refusal language present, no
  // surviving irreversible order, and no approval language outside the negated clauses. A mixed
  // "yes, deploy — but don't merge" is an approval wearing a refusal word; it falls through.
  if (REFUSAL.test(r) && !AFFIRMATIVE.test(r) && !ordered.irreversible && !APPROVAL_ANYWHERE.test(stripped)) {
    return { allow: true, gated: false, reason: 'reply declines or halts — safe to relay' };
  }
  const categories = [];
  for (const c of [...q.categories, ...ordered.categories]) if (!categories.includes(c)) categories.push(c);
  if (categories.length === 0) {
    return { allow: true, gated: false, reason: 'no irreversible action detected — safe to continue' };
  }
  const matched = [];
  for (const m of [...q.matched, ...ordered.matched]) if (!matched.includes(m)) matched.push(m);
  return {
    allow: false,
    gated: true,
    reason: `irreversible action (${categories.join(', ')}) — needs the human's explicit OK, not an auto-reply`,
    categories,
    matched,
  };
}

module.exports = { classify, gate, CATEGORIES };
