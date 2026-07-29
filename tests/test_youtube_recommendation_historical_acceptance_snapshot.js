'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const recommendationsSource = fs.readFileSync(
  path.join(root, 'assets', 'js', 'dashboard-04-recommendations.js'),
  'utf8',
);

const decisionStart = recommendationsSource.indexOf('function acceptedDecisionNote(');
const decisionEnd = recommendationsSource.indexOf('function setValid(', decisionStart);
assert.ok(decisionStart >= 0 && decisionEnd > decisionStart,
  'recommendation decision parsing helpers must remain available');

const decisionContext = {String};
vm.runInNewContext(
  `${recommendationsSource.slice(decisionStart, decisionEnd)}
   this.validStateForTest=validState;
   this.noteOfForTest=noteOf;`,
  decisionContext,
);

const historicalAcceptedVariants = new Map([
  ['x', ''],
  ['X', ''],
  ['x ', ''],
  ['x\tretoucher le titre', 'retoucher le titre'],
  ['x\nretoucher le visuel', 'retoucher le visuel'],
  ['x commentaire libre', 'commentaire libre'],
  ['x, raccourcir le titre', 'raccourcir le titre'],
  ['x; raccourcir le titre', 'raccourcir le titre'],
  ['x: raccourcir le titre', 'raccourcir le titre'],
  ['x- raccourcir le titre', 'raccourcir le titre'],
  ['x - raccourcir le titre', 'raccourcir le titre'],
  ['x \u00b7 raccourcir le titre', 'raccourcir le titre'],
  ['x \u00c2\u00b7 forme historique mal encod\u00e9e', 'forme historique mal encod\u00e9e'],
]);

for (const [value, expectedNote] of historicalAcceptedVariants) {
  assert.match(decisionContext.validStateForTest(value), /^x(?:note)?$/,
    `historical X decision must remain accepted: ${JSON.stringify(value)}`);
  assert.equal(decisionContext.noteOfForTest(value), expectedNote,
    `historical X suffix must remain available as its note: ${JSON.stringify(value)}`);
}

assert.equal(decisionContext.validStateForTest('xylophone'), 'note',
  'a word merely beginning with x must not be accepted');
assert.equal(decisionContext.noteOfForTest('xylophone'), 'xylophone',
  'a word merely beginning with x remains an ordinary note');

const dataContext = {window: {}};
vm.runInNewContext(
  fs.readFileSync(path.join(root, 'Lofi_Radar_data.js'), 'utf8'),
  dataContext,
);
const snapshot = dataContext.window.LOFI_DATA && dataContext.window.LOFI_DATA.d;
assert.ok(snapshot && Array.isArray(snapshot.recos) && Array.isArray(snapshot.roadmap),
  'the real YouTube snapshot must expose recommendations and Roadmap rows');

const startsWithX = snapshot.recos.filter(row => /^x/i.test(String(row && row.valid || '')));
assert.equal(startsWithX.length, 53,
  'the real snapshot must retain its 53 historical decisions beginning with X');
for (const row of startsWithX) {
  assert.match(decisionContext.validStateForTest(row.valid), /^x(?:note)?$/,
    `snapshot recommendation ${row.n} must be recognized as accepted`);
  const expectedNote = String(row.valid).slice(1).trim()
    .replace(/^(?:[,;:\-]|\u00c2?\u00b7)\s*/, '')
    .trim();
  assert.equal(decisionContext.noteOfForTest(row.valid), expectedNote,
    `snapshot recommendation ${row.n} must retain its historical note`);
}

const roadmapStart = recommendationsSource.indexOf('function isMondayRoadmapProject(');
const roadmapEnd = recommendationsSource.indexOf('function refusedRecommendationRows(', roadmapStart);
assert.ok(roadmapStart >= 0 && roadmapEnd > roadmapStart,
  'accepted Roadmap filtering helpers must remain available');

const roadmapContext = {
  DATA: snapshot,
  SCHED_LOCAL: [],
  normalizedRecommendationTitle(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  },
};
vm.runInNewContext(
  `${recommendationsSource.slice(roadmapStart, roadmapEnd)}
   this.acceptedRoadmapRowsForTest=acceptedRoadmapRows;`,
  roadmapContext,
);

const producedRows = snapshot.roadmap.filter(
  row => String(row && row.src || '').trim() === 'Nouveau mix (\u00e0 produire)',
);
const proposalRows = snapshot.roadmap.filter(
  row => String(row && row.src || '').trim() === 'Proposition rotation (\u00e0 valider)',
);
const mondayRows = snapshot.roadmap.filter(
  row => String(row && row.src || '').trim() === 'Existant (Monday)',
);
assert.equal(producedRows.length, 53,
  'the real snapshot must retain its 53 produced-mix Roadmap rows');
assert.ok(proposalRows.length > 0,
  'the real snapshot must contain pending rotation proposals for this regression test');

const acceptedRows = Array.from(roadmapContext.acceptedRoadmapRowsForTest());
const acceptedKeys = new Set(acceptedRows.map(row => `${Number(row.date)}|${row.title}`));
for (const row of producedRows) {
  assert.ok(!acceptedKeys.has(`${Number(row.date)}|${row.title}`),
    `historical produced mix must stay outside Roadmap: ${row.title}`);
}
for (const row of proposalRows) {
  assert.ok(!acceptedKeys.has(`${Number(row.date)}|${row.title}`),
    `unconfirmed rotation proposal must be excluded from Roadmap: ${row.title}`);
}
assert.equal(mondayRows.length, 88,
  'the real snapshot must retain the 88 projects synchronized from Monday');
assert.equal(acceptedRows.length, mondayRows.length,
  'without a new local placement, Roadmap must contain only Monday projects');
for (const row of mondayRows) {
  assert.ok(acceptedKeys.has(`${Number(row.date)}|${row.title}`),
    `Monday project must remain in Roadmap: ${row.title}`);
}

console.log('historical recommendation acceptances and real Roadmap snapshot: ok');
