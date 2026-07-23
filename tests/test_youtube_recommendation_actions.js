'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('assets/js/dashboard-04-recommendations.js', 'utf8');

assert.match(source, /function recosHTML\(\)\{return recoArchiveControlHTML\(\)\+'<div id="reco-list">'/,
  'the daily selection has a compact archive control but no verbose header');
assert.doesNotMatch(source.slice(source.indexOf('function recoCardHTML'), source.indexOf('function recoInfoRows')),
  /_dailyReasons/, 'selection-reason chips are absent from recommendation cards');
assert.doesNotMatch(source, /function validateRecommendationNow\(/,
  'validation must not silently add a recommendation to the roadmap');
assert.doesNotMatch(source, /Validate &amp; schedule/,
  'the action must remain a plain validation');
assert.match(source, /openSchedulePopup\(rec\)/,
  'a newly validated recommendation opens its date proposal');
assert.match(source, /function previewSchedDay\(timestamp\)/,
  'each date circle can reveal releases on that day');
assert.match(source, /function schedDayPopoverHtml\(date,rows\)/,
  'the date picker opens a compact release popover beside an occupied day');
assert.match(source, /function positionSchedDayPopover\(\)/,
  'the compact release popover is positioned by its clicked date');
assert.match(source, /function shiftSchedMonth\(delta\)/,
  'the date picker can navigate to adjacent months');
assert.match(source, /data-sched-day=/,
  'calendar controls identify their exact day for the popover');
assert.match(source, /SCHED_CUR\.sug=Object\.assign\(\{\},SCHED_CUR\.sug,\{date\}\)/,
  'a date click must move the proposed release marker and saved date');
const schedulePopup = source.slice(source.indexOf('function renderSchedPopup()'), source.indexOf('function previewSchedDay('));
assert.doesNotMatch(schedulePopup, /sched-btn-alt|Not now|Date de sortie proposée|Suggested release date/,
  'the date picker stays minimal: no explanatory header or deferred action');
assert.doesNotMatch(source, /schedNearbyReleases/,
  'nearby releases must be replaced by the compact exact-day popover');
assert.match(source, /recoN:reco\.n/,
  'roadmap entries preserve their recommendation identity');
assert.match(source, /toggleRecoArchive\(\)/,
  'the recommendation view exposes an archive toggle');
assert.match(source, /refusedRecommendationRows\(\)/,
  'refused recommendations are retained in the archive');
assert.match(source, /activeTodayIds=todayIds\.slice\(0,RECO_DAILY_LIMIT\)/,
  'a legacy queue cannot exceed the daily cap');
assert.match(source, /renderNav\(\)/,
  'the sidebar count refreshes after a recommendation decision');
assert.match(source, /setValid\('\+r\.n\+',\\'-\\'/,
  'each card exposes a direct refusal control');
const card = source.slice(source.indexOf('function recoCardHTML'), source.indexOf('function recoInfoRows'));
assert.ok(card.indexOf('rbtn-ko') < card.indexOf('rbtn-ok'),
  'card refusal must sit left of validation');
const detail = source.slice(source.indexOf('function recoActions'), source.indexOf('function recoCommentBox'));
assert.ok(detail.indexOf('rbtn-ko') < detail.indexOf('rbtn-ok'),
  'detail refusal must sit left of validation');
const css = fs.readFileSync('assets/css/dashboard.css', 'utf8');
assert.match(css, /\.rbtn-ok\{background:rgba\(74,222,128,\.1\);color:var\(--green\);border:1\.5px solid rgba\(74,222,128,\.5\)\}/,
  'validation uses the same transparent treatment as refusal');
assert.match(css, /\.sched-cell\{appearance:none;border:1px solid transparent;background:rgba\(150,163,214,\.06\);width:34px;height:34px/,
  'the date picker renders large circular day controls');
assert.match(css, /\.sched-cell\.has-event\{background:var\(--sched-event-color/,
  'occupied days fill the whole date circle with their genre color');
assert.match(css, /\.sched-cal-nav\{width:26px;height:26px/,
  'calendar month navigation uses compact previous/next controls');
assert.match(css, /\.sched-day-popover\{position:absolute/,
  'the release detail is a mini popover instead of a block below the calendar');
assert.match(source, /if\(activeTodayIds\.length\)/,
  'the day queue remains stable after decisions');

console.log('YouTube recommendation actions: OK');
