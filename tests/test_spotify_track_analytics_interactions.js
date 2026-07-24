'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('spotify/dashboard.js', 'utf8');

assert.match(dashboard, /function bindSparklineHover\(root\)/,
  'Daily analytics charts must bind their own hover interaction.');
assert.match(dashboard, /addEventListener\('pointermove',event=>showNearestSparkPoint\(svg,event\)\)/,
  'Hovering any point along a chart must select the nearest daily data point.');
assert.match(dashboard, /bindSparklineHover\(box\);/,
  'Track, artist, and playlist analytics panels must activate the hover marker.');
assert.match(dashboard, /function arRetryPlaylistCover\(image,playlistId\)/,
  'Editorial covers must retry through the resilient cover loader after an image error.');
assert.match(dashboard, /open\.spotify\.com\/oembed\?url=/,
  'Missing editorial covers must resolve from Spotify oEmbed.');
assert.doesNotMatch(dashboard, /data-metric-mode="streams" title=/,
  'Metric-mode buttons must not have a native hover tooltip.');
assert.doesNotMatch(dashboard, /class="num" title=/,
  'Numeric table cells must not have native hover tooltips.');

console.log('spotify track analytics interactions: OK');
