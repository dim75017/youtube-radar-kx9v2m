'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'js', 'dashboard-04-recommendations.js'),
  'utf8',
);

const decisionStart = source.indexOf('function setValid(');
const decisionEnd = source.indexOf('const WRITE_URL=', decisionStart);
const helperStart = source.indexOf("let RECO_TAB='pending';");
const helperEnd = source.indexOf('function recoTabControlHTML()', helperStart);
const scheduleStart = source.indexOf('function roadmapArchiveKey');
const scheduleEnd = source.indexOf('function schedBucket', scheduleStart);
const roadmapActionStart = source.indexOf('function archiveRoadmapEntry');
const roadmapActionEnd = source.indexOf('function deleteRoadmapEntry', roadmapActionStart);
const recoActionsStart = source.indexOf('function recoActions(');
const recoActionsEnd = source.indexOf('function recoCommentBox(', recoActionsStart);

assert.ok(decisionStart >= 0 && decisionEnd > decisionStart,
  'recommendation decision helpers must remain available');
assert.ok(helperStart >= 0 && helperEnd > helperStart,
  'recommendation and Roadmap separation helpers must remain available');
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart,
  'Roadmap archive filtering helpers must remain available');
assert.ok(roadmapActionStart >= 0 && roadmapActionEnd > roadmapActionStart,
  'Roadmap archive actions must remain available');

const archivedMonday = {
  title: 'Archived Monday project',
  date: 2,
  src: 'Existant (Monday)',
};
const visibleMonday = {
  title: 'Visible Monday project',
  date: 5,
  src: 'Existant (Monday)',
};
const placedRecommendation = {
  title: 'Already placed recommendation',
  date: 7,
  src: 'Recommandation validée (placement manuel)',
  recoN: 7,
};
const producedRecommendation = {
  title: 'Produced recommendation',
  date: 8,
  src: 'Nouveau mix (a produire)',
};
const unconfirmedProposal = {
  title: 'Unconfirmed recommendation',
  date: 9,
  src: 'Proposition rotation (a valider)',
};
const recommendationOnlyArchive = {
  key: 'reco:1',
  archivedAt: 10,
  row: {n: 1, title: 'Validated recommendation'},
};
const ambiguousPlacedArchive = {
  key: 'reco:7',
  archivedAt: 11,
  row: {...placedRecommendation},
};
const explicitRoadmapArchive = {
  key: 'roadmap:2|archived monday project',
  archivedAt: 12,
  row: {...archivedMonday, __kind: 'roadmap'},
};

const legacyProjectArchive = [
  recommendationOnlyArchive,
  ambiguousPlacedArchive,
  explicitRoadmapArchive,
];
const legacyRoadmapArchive = [
  {key: 'roadmap:5|visible monday project', archivedAt: 13, row: {...visibleMonday, __kind: 'roadmap'}},
];
const saved = new Map([
  ['lofi_radar_project_archive_v1', JSON.stringify(legacyProjectArchive)],
  ['lofi_radar_validated_archive_v1', JSON.stringify([recommendationOnlyArchive])],
  ['radar_roadmap_archive_v2', JSON.stringify(legacyRoadmapArchive)],
]);

let renderCount = 0;
let navRenderCount = 0;
let schedulePopupCount = 0;
let sheetWriteCount = 0;
const context = {
  DATA: {
    recos: [
      {n: 1, title: 'Validated recommendation', valid: 'X'},
      {n: 2, title: 'Refused recommendation', valid: '-'},
      {n: 3, title: 'Pending recommendation', valid: ''},
      {n: 7, title: 'Already placed recommendation', valid: '-'},
      {n: 8, title: 'Produced recommendation', valid: 'X'},
      {n: 9, title: 'Unconfirmed recommendation', valid: 'X'},
    ],
    roadmap: [archivedMonday, visibleMonday, producedRecommendation, unconfirmedProposal],
  },
  SCHED_LOCAL: [placedRecommendation],
  VIEW_CACHE: new Map([['roadmap|fr', {}], ['dashboard|fr', {}], ['recos|fr', {}]]),
  VIEW_WARMUP_TOKEN: 0,
  localStorage: {
    getItem: key => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  },
  isValidated: value => /^x(?:\s*$|\s*·)/i.test(String(value || '')),
  isRefused: value => /^-(?:\s*$|\s*·)/.test(String(value || '')),
  noteOf: value => {
    const match = String(value || '').match(/^[x-]\s*·\s*([\s\S]*)$/i);
    return match ? match[1] : '';
  },
  openSchedulePopup() { schedulePopupCount += 1; },
  saveCache() {},
  rerenderRecos() {},
  render() { renderCount += 1; },
  renderNav() { navRenderCount += 1; },
  closeDrawer() {},
  closeRoadmapContextMenu() {},
  clearTimeout() {},
  _cmtTimer: null,
  writeValid() { sheetWriteCount += 1; },
  document: {
    getElementById(id) {
      if (id === 'drawer') return {classList: {contains: () => false}};
      return null;
    },
  },
  window: {_pageRecos: [], _rm_rows: []},
  LANG: 'en',
};

