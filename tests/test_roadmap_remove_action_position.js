'use strict';

const fs = require('fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');
const start = source.indexOf('function openRoad(i){');
const end = source.indexOf('\nfunction deleteRoadmapEntry', start);
if (start < 0 || end < 0) throw new Error('openRoad function was not found');
const openRoad = source.slice(start, end);

const details = openRoad.indexOf('recoDetailBody(reco,-1)');
const action = openRoad.indexOf('rm-detail-actions');
if (details < 0 || action < 0 || action < details) {
  throw new Error('The remove-from-schedule action must render after the roadmap details');
}
if (!css.includes('.rm-detail-actions{display:flex;justify-content:flex-end;')) {
  throw new Error('The roadmap detail actions must be right-aligned');
}

console.log('Roadmap remove action placement guardrail passed');
