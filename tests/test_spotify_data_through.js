'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');
const dateStart = dashboard.indexOf('function factualDay');
const dateEnd = dashboard.indexOf('\nfunction money', dateStart);
const velocityStart = dashboard.indexOf('function monthsSince');
const velocityEnd = dashboard.indexOf('\nfunction normalizeCounterHistory', velocityStart);
assert.ok(dateStart >= 0 && dateEnd > dateStart, 'factual data-through helpers remain testable');
assert.ok(velocityStart >= 0 && velocityEnd > velocityStart, 'release-age velocity remains testable');

const context = {
  D: {t: '2026-07-17'},
  window: {
    SPOTIFY_PERFORMANCE: {
      freshness: {
        tracks_at: '2026-08-18T23:26:57Z',
        tracks_catalogue_at: '2026-08-19T23:26:57Z',
      },
    },
    SPOTIFY_SOUNDCHARTS: {generated_at: '2026-08-19T23:28:12Z'},
  },
};
vm.runInNewContext(
  `${dashboard.slice(dateStart, dateEnd)}
   ${dashboard.slice(velocityStart, velocityEnd)}
   this.dataThroughForTest=TRACK_DATA_THROUGH;
   this.perMonthForTest=perMonth;`,
  context,
);

assert.equal(context.dataThroughForTest, '2026-08-19',
  'track projections use the newest factual track date, not stale SPOTIFY_RADAR.t');
const monthly = context.perMonthForTest([0, 'Rêverie, CD 76', '2026-05-29', 205_208]);
assert.ok(monthly >= 76_000 && monthly <= 77_000,
  `Rêverie safe monthly velocity must reflect the 19 August data-through date; got ${monthly}`);

console.log('Spotify factual track data-through date: OK');
