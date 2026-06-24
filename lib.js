'use strict';

const engine = require('./engine');
const codex = require('./adapters/codex-code');
const { clip, prettify, relTime } = require('./util');

function collectSessions(opts = {}) {
  return engine.collect(codex, opts);
}

module.exports = {
  collectSessions,
  labelFor: codex.labelFor,
  prettify,
  relTime,
  clip,
  PROJECTS_DIR: codex.PROJECTS_DIR,
  LABELS_FILE: codex.LABELS_FILE,
};