vm.runInNewContext(
  `${source.slice(scheduleStart, scheduleEnd)}
   this.scheduledRowsForTest=scheduledRows;`,
  context,
);
vm.runInNewContext(
  `${source.slice(helperStart, helperEnd)}
   this.acceptedRowsForTest=acceptedRoadmapRows;
   this.validatedRowsForTest=validatedRecommendationRows;
   this.refusedRowsForTest=refusedRecommendationRows;
   this.roadmapArchivesForTest=roadmapArchiveItems;
   this.placeValidatedForTest=placeValidatedRecommendation;
   this.roadmapActionForTest=recommendationRoadmapActionHTML;`,
  context,
);
vm.runInNewContext(
  `${source.slice(roadmapActionStart, roadmapActionEnd)}
   this.archiveRoadmapForTest=archiveRoadmapEntry;
   this.restoreRoadmapForTest=restoreRoadmapEntry;`,
  context,
);
vm.runInNewContext(
  `${source.slice(decisionStart, decisionEnd)}
   this.setValidForTest=setValid;`,
  context,
);
vm.runInNewContext(
  `${source.slice(recoActionsStart, recoActionsEnd)}
   this.recoActionsForTest=recoActions;`,
  context,
);

const migratedRoadmapArchive = JSON.parse(saved.get('lofi_radar_roadmap_archive_v3'));
assert.equal(migratedRoadmapArchive.length, 1,
  'the v3 Roadmap archive migrates only one explicitly typed Roadmap row');
assert.equal(migratedRoadmapArchive[0].row.__kind, 'roadmap',
  'the migrated item keeps its explicit Roadmap type');
assert.equal(migratedRoadmapArchive[0].row.title, archivedMonday.title,
  'the explicitly archived Monday project is preserved');
assert.ok(!migratedRoadmapArchive.some(item => item.row && item.row.n === 1),
  'a recommendation-only archive is never migrated into Roadmap');
assert.ok(!migratedRoadmapArchive.some(item => item.row && item.row.recoN === 7),
  'an ambiguous recommendation archive is never treated as an explicit Roadmap archive');
assert.deepEqual(JSON.parse(saved.get('lofi_radar_project_archive_v1')), legacyProjectArchive,
  'the previous unified store remains untouched as a recoverable backup');
assert.deepEqual(JSON.parse(saved.get('radar_roadmap_archive_v2')), legacyRoadmapArchive,
  'the stale v2 Roadmap archive is retained as backup but not imported');

const accepted = Array.from(context.acceptedRowsForTest());
assert.ok(accepted.some(row => row.title === archivedMonday.title),
  'Monday remains a source for Roadmap before its separate archive filter is applied');
assert.ok(accepted.some(row => row.title === visibleMonday.title),
  'non-archived Monday projects remain accepted Roadmap rows');
assert.ok(accepted.some(row => row.title === producedRecommendation.title),
  'a produced mix is already an accepted Roadmap project');
assert.ok(!accepted.some(row => row.title === unconfirmedProposal.title),
  'an unconfirmed rotation proposal never enters the accepted Roadmap set');

const validated = Array.from(context.validatedRowsForTest());
assert.deepEqual(validated.map(row => row.n), [1, 9],
  'Validated excludes produced or manually placed projects but keeps an unconfirmed proposal');
assert.ok(validated.every(row => !/Monday/i.test(String(row.src || ''))),
  'Monday projects never appear in Validated');
assert.deepEqual(Array.from(context.refusedRowsForTest()).map(row => row.n), [2],
  'a stale refusal already placed in Roadmap is hidden and cannot teach a negative signal');

const scheduledAfterMigration = Array.from(context.scheduledRowsForTest());
assert.ok(!scheduledAfterMigration.some(row => row.title === archivedMonday.title),
  'the migrated v3 archive hides the explicitly archived Roadmap project');
assert.ok(scheduledAfterMigration.some(row => row.title === visibleMonday.title),
  'the stale v2 archive cannot hide a current Monday project');
assert.ok(scheduledAfterMigration.some(row => Number(row.recoN) === 7),
  'an explicitly placed recommendation remains in Roadmap');

const popupBeforeValidation = schedulePopupCount;
const scheduleCountBeforeValidation = context.SCHED_LOCAL.length;
context.setValidForTest(3, 'X', null, null);
assert.equal(context.DATA.recos.find(row => row.n === 3).valid, 'X',
  'validation still updates the recommendation decision');
