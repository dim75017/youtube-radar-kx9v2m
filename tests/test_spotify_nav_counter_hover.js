'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const coverage = fs.readFileSync('spotify/coverage.js', 'utf8');

assert.match(coverage, /counter\.removeAttribute\('title'\)/,
  'Navigation counters must remove their native tooltip attribute completely.');
assert.doesNotMatch(coverage, /counter\.title\s*=/,
  'Clearing tooltip text is insufficient because an empty title still matches the help-cursor selector.');
assert.doesNotMatch(coverage, /#nav \.count\[title\]\s*\{\s*cursor:help/,
  'Navigation counters must never use the question-mark help cursor.');

console.log('spotify navigation counter hover: OK');
