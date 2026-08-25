'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const fixture = JSON.parse(
  fs.readFileSync('tests/spotify_counter_integrity_cases.json', 'utf8'),
);

const helpersStart = dashboard.indexOf('function normalizeCounterHistory');
const helpersEnd = dashboard.indexOf('\nfunction shiftDay', helpersStart);
assert.ok(
  helpersStart >= 0 && helpersEnd > helpersStart,
  'Spotify counter-integrity helpers must remain extractable as one contract block',
);

const context = {};
vm.runInNewContext(
  `${dashboard.slice(helpersStart, helpersEnd)}
   this.normalizeCounterHistoryForTest = normalizeCounterHistory;
   this.trackCounterIntegrityForTest = trackCounterIntegrity;`,
  context,
);

assert.equal(fixture.version, 1, 'the fixture contract version must be explicit');
assert.equal(
  fixture.policy.extreme_discontinuity,
  'quarantine_from_the_first_untrusted_point',
  'extreme counter breaks must remain fail-closed',
);
assert.ok(Array.isArray(fixture.cases) && fixture.cases.length >= 9,
  'the contract must keep every representative counter-integrity case');

for (const testCase of fixture.cases) {
  const actual = JSON.parse(JSON.stringify(
    context.trackCounterIntegrityForTest(testCase.history),
  ));
  const eventTypes = actual.events.map(event => event.type);

  assert.equal(actual.status, testCase.expected.status,
    `${testCase.id}: integrity status`);
  assert.equal(actual.changed, testCase.expected.changed,
    `${testCase.id}: changed marker`);
  assert.deepEqual(actual.history, testCase.expected.history,
    `${testCase.id}: public counter history`);
  assert.deepEqual(eventTypes, testCase.expected.event_types,
    `${testCase.id}: audit event types`);
  assert.notEqual(actual.status, 'counter_rebased',
    `${testCase.id}: a sanitizer must never infer an identity reset`);
}

const normalization = fixture.cases.find(
  testCase => testCase.id === 'invalid_points_are_normalized_out',
);
assert.ok(normalization, 'the normalization contract case must remain present');
const normalized = JSON.parse(JSON.stringify(
  context.normalizeCounterHistoryForTest(normalization.history),
));
assert.deepEqual(normalized, normalization.expected.history,
  'normalization rejects booleans, negatives and impossible dates identically');

console.log(`spotify counter integrity contract: ${fixture.cases.length} cases passed`);
