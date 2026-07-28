'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');

assert.match(source, /function openRoadmapContextMenu\(i,ev\)/,
  'Roadmap entries expose a dedicated context menu');
assert.match(source, /onclick="archiveRoadmapEntry\('/,
  'the context menu provides the reversible Roadmap archive action');
assert.match(source, /ROADMAP_ARCHIVE_STORAGE_KEY='lofi_radar_roadmap_archive_v3'/,
  'Roadmap owns a fresh, dedicated archive store');
assert.match(source, /LEGACY_PROJECT_ARCHIVE_KEY='lofi_radar_project_archive_v1'/,
  'the previous unified store is retained only as a migration backup');
assert.doesNotMatch(source, /const PROJECT_ARCHIVE_KEY=/,
  'the current implementation no longer exposes a shared project archive');
assert.doesNotMatch(source, /function archiveProjectRow\(/,
  'Roadmap no longer calls a shared Recommendations archive writer');
assert.doesNotMatch(source, /function validatedArchiveRows\(/,
  'recommendation decisions no longer depend on a local archive collection');

const migration = source.slice(
  source.indexOf('function initializeRoadmapArchive'),
  source.indexOf('initializeRoadmapArchive();') + 'initializeRoadmapArchive();'.length,
);
assert.match(migration, /\.filter\(item=>item&&item\.row&&item\.row\.__kind==='roadmap'\)/,
  'migration accepts only entries explicitly archived from Roadmap');
assert.doesNotMatch(migration, /LEGACY_ROADMAP_ARCHIVE_STORAGE_KEY/,
  'the stale v2 Roadmap archive is never imported into the new store');
assert.doesNotMatch(migration, /LEGACY_RECO_ARCHIVE_STORAGE_KEY/,
  'recommendation-only archives are never imported into Roadmap');

const archiveAction = source.slice(
  source.indexOf('function archiveRoadmapEntry'),
  source.indexOf('function restoreRoadmapEntry'),
);
assert.match(archiveAction, /roadmapArchiveRows\(\)/,
  'right-click Roadmap reads only the dedicated Roadmap archive');
assert.match(archiveAction, /saveRoadmapArchiveRows\(archive\)/,
  'right-click Roadmap writes only the dedicated Roadmap archive');
assert.match(archiveAction, /__kind:'roadmap'/,
  'new Roadmap archives remain explicitly typed');
assert.doesNotMatch(archiveAction, /setValid\(|writeValid\(|archiveProjectRow\(/,
  'Roadmap archiving cannot change a recommendation decision');

const restoreAction = source.slice(
  source.indexOf('function restoreRoadmapEntry'),
  source.indexOf('function deleteRoadmapEntry'),
);
assert.match(restoreAction, /saveRoadmapArchiveRows\(roadmapArchiveRows\(\)\.filter/,
  'Roadmap restoration only removes an item from the dedicated Roadmap archive');
assert.doesNotMatch(restoreAction, /setValid\(|writeValid\(|restoreProjectArchive\(/,
  'Roadmap restoration cannot restore or rewrite a recommendation decision');

assert.match(source, /archiveRoadmapEntry\(i,ev\);return;/,
  'the legacy remove action resolves to the same reversible Roadmap archive');
assert.match(source, /function restoreRoadmapEntry\(i\)/,
  'archived Roadmap entries remain restorable');
assert.match(source, /data-roadmap-index="'\+i\+'" onclick="openRoad/,
  'Roadmap list rows expose their exact project index to the context menu');
assert.match(source, /class="cal-pill" data-roadmap-index="'\+r\._ri\+'"/,
  'monthly calendar releases expose their exact project index');
assert.match(source, /class="year-cell[\s\S]*data-roadmap-index="'\+evs\[0\]\._ri\+'"/,
  'annual calendar circles expose their exact project index');
assert.match(source, /target\.closest\('\[data-roadmap-index\]'\)/,
  'all Roadmap representations share the same delegated right-click action');
assert.match(css, /\.roadmap-context-menu\{position:fixed/,
  'the context menu remains positioned beside the pointer');

console.log('Roadmap context actions use a separate v3 archive: OK');