assert.equal(schedulePopupCount, popupBeforeValidation,
  'validation alone never opens Roadmap placement');
assert.equal(context.SCHED_LOCAL.length, scheduleCountBeforeValidation,
  'validation alone never creates a Roadmap entry');
assert.equal(sheetWriteCount, 1,
  'the recommendation decision is still written to its existing persistence layer');

context.placeValidatedForTest(3);
assert.equal(schedulePopupCount, popupBeforeValidation + 1,
  'placing a validated recommendation is an explicit second action');
assert.match(context.roadmapActionForTest(context.DATA.recos.find(row => row.n === 3)), /Place in roadmap|Placer dans la roadmap/,
  'a validated unscheduled recommendation exposes the explicit Roadmap action');
context.SCHED_LOCAL.push({
  title: 'Pending recommendation',
  date: 9,
  src: 'Recommandation validée (placement manuel)',
  recoN: 3,
});
assert.deepEqual(Array.from(context.validatedRowsForTest()).map(row => row.n), [1, 9],
  'a recommendation disappears from Validated as soon as its Roadmap placement is confirmed');
context.placeValidatedForTest(2);
context.placeValidatedForTest(7);
assert.equal(schedulePopupCount, popupBeforeValidation + 1,
  'a refused or already placed recommendation cannot open another placement');
assert.match(context.roadmapActionForTest(context.DATA.recos.find(row => row.n === 3)), /disabled/,
  'a confirmed placement immediately exposes its Roadmap state');
assert.match(context.roadmapActionForTest(context.DATA.recos.find(row => row.n === 7)), /disabled/,
  'an already placed recommendation exposes a disabled Roadmap state');
assert.doesNotMatch(context.recoActionsForTest(context.DATA.recos.find(row => row.n === 7), 0), /setValid\(7,'-'/,
  'a recommendation already handed to Roadmap cannot be refused from a stale detail drawer');
const placedDecisionBefore=context.DATA.recos.find(row => row.n === 7).valid;
context.setValidForTest(7, '-', null, null);
assert.equal(context.DATA.recos.find(row => row.n === 7).valid, placedDecisionBefore,
  'the decision handler also rejects a stale refusal action after Roadmap placement');

const decisionsBeforeRoadmapArchive = context.DATA.recos.map(row => row.valid);
const legacyStoreBeforeRoadmapArchive = saved.get('lofi_radar_project_archive_v1');
context.window._rm_rows = [visibleMonday];
context.archiveRoadmapForTest(0, {stopPropagation() {}});
const separateRoadmapArchive = JSON.parse(saved.get('lofi_radar_roadmap_archive_v3'));
assert.equal(separateRoadmapArchive.filter(item => item.row && item.row.title === visibleMonday.title).length, 1,
  'right-click archiving writes the current project once to the separate v3 store');
assert.deepEqual(context.DATA.recos.map(row => row.valid), decisionsBeforeRoadmapArchive,
  'Roadmap archiving never changes recommendation decisions');
assert.equal(saved.get('lofi_radar_project_archive_v1'), legacyStoreBeforeRoadmapArchive,
  'Roadmap archiving never writes to the previous Recommendations archive');
assert.ok(!Array.from(context.scheduledRowsForTest()).some(row => row.title === visibleMonday.title),
  'the separate Roadmap archive hides the project only from Roadmap');
assert.deepEqual(Array.from(context.validatedRowsForTest()).map(row => row.n), [1, 9],
  'Roadmap archiving leaves Validated unchanged');
assert.deepEqual(Array.from(context.refusedRowsForTest()).map(row => row.n), [2],
  'Roadmap archiving leaves Refused unchanged');

context.window._roadmap_archive_items = context.roadmapArchivesForTest();
const restoreIndex = context.window._roadmap_archive_items.findIndex(
  item => item.row && item.row.title === visibleMonday.title,
);
assert.ok(restoreIndex >= 0, 'the separately archived Roadmap item can be found for restoration');
context.restoreRoadmapForTest(restoreIndex);
assert.ok(Array.from(context.scheduledRowsForTest()).some(row => row.title === visibleMonday.title),
  'restoring a Roadmap archive restores only its Roadmap visibility');
assert.deepEqual(context.DATA.recos.map(row => row.valid), decisionsBeforeRoadmapArchive,
  'Roadmap restoration also leaves recommendation decisions unchanged');
assert.ok(renderCount >= 2 && navRenderCount >= 2,
  'Roadmap archive changes invalidate and refresh their derived views immediately');

console.log('Recommendation decisions and Roadmap archive are safely decoupled.');
