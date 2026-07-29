'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'js', 'dashboard-04-recommendations.js'),
  'utf8',
);

const validityStart = source.indexOf('function acceptedDecisionNote(');
const validityEnd = source.indexOf('function setValid(', validityStart);
const helperStart = source.indexOf("let RECO_TAB='pending';");
const helperEnd = source.indexOf('function recoTabControlHTML()', helperStart);
const scheduleStart = source.indexOf('function roadmapArchiveKey(');
const scheduleEnd = source.indexOf('function schedBucket(', scheduleStart);
const dailyStart = source.indexOf('function dailyRecommendationSet()');
const dailyEnd = source.indexOf('function activeDailyRecommendationCount()', dailyStart);

assert.ok(validityStart >= 0 && validityEnd > validityStart,
  'recommendation validity helpers must remain available');
assert.ok(helperStart >= 0 && helperEnd > helperStart,
  'recommendation/Roadmap state helpers must remain available');
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart,
  'Roadmap archive helpers must remain available');
assert.ok(dailyStart >= 0 && dailyEnd > dailyStart,
  'daily recommendation selection must remain available');

const acceptedValidatedRecos = Array.from({length: 53}, (_, index) => ({
  n: index + 1,
  title: `Accepted new mix ${String(index + 1).padStart(2, '0')}`,
  valid: 'X',
  genre: 'Lofi / chillhop',
  score: 100 - index,
}));
const acceptedNewMixRows = acceptedValidatedRecos.map((reco, index) => ({
  title: reco.title,
  date: 2_000_000 + index,
  src: 'Nouveau mix (à produire)',
}));

const refusedInRoadmap = {
  n: 54,
  title: 'Refused historically but already produced',
  valid: '-',
  genre: 'Ambient',
};
const malformedInArchivedRoadmap = {
  n: 55,
  title: 'Legacy freeform decision already produced',
  valid: 'ancienne validation sans marqueur standard',
  genre: 'Piano',
};
const rotationProposal = {
  n: 56,
  title: 'Rotation proposal still awaiting Roadmap placement',
  valid: 'X',
  genre: 'Jazz',
};
const ordinaryValidated = {n: 57, title: 'Ordinary validated idea', valid: 'X'};
const ordinaryRefused = {n: 58, title: 'Ordinary refused idea', valid: '-'};
const ordinaryPending = {n: 59, title: 'Ordinary pending idea', valid: '', score: 20};
const mondayValidated = {n: 60, title: 'Existing Monday project', valid: 'X'};
const locallyPlacedValidated = {n: 61, title: 'Locally placed project', valid: 'X'};

const refusedRoadmapRow = {
  title: refusedInRoadmap.title,
  date: 2_100_054,
  src: 'Nouveau mix (à produire)',
};
const archivedMalformedRow = {
  title: malformedInArchivedRoadmap.title,
  date: 2_100_055,
  src: 'Nouveau mix (à produire)',
};
const rotationProposalRow = {
  title: rotationProposal.title,
  date: 2_100_056,
  src: 'Proposition rotation (à valider)',
};
const mondayRow = {
  title: mondayValidated.title,
  date: 2_100_060,
  src: 'Existant (Monday)',
};
const localPlacement = {
  title: locallyPlacedValidated.title,
  date: 2_100_061,
  src: 'Recommandation validée (placement manuel)',
  recoN: locallyPlacedValidated.n,
};

const archivedValidatedRow = acceptedNewMixRows[52];
const archiveItems = [archivedValidatedRow, archivedMalformedRow].map(row => ({
  key: `roadmap:${row.date}|${row.title.trim().toLocaleLowerCase().replace(/\s+/g, ' ')}`,
  archivedAt: 2_200_000,
  row: {...row, __kind: 'roadmap'},
}));
const saved = new Map([
  ['lofi_radar_roadmap_archive_v3', JSON.stringify(archiveItems)],
]);

