'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboardPath = path.join(__dirname, '..', 'assets', 'js', 'dashboard-04-recommendations.js');
const source = fs.readFileSync(dashboardPath, 'utf8');
const start = source.indexOf('const SCHED_RULES');
const end = source.indexOf('let SCHED_LOCAL=', start);
assert.ok(start >= 0 && end > start, 'roadmap scheduling helpers must remain defined');

const RealDate = Date;
const fixedNow = new RealDate('2026-07-23T12:00:00Z').getTime();
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return fixedNow; }
}

const seed = new FixedDate();
seed.setHours(0, 0, 0, 0);
seed.setDate(seed.getDate() + 3);
const roadmap = [];
for (let offset = 0; offset <= 420; offset += 1) {
  const date = new FixedDate(seed.getTime() + offset * 86_400_000);
  if (date.getDay() !== 0 && date.getDay() !== 6) roadmap.push({ date: +date, genre: 'Other' });
}

const context = { DATA: { roadmap }, SCHED_LOCAL: [], Date: FixedDate };
vm.runInNewContext(
  `${source.slice(start, end)}; this.suggestRoadmapDate=suggestRoadmapDate;`,
  context,
);

const proposal = context.suggestRoadmapDate({ genre: 'Other', title: 'No horizon cap' }, new Set());
assert.ok(proposal, 'a recommendation always receives a release date');
assert.ok(
  proposal.date.getTime() > seed.getTime() + 420 * 86_400_000,
  'the scheduler must continue beyond a formerly capped 420-day horizon',
);

for (const file of [dashboardPath, path.join(__dirname, '..', 'Lofi_Radar.html')]) {
  const content = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(content, /tries\s*<\s*420/);
  assert.doesNotMatch(content, /No open slot found in the next 400 days/i);
  assert.doesNotMatch(content, /No date available/i);
}

console.log('roadmap slot scheduling: OK');
