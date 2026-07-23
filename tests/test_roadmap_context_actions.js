'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');

assert.match(source, /function openRoadmapContextMenu\(i,ev\)/,
  'roadmap entries expose a dedicated context menu');
assert.match(source, /onclick="archiveRoadmapEntry\('/,
  'the context menu provides the archive action');
assert.match(source, /onclick="deleteRoadmapEntry\('/,
  'the context menu provides the trash action');
assert.match(source, /function restoreRoadmapEntry\(i\)/,
  'archived roadmap entries can be restored');
assert.match(source, /oncontextmenu="openRoadmapContextMenu/,
  'the roadmap list opens the menu at the right-click location');
assert.match(source, /target\.closest\('\.cal-pill'\)/,
  'calendar releases support the same right-click action');
assert.match(css, /\.roadmap-context-menu\{position:fixed/,
  'the context menu is positioned beside the pointer');

console.log('Roadmap context actions: OK');
