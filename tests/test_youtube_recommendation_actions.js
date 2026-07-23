'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');

assert.match(source, /function recosHTML\(\)\{const rows=dailyRecommendationSet\(\);return '<div id="reco-list">'/,
  'the daily selection header is not rendered');
assert.doesNotMatch(source.slice(source.indexOf('function recoCardHTML'), source.indexOf('function recoInfoRows')),
  /_dailyReasons/, 'selection-reason chips are absent from recommendation cards');
assert.match(source, /function validateRecommendationNow\(/,
  'card validation has a direct action');
assert.match(source, /skipSchedulePopup:true/,
  'direct validation bypasses the extra scheduling modal');
assert.match(source, /function scheduleRecommendation\(/,
  'direct validation creates a roadmap entry');
assert.match(source, /recoN:reco\.n/,
  'roadmap entries preserve their recommendation identity');
assert.match(source, /Validate &amp; schedule/,
  'each card exposes a one-click validation and scheduling control');
assert.match(source, /setValid\('\+r\.n\+',\\'-\\'/,
  'each card exposes a direct refusal control');
assert.match(source, /if\(todayIds\.length\)/,
  'the day queue remains stable after decisions');

console.log('YouTube recommendation actions: OK');
