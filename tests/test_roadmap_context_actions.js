'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');

assert.match(source, /function openRoadmapContextMenu\(i,ev\)/,
  'roadmap entries expose a dedicated context menu');
assert.match(source, /onclick="archiveRoadmapEntry\('/,
  'the context menu provides the archive action');
assert.match(source, /PROJECT_ARCHIVE_KEY='lofi_radar_project_archive_v1'/,
  'Recommendations and Roadmap use one canonical archive');
assert.match(source, /LEGACY_RECO_ARCHIVE_STORAGE_KEY='lofi_radar_validated_archive_v1'/,
  'the old Recommendations archive is retained only as a migration backup');
assert.match(source, /LEGACY_ROADMAP_ARCHIVE_STORAGE_KEY='radar_roadmap_archive_v2'/,
  'the old Roadmap archive is retained only as a migration backup');
assert.doesNotMatch(source, /\bROADMAP_ARCHIVE_LOCAL\b/,
  'Roadmap no longer owns a separate archive collection');
assert.match(source, /function archiveProjectRow\(row\)/,
  'Recommendations and Roadmap share one archive writer');
assert.match(source, /const row=Object\.assign\(\{\},r,\{__kind:'roadmap'[\s\S]*archiveProjectRow\(row\)/,
  'right-click Roadmap uses the shared Recommendations archive writer');
assert.match(source, /archiveRoadmapEntry\(i,ev\);return;/,
  'the legacy remove action now resolves to a reversible archive');
assert.match(source, /function restoreRoadmapEntry\(i\)/,
  'archived roadmap entries can be restored');
assert.match(source, /data-roadmap-index="'\+i\+'" onclick="openRoad/,
  'roadmap list rows expose their exact project index to the context menu');
assert.match(source, /class="cal-pill" data-roadmap-index="'\+r\._ri\+'"/,
  'monthly calendar releases expose their exact project index');
assert.match(source, /class="year-cell[\s\S]*data-roadmap-index="'\+evs\[0\]\._ri\+'"/,
  'annual calendar circles expose their exact project index');
assert.match(source, /target\.closest\('\[data-roadmap-index\]'\)/,
  'all roadmap representations share the same delegated right-click action');
assert.match(css, /\.roadmap-context-menu\{position:fixed/,
  'the context menu is positioned beside the pointer');

console.log('Roadmap context actions: OK');
