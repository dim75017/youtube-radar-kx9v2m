'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'dashboard-04-recommendations.js'), 'utf8');
const helperStart = source.indexOf("let RECO_TAB='pending';");
const helperEnd = source.indexOf('function recoTabControlHTML()', helperStart);
const scheduleStart = source.indexOf('function roadmapArchiveKey');
const scheduleEnd = source.indexOf('function schedBucket', scheduleStart);
const roadmapArchiveStart = source.indexOf('function archiveRoadmapEntry');
const roadmapArchiveEnd = source.indexOf('function restoreRoadmapEntry', roadmapArchiveStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'validated recommendation helpers must remain available');
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, 'roadmap archive filter must remain available');
assert.ok(roadmapArchiveStart >= 0 && roadmapArchiveEnd > roadmapArchiveStart, 'roadmap archive action must remain available');

const mondayRow = {title: 'Monday project', date: 2, src: 'Monday'};
const plannedRecommendation = {title: 'Planned recommendation', date: 3, src: 'Proposition rotation (Ã  valider)', recoN: 7};
const plannedMondayRow = {title: 'Planned recommendation', date: 3, src: 'Existant (Monday)', scene: 'Monday source'};
const automaticProposal = {title: 'Automatic 2028 proposal', date: 1830297600000, src: 'Proposition rotation (à valider)'};
const legacyRoadmapArchive = {
  key: 'roadmap:2|monday project',
  archivedAt: 1,
  row: {...mondayRow, __kind: 'roadmap', valid: 'X', planned: true},
};
const standaloneArchive = {
  key: 'reco:99',
  archivedAt: 1,
  row: {n: 99, title: 'Standalone archived recommendation'},
};
const plannedStandaloneArchive = {
  key: 'reco:7',
  archivedAt: 1,
  row: {n: 7, title: 'Planned recommendation'},
};
const saved = new Map([
  ['lofi_radar_validated_archive_v1', JSON.stringify([standaloneArchive, plannedStandaloneArchive, legacyRoadmapArchive])],
  ['radar_roadmap_archive_v2', JSON.stringify([mondayRow, {...plannedRecommendation, archivedAt: 2}])],
]);
let renderCount = 0;
let navRenderCount = 0;
const context = {
  DATA: {
    recos: [
      {n: 1, title: 'Existing plan', valid: 'X'},
      {n: 2, title: 'Validated only', valid: 'X'},
      {n: 3, title: 'Pending', valid: ''},
      {n: 7, title: 'Planned recommendation', valid: 'X'},
    ],
    roadmap: [{title: 'Existing plan', date: 1, src: 'Existant (Monday)'}, mondayRow, plannedMondayRow, automaticProposal],
  },
  SCHED_LOCAL: [plannedRecommendation],
  VIEW_CACHE: new Map([['roadmap|en', {}], ['dashboard|en', {}], ['recos|en', {}]]),
  VIEW_WARMUP_TOKEN: 0,
  localStorage: {
    getItem: key => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  },
  isValidated: value => /^x/i.test(String(value || '').trim()),
  window: {_pageRecos: []},
  closeDrawer() {},
  closeRoadmapContextMenu() {},
  rerenderRecos() {},
  render() { renderCount += 1; },
  renderNav() { navRenderCount += 1; },
};

vm.runInNewContext(`${source.slice(helperStart, helperEnd)}; this.validatedRows=validatedRecommendationRows; this.restoreValidated=restoreValidatedRecommendation; this.archiveItems=roadmapArchiveItems; this.acceptedRows=acceptedRoadmapRows;`, context);
vm.runInNewContext(`${source.slice(scheduleStart, scheduleEnd)}; this.scheduled=scheduledRows;`, context);
vm.runInNewContext(`${source.slice(roadmapArchiveStart, roadmapArchiveEnd)}; this.archiveRoadmap=archiveRoadmapEntry;`, context);

