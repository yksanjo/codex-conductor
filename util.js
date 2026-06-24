'use strict';

// Tiny shared helpers used by the engine and every adapter. Pure, zero-dependency.

function clip(str, n) {
  if (str == null) return '';
  str = String(str).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function prettify(name) {
  if (!name) return '(unknown)';
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function relTime(ts) {
  if (!ts) return 'unknown';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// Run `fn` over items with at most `limit` in flight — bounds concurrent file streams so a
// huge scan (or --all) can't exhaust file descriptors.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker));
  return out;
}

module.exports = { clip, prettify, relTime, mapLimit };