const context = {
  DATA: {
    recos: [
      ...acceptedValidatedRecos,
      refusedInRoadmap,
      malformedInArchivedRoadmap,
      rotationProposal,
      ordinaryValidated,
      ordinaryRefused,
      ordinaryPending,
      mondayValidated,
      locallyPlacedValidated,
    ],
    roadmap: [
      ...acceptedNewMixRows,
      refusedRoadmapRow,
      archivedMalformedRow,
      rotationProposalRow,
      mondayRow,
    ],
  },
  SCHED_LOCAL: [localPlacement],
  localStorage: {
    getItem: key => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
  },
  window: {},
  LANG: 'fr',
  recoDayKey: () => '2026-07-28',
  recoRotationHistory: () => ({
    '2026-07-28': [1, 54, 55, 56, 59],
  }),
  recoProfile: () => ({}),
  recoDailyScore: row => Number(row.score) || 0,
  recoReasons: () => [],
};

vm.runInNewContext(source.slice(scheduleStart, scheduleEnd), context);
vm.runInNewContext(source.slice(validityStart, validityEnd), context);
vm.runInNewContext(
  `${source.slice(helperStart, helperEnd)}
   this.acceptedRoadmapRowsForTest=acceptedRoadmapRows;
   this.recommendationRoadmapEntryForTest=recommendationRoadmapEntry;
   this.validatedRecommendationRowsForTest=validatedRecommendationRows;
   this.refusedRecommendationRowsForTest=refusedRecommendationRows;`,
  context,
);
vm.runInNewContext(
  `const RECO_DAILY_LIMIT=50;
   ${source.slice(dailyStart, dailyEnd)}
   this.dailyRecommendationSetForTest=dailyRecommendationSet;`,
  context,
);

const acceptedRows = Array.from(context.acceptedRoadmapRowsForTest());
const acceptedTitles = new Set(acceptedRows.map(row => row.title));

assert.equal(context.isValidated(malformedInArchivedRoadmap.valid), false,
  'the legacy freeform status must exercise the pending-state fallback');
assert.equal(context.isRefused(malformedInArchivedRoadmap.valid), false,
  'the legacy freeform status must not be mistaken for a refusal');

assert.equal(
  acceptedNewMixRows.filter(row => acceptedTitles.has(row.title)).length,
  0,
  'historical “Nouveau mix (à produire)” rows must not pre-fill Roadmap',
);
assert.ok(!acceptedTitles.has(rotationProposal.title),
  '“Proposition rotation (à valider)” must not count as an accepted Roadmap project');
assert.ok(acceptedTitles.has(mondayValidated.title),
  'existing Monday projects remain accepted Roadmap projects');
assert.ok(acceptedTitles.has(locallyPlacedValidated.title),
  'an explicitly confirmed local placement remains an accepted Roadmap project');

const validatedIds = Array.from(context.validatedRecommendationRowsForTest()).map(row => row.n);
assert.equal(
  acceptedValidatedRecos.filter(row => validatedIds.includes(row.n)).length,
  53,
  'the 53 validated ideas must remain available for a future team placement',
);
assert.ok(!validatedIds.includes(mondayValidated.n),
  'a validated Monday project must not remain in Validated');
assert.ok(!validatedIds.includes(locallyPlacedValidated.n),
  'a locally placed idea must not remain in Validated');
assert.deepEqual(validatedIds, [...acceptedValidatedRecos.map(row => row.n), rotationProposal.n, ordinaryValidated.n],
  'validated recommendations stay in Validated until an explicit placement');

const refusedIds = Array.from(context.refusedRecommendationRowsForTest()).map(row => row.n);
assert.deepEqual(refusedIds, [refusedInRoadmap.n, ordinaryRefused.n],
  'an obsolete produced-mix row must not hide a refused recommendation');

assert.ok(!context.recommendationRoadmapEntryForTest(malformedInArchivedRoadmap),
  'an archived historical produced-mix row is not a Roadmap hand-off');
assert.ok(!Array.from(context.scheduledRows()).some(row => row.title === malformedInArchivedRoadmap.title),
  'historical produced-mix rows stay outside the active Roadmap');
assert.ok(validatedIds.includes(acceptedValidatedRecos[52].n),
  'an old Roadmap archive cannot hide a still-validated recommendation');

const pendingIds = Array.from(context.dailyRecommendationSetForTest()).map(row => row.n);
assert.deepEqual(pendingIds, [malformedInArchivedRoadmap.n, ordinaryPending.n],
  'an obsolete produced-mix row no longer hides a pending recommendation');

console.log('Roadmap has priority over Pending, Validated and Refused recommendation queues.');
