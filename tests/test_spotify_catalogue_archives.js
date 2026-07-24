const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');

for (const required of [
  "CATALOGUE_ARCHIVE_STORAGE='spotify_catalogue_archives_v1'",
  'function catalogueArchiveItem(',
  'function catalogueRestoreItem(',
  'function catalogueOpenArchivePanel(',
  'function catalogueArchiveContext(',
  'catalogueArchiveToolbar()',
]) assert.ok(dashboard.includes(required), `Missing reversible catalogue archive control: ${required}`);

assert.match(dashboard, /catalogueIsArchived\('tracks',r\[6\]\)/,
  'Archived tracks must disappear from the Tracks list.');
assert.match(dashboard, /catalogueIsArchived\('artists',g\.id\|\|g\.name\)/,
  'Archived artists must disappear from the Artists list.');
assert.match(dashboard, /catalogueIsArchived\('playlists',r\[0\]\)/,
  'Archived playlists must disappear from the Playlists list.');
assert.match(dashboard, /AR_OPPORTUNITY_CACHE\.filter\(opportunity=>!catalogueIsArchived\('tracks',opportunity\.spotifyId\)\)/,
  'Archived tracks must also disappear from Opportunities.');
assert.match(dashboard, /archive:\{kind:'tracks'/,
  'Track right-click menu must include archiving.');
assert.match(dashboard, /archive:\{kind:'artists'/,
  'Artist right-click menu must include archiving.');
assert.match(dashboard, /catalogueArchiveContext\('playlists'/,
  'Playlist right-click menu must include archiving.');

console.log('spotify catalogue archives: OK');
