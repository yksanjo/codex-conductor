'use strict';

// drive.js — the shared "find a window and drive it" helpers.
//
// These three functions are how Conductor turns a loose session reference (a sessionId, an
// 8-char shortId, or a friendly label) into a real keystroke landing in the right tmux window.
// They were originally inline in mcp.js; they're factored out here so the local MCP (mcp.js)
// and the remote Copilot Seat (seat-server.js) drive windows through EXACTLY the same path —
// adopt-if-needed, deliver-when-ready — instead of drifting into two subtly different copies.
// Zero dependencies beyond the engine + control plane it already uses.

const engine = require('./engine');
const { collectSessions } = require('./lib');
const manage = require('./manage');
const { DEFAULT_ADAPTER } = require('./config');

// Find one session row by sessionId, 8-char shortId, or friendly label (case-insensitive).
async function findSession(ref, minutes = 4320) {
  const key = String(ref || '').toLowerCase();
  const rows = DEFAULT_ADAPTER === 'claude-code'
    ? await collectSessions({ minutes, all: false })
    : await engine.collect(engine.loadAdapter(DEFAULT_ADAPTER), { minutes, all: false });
  return rows.find((r) =>
    r.sessionId.toLowerCase() === key ||
    r.shortId.toLowerCase() === key ||
    (r.label || '').toLowerCase() === key);
}

// The "question" a window is blocked on = its last assistant TEXT (the thing it's waiting on
// you for). Falls back to its last action if it ended on a tool call. Prefer the full text
// (capped at 4000 chars by the adapter) over the 100-char display summary — the gate
// classifies this, and a long message ending "…Deploy to prod now?" must stay visible to it.
function lastAssistantText(s) {
  for (let i = (s.recent || []).length - 1; i >= 0; i--) {
    const r = s.recent[i];
    if (r.actor === 'assistant' && r.kind === 'text') return r.text || r.summary;
  }
  return s.lastAction;
}

// Deliver a reply to a window: if it's already managed, send straight to its tmux window;
// otherwise adopt it (fork into tmux) and drive it from boot to ready, then deliver. Mirrors
// the cockpit's /api/adopt-say so the MCP and the UI behave identically.
async function replyToSession(ref, text) {
  if (!manage.hasTmux()) return { ok: false, error: 'tmux is not installed (brew install tmux).' };
  const managedBySession = manage.managedBySession();
  const s = await findSession(ref);
  // Already managed (by sessionId, adoptedFrom, or label)?
  const existing = (s && managedBySession[s.sessionId])
    || manage.listManaged().find((w) => w.label === manage.sanitize(ref));
  if (existing) {
    const r = manage.deliver(existing.label, text);   // gated + confirmed; reports if it wasn't ready
    if (r.ok) return { ok: true, label: existing.label, adopted: false, status: r.status };
    if (r.status === 'skipped') return { ok: false, label: existing.label, error: `window "${existing.label}" isn't at a ready prompt (${r.stage}) — nothing was sent; open it and clear the ${r.stage} prompt, then retry.` };
    return r;
  }
  if (!s) return { ok: false, error: `no session matched "${ref}" — try list_sessions or widen the time window.` };
  const label = manage.uniqueLabel(s.label || s.shortId, s.sessionId);
  const r = manage.adopt(label, s.sessionId, s.cwd, { capture: false });
  if (r.ok) {
    manage.deliverAdopted(label, text);   // accept trust/resume prompts, then deliver once ready
    return { ok: true, label, adopted: true, note: 'adopted into tmux; the reply lands once the fork is ready (~a few s).' };
  }
  // adopt failed (usually a managed copy already exists) → try sending to that label
  const sr = manage.say(label, text);
  return sr.ok ? { ok: true, label, adopted: false } : { ok: false, error: r.error || sr.error };
}

module.exports = { findSession, lastAssistantText, replyToSession };
