'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'dashboard-04-recommendations.js'), 'utf8');
const start = source.indexOf("let RECO_TAB='pending';");
const end = source.indexOf('function recoTabControlHTML()', start);
assert.ok(start >= 0 && end > start, 'validated recommendation helpers must remain available');

const saved = new Map();
const context = {
  DATA: {
    recos: [
      {n: 1, title: 'Existing plan', valid: 'X'},
      {n: 2, title: 'Validated only', valid: 'X'},
      {n: 3, title: 'Pending', valid: ''},
    ],
    roadmap: [{title: 'Existing plan', date: 1}, {title: 'Monday project', date: 2}],
  },
  localStorage: {
    getItem: key => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
  },
  isValidated: value => /^x/i.test(String(value || '').trim()),
  window: {_pageRecos: []},
  closeDrawer() {},
  rerenderRecos() {},
};
vm.runInNewContext(`${source.slice(start, end)}; this.rows=validatedRecommendationRows; this.key=validatedRowKey; this.archive=archiveValidatedRecommendation;`, context);

let rows = Array.from(context.rows());
assert.equal(rows.length, 3, 'validated view includes every current roadmap project plus standalone validations without duplicate titles');
assert.ok(rows.some(row => row.__kind === 'roadmap' && row.title === 'Monday project'));

context.window._pageRecos = rows;
context.archive(rows.findIndex(row => row.title === 'Monday project'));
rows = Array.from(context.rows());
assert.equal(rows.length, 2, 'archiving hides a card from Validated');
assert.equal(context.DATA.roadmap.length, 1, 'archiving a validated roadmap project removes it from the roadmap too');
assert.equal(context.DATA.roadmap[0].title, 'Existing plan');

assert.match(source, /rbtn-archive/, 'validated cards expose a visible archive action');
console.log('Recommendation validated/archive checks passed.');
