'use strict';

// Conductor — back-compat facade.
//
// The engine is now source-agnostic (engine.js) and reads through pluggable adapters
// (adapters/<name>.js). This module preserves Conductor's original API: `collectSessions()`
// returns one public row per live Claude Code window, exactly as before. It is the Claude Code
// adapter wired through the engine, so the CLI / cockpit / MCP keep working unchanged.

const engine = require('./engine');
const claude = require('./adapters/claude-code');
const { clip, prettify, relTime } = require('./util');

// Collect one row per live Claude Code session (the historical shape).
function collectSessions(opts = {}) {
  return engine.collect(claude, opts);
}

module.exports = {
  collectSessions,
  labelFor: claude.labelFor,
  prettify,
  relTime,
  clip,
  PROJECTS_DIR: claude.PROJECTS_DIR,
  LABELS_FILE: claude.LABELS_FILE,
};