const migratedArchive = JSON.parse(saved.get('lofi_radar_project_archive_v1'));
assert.deepEqual(migratedArchive.map(item => item.key), ['reco:99', 'reco:7'], 'the one-time migration preserves recommendation decisions and planned recommendations');
assert.equal(migratedArchive.find(item => item.key === 'reco:7').row.__kind, 'roadmap', 'migration recovers an archived planned recommendation by recoN');
assert.equal(saved.has('lofi_radar_validated_archive_v1'), true, 'the legacy Recommendations archive remains available as a backup');
assert.equal(saved.has('radar_roadmap_archive_v2'), true, 'the legacy Roadmap archive remains available as a backup');
saved.set('lofi_radar_project_archive_v1', JSON.stringify(migratedArchive.map(item => item.key === 'reco:7' ? plannedStandaloneArchive : item)));
assert.ok(Array.from(context.scheduled()).some(row => row.title === 'Monday project'), 'Monday projects are present in Roadmap by default');
assert.ok(Array.from(context.validatedRows()).some(row => row.__kind === 'roadmap' && row.title === 'Monday project'), 'Monday projects are accepted in Validated by default');
assert.ok(!Array.from(context.scheduled()).some(row => row.title === 'Automatic 2028 proposal'), 'unvalidated automatic proposals are not part of the Roadmap baseline');
assert.ok(!Array.from(context.validatedRows()).some(row => row.title === 'Automatic 2028 proposal'), 'unvalidated automatic proposals are not accepted by default');
assert.ok(!Array.from(context.scheduled()).some(row => row.title === 'Planned recommendation'), 'a pre-existing recommendation archive also hides its later planned Roadmap entry');
assert.ok(!Array.from(context.validatedRows()).some(row => row.title === 'Planned recommendation'), 'the pre-existing recommendation archive remains shared after planning');
assert.equal(Array.from(context.archiveItems()).filter(item => item.key === 'reco:7').length, 1, 'Roadmap Archives resolves an archived recommendation against its planned entry');
context.restoreValidated('reco:7');
const mergedPlannedRow = Array.from(context.acceptedRows()).find(row => row.title === 'Planned recommendation');
assert.equal(mergedPlannedRow.recoN, 7, 'Monday deduplication preserves the confirmed recommendation identity');
assert.equal(mergedPlannedRow.src, 'Existant (Monday)', 'Monday remains the source of truth after deduplication');

context.window._rm_rows = [mergedPlannedRow];
context.archiveRoadmap(0, {stopPropagation() {}});
let sharedArchive = JSON.parse(saved.get('lofi_radar_project_archive_v1'));
assert.equal(sharedArchive.filter(item => item.key === 'reco:7').length, 1, 'a planned recommendation keeps the same canonical identity in both views');
assert.ok(!Array.from(context.scheduled()).some(row => row.title === 'Planned recommendation'), 'archiving the planned recommendation hides it from Roadmap');
assert.ok(!Array.from(context.validatedRows()).some(row => row.title === 'Planned recommendation'), 'the same canonical identity hides it from Validated');
context.restoreValidated('reco:7');
assert.ok(Array.from(context.scheduled()).some(row => row.title === 'Planned recommendation'), 'restoring the recommendation identity restores its Roadmap entry');

context.window._rm_rows = [mondayRow];
context.archiveRoadmap(0, {stopPropagation() {}});
context.archiveRoadmap(0, {stopPropagation() {}});
const unifiedArchive = JSON.parse(saved.get('lofi_radar_project_archive_v1'));
const roadmapItems = unifiedArchive.filter(item => item.key === 'roadmap:2|monday project');
assert.equal(roadmapItems.length, 1, 'Roadmap archiving is idempotent in the shared Recommendations archive');
assert.equal(roadmapItems[0].row.__kind, 'roadmap', 'the shared archive keeps the project type');
assert.equal(context.DATA.roadmap.length, 4, 'archiving never mutates the Monday feed');
assert.ok(!Array.from(context.scheduled()).some(row => row.title === 'Monday project'), 'the shared archive hides the project from Roadmap');
assert.ok(!Array.from(context.validatedRows()).some(row => row.title === 'Monday project'), 'the same archive hides the project from Validated');
assert.equal(Array.from(context.archiveItems()).length, 1, 'Roadmap archive UI reads the same Recommendations archive');
assert.ok(renderCount >= 1 && navRenderCount >= 1, 'derived views and navigation refresh immediately');
assert.equal(context.VIEW_CACHE.size, 0, 'stale Roadmap and Recommendations markup is invalidated');

context.restoreValidated('roadmap:2|monday project');
assert.ok(Array.from(context.scheduled()).some(row => row.title === 'Monday project'), 'restoring in Recommendations restores Roadmap');
assert.ok(Array.from(context.validatedRows()).some(row => row.title === 'Monday project'), 'restoring in Recommendations restores Validated');

saved.set('radar_roadmap_archive_v2', JSON.stringify([mondayRow]));
assert.ok(Array.from(context.scheduled()).some(row => row.title === 'Monday project'), 'a stale legacy Roadmap store can no longer hide Monday');

assert.match(source, /Projets archivés/, 'Recommendations archive labels the unified project archive clearly');
assert.match(source, /rbtn-archive/, 'validated cards expose a visible archive action');
console.log('Recommendation and Roadmap unified archive checks passed.');
